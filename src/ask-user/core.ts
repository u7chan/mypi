/**
 * `ask_user` primitives: argument validation, the pending/answer file contract
 * shared with hwc (the Herdr web client), and the TUI-vs-Web race.
 *
 * Pi's dialogs return `undefined` both for Esc and for an abort, so the
 * controller records the winner *before* it aborts the dialog.  Otherwise a
 * Web answer would be mistaken for a dismissed dialog.
 *
 * The clock, filesystem and UUID source are injectable; `bun test` drives the
 * whole exchange without a terminal or node_modules.
 *
 * File contract (one line of JSON, written with tmp + rename, mode 0600):
 *
 *     <session>.ask.json         mypi -> hwc  (question being asked)
 *     <session>.ask.answer.json  hwc -> mypi  (the chosen answer)
 *
 * The pending id and the tool call are 1:1.  An answer whose id does not match
 * the current pending question is ignored and, crucially, left on disk while
 * waiting: it may be the correct answer to the next question that arrived
 * between the read and the delete.
 */

export const FORMAT_VERSION = 1;

export const PENDING_SUFFIX = ".ask.json";
export const ANSWER_SUFFIX = ".ask.answer.json";

export const MAX_QUESTION_CODEPOINTS = 500;
export const MAX_OPTION_CODEPOINTS = 120;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_ANSWER_CODEPOINTS = 2_000;

/** 2000-code-point answers need at most 8000 UTF-8 bytes; leave slack. */
export const MAX_PENDING_BYTES = 8 * 1024;
export const MAX_ANSWER_BYTES = 16 * 1024;

export const POLL_INTERVAL_MS = 300;

export const BLOCKED_LABEL = "ユーザーの回答待ち";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /\p{Cc}/u;

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export type PendingQuestion = {
	v: typeof FORMAT_VERSION;
	id: string;
	question: string;
	/** `null` means free text; otherwise the user picks exactly one label. */
	options: string[] | null;
};

export type AskAnswer = { kind: "option"; label: string } | { kind: "text"; text: string };

export type AnswerFile = {
	v: typeof FORMAT_VERSION;
	id: string;
	answer: AskAnswer;
};

export type AskUserRoute = {
	pendingPath: string;
	answerPath: string;
};

export type AskUserRequest = {
	question: string;
	options: string[] | null;
	/** `null` disables the file contract and the Herdr blocked report. */
	route: AskUserRoute | null;
	/** Shows the TUI/RPC dialog. Resolves `undefined` on Esc or abort. */
	prompt(signal: AbortSignal): Promise<string | undefined>;
};

export type AskUserOutcome =
	| { status: "answered"; answer: AskAnswer; winner: "tui" | "file" }
	| { status: "dismissed" }
	| { status: "aborted" }
	| { status: "busy" }
	| { status: "invalid"; error: string };

export type AskUserFileSystem = {
	/** Returns `null` when the file is missing, unreadable or over `maxBytes`. */
	read(path: string, maxBytes: number): string | null;
	/** Atomically replaces `path`; returns false instead of throwing. */
	write(path: string, body: string): boolean;
	/** Removes `path`; a missing file is not an error. */
	remove(path: string): void;
};

export type AskUserScheduler = {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
};

export type AskUserControllerOptions = {
	fs: AskUserFileSystem;
	scheduler: AskUserScheduler;
	pollMs?: number;
	randomUUID?: () => string;
	/** Reports `herdr:blocked`; called once with `true` and once with `false`. */
	notifyBlocked?: (active: boolean) => void;
};

export type AskUserController = {
	/** Returns `busy` without touching the filesystem or UI. */
	ask(request: AskUserRequest, signal: AbortSignal | undefined): Promise<AskUserOutcome>;
};

export const defaultScheduler: AskUserScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function pendingPathFor(sessionFile: string): string {
	return `${sessionFile}${PENDING_SUFFIX}`;
}

export function answerPathFor(sessionFile: string): string {
	return `${sessionFile}${ANSWER_SUFFIX}`;
}

export function codePointLength(value: string): number {
	return Array.from(value).length;
}

/** Sizes are checked before parsing; an oversized file is treated as absent. */
export function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

export function isValidUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

function fail<T>(error: string): Validation<T> {
	return { ok: false, error };
}

function hasForbiddenControl(value: string, allowed: string): boolean {
	for (const character of value) {
		if (allowed.includes(character)) continue;
		if (CONTROL.test(character)) return true;
	}
	return false;
}

/**
 * `\r\n` and lone `\r` become `\n`, then the text is trimmed.  Newlines are
 * allowed (the TUI title and the Web card show them); every other control
 * character is rejected so ANSI never reaches the terminal title.
 */
export function normalizeQuestion(value: unknown): Validation<string> {
	if (typeof value !== "string") return fail("question must be a string");
	const question = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	const length = codePointLength(question);
	if (length < 1 || length > MAX_QUESTION_CODEPOINTS) {
		return fail(`question must be 1-${MAX_QUESTION_CODEPOINTS} code points after trimming`);
	}
	if (hasForbiddenControl(question, "\n")) {
		return fail("question must not contain control characters other than newlines");
	}
	return { ok: true, value: question };
}

/** `undefined` and `null` mean free text.  Options are returned trimmed. */
export function normalizeOptions(value: unknown): Validation<string[] | null> {
	if (value === undefined || value === null) return { ok: true, value: null };
	if (!Array.isArray(value)) return fail("options must be an array of strings");
	if (value.length < MIN_OPTIONS || value.length > MAX_OPTIONS) {
		return fail(`options must have ${MIN_OPTIONS}-${MAX_OPTIONS} entries`);
	}
	const options: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") return fail("options must be an array of strings");
		const option = item.trim();
		const length = codePointLength(option);
		if (length < 1 || length > MAX_OPTION_CODEPOINTS) {
			return fail(`each option must be 1-${MAX_OPTION_CODEPOINTS} code points after trimming`);
		}
		if (hasForbiddenControl(option, "")) {
			return fail("options must not contain control characters or newlines");
		}
		if (seen.has(option)) return fail("options must be unique after trimming");
		seen.add(option);
		options.push(option);
	}
	return { ok: true, value: options };
}

/** Free-text answers keep internal newlines and tabs, trimmed at the ends. */
export function validateAnswerText(value: unknown): Validation<string> {
	if (typeof value !== "string") return fail("answer text must be a string");
	const text = value.trim();
	const length = codePointLength(text);
	if (length < 1 || length > MAX_ANSWER_CODEPOINTS) {
		return fail(`answer text must be 1-${MAX_ANSWER_CODEPOINTS} code points after trimming`);
	}
	if (hasForbiddenControl(text, "\n\t")) {
		return fail("answer text must not contain control characters other than newlines and tabs");
	}
	return { ok: true, value: text };
}

export function serializePending(pending: PendingQuestion): string {
	return `${JSON.stringify(pending)}\n`;
}

export function serializeAnswer(answer: AnswerFile): string {
	return `${JSON.stringify(answer)}\n`;
}

/**
 * A missing `options` field is rejected: the writer always emits `null` for
 * free text, so an absent field means the file was not produced by this
 * contract.
 */
export function parsePending(body: string): PendingQuestion | null {
	if (utf8ByteLength(body) > MAX_PENDING_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.v !== FORMAT_VERSION) return null;
	if (!isValidUuid(record.id)) return null;
	const question = normalizeQuestion(record.question);
	if (!question.ok) return null;
	if (!Object.hasOwn(record, "options")) return null;
	const options = normalizeOptions(record.options);
	if (!options.ok) return null;
	return { v: FORMAT_VERSION, id: record.id, question: question.value, options: options.value };
}

/**
 * Shape and universal limits only.  Matching the label against the pending
 * question (or requiring free text when `options` is null) needs the question,
 * so it is done by `validateAnswerForQuestion`.
 */
export function parseAnswerFile(body: string): AnswerFile | null {
	if (utf8ByteLength(body) > MAX_ANSWER_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.v !== FORMAT_VERSION) return null;
	if (!isValidUuid(record.id)) return null;
	const raw = record.answer;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const answer = raw as Record<string, unknown>;
	if (answer.kind === "option") {
		if (typeof answer.label !== "string" || answer.label === "") return null;
		return { v: FORMAT_VERSION, id: record.id, answer: { kind: "option", label: answer.label } };
	}
	if (answer.kind === "text") {
		const text = validateAnswerText(answer.text);
		if (!text.ok) return null;
		return { v: FORMAT_VERSION, id: record.id, answer: { kind: "text", text: text.value } };
	}
	return null;
}

/** An option must be one of the offered labels; text only when there are none. */
export function validateAnswerForQuestion(
	answer: AskAnswer,
	options: string[] | null,
): Validation<AskAnswer> {
	if (answer.kind === "option") {
		if (options === null) return fail("an option answer requires a question with options");
		if (!options.includes(answer.label)) return fail("the answer is not one of the offered options");
		return { ok: true, value: answer };
	}
	if (options !== null) return fail("a free-text answer requires a question without options");
	const text = validateAnswerText(answer.text);
	if (!text.ok) return fail(text.error);
	return { ok: true, value: { kind: "text", text: text.value } };
}

/**
 * Runs one question.  The single-pending slot is taken synchronously, before
 * any await, so a second parallel call sees `busy` and touches nothing.
 *
 * Cleanup order is fixed: stop the monitor, remove pending, remove answer,
 * then report `blocked: false` (only when `blocked: true` was reported).
 */
export function createAskUserController(options: AskUserControllerOptions): AskUserController {
	const { fs, scheduler } = options;
	const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
	const makeUuid = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
	let busy = false;

	return {
		async ask(request, signal) {
			if (busy) return { status: "busy" };
			busy = true;
			try {
				return await runQuestion(request, signal);
			} finally {
				busy = false;
			}
		},
	};

	async function runQuestion(
		request: AskUserRequest,
		signal: AbortSignal | undefined,
	): Promise<AskUserOutcome> {
		// Aborted before entry: do not touch the filesystem or open a dialog.
		if (signal?.aborted) return { status: "aborted" };

		const { route } = request;
		const id = route === null ? "" : makeUuid();
		const dialog = new AbortController();
		let winner: "tui" | "file" | "aborted" | null = null;
		let fileAnswer: AskAnswer | null = null;
		let pendingWritten = false;
		let blockedReported = false;
		let pollHandle: unknown = null;

		const stopPolling = () => {
			if (pollHandle === null) return;
			scheduler.clearTimeout(pollHandle);
			pollHandle = null;
		};

		const onExternalAbort = () => {
			if (winner !== null) return;
			// Record before aborting: `select`/`input` resolve `undefined` for
			// both Esc and abort, and the dialog must not turn into "dismissed".
			winner = "aborted";
			stopPolling();
			dialog.abort();
		};

		const considerAnswer = () => {
			if (winner !== null || route === null) return;
			let body: string | null = null;
			try {
				body = fs.read(route.answerPath, MAX_ANSWER_BYTES);
			} catch {
				body = null;
			}
			if (body === null) return;
			const parsed = parseAnswerFile(body);
			// A mismatched id may be the next question's answer that was renamed
			// into place between our read and our delete.  Leave it alone.
			if (parsed === null || parsed.id !== id) return;
			const valid = validateAnswerForQuestion(parsed.answer, request.options);
			if (!valid.ok) return;
			winner = "file";
			fileAnswer = valid.value;
			stopPolling();
			dialog.abort();
		};

		const poll = () => {
			pollHandle = null;
			considerAnswer();
			if (winner !== null) return;
			pollHandle = scheduler.setTimeout(poll, pollMs);
		};

		signal?.addEventListener("abort", onExternalAbort);

		try {
			if (route !== null) {
				// Remove leftovers from the previous question before writing the
				// new pending file.  No answer to the new question can exist yet.
				try {
					fs.remove(route.pendingPath);
					fs.remove(route.answerPath);
				} catch {
					// Best-effort stale cleanup.
				}
				try {
					pendingWritten = fs.write(
						route.pendingPath,
						serializePending({
							v: FORMAT_VERSION,
							id,
							question: request.question,
							options: request.options,
						}),
					);
				} catch {
					pendingWritten = false;
				}
				if (pendingWritten) {
					try {
						options.notifyBlocked?.(true);
						blockedReported = true;
					} catch {
						// Reporting is best-effort; the dialog still works.
					}
					pollHandle = scheduler.setTimeout(poll, pollMs);
				}
			}

			const tuiValue = await request.prompt(dialog.signal);

			if (winner === "file" && fileAnswer !== null) {
				return { status: "answered", answer: fileAnswer, winner: "file" };
			}
			if (winner === "aborted") return { status: "aborted" };

			stopPolling();
			winner = "tui";

			if (tuiValue === undefined) return { status: "dismissed" };
			if (request.options !== null) {
				if (!request.options.includes(tuiValue)) {
					return { status: "invalid", error: "the selected answer is not one of the offered options" };
				}
				return { status: "answered", answer: { kind: "option", label: tuiValue }, winner: "tui" };
			}
			if (tuiValue.trim() === "") return { status: "dismissed" };
			const text = validateAnswerText(tuiValue);
			if (!text.ok) return { status: "invalid", error: text.error };
			return { status: "answered", answer: { kind: "text", text: text.value }, winner: "tui" };
		} finally {
			stopPolling();
			signal?.removeEventListener("abort", onExternalAbort);
			if (route !== null && pendingWritten) {
				try {
					fs.remove(route.pendingPath);
				} catch {
					// Best-effort cleanup.
				}
				try {
					fs.remove(route.answerPath);
				} catch {
					// Best-effort cleanup.
				}
			}
			if (blockedReported) {
				try {
					options.notifyBlocked?.(false);
				} catch {
					// Best-effort cleanup.
				}
			}
		}
	}
}
