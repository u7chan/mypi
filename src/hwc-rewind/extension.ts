import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CAPABILITY_TYPE,
	MARKER_TYPE,
	USAGE,
	capabilityData,
	hasCapability,
	parseRewindArgs,
	planRewind,
	rewindMarker,
} from "./core.ts";

export {
	CAPABILITY_TYPE,
	FORMAT_VERSION,
	hasCapability,
	ID_PATTERN,
	isCapabilityEntry,
	isRewindMarker,
	isUserMessageEntry,
	MARKER_TYPE,
	markerTargetId,
	parseRewindArgs,
	planRewind,
	rewindMarker,
	USAGE,
} from "./core.ts";
export type {
	EntryLike,
	HwcCapability,
	ParsedRewind,
	RewindMarker,
	RewindPlan,
	RewindRequest,
} from "./core.ts";

/**
 * Adds the internal `/hwc-rewind` command and the `hwc-capabilities` marker
 * for hwc (the Herdr web client).
 *
 * Only Herdr panes have `HERDR_PANE_ID`; a normal pi start keeps exactly the
 * same commands and handlers as before this feature.  hwc uses the
 * capability to decide whether to offer editing an earlier user message, then
 * sends `/hwc-rewind <entryId> <requestId>`.
 *
 * The command navigates to the target without a summary, clears the editor
 * (the TUI would otherwise restore the original message and hwc could not
 * type a replacement), and appends a `hwc-rewind` marker so hwc can observe
 * completion.  It never restores files and never writes a branch summary.
 *
 * Idempotency and crash recovery are deliberately asymmetric: a completed
 * request returns success without moving or writing again, and a retry whose
 * target is already the leaf's parent appends only the missing marker.
 */
export default function hwcRewindExtension(pi: ExtensionAPI): void {
	if (!process.env.HERDR_PANE_ID) return;

	pi.on("session_start", (_event, ctx) => {
		// `--no-session` has nowhere to persist the capability.  A session that
		// already has one, including on another branch, must not get a second.
		if (!ctx.sessionManager.getSessionFile()) return;
		if (hasCapability(ctx.sessionManager.getEntries())) return;
		try {
			pi.appendEntry(CAPABILITY_TYPE, capabilityData());
		} catch {
			// Observational only: hwc just will not offer editing for this pane.
		}
	});

	pi.registerCommand("hwc-rewind", {
		description: "Internal command used by hwc (Herdr Web Client)",
		handler: async (args, ctx) => {
			await rewind(pi, args, ctx);
		},
	});
}

async function rewind(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseRewindArgs(args);
	if (!parsed.ok) {
		notifyError(ctx, parsed.error);
		return;
	}
	const { entryId, requestId } = parsed.request;

	const plan = planRewind({
		branch: ctx.sessionManager.getBranch(),
		target: ctx.sessionManager.getEntry(entryId),
		leafId: ctx.sessionManager.getLeafId(),
		entryId,
		requestId,
	});

	if (plan.action === "ignore") return;
	if (plan.action === "reject") {
		notifyError(ctx, plan.reason);
		return;
	}

	if (plan.action === "navigate") {
		try {
			const result = await ctx.navigateTree(entryId, { summarize: false });
			if (result.cancelled) {
				notifyError(ctx, `navigation to "${entryId}" was cancelled`);
				return;
			}
		} catch (error) {
			notifyError(ctx, `navigation to "${entryId}" failed: ${messageOf(error)}`);
			return;
		}
	}

	ctx.ui.setEditorText("");

	try {
		pi.appendEntry(MARKER_TYPE, rewindMarker(requestId, entryId, ctx.sessionManager.getLeafId()));
	} catch (error) {
		// The session already moved in memory, so retrying the command with the
		// same requestId takes the `marker-only` path and writes just the marker.
		notifyError(ctx, `could not record the rewind marker: ${messageOf(error)}`);
	}
}

function notifyError(ctx: ExtensionContext, reason: string): void {
	ctx.ui.notify(`hwc-rewind: ${reason}`, "error");
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
