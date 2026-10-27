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
 * Wall-clock time between deltas is only a proxy for generation time.  Pi
 * emits `message_start` after the response headers, gateways coalesce
 * chunks, and a short reply often arrives as one or two flushes a few
 * milliseconds apart.  Dividing its tokens by that window produces rates in
 * the thousands.  A response is therefore only rated when the stream lasted
 * at least `minSpanMs` and produced at least `minArrivals` distinct arrival
 * instants; otherwise the footer shows `-- tok/s` and the message is left out
 * of the average.
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
 * The clock and the throttle are injectable so the state machine can be driven
 * without a terminal or real timers.
 */

export const STATUS_KEY = "tok";

/** Rendering on every delta would repaint the footer per token. */
export const DEFAULT_THROTTLE_MS = 250;

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

/** The parts of Pi's `AssistantMessageEvent` the controller reads. */
export interface AssistantDeltaLike {
	type: string;
	delta?: string;
	partial?: AssistantMessageLike;
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
function visibleOutput(usage: AssistantUsageLike | undefined, reasoningStreamed: boolean): number | undefined {
	const output = outputTokens(usage);
	if (output === undefined) return undefined;
	if (reasoningStreamed) return output;
	return Math.max(0, output - reasoningTokens(usage));
}

/**
 * One assistant message in flight.
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
	const minSpanMs = options.minSpanMs ?? DEFAULT_MIN_SPAN_MS;
	const minArrivals = options.minArrivals ?? DEFAULT_MIN_ARRIVALS;

	let active = false;
	let firstDeltaAt: number | undefined;
	let lastDeltaAt: number | undefined;
	let arrivalSlots = 0;
	let thinkingDeltas = 0;
	let streamedTokens = 0;
	let reportedOutput: number | undefined;
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
		active = false;
		firstDeltaAt = undefined;
		lastDeltaAt = undefined;
		arrivalSlots = 0;
		thinkingDeltas = 0;
		streamedTokens = 0;
		reportedOutput = undefined;
		lastShownAt = undefined;
	};

	const begin = () => {
		forgetMessage();
		active = true;
	};

	const show = (tokens: number, spanMs: number, ctx: TokRateContext) => {
		if (tokens <= 0 || spanMs <= 0) return;
		ctx.ui.setStatus(STATUS_KEY, formatThemedTokRateStatus((tokens * 1000) / spanMs, ctx.ui.theme));
	};

	/** Both the live update and the final value need a window worth dividing by. */
	const measurable = (spanMs: number) => spanMs >= minSpanMs && arrivalSlots >= minArrivals;

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
			begin();
			clear(ctx);
		},

		messageUpdate(event, ctx) {
			if (!ctx.hasUI) return;
			if (event.partial?.role !== undefined && event.partial.role !== "assistant") return;
			if (!active) begin();

			const at = now();
			const delta = deltaText(event);
			if (delta !== undefined && delta.length > 0) {
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
			if (firstDeltaAt === undefined) return;

			const spanMs = at - firstDeltaAt;
			if (!measurable(spanMs)) return;
			if (lastShownAt !== undefined && at - lastShownAt < throttleMs) return;

			lastShownAt = at;
			// Some providers (Anthropic is one) report a fixed `output_tokens`
			// from the first chunk and only replace it at the end.  A smaller
			// reported value is that stale snapshot, not the current total, so
			// keep the running estimate ahead of it until `message_end`.
			show(Math.max(reportedOutput ?? 0, streamedTokens), spanMs, ctx);
		},

		messageEnd(message, ctx) {
			if (!ctx.hasUI || message.role !== "assistant" || !active) return;

			const finishedAt = now();
			const confirmedTokens = visibleOutput(message.usage, thinkingDeltas > 0);
			const tokens = confirmedTokens ?? reportedOutput ?? streamedTokens;
			const generationSpan = firstDeltaAt !== undefined ? finishedAt - firstDeltaAt : undefined;
			// Read the window before the per-message state is cleared.
			const timed = generationSpan !== undefined && measurable(generationSpan);

			forgetMessage();

			// A failed or aborted message has no meaningful rate; leaving the
			// previous one on screen would describe the wrong response.
			if (message.stopReason === "error" || message.stopReason === "aborted" || tokens <= 0) {
				clear(ctx);
				return;
			}

			// A one-chunk reply, or a burst that shares a few milliseconds, has
			// no generation window; any rate from it would be delivery noise.
			if (!timed || generationSpan === undefined) {
				ctx.ui.setStatus(STATUS_KEY, formatThemedMissingTokRateStatus(ctx.ui.theme));
				return;
			}

			// `usage.output` is the confirmed token count.  The partial and
			// character-estimate fallbacks are only for the live/one-message
			// display; averaging them would mix estimates into a usage total.
			if (confirmedTokens !== undefined) {
				runOutputTokens += confirmedTokens;
				runGenerationMs += generationSpan;
				runMessages += 1;
			}
			show(tokens, generationSpan, ctx);
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
