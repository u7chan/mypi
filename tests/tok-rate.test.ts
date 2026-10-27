import { describe, expect, test } from "bun:test";
import tokRateExtension, {
	createTokRateController,
	DEFAULT_MIN_ARRIVALS,
	DEFAULT_MIN_SPAN_MS,
	DEFAULT_THROTTLE_MS,
	estimateTokens,
	formatThemedAverageTokRateStatus,
	formatThemedMissingTokRateStatus,
	formatThemedTokRateStatus,
	formatTokPerSecond,
	STATUS_KEY,
} from "../src/tok-rate/extension.ts";
import type { TokRateContext, TokRateTheme } from "../src/tok-rate/core.ts";

const theme: TokRateTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
};

function createFakeUi() {
	const statuses: Array<[string, string | undefined]> = [];
	const ctx: TokRateContext = {
		hasUI: true,
		ui: {
			theme,
			setStatus: (key, text) => {
				statuses.push([key, text]);
			},
		},
	};
	return { ctx, statuses };
}

function createClock(startedAt = 0) {
	let current = startedAt;
	return {
		now: () => current,
		advance: (ms: number) => {
			current += ms;
		},
	};
}

const textDelta = (delta: string) => ({
	type: "text_delta",
	delta,
	partial: { role: "assistant", usage: { output: 0 } },
});

/**
 * Emit `count` ASCII deltas `gapMs` apart, leaving the clock on the last one.
 * 40 characters estimate as ten tokens.
 */
function emitDeltas(
	controller: ReturnType<typeof createTokRateController>,
	ctx: TokRateContext,
	clock: ReturnType<typeof createClock>,
	count: number,
	gapMs: number,
	chars = 40,
) {
	for (let index = 0; index < count; index++) {
		if (index > 0) clock.advance(gapMs);
		controller.messageUpdate(textDelta("a".repeat(chars)), ctx);
	}
}

describe("estimateTokens", () => {
	test("counts ASCII as a quarter token and wide characters as one", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("あいうえお")).toBe(5);
		expect(estimateTokens("ab日本")).toBe(2.5);
		expect(estimateTokens("👩‍💻")).toBe(3);
	});
});

describe("formatTokPerSecond", () => {
	test("rounds high rates and keeps a decimal below 100", () => {
		expect(formatTokPerSecond(158.4)).toBe("158");
		expect(formatTokPerSecond(100)).toBe("100");
		expect(formatTokPerSecond(42.34)).toBe("42.3");
		expect(formatTokPerSecond(0.45)).toBe("0.5");
	});

	test("collapses invalid and non-positive input to zero", () => {
		expect(formatTokPerSecond(0)).toBe("0");
		expect(formatTokPerSecond(-3)).toBe("0");
		expect(formatTokPerSecond(Number.NaN)).toBe("0");
		expect(formatTokPerSecond(Number.POSITIVE_INFINITY)).toBe("0");
	});

	test("renders the themed footer status", () => {
		expect(formatThemedTokRateStatus(158.4, theme)).toBe("158<dim> tok/s</dim>");
		expect(formatThemedAverageTokRateStatus(92.3, theme)).toBe("<dim>avg</dim> 92.3<dim> tok/s</dim>");
	});

	test("renders the missing marker for untimed responses", () => {
		expect(formatThemedMissingTokRateStatus(theme)).toBe("<dim>-- tok/s</dim>");
	});
});

describe("tok-rate controller", () => {
	test("shows a throttled live estimate once the window is measurable", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		expect(statuses).toEqual([[STATUS_KEY, undefined]]);

		// Eight arrivals over 350ms are still below both gates.
		emitDeltas(controller, ctx, clock, 8, 50);
		expect(statuses).toHaveLength(1);

		// A ninth arrival at 400ms with 90 estimated tokens.
		clock.advance(50);
		controller.messageUpdate(textDelta("a".repeat(40)), ctx);
		expect(statuses.at(-1)?.[1]).toBe("225<dim> tok/s</dim>");

		// Inside the throttle window nothing repaints.
		clock.advance(DEFAULT_THROTTLE_MS - 1);
		controller.messageUpdate(textDelta("a".repeat(40)), ctx);
		expect(statuses).toHaveLength(2);

		clock.advance(1);
		controller.messageUpdate(textDelta("a".repeat(40)), ctx);
		expect(statuses).toHaveLength(3);
	});

	test("does not rate a burst that shares a millisecond", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		// 400 estimated tokens delivered as three events in the same millisecond.
		controller.messageStart({ role: "assistant" }, ctx);
		controller.messageUpdate(textDelta("a".repeat(800)), ctx);
		controller.messageUpdate(textDelta("a".repeat(800)), ctx);
		clock.advance(5);
		controller.messageUpdate(textDelta("a".repeat(800)), ctx);
		expect(statuses).toHaveLength(1);

		controller.messageEnd({ role: "assistant", usage: { output: 400 }, stopReason: "stop" }, ctx);
		expect(statuses.at(-1)?.[1]).toBe("<dim>-- tok/s</dim>");
	});

	test("uses provider-reported usage when it is ahead of the estimate", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 8, 50, 2);
		clock.advance(650);
		controller.messageUpdate(
			{ type: "text_delta", delta: "hi", partial: { role: "assistant", usage: { output: 60 } } },
			ctx,
		);
		expect(statuses.at(-1)?.[1]).toBe("60.0<dim> tok/s</dim>");
	});

	test("keeps estimating while a provider repeats a stale initial usage", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });
		// Anthropic streams `output_tokens: 1` from the start and only updates it
		// when the message ends; trusting it would report 1 token per second.
		const stale = { role: "assistant", usage: { output: 1 } };
		const staleDelta = (chars: number) => ({ type: "text_delta", delta: "a".repeat(chars), partial: stale });

		controller.messageStart({ role: "assistant" }, ctx);
		for (let index = 0; index < 9; index++) {
			if (index > 0) clock.advance(250);
			controller.messageUpdate(staleDelta(40), ctx);
		}
		expect(statuses.at(-1)?.[1]).toBe("45.0<dim> tok/s</dim>");

		clock.advance(1_000);
		controller.messageUpdate(staleDelta(40), ctx);
		expect(statuses.at(-1)?.[1]).toBe("33.3<dim> tok/s</dim>");
	});

	test("freezes the confirmed rate over the generation span at message end", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 10, 100, 4);
		controller.messageEnd({ role: "assistant", usage: { output: 300 }, stopReason: "stop" }, ctx);

		expect(statuses.at(-1)?.[1]).toBe("333<dim> tok/s</dim>");
	});

	test("shows the missing marker for one-chunk and short bursts", () => {
		// A single chunk after a long wait has no observable generation window.
		const chunkedClock = createClock();
		const chunkedUi = createFakeUi();
		const chunked = createTokRateController({ now: chunkedClock.now });
		chunked.messageStart({ role: "assistant" }, chunkedUi.ctx);
		chunkedClock.advance(2_000);
		chunked.messageUpdate(textDelta("fixture OK"), chunkedUi.ctx);
		chunkedClock.advance(10);
		chunked.messageEnd({ role: "assistant", usage: { output: 10 }, stopReason: "stop" }, chunkedUi.ctx);
		expect(chunkedUi.statuses.at(-1)?.[1]).toBe("<dim>-- tok/s</dim>");
		chunked.agentSettled(chunkedUi.ctx);
		expect(chunkedUi.statuses.at(-1)).toEqual([STATUS_KEY, undefined]);

		// Three flushes a millisecond apart: 11 tokens in 2ms is 5500 tok/s.
		const burstClock = createClock();
		const burstUi = createFakeUi();
		const burst = createTokRateController({ now: burstClock.now });
		burst.messageStart({ role: "assistant" }, burstUi.ctx);
		burst.messageUpdate(textDelta("a".repeat(12)), burstUi.ctx);
		burstClock.advance(1);
		burst.messageUpdate(textDelta("a".repeat(28)), burstUi.ctx);
		burstClock.advance(1);
		burst.messageUpdate(textDelta("a".repeat(4)), burstUi.ctx);
		burst.messageEnd({ role: "assistant", usage: { output: 11 }, stopReason: "stop" }, burstUi.ctx);
		expect(burstUi.statuses.at(-1)?.[1]).toBe("<dim>-- tok/s</dim>");
	});

	test("keeps bursty responses out of the instruction average", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		// 90 tokens over 900ms.
		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 10, 100);
		controller.messageEnd({ role: "assistant", usage: { output: 90 }, stopReason: "stop" }, ctx);
		expect(statuses.at(-1)?.[1]).toBe("100<dim> tok/s</dim>");

		// 500 tokens delivered in two flushes must not drag the average down.
		controller.messageStart({ role: "assistant" }, ctx);
		clock.advance(3_000);
		controller.messageUpdate(textDelta("a".repeat(800)), ctx);
		clock.advance(1);
		controller.messageUpdate(textDelta("a".repeat(800)), ctx);
		controller.messageEnd({ role: "assistant", usage: { output: 500 }, stopReason: "stop" }, ctx);
		expect(statuses.at(-1)?.[1]).toBe("<dim>-- tok/s</dim>");

		controller.agentSettled(ctx);
		expect(statuses.at(-1)?.[1]).toBe("<dim>avg</dim> 100<dim> tok/s</dim>");
	});

	test("drops the value for failed, aborted, or empty responses", () => {
		for (const stopReason of ["error", "aborted"]) {
			const clock = createClock();
			const { ctx, statuses } = createFakeUi();
			const controller = createTokRateController({ now: clock.now });

			controller.messageStart({ role: "assistant" }, ctx);
			controller.messageUpdate(textDelta("partial"), ctx);
			clock.advance(1_000);
			controller.messageEnd({ role: "assistant", usage: { output: 40 }, stopReason }, ctx);
			expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
		}

		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });
		controller.messageStart({ role: "assistant" }, ctx);
		controller.messageEnd({ role: "assistant", usage: { output: 0 }, stopReason: "stop" }, ctx);
		expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
	});

	test("switches to the instruction average when the run settles", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		// Message 1: 90 tokens over 900ms.
		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 10, 100);
		controller.messageEnd({ role: "assistant", usage: { output: 90 }, stopReason: "stop" }, ctx);
		expect(statuses.at(-1)?.[1]).toBe("100<dim> tok/s</dim>");

		// Message 2: 45 tokens over 900ms (50 tok/s for this message).
		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 10, 100);
		controller.messageEnd({ role: "assistant", usage: { output: 45 }, stopReason: "stop" }, ctx);
		expect(statuses.at(-1)?.[1]).toBe("50.0<dim> tok/s</dim>");

		// (90 + 45) tokens / (900ms + 900ms) = 75 tok/s.
		controller.agentSettled(ctx);
		expect(statuses.at(-1)?.[1]).toBe("<dim>avg</dim> 75.0<dim> tok/s</dim>");
	});

	test("uses the message rate as the average for a single-message run", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 10, 100);
		controller.messageEnd({ role: "assistant", usage: { output: 90 }, stopReason: "stop" }, ctx);
		controller.agentSettled(ctx);

		expect(statuses.at(-1)?.[1]).toBe("<dim>avg</dim> 100<dim> tok/s</dim>");
	});

	test("excludes failed messages and clears when nothing succeeded", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 10, 100);
		controller.messageEnd({ role: "assistant", usage: { output: 90 }, stopReason: "stop" }, ctx);

		// A failed retry after the success must not enter the average.
		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 10, 100);
		controller.messageEnd({ role: "assistant", usage: { output: 500 }, stopReason: "error" }, ctx);
		controller.agentSettled(ctx);
		expect(statuses.at(-1)?.[1]).toBe("<dim>avg</dim> 100<dim> tok/s</dim>");

		// A new instruction with no successful message clears the old average.
		controller.reset(ctx);
		controller.messageStart({ role: "assistant" }, ctx);
		controller.messageEnd({ role: "assistant", usage: { output: 0 }, stopReason: "stop" }, ctx);
		controller.agentSettled(ctx);
		expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
	});

	test("subtracts reasoning tokens that were not streamed", () => {
		// 120 output tokens include 20 reasoning tokens the clock never saw.
		const hiddenClock = createClock();
		const hiddenUi = createFakeUi();
		const hidden = createTokRateController({ now: hiddenClock.now });
		hidden.messageStart({ role: "assistant" }, hiddenUi.ctx);
		emitDeltas(hidden, hiddenUi.ctx, hiddenClock, 12, 100, 100);
		hidden.messageEnd(
			{ role: "assistant", usage: { output: 120, reasoning: 20 }, stopReason: "stop" },
			hiddenUi.ctx,
		);
		expect(hiddenUi.statuses.at(-1)?.[1]).toBe("90.9<dim> tok/s</dim>");

		// Streamed thinking starts the clock, so all 120 tokens are timed.
		const streamedClock = createClock();
		const streamedUi = createFakeUi();
		const streamed = createTokRateController({ now: streamedClock.now });
		streamed.messageStart({ role: "assistant" }, streamedUi.ctx);
		streamed.messageUpdate(
			{ type: "thinking_delta", delta: "a".repeat(100), partial: { role: "assistant", usage: { output: 0 } } },
			streamedUi.ctx,
		);
		emitDeltas(streamed, streamedUi.ctx, streamedClock, 12, 100, 100);
		streamed.messageEnd(
			{ role: "assistant", usage: { output: 120, reasoning: 20 }, stopReason: "stop" },
			streamedUi.ctx,
		);
		expect(streamedUi.statuses.at(-1)?.[1]).toBe("109<dim> tok/s</dim>");
	});

	test("averages only responses with confirmed usage", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		// Confirmed: 90 tokens over 900ms.
		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 10, 100);
		controller.messageEnd({ role: "assistant", usage: { output: 90 }, stopReason: "stop" }, ctx);

		// No confirmed usage: the display still shows the estimate, but the
		// instruction average must keep using only confirmed usage.
		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 10, 100);
		controller.messageEnd({ role: "assistant", usage: { output: 0 }, stopReason: "stop" }, ctx);
		expect(statuses.at(-1)?.[1]).toBe("111<dim> tok/s</dim>");

		controller.agentSettled(ctx);
		expect(statuses.at(-1)?.[1]).toBe("<dim>avg</dim> 100<dim> tok/s</dim>");

		// Nothing confirmed at all: no average to show.
		controller.reset(ctx);
		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 10, 100);
		controller.messageEnd({ role: "assistant", stopReason: "stop" }, ctx);
		controller.agentSettled(ctx);
		expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
	});

	test("hides the average when every message failed", () => {
		for (const stopReason of ["error", "aborted"]) {
			const clock = createClock();
			const { ctx, statuses } = createFakeUi();
			const controller = createTokRateController({ now: clock.now });

			controller.messageStart({ role: "assistant" }, ctx);
			emitDeltas(controller, ctx, clock, 10, 100);
			controller.messageEnd({ role: "assistant", usage: { output: 90 }, stopReason }, ctx);
			controller.agentSettled(ctx);
			expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
		}
	});

	test("resets on a new instruction and survives a user or tool-result message", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		emitDeltas(controller, ctx, clock, 9, 50);
		expect(statuses.at(-1)?.[1]).toContain("tok/s");

		// A user or tool-result message must not clear the last assistant rate.
		const shown = statuses.at(-1)?.[1];
		controller.messageStart({ role: "user" }, ctx);
		expect(statuses.at(-1)?.[1]).toBe(shown);
		controller.messageEnd({ role: "user" } as never, ctx);
		expect(statuses.at(-1)?.[1]).toBe(shown);

		controller.reset(ctx);
		expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);

		controller.sessionShutdown(ctx);
		expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);
	});

	test("does nothing without a UI", () => {
		const clock = createClock();
		const { statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });
		const headless: TokRateContext = {
			hasUI: false,
			ui: { theme, setStatus: () => { throw new Error("headless UI access"); } },
		};

		controller.messageStart({ role: "assistant" }, headless);
		controller.messageUpdate(textDelta("hello"), headless);
		clock.advance(1_000);
		controller.messageEnd({ role: "assistant", usage: { output: 10 } }, headless);
		controller.sessionShutdown(headless);
		expect(statuses).toEqual([]);
	});

	test("registers the message lifecycle handlers", () => {
		const events: string[] = [];
		const pi = {
			on(event: string) {
				events.push(event);
			},
			registerCommand() {},
			registerTool() {},
		};
		tokRateExtension(pi as never);
		expect(events).toEqual([
			"before_agent_start",
			"message_start",
			"message_update",
			"message_end",
			"agent_settled",
			"session_shutdown",
		]);
	});

	test("documents the default gates", () => {
		expect(DEFAULT_MIN_SPAN_MS).toBe(400);
		expect(DEFAULT_MIN_ARRIVALS).toBe(8);
		expect(DEFAULT_THROTTLE_MS).toBe(250);
	});
});
