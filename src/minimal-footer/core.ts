/**
 * Stats-free footer renderer for Pi.
 *
 * The built-in footer always prints the token/cost stats block
 * (`↑input ↓output R… W… CH% $cost`) next to the context-window usage.  This
 * PoC replaces the footer with one that keeps the parts that matter for
 * cache watching — context window, model info, and extension statuses — and
 * drops the always-growing token/cost block entirely.
 *
 * The rendering mirrors the built-in footer component (cwd line, context
 * colouring thresholds, right-aligned model info) but folds the extension
 * statuses onto the stats line, so the footer stays two lines high.
 */

export interface MinimalFooterTheme {
	fg(color: "dim" | "error" | "warning", text: string): string;
}

export interface ContextUsageInfo {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface FooterModelInfo {
	id?: string;
	provider?: string;
	reasoning?: boolean;
	contextWindow?: number;
}

/** The read-only footer data Pi hands to `ctx.ui.setFooter()` factories. */
export interface FooterRenderData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	/** Subscribe to git branch changes; returns the unsubscribe function. */
	onBranchChange(callback: () => void): () => void;
}

export interface FooterRenderInput {
	theme: MinimalFooterTheme;
	footerData: FooterRenderData;
	model?: FooterModelInfo;
	thinkingLevel?: string;
	cwd: string;
	home?: string;
	sessionName?: string;
	contextUsage?: ContextUsageInfo;
	width: number;
}

/** Pi supplies terminal-column helpers; the pure renderer can also run offline. */
export interface FooterTextMetrics {
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis?: string): string;
}

/** The slice of the Pi extension context the adapter needs. */
export interface MinimalFooterContext {
	mode: string;
	hasUI: boolean;
	model?: FooterModelInfo;
	thinkingLevel?: string;
	sessionManager: {
		getCwd(): string;
		getSessionName(): string | undefined;
	};
	getContextUsage(): ContextUsageInfo | undefined;
	ui: {
		setFooter(
			factory:
				| ((tui: { requestRender(): void }, theme: MinimalFooterTheme, footerData: FooterRenderData) => {
						invalidate(): void;
						dispose?(): void;
						render(width: number): string[];
				  })
				| undefined,
		): void;
	};
}

/**
 * Reading order of the known segments: response timing and speed first, then
 * cache lifetime and reuse, with links last.  Other extensions' statuses keep
 * their alphabetical order and sit just before the links.
 */
export const STATUS_ORDER = ["elapsed", "tok", "cache-ttl", "cache-reuse"] as const;

function statusRank(key: string): number {
	const index = STATUS_ORDER.indexOf(key as (typeof STATUS_ORDER)[number]);
	if (index >= 0) return index;
	return key === "git" ? STATUS_ORDER.length + 1 : STATUS_ORDER.length;
}

/**
 * Keys that stay on the stats line.  Everything else belongs to another
 * extension, can appear and disappear with the model, and is the part that
 * moves to a third line when the stats line runs out of width.
 */
const OWN_STATUS_KEYS: ReadonlySet<string> = new Set<string>([...STATUS_ORDER, "git"]);

interface StatusEntry {
	key: string;
	text: string;
}

/** Separator between status segments; dim so the values stay dominant. */
const STATUS_SEPARATOR = " · ";

/** Same compaction as the built-in footer's formatTokens. */
export function formatFooterTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Escape sequences that occupy no columns: CSI (colours), OSC (hyperlinks,
 * window titles), and APC (kitty images).  OSC may end with BEL or ST, so
 * stripping `\x1b[...m` alone is not enough: an OSC 8 URL would count toward
 * the width and push real text (for example the PR number next to the
 * repository link) out of the footer.
 */
const ZERO_WIDTH_SEQUENCE =
	/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** One escape sequence or one character - the units truncation walks. */
const TOKEN = new RegExp(`${ZERO_WIDTH_SEQUENCE.source}|[\\s\\S]`, "g");

/** OSC 8 close: the same sequence with empty parameters and URI. */
const OSC8_CLOSE = /^\x1b\]8;;(?:\x07|\x1b\\)$/;

/** Visible length ignoring escape sequences. */
function visibleLength(text: string): number {
	return text.replace(ZERO_WIDTH_SEQUENCE, "").length;
}

/** ANSI/OSC-aware truncation: escape sequences never count toward the width. */
function truncate(text: string, width: number, ellipsis = ""): string {
	if (visibleLength(text) <= width) return text;
	const budget = Math.max(0, width - visibleLength(ellipsis));
	let out = "";
	let seen = 0;
	let openHyperlink = false;
	for (const token of text.match(TOKEN) ?? []) {
		if (token.startsWith("\x1b")) {
			out += token;
			if (token.startsWith("\x1b]8;")) openHyperlink = !OSC8_CLOSE.test(token);
			continue;
		}
		if (seen >= budget) break;
		out += token;
		seen++;
	}
	// Keep a truncated link from spanning the rest of the footer line.
	if (openHyperlink) out += "\x1b]8;;\x1b\\";
	return out + ellipsis;
}

function replaceHome(cwd: string, home?: string): string {
	if (!home || !cwd.startsWith(home)) return cwd;
	return `~${cwd.slice(home.length)}`;
}

/** Collapse whitespace like the built-in footer's sanitizeStatusText. */
function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/** `232k/1.0M (23.2%)` or `?/256k`, coloured by the built-in thresholds. */
function formatContextUsage(input: FooterRenderInput): string {
	const contextWindow = input.contextUsage?.contextWindow ?? input.model?.contextWindow ?? 0;
	const windowText = formatFooterTokens(contextWindow);
	const tokens = input.contextUsage?.tokens;
	const usedText = tokens === null || tokens === undefined ? "?" : formatFooterTokens(tokens);
	const percent = input.contextUsage?.percent;
	const percentText = percent === null || percent === undefined ? "" : ` (${percent.toFixed(1)}%)`;
	const text = `${usedText}/${windowText}${percentText}`;
	if (percent === null || percent === undefined) return input.theme.fg("dim", text);
	if (percent > 90) return input.theme.fg("error", text);
	if (percent > 70) return input.theme.fg("warning", text);
	return input.theme.fg("dim", text);
}

/**
 * Right side of the stats line in decreasing verbosity: `provider model level`,
 * `model level`, then the bare model id.  Single spaces keep the line easy to
 * copy into `/dm provider/model:level`; the first variant that fits alongside
 * every status wins, so a narrow terminal drops the provider before it drops
 * cache information.
 */
function formatModelInfoVariants(input: FooterRenderInput): string[] {
	const modelName = input.model?.id || "no-model";
	const variants = [modelName];
	if (input.model?.reasoning) {
		variants.unshift(`${modelName} ${input.thinkingLevel || "off"}`);
	}
	if (input.footerData.getAvailableProviderCount() > 1 && input.model?.provider) {
		variants.unshift(`${input.model.provider} ${variants[0]}`);
	}
	return variants;
}

function joinStatusEntries(entries: readonly StatusEntry[], separator: string): string {
	return entries.map((entry) => entry.text).join(separator);
}

/**
 * `used/window (percent) · statuses` on the left, model info right-aligned.
 *
 * When no model variant fits next to all statuses, the statuses keep the line
 * and the model is dropped: cache watching is the reason this footer exists.
 */
function renderStatsLine(
	input: FooterRenderInput,
	entries: readonly StatusEntry[],
	width: number,
	metrics: FooterTextMetrics,
): string {
	const { theme } = input;
	const left = formatContextUsage(input);
	const separator = theme.fg("dim", STATUS_SEPARATOR);
	const statusText = joinStatusEntries(entries, separator);
	const leftWidth = metrics.visibleWidth(left);
	const statusWidth = entries.length > 0 ? metrics.visibleWidth(separator) + metrics.visibleWidth(statusText) : 0;
	const body = entries.length > 0 ? left + separator + statusText : left;
	const bodyWidth = leftWidth + statusWidth;

	for (const info of formatModelInfoVariants(input)) {
		const right = theme.fg("dim", info);
		const rightWidth = metrics.visibleWidth(right);
		if (bodyWidth + 2 + rightWidth <= width) {
			const padding = " ".repeat(width - bodyWidth - rightWidth);
			return metrics.truncateToWidth(body + padding + right, width, "");
		}
	}

	const statusRoom = Math.max(0, width - leftWidth - metrics.visibleWidth(separator));
	if (entries.length === 0 || statusRoom === 0) {
		return metrics.truncateToWidth(left, width, "");
	}
	const truncated = metrics.truncateToWidth(statusText, statusRoom, theme.fg("dim", "..."));
	return metrics.truncateToWidth(truncated ? left + separator + truncated : left, width, "");
}

/**
 * Truncate with an ellipsis, then clip the result to the width.
 *
 * The offline fallback appends the three-column ellipsis even when it is wider
 * than the space left (a one- or two-column terminal), so the second pass
 * keeps every rendered line inside `width`.  Pi's host metrics already do
 * this, which makes the second call a no-op there.
 */
function fitLine(text: string, width: number, metrics: FooterTextMetrics, ellipsis: string): string {
	// Below the ellipsis width, show raw characters instead of a clipped marker.
	const marker = metrics.visibleWidth(ellipsis) < width ? ellipsis : "";
	return metrics.truncateToWidth(metrics.truncateToWidth(text, width, marker), width, "");
}

/**
 * Lay the statuses out on the stats line, spilling other extensions' statuses
 * to a third line when the whole row would be cut instead.
 *
 * This package's segments (`elapsed`, `tok`, `cache-ttl`, `cache-reuse`) and
 * `git` stay on the stats line: the links are the reason it exists.  A Codex
 * adapter plus its usage counters adds roughly 40 columns, which used to clip
 * the tail of the row down to `u7...` and hide the PR number.  Moving the
 * foreign segments keeps them intact on their own line and gives the freed
 * width back to the model info.  The height changes only when the row crosses
 * the terminal width; a third line that is still too wide is truncated like
 * any other line, and a stats line that overflows without foreign statuses
 * keeps the old truncation.
 */
function buildStatsLines(
	input: FooterRenderInput,
	entries: readonly StatusEntry[],
	width: number,
	metrics: FooterTextMetrics,
): string[] {
	const hasForeignStatus = entries.some((entry) => !OWN_STATUS_KEYS.has(entry.key));
	if (hasForeignStatus) {
		const separator = input.theme.fg("dim", STATUS_SEPARATOR);
		const leftWidth = metrics.visibleWidth(formatContextUsage(input));
		const bodyWidth =
			leftWidth + metrics.visibleWidth(separator) + metrics.visibleWidth(joinStatusEntries(entries, separator));

		if (bodyWidth > width) {
			const own = entries.filter((entry) => OWN_STATUS_KEYS.has(entry.key));
			const foreign = entries.filter((entry) => !OWN_STATUS_KEYS.has(entry.key));
			const statsLine = renderStatsLine(input, own, width, metrics);
			const foreignLine = fitLine(
				joinStatusEntries(foreign, separator),
				width,
				metrics,
				input.theme.fg("dim", "..."),
			);
			// A terminal too narrow for even the ellipsis leaves nothing to show.
			return foreignLine ? [statsLine, foreignLine] : [statsLine];
		}
	}

	return [renderStatsLine(input, entries, width, metrics)];
}

/**
 * The stats-free footer lines:
 * 1. `~/cwd (branch) • session`
 * 2. `used/window (percent) · statuses` … right-aligned model info (no token/cost
 *    stats), the statuses sorted by key like the built-in footer
 * 3. only when other extensions' statuses would be cut on line 2: those
 *    statuses, without the context and model parts
 */
export function buildFooterLines(
	input: FooterRenderInput,
	metrics: FooterTextMetrics = { visibleWidth: visibleLength, truncateToWidth: truncate },
): string[] {
	const { theme, width } = input;

	let pwd = replaceHome(input.cwd, input.home);
	const branch = input.footerData.getGitBranch();
	if (branch) pwd = `${pwd} (${branch})`;
	if (input.sessionName) pwd = `${pwd} • ${input.sessionName}`;
	const pwdLine = fitLine(theme.fg("dim", pwd), width, metrics, theme.fg("dim", "..."));

	const entries = Array.from(input.footerData.getExtensionStatuses().entries())
		.sort(([a], [b]) => statusRank(a) - statusRank(b) || a.localeCompare(b))
		.map(([key, text]) => ({ key, text: sanitizeStatusText(text) }));

	return [pwdLine, ...buildStatsLines(input, entries, width, metrics)];
}
