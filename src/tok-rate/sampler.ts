/**
 * Live sampling of one assistant message's generation speed.
 *
 * Two features need the same number: the TUI footer (`tok-rate`) and the
 * activity sidecar (`live-thinking`).  They must agree, so the measurement
 * lives here and both only decide how to publish it.
 *
 * Wall-clock time between deltas is only a proxy for generation time.  Pi
 * emits `message_start` after the response headers, gateways coalesce chunks,
 * and a short reply often arrives as one or two flushes a few milliseconds
 * apart.  Dividing its tokens by that window produces rates in the thousands.
 * A response is therefore only rated when the stream lasted at least
 * `minSpanMs` and produced at least `minArrivals` distinct arrival instants.
 *
 * Live numbers are estimates.  Most providers report usage only on the final
 * chunk, so the running rate divides a character-based token estimate by the
 * time since the first delta.  ASCII counts as a quarter token, everything
 * else (CJK, emoji) as one, which keeps Japanese output from reading several
 * times faster than it is.  As soon as `partial.usage.output` appears it wins.
 * Providers that report reasoning tokens without streaming them would put
 * tokens into the numerator whose generation never reached the clock, so
 * `usage.reasoning` is subtracted when no `thinking_delta` was seen.
 *
 * The sampler has no clock and no throttle: every entry point takes the
 * arrival instant, so a test can drive it directly and each publisher keeps
 * its own write cadence.
 */

/** Too-short spans divide by noise; wait for a measurable window. */
export const DEFAULT_MIN_SPAN_MS = 400;

/**
 * Bursts that arrive within the same millisecond are one delivery event, not
 * independent samples.  A rate needs enough of them to be more than jitter.
 */
export const DEFAULT_MIN_ARRIVALS = 8;

/**
 * Rough output-token estimate for a streamed delta.
 *
 * ASCII text averages about four characters per token; CJK and emoji are
 * usually one token per character (or more), so they count as a full token.
 */
export function estimateTokens(text: string): number {
	let tokens = 0;
	for (const char of text) {
		const codePoint = char.codePointAt(0) ?? 0;
		tokens += codePoint > 0x7f ? 1 : 0.25;
	}
	return tokens;
}

export interface AssistantUsageLike {
	output?: number;
	/** Subset of `output`; reported only by providers that break it out. */
	reasoning?: number;
}

export interface AssistantMessageLike {
	role?: string;
	usage?: AssistantUsageLike;
	stopReason?: string;
}

/** The parts of Pi's `AssistantMessageEvent` the sampler reads. */
export interface AssistantDeltaLike {
	type: string;
	delta?: string;
	partial?: AssistantMessageLike;
}

export interface MessageSamplerOptions {
	minSpanMs?: number;
	minArrivals?: number;
}

export type MessageSample = {
	/** The event carried a delta, so its instant is a timing point. */
	delta: boolean;
	/** Output tokens known at this instant: the larger of usage and the estimate. */
	tokens: number;
	/** Milliseconds from the first delta; undefined before any delta arrived. */
	spanMs?: number;
	/** The window is long and sampled enough to divide by. */
	measurable: boolean;
	/** `tokens / span` when measurable, otherwise null. */
	tokPerSecond: number | null;
};

export type FinishedMessageSample = {
	/** Token count of the finished message. */
	tokens: number;
	/** Provider-confirmed output, when the message reported it. */
	confirmedTokens?: number;
	spanMs?: number;
	measurable: boolean;
};

export interface MessageSampler {
	/** Forget the current message. */
	reset(): void;
	/** Open the measurement for a new assistant message. */
	begin(): void;
	/** Consume one streaming event at the given arrival instant. */
	sample(event: AssistantDeltaLike, at: number): MessageSample;
	/** Close the measurement. Returns null when no message was open. */
	finish(message: AssistantMessageLike, at: number): FinishedMessageSample | null;
	/** Whether the provider streamed reasoning in this message. */
	reasoningStreamed(): boolean;
}

function deltaText(event: AssistantDeltaLike): string | undefined {
	if (event.type !== "text_delta" && event.type !== "thinking_delta" && event.type !== "toolcall_delta") {
		return undefined;
	}
	return event.delta;
}

function outputTokens(usage: AssistantUsageLike | undefined): number | undefined {
	const output = usage?.output;
	if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) return undefined;
	return output;
}

function reasoningTokens(usage: AssistantUsageLike | undefined): number {
	const reasoning = usage?.reasoning;
	if (typeof reasoning !== "number" || !Number.isFinite(reasoning) || reasoning <= 0) return 0;
	return reasoning;
}

/**
 * Output tokens the stream actually carried.
 *
 * `usage.output` includes reasoning.  When the provider streams thinking the
 * first `thinking_delta` opens the window, so those tokens are timed.  When it
 * only reports them, the clock starts at the first visible delta and the
 * reasoning tokens must come out of the numerator.
 */
function visibleOutput(
	usage: AssistantUsageLike | undefined,
	reasoningStreamed: boolean,
): number | undefined {
	const output = outputTokens(usage);
	if (output === undefined) return undefined;
	if (reasoningStreamed) return output;
	return Math.max(0, output - reasoningTokens(usage));
}

/**
 * One assistant message in flight.
 *
 * `begin` opens the measurement (Pi emits `message_start` before the provider
 * stream), deltas accumulate the live estimate, and `finish` closes it.  A
 * missing `begin` - a mid-stream reload, or a test driving single events -
 * opens the measurement on the first sample.
 *
 * A stream is only measurable when it lasted long enough and produced enough
 * distinct arrival instants: a message that ends with one or two flushes, or
 * whose deltas share a millisecond, has no observable generation window.
 */
export function createMessageSampler(options: MessageSamplerOptions = {}): MessageSampler {
	const minSpanMs = options.minSpanMs ?? DEFAULT_MIN_SPAN_MS;
	const minArrivals = options.minArrivals ?? DEFAULT_MIN_ARRIVALS;

	let active = false;
	let firstDeltaAt: number | undefined;
	let lastDeltaAt: number | undefined;
	let arrivalSlots = 0;
	let thinkingDeltas = 0;
	let streamedTokens = 0;
	let reportedOutput: number | undefined;

	const reset = () => {
		active = false;
		firstDeltaAt = undefined;
		lastDeltaAt = undefined;
		arrivalSlots = 0;
		thinkingDeltas = 0;
		streamedTokens = 0;
		reportedOutput = undefined;
	};

	const begin = () => {
		reset();
		active = true;
	};

	/** Both the live value and the final value need a window worth dividing by. */
	const measurable = (spanMs: number) => spanMs >= minSpanMs && arrivalSlots >= minArrivals;

	return {
		reset,
		begin,
		reasoningStreamed: () => thinkingDeltas > 0,
		sample(event, at) {
			if (!active) begin();

			const delta = deltaText(event);
			const carried = delta !== undefined && delta.length > 0;
			if (carried) {
				firstDeltaAt ??= at;
				if (event.type === "thinking_delta") thinkingDeltas += 1;
				if (at !== lastDeltaAt) {
					arrivalSlots += 1;
					lastDeltaAt = at;
				}
				streamedTokens += estimateTokens(delta);
			}

			const reported = visibleOutput(event.partial?.usage, thinkingDeltas > 0);
			if (reported !== undefined && reported > (reportedOutput ?? 0)) reportedOutput = reported;

			// Some providers (Anthropic is one) report a fixed `output_tokens`
			// from the first chunk and only replace it at the end.  A smaller
			// reported value is that stale snapshot, not the current total, so
			// keep the running estimate ahead of it until the message ends.
			const tokens = Math.max(reportedOutput ?? 0, streamedTokens);
			const spanMs = firstDeltaAt === undefined ? undefined : at - firstDeltaAt;
			const timed = spanMs !== undefined && measurable(spanMs);
			const tokPerSecond =
				timed && tokens > 0 && spanMs !== undefined && spanMs > 0 ? (tokens * 1000) / spanMs : null;
			return { delta: carried, tokens, spanMs, measurable: timed, tokPerSecond };
		},
		finish(message, at) {
			if (!active) return null;
			const confirmedTokens = visibleOutput(message.usage, thinkingDeltas > 0);
			const tokens = confirmedTokens ?? reportedOutput ?? streamedTokens;
			const spanMs = firstDeltaAt === undefined ? undefined : at - firstDeltaAt;
			return {
				tokens,
				confirmedTokens,
				spanMs,
				measurable: spanMs !== undefined && measurable(spanMs),
			};
		},
	};
}
