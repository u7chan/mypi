import { describe, expect, test } from "bun:test";
import tokRateExtension, {
	createTokRateController,
	DEFAULT_MIN_SPAN_MS,
	DEFAULT_THROTTLE_MS,
	estimateTokens,
	formatThemedAverageTokRateStatus,
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

const start = { type: "start", partial: { role: "assistant", usage: { output: 0 } } };
const textDelta = (delta: string) => ({
	type: "text_delta",
	delta,
	partial: { role: "assistant", usage: { output: 0 } },
});

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
});

describe("tok-rate controller", () => {
	test("shows a throttled live estimate once the span is measurable", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		expect(statuses).toEqual([[STATUS_KEY, undefined]]);

		// 400 ASCII characters = 100 estimated tokens, all sent at t=0.
		controller.messageUpdate(textDelta("a".repeat(400)), ctx);
		expect(statuses).toHaveLength(1);
		expect(statuses.at(-1)?.[1]).toBeUndefined();

		clock.advance(DEFAULT_MIN_SPAN_MS - 1);
		controller.messageUpdate(textDelta("b"), ctx);
		expect(statuses).toHaveLength(1);

		clock.advance(1);
		controller.messageUpdate(textDelta("c"), ctx);
		expect(statuses.at(-1)?.[1]).toBe("251<dim> tok/s</dim>");

		// Inside the throttle window nothing repaints.
		clock.advance(DEFAULT_THROTTLE_MS - 1);
		controller.messageUpdate(textDelta("d"), ctx);
		expect(statuses).toHaveLength(2);

		clock.advance(1);
		controller.messageUpdate(textDelta("e"), ctx);
		expect(statuses).toHaveLength(3);
	});

	test("uses provider-reported usage when it is ahead of the estimate", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		controller.messageUpdate(textDelta("a".repeat(40)), ctx);
		clock.advance(1_000);
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

		controller.messageStart({ role: "assistant" }, ctx);
		controller.messageUpdate({ type: "text_delta", delta: "a".repeat(200), partial: stale }, ctx);
		clock.advance(1_000);
		controller.messageUpdate({ type: "text_delta", delta: "b".repeat(200), partial: stale }, ctx);
		expect(statuses.at(-1)?.[1]).toBe("100<dim> tok/s</dim>");

		clock.advance(1_000);
		controller.messageUpdate({ type: "text_delta", delta: "c".repeat(200), partial: stale }, ctx);
		expect(statuses.at(-1)?.[1]).toBe("75.0<dim> tok/s</dim>");
	});

	test("freezes the confirmed rate over the generation span at message end", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		clock.advance(500);
		controller.messageUpdate(textDelta("hello"), ctx);
		clock.advance(2_500);
		controller.messageEnd({ role: "assistant", usage: { output: 300 }, stopReason: "stop" }, ctx);

		expect(statuses.at(-1)?.[1]).toBe("120<dim> tok/s</dim>");
	});

	test("falls back to the full span when the provider sends one burst", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		clock.advance(2_000);
		controller.messageUpdate(textDelta("fixture OK"), ctx);
		clock.advance(10);
		controller.messageEnd({ role: "assistant", usage: { output: 10 }, stopReason: "stop" }, ctx);

		expect(statuses.at(-1)?.[1]).toBe("5.0<dim> tok/s</dim>");
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

		// Message 1: 100 tokens over 1s.
		controller.messageStart({ role: "assistant" }, ctx);
		controller.messageUpdate(textDelta("a".repeat(400)), ctx);
		clock.advance(1_000);
		controller.messageEnd({ role: "assistant", usage: { output: 100 }, stopReason: "stop" }, ctx);
		expect(statuses.at(-1)?.[1]).toBe("100<dim> tok/s</dim>");

		// Message 2: 50 tokens over 1.5s (33.3 tok/s for this message).
		controller.messageStart({ role: "assistant" }, ctx);
		controller.messageUpdate(textDelta("b".repeat(200)), ctx);
		clock.advance(1_500);
		controller.messageEnd({ role: "assistant", usage: { output: 50 }, stopReason: "stop" }, ctx);
		expect(statuses.at(-1)?.[1]).toBe("33.3<dim> tok/s</dim>");

		// (100 + 50) tokens / (1s + 1.5s) = 60 tok/s.
		controller.agentSettled(ctx);
		expect(statuses.at(-1)?.[1]).toBe("<dim>avg</dim> 60.0<dim> tok/s</dim>");
	});

	test("uses the message rate as the average for a single-message run", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		controller.messageUpdate(textDelta("a".repeat(400)), ctx);
		clock.advance(1_000);
		controller.messageEnd({ role: "assistant", usage: { output: 100 }, stopReason: "stop" }, ctx);
		controller.agentSettled(ctx);

		expect(statuses.at(-1)?.[1]).toBe("<dim>avg</dim> 100<dim> tok/s</dim>");
	});

	test("excludes failed messages and clears when nothing succeeded", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		controller.messageUpdate(textDelta("a".repeat(400)), ctx);
		clock.advance(1_000);
		controller.messageEnd({ role: "assistant", usage: { output: 100 }, stopReason: "stop" }, ctx);

		// A failed retry after the success must not enter the average.
		controller.messageStart({ role: "assistant" }, ctx);
		controller.messageUpdate(textDelta("b".repeat(200)), ctx);
		clock.advance(1_000);
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

	test("resets on a new instruction and survives a user or tool-result message", () => {
		const clock = createClock();
		const { ctx, statuses } = createFakeUi();
		const controller = createTokRateController({ now: clock.now });

		controller.messageStart({ role: "assistant" }, ctx);
		controller.messageUpdate(textDelta("a".repeat(400)), ctx);
		clock.advance(1_000);
		controller.messageUpdate(textDelta("b"), ctx);
		expect(statuses.at(-1)?.[1]).toContain("tok/s");

		controller.reset(ctx);
		expect(statuses.at(-1)).toEqual([STATUS_KEY, undefined]);

		// A user message must not clear the last assistant rate.
		controller.messageUpdate(textDelta("x"), ctx);
		clock.advance(1_000);
		controller.messageUpdate(textDelta("y"), ctx);
		const shown = statuses.at(-1)?.[1];
		controller.messageStart({ role: "user" }, ctx);
		expect(statuses.at(-1)?.[1]).toBe(shown);

		controller.messageEnd({ role: "user" } as never, ctx);
		expect(statuses.at(-1)?.[1]).toBe(shown);

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
});
