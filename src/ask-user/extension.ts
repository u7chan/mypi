import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
	answerPathFor,
	BLOCKED_LABEL,
	createAskUserController,
	defaultScheduler,
	displayOptions,
	MAX_OPTIONS,
	MAX_QUESTION_CODEPOINTS,
	MIN_OPTIONS,
	normalizeOptions,
	normalizeQuestion,
	normalizeRecommended,
	pendingPathFor,
	RECOMMENDED_PREFIX,
	type AskAnswer,
	type AskUserController,
	type AskUserFileSystem,
	type AskUserRoute,
	type AskUserScheduler,
} from "./core.ts";

// Re-export the pure pieces so hwc and the tests can use the same contract
// without loading a Pi runtime.  The extension itself only adapts them to Pi.
export {
	ANSWER_SUFFIX,
	answerPathFor,
	BLOCKED_LABEL,
	codePointLength,
	createAskUserController,
	displayOptions,
	FORMAT_VERSION,
	FREE_TEXT_LABEL,
	isValidUuid,
	MAX_ANSWER_BYTES,
	MAX_ANSWER_CODEPOINTS,
	MAX_OPTION_CODEPOINTS,
	MAX_OPTIONS,
	MAX_PENDING_BYTES,
	MAX_QUESTION_CODEPOINTS,
	MIN_OPTIONS,
	normalizeOptions,
	normalizeQuestion,
	normalizeRecommended,
	parseAnswerFile,
	RECOMMENDED_PREFIX,
	parsePending,
	PENDING_SUFFIX,
	pendingPathFor,
	POLL_INTERVAL_MS,
	serializeAnswer,
	serializePending,
	utf8ByteLength,
	validateAnswerForQuestion,
	validateAnswerText,
} from "./core.ts";
export type {
	AnswerFile,
	AskAnswer,
	AskUserController,
	AskUserControllerOptions,
	AskUserFileSystem,
	AskUserOutcome,
	AskUserRequest,
	AskUserRoute,
	AskUserScheduler,
	OptionDisplay,
	PendingQuestion,
	Validation,
} from "./core.ts";

export interface AskUserEnvironment {
	fs?: AskUserFileSystem;
	scheduler?: AskUserScheduler;
	randomUUID?: () => string;
	/** Injected in tests; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

const TOOL_PARAMETERS: TSchema = {
	type: "object",
	properties: {
		question: {
			type: "string",
			description: `Question for the user (1-${MAX_QUESTION_CODEPOINTS} code points after trimming; newlines allowed)`,
		},
		options: {
			type: "array",
			items: { type: "string" },
			minItems: MIN_OPTIONS,
			maxItems: MAX_OPTIONS,
			description: `Optional choices (${MIN_OPTIONS}-${MAX_OPTIONS}). When set, recommended is required and the user can also type a free-text answer.`,
		},
		recommended: {
			type: "string",
			description: `Required when options is set: one of the option labels you recommend. It is shown first with ${RECOMMENDED_PREFIX.trim()}.`,
		},
	},
	required: ["question"],
	additionalProperties: false,
};

type ToolParams = {
	question?: unknown;
	options?: unknown;
	recommended?: unknown;
};

type AskUserDetails =
	| { status: "answered"; askId: string; winner: "tui" | "file"; kind: "option" | "text" }
	| { status: "dismissed"; askId: string }
	| { status: "aborted"; askId: string }
	| { status: "busy" }
	| { status: "unsupported" }
	| { status: "invalid"; askId: string; error: string };

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
	details: AskUserDetails;
};

let temporaryCount = 0;

/**
 * Atomic writes with 0600 and a tmp file that is removed on failure.
 * live-thinking's sink leaves the tmp behind, so its implementation is not
 * reused here.  Every error is swallowed: a full disk must not stop the
 * dialog, and `write` returning false only disables the Web answer path.
 */
const defaultFileSystem: AskUserFileSystem = {
	read(path, maxBytes) {
		try {
			if (statSync(path).size > maxBytes) return null;
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	},
	write(path, body) {
		const temporary = `${path}.${process.pid}.${temporaryCount++}.tmp`;
		try {
			writeFileSync(temporary, body, { mode: 0o600 });
			renameSync(temporary, path);
			return true;
		} catch {
			try {
				unlinkSync(temporary);
			} catch {
				// The temporary file may not have been created.
			}
			return false;
		}
	},
	remove(path) {
		try {
			unlinkSync(path);
		} catch {
			// Missing is the normal case.
		}
	},
};

function sessionFileOf(ctx: ExtensionContext): string | null {
	try {
		return ctx.sessionManager.getSessionFile() ?? null;
	} catch {
		return null;
	}
}

/**
 * The Web contract and `herdr:blocked` are enabled only for a persistent
 * Herdr TUI: RPC/print/json have no pane, and `--no-session` has nowhere to
 * put the pending file.
 */
function routeFor(
	ctx: ExtensionContext,
	env: Record<string, string | undefined>,
): AskUserRoute | null {
	if (ctx.mode !== "tui") return null;
	if (env.HERDR_ENV !== "1") return null;
	if (!env.HERDR_SOCKET_PATH) return null;
	if (!env.HERDR_PANE_ID) return null;
	const sessionFile = sessionFileOf(ctx);
	if (sessionFile === null) return null;
	return { pendingPath: pendingPathFor(sessionFile), answerPath: answerPathFor(sessionFile) };
}

function answerText(answer: AskAnswer): string {
	return answer.kind === "option" ? answer.label : answer.text;
}

function errorResult(details: AskUserDetails, text: string): ToolResult {
	return { content: [{ type: "text", text }], isError: true, details };
}

function mapOutcome(outcome: Awaited<ReturnType<AskUserController["ask"]>>): ToolResult {
	switch (outcome.status) {
		case "answered":
			return {
				content: [{ type: "text", text: `ユーザーの回答: ${answerText(outcome.answer)}` }],
				details: {
					status: "answered",
					askId: outcome.askId,
					winner: outcome.winner,
					kind: outcome.answer.kind,
				},
			};
		case "dismissed":
			return {
				content: [{ type: "text", text: "ユーザーは回答しませんでした。" }],
				details: { status: "dismissed", askId: outcome.askId },
			};
		case "aborted":
			return errorResult(
				{ status: "aborted", askId: outcome.askId },
				"ask_user was interrupted before the user answered.",
			);
		case "busy":
			return errorResult(
				{ status: "busy" },
				"ask_user is already waiting for an answer in this session; answer or dismiss the open question first.",
			);
		case "invalid":
			return errorResult(
				{ status: "invalid", askId: outcome.askId, error: outcome.error },
				`ask_user: ${outcome.error}`,
			);
	}
}

/**
 * Adds the `ask_user` tool: the model asks one question and waits for either
 * the TUI/RPC dialog or an answer file written by hwc.
 *
 * Inside a persistent Herdr TUI the tool also writes `<session>.ask.json` and
 * reports `herdr:blocked` while it waits, so hwc shows the pane as needing
 * attention and can answer from the Web.  Everywhere else only the dialog is
 * used.  The tool result is the answer (`ユーザーの回答: ...`), so answering
 * never approves a bash/edit call.
 */
export default function askUserExtension(pi: ExtensionAPI, environment?: AskUserEnvironment): void {
	const fs = environment?.fs ?? defaultFileSystem;
	const scheduler = environment?.scheduler ?? defaultScheduler;
	const env = environment?.env ?? process.env;
	const controller = createAskUserController({
		fs,
		scheduler,
		randomUUID: environment?.randomUUID ?? randomUUID,
		notifyBlocked: (active) => {
			pi.events.emit("herdr:blocked", { active, label: BLOCKED_LABEL });
		},
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: "ユーザーに質問して回答を待つ",
		promptSnippet: "Ask the user a question and wait for the answer",
		promptGuidelines: [
			"リポジトリや会話から決められない判断だけに使い、日常的な確認には使わない",
			"options を渡すときは recommended に推奨する選択肢を 1 つ指定する",
			"options があってもユーザーは自由入力できる",
			"回答は bash / edit の実行を許可しない",
			"対話セッションでのみ使える",
		],
		parameters: TOOL_PARAMETERS,
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const params = rawParams as ToolParams;
			const question = normalizeQuestion(params.question);
			if (!question.ok) {
				return errorResult({ status: "invalid", askId: "", error: question.error }, question.error);
			}
			const options = normalizeOptions(params.options);
			if (!options.ok) {
				return errorResult({ status: "invalid", askId: "", error: options.error }, options.error);
			}
			const recommended = normalizeRecommended(params.recommended, options.value);
			if (!recommended.ok) {
				return errorResult(
					{ status: "invalid", askId: "", error: recommended.error },
					recommended.error,
				);
			}

			if (!ctx.hasUI) {
				return errorResult(
					{ status: "unsupported" },
					"ask_user requires an interactive session (TUI or RPC).",
				);
			}

			const route = routeFor(ctx, env);
			try {
				const outcome = await controller.ask(
					{
						question: question.value,
						options: options.value,
						recommended: recommended.value,
						freeText: true,
						route,
						prompt: async (dialogSignal) => {
							if (options.value === null) {
								const text = await ctx.ui.input(question.value, "", { signal: dialogSignal });
								return text === undefined ? undefined : { kind: "text", text };
							}
							const display = displayOptions(options.value, recommended.value, true);
							const picked = await ctx.ui.select(question.value, display.labels, {
								signal: dialogSignal,
							});
							if (picked === undefined) return undefined;
							if (picked === display.freeTextLabel) {
								const text = await ctx.ui.input(question.value, "", { signal: dialogSignal });
								return text === undefined ? undefined : { kind: "text", text };
							}
							const label = display.byLabel.get(picked);
							return label === undefined
								? { kind: "option", label: picked }
								: { kind: "option", label };
						},
					},
					signal,
				);
				return mapOutcome(outcome);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(
					{ status: "invalid", askId: "", error: message },
					`ask_user: ${message}`,
				);
			}
		},
	});
}
