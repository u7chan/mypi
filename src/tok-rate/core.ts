/**
 * Tokens-per-second footer status for Pi.
 *
 * Pi's built-in footer shows cumulative token counts but never the generation
 * speed.  This feature tracks one assistant message at a time: while deltas
 * stream it shows the rate of the output produced so far, and at
 * `message_end` it replaces that with the provider-reported `usage.output`
 * over the same span.  Once the instruction settles it switches to
 * `avg N tok/s`: successful messages' combined output divided by their
 * combined generation time, so tool waits and other idle time are excluded.
 *
 * Wall-clock time between deltas is only a proxy for generation time, and a
 * short or coalesced reply has no measurable window.  A response is therefore
 * only rated when the stream lasted at least `minSpanMs` and produced at least
 * `minArrivals` distinct arrival instants; otherwise the footer shows
 * `-- tok/s` and the message is left out of the average.
 *
 * The measurement itself - the character estimate, the provider usage
 * handling and the gates - lives in `sampler.ts`, shared with `live-thinking`,
 * so the footer and the activity sidecar always report the same live rate.
 *
 * The clock and the throttle are injectable so the state machine can be driven
 * without a terminal or real timers.
 */

import {
	createMessageSampler,
	type AssistantDeltaLike,
	type AssistantMessageLike,
} from "./sampler.ts";

// Keep the historical module surface: readers and tests import these here.
export { DEFAULT_MIN_ARRIVALS, DEFAULT_MIN_SPAN_MS, estimateTokens } from "./sampler.ts";
export type { AssistantDeltaLike, AssistantMessageLike, AssistantUsageLike } from "./sampler.ts";

export const STATUS_KEY = "tok";

/** Rendering on every delta would repaint the footer per token. */
export const DEFAULT_THROTTLE_MS = 250;

/** `158`, `42.3`: whole numbers once the rate is high enough to not need decimals. */
export function formatTokPerSecond(tokensPerSecond: number): string {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "0";
	return tokensPerSecond >= 100 ? String(Math.round(tokensPerSecond)) : tokensPerSecond.toFixed(1);
}

export interface TokRateTheme {
	fg(color: "dim", text: string): string;
}

/** The footer status: the rate in normal text, its unit dimmed. */
export function formatThemedTokRateStatus(tokensPerSecond: number, theme: TokRateTheme): string {
	return `${formatTokPerSecond(tokensPerSecond)}${theme.fg("dim", " tok/s")}`;
}

/** The settled average: `avg 92 tok/s` with the label and unit dimmed. */
export function formatThemedAverageTokRateStatus(tokensPerSecond: number, theme: TokRateTheme): string {
	return `${theme.fg("dim", "avg")} ${formatTokPerSecond(tokensPerSecond)}${theme.fg("dim", " tok/s")}`;
}

/** No trustworthy rate: the response was too short or too bursty to time. */
export function formatThemedMissingTokRateStatus(theme: TokRateTheme): string {
	return theme.fg("dim", "-- tok/s");
}

export interface TokRateUi {
	theme: TokRateTheme;
	setStatus(key: string, text: string | undefined): void;
}

/** The slice of the Pi extension context this controller uses. */
export interface TokRateContext {
	hasUI: boolean;
	ui: TokRateUi;
}

export interface TokRateControllerOptions {
	now?: () => number;
	throttleMs?: number;
	minSpanMs?: number;
	minArrivals?: number;
}

export interface TokRateController {
	/** Clear the previous value when a new instruction starts. */
	reset(ctx: TokRateContext): void;
	/** Open the measurement for a new assistant message. */
	messageStart(message: AssistantMessageLike, ctx: TokRateContext): void;
	/** Consume one streaming event of the current assistant message. */
	messageUpdate(event: AssistantDeltaLike, ctx: TokRateContext): void;
	/** Freeze the confirmed value for a finished assistant message. */
	messageEnd(message: AssistantMessageLike, ctx: TokRateContext): void;
	/** Replace the last message's rate with the instruction average. */
	agentSettled(ctx: TokRateContext): void;
	/** Drop the value when the session goes away. */
	sessionShutdown(ctx: TokRateContext): void;
}

/**
 * One assistant message in flight, published in the footer.
 *
 * `messageStart` opens the measurement (Pi emits it for the provider's `start`
 * event, not as a `message_update`), deltas accumulate the live estimate, and
 * `messageEnd` closes it.  A missing start - a mid-stream reload, or a test
 * driving single events - opens the measurement on the first delta.
 *
 * A stream is only measurable when it lasted long enough and produced enough
 * distinct arrival instants: a message that ends with one or two flushes, or
 * whose deltas share a millisecond, has no observable generation window.  Such
 * a message is reported as `--` instead of dividing by that noise, and it does
 * not enter the instruction average.
 */
export function createTokRateController(options: TokRateControllerOptions = {}): TokRateController {
	const now = options.now ?? (() => Date.now());
	const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
	const sampler = createMessageSampler({
		minSpanMs: options.minSpanMs,
		minArrivals: options.minArrivals,
	});

	let lastShownAt: number | undefined;

	// Per-instruction totals for the settled average.  Only successful,
	// measurable messages with a confirmed `usage.output` are counted.
	let runOutputTokens = 0;
	let runGenerationMs = 0;
	let runMessages = 0;

	const clear = (ctx: TokRateContext) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const forgetMessage = () => {
		sampler.reset();
		lastShownAt = undefined;
	};

	const show = (tokens: number, spanMs: number, ctx: TokRateContext) => {
		if (tokens <= 0 || spanMs <= 0) return;
		ctx.ui.setStatus(STATUS_KEY, formatThemedTokRateStatus((tokens * 1000) / spanMs, ctx.ui.theme));
	};

	return {
		reset(ctx) {
			forgetMessage();
			runOutputTokens = 0;
			runGenerationMs = 0;
			runMessages = 0;
			clear(ctx);
		},

		messageStart(message, ctx) {
			if (!ctx.hasUI || message.role !== "assistant") return;
			sampler.begin();
			lastShownAt = undefined;
			clear(ctx);
		},

		messageUpdate(event, ctx) {
			if (!ctx.hasUI) return;
			if (event.partial?.role !== undefined && event.partial.role !== "assistant") return;

			const at = now();
			const sample = sampler.sample(event, at);
			if (sample.spanMs === undefined || !sample.measurable) return;
			if (lastShownAt !== undefined && at - lastShownAt < throttleMs) return;

			lastShownAt = at;
			show(sample.tokens, sample.spanMs, ctx);
		},

		messageEnd(message, ctx) {
			if (!ctx.hasUI || message.role !== "assistant") return;

			const finishedAt = now();
			const sample = sampler.finish(message, finishedAt);
			if (sample === null) return;
			forgetMessage();

			const { tokens, confirmedTokens, spanMs, measurable } = sample;

			// A failed or aborted message has no meaningful rate; leaving the
			// previous one on screen would describe the wrong response.
			if (message.stopReason === "error" || message.stopReason === "aborted" || tokens <= 0) {
				clear(ctx);
				return;
			}

			// A one-chunk reply, or a burst that shares a few milliseconds, has
			// no generation window; any rate from it would be delivery noise.
			if (!measurable || spanMs === undefined) {
				ctx.ui.setStatus(STATUS_KEY, formatThemedMissingTokRateStatus(ctx.ui.theme));
				return;
			}

			// `usage.output` is the confirmed token count.  The partial and
			// character-estimate fallbacks are only for the live/one-message
			// display; averaging them would mix estimates into a usage total.
			if (confirmedTokens !== undefined) {
				runOutputTokens += confirmedTokens;
				runGenerationMs += spanMs;
				runMessages += 1;
			}
			show(tokens, spanMs, ctx);
		},

		agentSettled(ctx) {
			if (!ctx.hasUI) return;

			forgetMessage();
			if (runMessages === 0 || runGenerationMs <= 0) {
				clear(ctx);
				return;
			}
			ctx.ui.setStatus(
				STATUS_KEY,
				formatThemedAverageTokRateStatus((runOutputTokens * 1000) / runGenerationMs, ctx.ui.theme),
			);
		},

		sessionShutdown(ctx) {
			forgetMessage();
			runOutputTokens = 0;
			runGenerationMs = 0;
			runMessages = 0;
			clear(ctx);
		},
	};
}
