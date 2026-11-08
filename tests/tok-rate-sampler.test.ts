import { describe, expect, test } from "bun:test";
import {
	createMessageSampler,
	DEFAULT_MIN_ARRIVALS,
	DEFAULT_MIN_SPAN_MS,
	type AssistantDeltaLike,
	type MessageSampler,
} from "../src/tok-rate/sampler.ts";

const textDelta = (delta: string, usage: { output?: number; reasoning?: number } = {}): AssistantDeltaLike => ({
	type: "text_delta",
	delta,
	partial: { role: "assistant", usage },
});

/** Emit `count` four-character deltas `gapMs` apart, returning the last sample. */
function emit(sampler: MessageSampler, count: number, gapMs: number, startAt = 0) {
	let sample = sampler.sample(textDelta("aaaa"), startAt);
	for (let index = 1; index < count; index++) {
		sample = sampler.sample(textDelta("aaaa"), startAt + index * gapMs);
	}
	return { sample, at: startAt + (count - 1) * gapMs };
}

describe("message sampler", () => {
	test("documents the shared gates", () => {
		expect(DEFAULT_MIN_SPAN_MS).toBe(400);
		expect(DEFAULT_MIN_ARRIVALS).toBe(8);
	});

	test("holds the rate until the window is both long and sampled enough", () => {
		const sampler = createMessageSampler();
		sampler.begin();

		// Eight arrivals over 350ms: enough samples, too short a window.
		const short = emit(sampler, 8, 50);
		expect(short.at).toBe(350);
		expect(short.sample).toMatchObject({ delta: true, tokens: 8, spanMs: 350, measurable: false });
		expect(short.sample.tokPerSecond).toBeNull();

		// The ninth arrival at 400ms passes both gates.
		const timed = sampler.sample(textDelta("aaaa"), 400);
		expect(timed).toMatchObject({ delta: true, tokens: 9, spanMs: 400, measurable: true });
		expect(timed.tokPerSecond).toBe(22.5);
	});

	test("counts a burst that shares a millisecond as one arrival", () => {
		const sampler = createMessageSampler();
		sampler.begin();
		for (let index = 0; index < 12; index++) sampler.sample(textDelta("aaaa"), 0);

		const sample = sampler.sample(textDelta("aaaa"), 400);
		expect(sample).toMatchObject({ tokens: 13, spanMs: 400, measurable: false });
		expect(sample.tokPerSecond).toBeNull();
	});

	test("uses the provider usage when it is ahead and ignores a stale one", () => {
		const sampler = createMessageSampler();
		sampler.begin();
		// Anthropic reports `output_tokens: 1` from the first chunk.
		let sample = sampler.sample(textDelta("aaaa", { output: 1 }), 0);
		for (let index = 1; index < 9; index++) sample = sampler.sample(textDelta("aaaa", { output: 1 }), index * 50);
		expect(sample.tokens).toBe(9);

		// A reported total ahead of the estimate wins at this instant.
		sample = sampler.sample(textDelta("aaaa", { output: 60 }), 450);
		expect(sample).toMatchObject({ tokens: 60, spanMs: 450 });
		expect(sample.tokPerSecond).toBeCloseTo(133.333, 3);

		// The next chunk repeats the stale snapshot; the estimate must not fall.
		sample = sampler.sample(textDelta("aaaa", { output: 1 }), 500);
		expect(sample).toMatchObject({ tokens: 60, spanMs: 500 });
	});

	test("subtracts reasoning tokens that never reached the clock", () => {
		const hidden = createMessageSampler();
		hidden.begin();
		for (let index = 0; index < 10; index++) hidden.sample(textDelta("a".repeat(40)), index * 100);
		expect(
			hidden.finish({ role: "assistant", usage: { output: 120, reasoning: 20 }, stopReason: "stop" }, 900),
		).toMatchObject({ tokens: 100, confirmedTokens: 100, spanMs: 900, measurable: true });

		// Streamed thinking opens the window, so the whole output was timed.
		const streamed = createMessageSampler();
		streamed.begin();
		for (let index = 0; index < 10; index++) {
			streamed.sample({ type: "thinking_delta", delta: "a".repeat(40) }, index * 100);
		}
		expect(streamed.reasoningStreamed()).toBe(true);
		expect(
			streamed.finish({ role: "assistant", usage: { output: 120, reasoning: 20 }, stopReason: "stop" }, 900),
		).toMatchObject({ tokens: 120, confirmedTokens: 120 });
	});

	test("opens on the first sample, reports non-delta instants, and forgets on reset", () => {
		const sampler = createMessageSampler();
		expect(sampler.finish({ role: "assistant" }, 0)).toBeNull();

		// A mid-stream reload has no `message_start`; the first delta opens it.
		sampler.sample(textDelta("aaaa"), 0);
		// `text_end` is not a timing point, but it is an arrival instant.
		const end = sampler.sample({ type: "text_end", partial: { role: "assistant" } }, 500);
		expect(end).toMatchObject({ delta: false, tokens: 1, spanMs: 500, measurable: false });

		sampler.reset();
		expect(sampler.finish({ role: "assistant" }, 500)).toBeNull();
	});

	test("accepts the gate overrides the publisher injects", () => {
		const sampler = createMessageSampler({ minSpanMs: 1_000, minArrivals: 2 });
		sampler.begin();
		const sample = emit(sampler, 9, 100).sample;
		expect(sample).toMatchObject({ spanMs: 800, measurable: false });
		expect(sampler.sample(textDelta("aaaa"), 1_000)).toMatchObject({ spanMs: 1_000, measurable: true });
	});
});
