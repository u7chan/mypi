/**
 * hwc rewind primitives for Pi.
 *
 * hwc (Herdr Web Client) lets the user edit an earlier user message and send
 * it again.  The TUI can rewind by opening the session tree, but hwc cannot
 * drive that picker.  Instead it invokes `/hwc-rewind <entryId> <requestId>`
 * in the Herdr pane.  This module holds the argument grammar, the session
 * entry shapes and the decision that the extension's command applies.
 *
 * Two custom session entries carry the contract shared with hwc's ADR:
 *
 *     hwc-capabilities  { v: 1, rewind: true }      written once per session
 *     hwc-rewind        { v: 1, requestId, targetId, leafId }
 *
 * Capability tells hwc that this pane understands rewind.  A marker tells it
 * that a request completed: `targetId` is the edited user message and `leafId`
 * is the leaf after navigating (the target's parent; null only when the
 * target has no parent, which does not normally happen in Pi 1.5.2 because
 * the session already has entries before the first user message).
 *
 * Markers are appended after navigation.  `navigateTree` itself writes
 * nothing, so without the marker hwc cannot observe the move.  Markers do not
 * enter the LLM context.
 */

export const CAPABILITY_TYPE = "hwc-capabilities";
export const MARKER_TYPE = "hwc-rewind";

/** Bumped together with hwc's ADR; readers check it before using the data. */
export const FORMAT_VERSION = 1;

/** Session entry ids and request ids share one deliberately small alphabet. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const USAGE = "/hwc-rewind <entryId> <requestId>";

/** The subset of a Pi session entry this feature reads. */
export type EntryLike = {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
	message?: { role?: string };
};

export type HwcCapability = {
	v: typeof FORMAT_VERSION;
	rewind: true;
};

export type RewindMarker = {
	v: typeof FORMAT_VERSION;
	requestId: string;
	/** The user message hwc wants to edit. */
	targetId: string;
	/** Leaf after navigating: the target's parent (null if it has none). */
	leafId: string | null;
};

export type RewindRequest = {
	entryId: string;
	requestId: string;
};

export type ParsedRewind =
	| { ok: true; request: RewindRequest }
	| { ok: false; error: string };

export type RewindPlan =
	/** The same request already completed; report success without writing. */
	| { action: "ignore" }
	| { action: "navigate" }
	/** Navigation happened, but the marker write failed; append it only. */
	| { action: "marker-only" }
	| { action: "reject"; reason: string };

export function parseRewindArgs(args: string): ParsedRewind {
	const trimmed = args.trim();
	const tokens = trimmed === "" ? [] : trimmed.split(/\s+/);
	if (tokens.length !== 2) {
		return { ok: false, error: `expected 2 arguments; usage: ${USAGE}` };
	}
	const [entryId, requestId] = tokens;
	if (!ID_PATTERN.test(entryId)) {
		return { ok: false, error: `invalid entryId "${entryId}"; expected ${ID_PATTERN}` };
	}
	if (!ID_PATTERN.test(requestId)) {
		return { ok: false, error: `invalid requestId "${requestId}"; expected ${ID_PATTERN}` };
	}
	return { ok: true, request: { entryId, requestId } };
}

export function capabilityData(): HwcCapability {
	return { v: FORMAT_VERSION, rewind: true };
}

export function rewindMarker(requestId: string, targetId: string, leafId: string | null): RewindMarker {
	return { v: FORMAT_VERSION, requestId, targetId, leafId };
}

export function isCapabilityEntry(entry: EntryLike): boolean {
	if (entry.type !== "custom" || entry.customType !== CAPABILITY_TYPE) return false;
	const data = asRecord(entry.data);
	return data?.v === FORMAT_VERSION && data.rewind === true;
}

export function hasCapability(entries: readonly EntryLike[]): boolean {
	return entries.some(isCapabilityEntry);
}

export function isRewindMarker(entry: EntryLike, requestId: string): boolean {
	if (entry.type !== "custom" || entry.customType !== MARKER_TYPE) return false;
	const data = asRecord(entry.data);
	return data?.requestId === requestId;
}

export function findRewindMarker(
	entries: readonly EntryLike[],
	requestId: string,
): EntryLike | undefined {
	return entries.find((entry) => isRewindMarker(entry, requestId));
}

/** The target recorded by a marker, or undefined for a malformed one. */
export function markerTargetId(entry: EntryLike): string | undefined {
	const data = asRecord(entry.data);
	return typeof data?.targetId === "string" ? data.targetId : undefined;
}

export function isUserMessageEntry(entry: EntryLike): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}

/**
 * Decide what a rewind request needs to do, without touching Pi.
 *
 * The order mirrors the command contract: a completed request is idempotent,
 * then the target must be a user message that is not the current leaf, then it
 * must either be on the active branch (navigate) or be the parent of the leaf
 * (navigation already happened but the marker append failed; retry only the
 * marker).  Anything else is rejected and writes no marker.
 */
export function planRewind(input: {
	branch: readonly EntryLike[];
	target: EntryLike | undefined;
	leafId: string | null;
	entryId: string;
	requestId: string;
}): RewindPlan {
	const { branch, target, leafId, entryId, requestId } = input;

	const marker = findRewindMarker(branch, requestId);
	if (marker) {
		const completedTarget = markerTargetId(marker);
		if (completedTarget === entryId) return { action: "ignore" };
		return {
			action: "reject",
			reason: `requestId "${requestId}" already rewound "${completedTarget ?? "an unknown target"}"`,
		};
	}

	if (!target) {
		return { action: "reject", reason: `entry "${entryId}" was not found` };
	}
	if (!isUserMessageEntry(target)) {
		return { action: "reject", reason: `entry "${entryId}" is not a user message` };
	}
	if (leafId === entryId) {
		return { action: "reject", reason: `entry "${entryId}" is the current leaf` };
	}
	if (branch.some((entry) => entry.id === entryId)) {
		return { action: "navigate" };
	}
	if (target.parentId === leafId) {
		return { action: "marker-only" };
	}
	return { action: "reject", reason: `entry "${entryId}" is not on the active branch` };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
