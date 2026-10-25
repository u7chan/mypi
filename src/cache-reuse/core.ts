/**
 * Cache-reuse footer status: how much of the latest prompt came from cache.
 *
 * The footer shows only the observed side of that: `usage.cacheRead`, the
 * tokens the provider served from cache for the latest assistant response.
 * No dollar estimate is derived from catalogue rates.  The usual setup here is
 * subscription-backed, so a counterfactual amount would describe a bill that
 * is never paid, and an honest estimate would need complete, consistent
 * provider pricing that is not always available.
 */

export const STATUS_KEY = "cache-reuse";

export interface CacheReuse {
	/** Tokens billed at the cache-read rate in the latest response. */
	cachedTokens: number;
}

function toFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return the cached tokens of one response, or undefined when there was no hit. */
export function computeCacheReuse(usage: unknown): CacheReuse | undefined {
	if (!isRecord(usage)) return undefined;

	const cachedTokens = toFiniteNumber(usage.cacheRead);
	if (cachedTokens === undefined || cachedTokens <= 0) return undefined;

	return { cachedTokens };
}

/** Compact token count for the footer: `128`, `12.3k`, `1.23M`. */
export function formatCachedTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens < 0) return "0";
	if (tokens < 1000) return `${Math.round(tokens)}`;

	const trim = (text: string) => text.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
	if (tokens < 1e6) return `${trim((tokens / 1e3).toFixed(1))}k`;
	return `${trim((tokens / 1e6).toFixed(2))}M`;
}

/**
 * Footer text for one cache hit, e.g. `cached 12.3k`.  The unit is implied:
 * spelling `tok` here sits next to the `tok/s` segment and reads as a rate.
 */
export function formatCacheReuseStatus(reuse: CacheReuse): string {
	return `cached ${formatCachedTokens(reuse.cachedTokens)}`;
}

export interface CacheReuseStatusContext {
	hasUI: boolean;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		theme?: CacheReuseTheme;
	};
}

/** The small part of Pi's theme API needed by the status renderer. */
export interface CacheReuseTheme {
	fg(color: "dim", text: string): string;
}

/**
 * Style the status like the other footer segments: a dim label and a value in
 * the terminal's normal foreground.  Split out so the controller stays
 * usable without a TUI theme (tests, RPC clients, other harnesses).
 */
export function formatThemedCacheReuse(text: string, theme?: CacheReuseTheme): string {
	if (!theme || !text.startsWith("cached ")) return text;

	return `${theme.fg("dim", "cached")}${text.slice("cached".length)}`;
}

export interface CacheReuseController {
	sessionStart(ctx: CacheReuseStatusContext): void;
	messageEnd(message: unknown, ctx: CacheReuseStatusContext): void;
	modelSelect(ctx: CacheReuseStatusContext): void;
	sessionShutdown(ctx: CacheReuseStatusContext): void;
	getLatest(): CacheReuse | undefined;
}

/**
 * Stateful adapter tracking the latest response's cache reuse.
 *
 * The segment only exists while the latest assistant response reported a
 * cache hit: a hit-less response clears it, and so do model switches and
 * session boundaries, because the number belongs to one specific response.
 */
export function createCacheReuseController(): CacheReuseController {
	let latest: CacheReuse | undefined;
	let context: CacheReuseStatusContext | undefined;
	let lastText: string | undefined | null = null;

	const render = (ctx: CacheReuseStatusContext | undefined = context) => {
		if (!ctx?.hasUI) return;

		const text = latest === undefined ? undefined : formatCacheReuseStatus(latest);
		const renderedText = text === undefined ? undefined : formatThemedCacheReuse(text, ctx.ui.theme);
		if (renderedText === lastText) return;
		lastText = renderedText;
		ctx.ui.setStatus(STATUS_KEY, renderedText);
	};

	// Clearing goes through render() so an unchanged footer is not touched,
	// while a segment left over from a previous session or model is removed.
	const reset = (ctx: CacheReuseStatusContext) => {
		latest = undefined;
		context = ctx;
		render(ctx);
	};

	return {
		sessionStart(ctx) {
			reset(ctx);
		},

		messageEnd(message, ctx) {
			context = ctx;
			if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) {
				return;
			}

			latest = computeCacheReuse(message.usage);
			render(ctx);
		},

		modelSelect(ctx) {
			reset(ctx);
		},

		sessionShutdown(ctx) {
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
			latest = undefined;
			context = undefined;
			lastText = undefined;
		},

		getLatest() {
			return latest;
		},
	};
}
