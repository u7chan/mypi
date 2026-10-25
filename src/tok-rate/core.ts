/**
 * Tokens-per-second footer status for Pi.
 *
 * Pi's built-in footer shows cumulative token counts but never the generation
 * speed.  This feature tracks one assistant message at a time: while deltas
 * stream it shows the rate of the output produced so far, and at
 * `message_end` it replaces that with the provider-reported `usage.output`
 * over the same span.
 *
 * Live numbers are estimates.  Most providers report usage only on the final
 * chunk, so the running rate divides a character-based token estimate by the
 * time since the first delta.  ASCII counts as a quarter token, everything
 * else (CJK, emoji) as one, which keeps Japanese output from reading several
 * times faster than it is.  As soon as `partial.usage.output` appears it wins.
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
 * A provider that delivers the whole message in one chunk has almost no
 * generation span.  Fall back to the full start→end time below this.
 */
export const DEFAULT_FALLBACK_SPAN_MS = 100;

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
	fg(color: "accent" | "dim", text: string): string;
}

/** The footer status: accent label, dim value, like the other segments. */
export function formatThemedTokRateStatus(tokensPerSecond: number, theme: TokRateTheme): string {
	return `${theme.fg("accent", "TOK/S")}${theme.fg("dim", ` ${formatTokPerSecond(tokensPerSecond)}`)}`;
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
	fallbackSpanMs?: number;
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

/**
 * One assistant message in flight.
 *
 * `messageStart` opens the measurement (Pi emits it for the provider's `start`
 * event, not as a `message_update`), deltas accumulate the live estimate, and
 * `messageEnd` closes it.  A missing start - a mid-stream reload, or a test
 * driving single events - opens the measurement on the first delta.
 */
export function createTokRateController(options: TokRateControllerOptions = {}): TokRateController {
	const now = options.now ?? (() => Date.now());
	const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
	const minSpanMs = options.minSpanMs ?? DEFAULT_MIN_SPAN_MS;
	const fallbackSpanMs = options.fallbackSpanMs ?? DEFAULT_FALLBACK_SPAN_MS;

	let active = false;
	let startedAt = 0;
	let firstDeltaAt: number | undefined;
	let streamedTokens = 0;
	let reportedOutput: number | undefined;
	let lastShownAt: number | undefined;

	const clear = (ctx: TokRateContext) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const begin = () => {
		active = true;
		startedAt = now();
		firstDeltaAt = undefined;
		streamedTokens = 0;
		reportedOutput = undefined;
		lastShownAt = undefined;
	};

	const show = (tokens: number, spanMs: number, ctx: TokRateContext) => {
		if (tokens <= 0 || spanMs <= 0) return;
		ctx.ui.setStatus(STATUS_KEY, formatThemedTokRateStatus((tokens * 1000) / spanMs, ctx.ui.theme));
	};

	return {
		reset(ctx) {
			active = false;
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

			const delta = deltaText(event);
			if (delta !== undefined && delta.length > 0) {
				firstDeltaAt ??= now();
				streamedTokens += estimateTokens(delta);
			}

			const reported = outputTokens(event.partial?.usage);
			if (reported !== undefined && reported > (reportedOutput ?? 0)) reportedOutput = reported;
			if (firstDeltaAt === undefined) return;

			const at = now();
			const spanMs = at - firstDeltaAt;
			if (spanMs < minSpanMs) return;
			if (lastShownAt !== undefined && at - lastShownAt < throttleMs) return;

			lastShownAt = at;
			show(reportedOutput ?? streamedTokens, spanMs, ctx);
		},

		messageEnd(message, ctx) {
			if (!ctx.hasUI || message.role !== "assistant" || !active) return;

			const finishedAt = now();
			const tokens = outputTokens(message.usage) ?? reportedOutput ?? streamedTokens;
			const generationSpan = firstDeltaAt !== undefined ? finishedAt - firstDeltaAt : undefined;
			const totalSpan = finishedAt - startedAt;
			const spanMs =
				generationSpan !== undefined && generationSpan >= fallbackSpanMs ? generationSpan : totalSpan;

			active = false;
			firstDeltaAt = undefined;
			lastShownAt = undefined;

			// A failed or aborted message has no meaningful rate; leaving the
			// previous one on screen would describe the wrong response.
			if (message.stopReason === "error" || message.stopReason === "aborted" || tokens <= 0) {
				clear(ctx);
				return;
			}
			show(tokens, spanMs, ctx);
		},

		sessionShutdown(ctx) {
			active = false;
			clear(ctx);
		},
	};
}
