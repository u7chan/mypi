import { describe, expect, test } from "bun:test";
import {
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
	parsePending,
	PENDING_SUFFIX,
	pendingPathFor,
	POLL_INTERVAL_MS,
	RECOMMENDED_PREFIX,
	serializeAnswer,
	serializePending,
	validateAnswerForQuestion,
	validateAnswerText,
	type AskAnswer,
	type AskUserController,
	type AskUserFileSystem,
	type AskUserRoute,
} from "../src/ask-user/extension.ts";
import registerAskUser from "../src/ask-user/extension.ts";

const SESSION = "/agent/sessions/slug/2026-11-22T00-00-00-000Z_01a1.jsonl";
const PENDING = pendingPathFor(SESSION);
const ANSWER = answerPathFor(SESSION);
const ROUTE: AskUserRoute = { pendingPath: PENDING, answerPath: ANSWER };
const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function createFakeFileSystem(options: { failWrite?: boolean; readThrows?: boolean } = {}) {
	const files = new Map<string, string>();
	const log: Array<{ op: "read" | "write" | "remove"; path: string }> = [];
	const fs: AskUserFileSystem = {
		read(path, maxBytes) {
			log.push({ op: "read", path });
			if (options.readThrows) throw new Error("read failed");
			const body = files.get(path);
			if (body === undefined) return null;
			return new TextEncoder().encode(body).length > maxBytes ? null : body;
		},
		write(path, body) {
			log.push({ op: "write", path });
			if (options.failWrite) return false;
			files.set(path, body);
			return true;
		},
		remove(path) {
			log.push({ op: "remove", path });
			files.delete(path);
		},
	};
	return { fs, files, log, ops: () => log.map((entry) => `${entry.op}:${entry.path}`) };
}

function createClock() {
	const timers = new Map<number, { due: number; callback: () => void }>();
	let clock = 0;
	let nextId = 1;
	const scheduler = {
		setTimeout: (callback: () => void, delayMs: number) => {
			const id = nextId++;
			timers.set(id, { due: clock + delayMs, callback });
			return id;
		},
		clearTimeout: (handle: unknown) => {
			timers.delete(handle as number);
		},
	};
	return {
		scheduler,
		advance: (ms: number) => {
			clock += ms;
			for (const [id, timer] of [...timers]) {
				if (timer.due > clock) continue;
				timers.delete(id);
				timer.callback();
			}
		},
		pendingTimers: () => timers.size,
	};
}

/** A dialog whose promise resolves `undefined` on abort, like Pi's. */
function createDialog() {
	const signals: AbortSignal[] = [];
	let resolve: (value: AskAnswer | undefined) => void = () => {};
	const prompt = (signal: AbortSignal) => {
		signals.push(signal);
		return new Promise<AskAnswer | undefined>((done) => {
			resolve = done;
			signal.addEventListener("abort", () => done(undefined), { once: true });
		});
	};
	return {
		prompt,
		signals,
		answer: (value: AskAnswer | undefined) => resolve(value),
		answerOption: (label: string) => resolve({ kind: "option", label }),
		answerText: (text: string) => resolve({ kind: "text", text }),
		signal: () => signals.at(-1),
	};
}

/** The TUI select/input adapters still exchange plain strings. */
function createStringDialog() {
	const signals: AbortSignal[] = [];
	let resolve: (value: string | undefined) => void = () => {};
	const prompt = (signal: AbortSignal) => {
		signals.push(signal);
		return new Promise<string | undefined>((done) => {
			resolve = done;
			signal.addEventListener("abort", () => done(undefined), { once: true });
		});
	};
	return {
		prompt,
		signals,
		answer: (value: string | undefined) => resolve(value),
		signal: () => signals.at(-1),
	};
}

function setup(options: { failWrite?: boolean; readThrows?: boolean } = {}) {
	const fake = createFakeFileSystem(options);
	const clock = createClock();
	const blocked: boolean[] = [];
	const controller = createAskUserController({
		fs: fake.fs,
		scheduler: clock.scheduler,
		pollMs: POLL_INTERVAL_MS,
		randomUUID: () => ID,
		notifyBlocked: (active) => {
			blocked.push(active);
		},
	});
	return { ...fake, ...clock, blocked, controller };
}

function request(
	controller: AskUserController,
	dialog: ReturnType<typeof createDialog>,
	options: {
		question?: string;
		choices?: string[] | null;
		recommended?: string | null;
		freeText?: boolean;
		route?: AskUserRoute | null;
		signal?: AbortSignal;
	} = {},
) {
	const choices = options.choices === undefined ? ["A", "B"] : options.choices;
	return controller.ask(
		{
			question: options.question ?? "Which one?",
			options: choices,
			recommended:
				options.recommended === undefined
					? choices === null
						? null
						: choices[0] ?? null
					: options.recommended,
			freeText: options.freeText ?? true,
			route: options.route === undefined ? ROUTE : options.route,
			prompt: dialog.prompt,
		},
		options.signal,
	);
}

describe("question and option validation", () => {
	test("question normalizes CRLF and trims, but keeps internal newlines", () => {
		expect(normalizeQuestion("  first\r\nsecond\rthird  ")).toEqual({
			ok: true,
			value: "first\nsecond\nthird",
		});
		expect(normalizeQuestion("line one\nline two")).toEqual({ ok: true, value: "line one\nline two" });
	});

	test("question rejects empty, oversized and non-newline control characters", () => {
		expect(normalizeQuestion(undefined).ok).toBe(false);
		expect(normalizeQuestion("   ").ok).toBe(false);
		expect(normalizeQuestion("a".repeat(MAX_QUESTION_CODEPOINTS)).ok).toBe(true);
		expect(normalizeQuestion("a".repeat(MAX_QUESTION_CODEPOINTS + 1)).ok).toBe(false);
		expect(normalizeQuestion("ok\u0000bad").ok).toBe(false);
		expect(normalizeQuestion("\u001b[31mred").ok).toBe(false);
		// Code points, not UTF-16 units.
		expect(normalizeQuestion("😀".repeat(MAX_QUESTION_CODEPOINTS)).ok).toBe(true);
		expect(normalizeQuestion("😀".repeat(MAX_QUESTION_CODEPOINTS + 1)).ok).toBe(false);
	});

	test("options are optional, trimmed, unique, 2-6 and single-line", () => {
		expect(normalizeOptions(undefined)).toEqual({ ok: true, value: null });
		expect(normalizeOptions(null)).toEqual({ ok: true, value: null });
		expect(normalizeOptions([" Yes ", "No"])).toEqual({ ok: true, value: ["Yes", "No"] });
		expect(normalizeOptions(["A"]).ok).toBe(false);
		expect(normalizeOptions(["A", "B", "C", "D", "E", "F", "G"]).ok).toBe(false);
		expect(normalizeOptions(["A", " A "]).ok).toBe(false);
		expect(normalizeOptions(["A", "B\nC"]).ok).toBe(false);
		expect(normalizeOptions(["A", "B\u0000"]).ok).toBe(false);
		expect(normalizeOptions(["A", "B", "C", "D", "E", "F"]).ok).toBe(true);
		expect(normalizeOptions(["x".repeat(MAX_OPTION_CODEPOINTS), "B"]).ok).toBe(true);
		expect(normalizeOptions(["x".repeat(MAX_OPTION_CODEPOINTS + 1), "B"]).ok).toBe(false);
		expect(normalizeOptions(["A", 2]).ok).toBe(false);
		expect(MIN_OPTIONS).toBe(2);
		expect(MAX_OPTIONS).toBe(6);
	});

	test("recommended is required with options and must be one of them", () => {
		expect(normalizeRecommended(undefined, null)).toEqual({ ok: true, value: null });
		expect(normalizeRecommended(null, null)).toEqual({ ok: true, value: null });
		expect(normalizeRecommended("A", null).ok).toBe(false);
		expect(normalizeRecommended(undefined, ["A", "B"]).ok).toBe(false);
		expect(normalizeRecommended(" C ", ["A", "B"]).ok).toBe(false);
		expect(normalizeRecommended(" B ", ["A", "B"])).toEqual({ ok: true, value: "B" });
	});

	test("the TUI list puts the recommended label first and maps it back to the raw label", () => {
		expect(displayOptions(["A", "B", "C"], "B", true)).toEqual({
			labels: ["推奨💡 B", "A", "C", FREE_TEXT_LABEL],
			byLabel: new Map([
				["推奨💡 B", "B"],
				["A", "A"],
				["C", "C"],
			]),
			freeTextLabel: FREE_TEXT_LABEL,
		});
		expect(displayOptions(["A", "B"], "A", false)).toEqual({
			labels: [`${RECOMMENDED_PREFIX}A`, "B"],
			byLabel: new Map([
				[`${RECOMMENDED_PREFIX}A`, "A"],
				["B", "B"],
			]),
			freeTextLabel: null,
		});
	});

	test("the free-text row keeps its label when the model offers the same label", () => {
		const display = displayOptions([FREE_TEXT_LABEL, "B"], "B", true);
		expect(new Set(display.labels).size).toBe(display.labels.length);
		expect(display.freeTextLabel).toBe(FREE_TEXT_LABEL);
		expect(display.labels).toEqual([
			`${RECOMMENDED_PREFIX}B`,
			`${FREE_TEXT_LABEL}（選択肢）`,
			FREE_TEXT_LABEL,
		]);
		expect(display.byLabel.get(`${FREE_TEXT_LABEL}（選択肢）`)).toBe(FREE_TEXT_LABEL);
		// The canonical row always means free text, never the model option.
		expect(display.byLabel.get(FREE_TEXT_LABEL)).toBeUndefined();
	});

	test("free-text answers are trimmed and keep internal newlines and tabs", () => {
		expect(validateAnswerText("  first\nsecond\tthird  ")).toEqual({
			ok: true,
			value: "first\nsecond\tthird",
		});
		expect(validateAnswerText("   ").ok).toBe(false);
		expect(validateAnswerText("bad\rreturn").ok).toBe(false);
		expect(validateAnswerText("bad\u0001control").ok).toBe(false);
		expect(validateAnswerText("x".repeat(MAX_ANSWER_CODEPOINTS)).ok).toBe(true);
		expect(validateAnswerText("x".repeat(MAX_ANSWER_CODEPOINTS + 1)).ok).toBe(false);
		expect(validateAnswerText("😀".repeat(MAX_ANSWER_CODEPOINTS)).ok).toBe(true);
		expect(codePointLength("😀a")).toBe(2);
	});
});

describe("file contract", () => {
	const pending = {
		v: FORMAT_VERSION,
		id: ID,
		question: "Which one?",
		options: ["A", "B"],
		recommended: "A",
		freeText: true,
	} as const;

	test("serializes one JSON line with a trailing newline", () => {
		expect(serializePending(pending)).toBe(`${JSON.stringify(pending)}\n`);
		expect(serializePending({ ...pending, options: null, recommended: null })).toContain('"options":null');
		expect(serializePending({ ...pending, options: null, recommended: null })).toContain('"recommended":null');
		const answer = { v: FORMAT_VERSION, id: ID, answer: { kind: "option", label: "A" } } as const;
		expect(serializeAnswer(answer)).toBe(`${JSON.stringify(answer)}\n`);
	});

	test("round-trips pending and answers", () => {
		expect(parsePending(serializePending(pending))).toEqual(pending);
		expect(parsePending(serializePending({ ...pending, question: "a\r\nb" }))?.question).toBe("a\nb");
		// An old v1 pending has neither field.  The recommendation is dropped and
		// text stays unavailable while options are present.
		expect(
			parsePending(JSON.stringify({ v: 1, id: ID, question: "Q", options: ["A", "B"] })),
		).toEqual({ v: 1, id: ID, question: "Q", options: ["A", "B"], recommended: null, freeText: false });
		expect(
			parsePending(JSON.stringify({ v: 1, id: ID, question: "Q", options: null })),
		).toMatchObject({ recommended: null, freeText: true });
		// A recommendation that is not an offered label is a decoration error.
		expect(
			parsePending(
				JSON.stringify({ ...pending, recommended: "C" }),
			)?.recommended,
		).toBeNull();
		expect(parseAnswerFile(serializeAnswer({ v: FORMAT_VERSION, id: ID, answer: { kind: "option", label: "A" } })))
			.toEqual({ v: FORMAT_VERSION, id: ID, answer: { kind: "option", label: "A" } });
		expect(
			parseAnswerFile(
				serializeAnswer({ v: FORMAT_VERSION, id: ID, answer: { kind: "text", text: "  hi\nthere  " } }),
			)?.answer,
		).toEqual({ kind: "text", text: "hi\nthere" });
	});

	test("paths are the session path plus a fixed suffix", () => {
		expect(PENDING).toBe(`${SESSION}${PENDING_SUFFIX}`);
		expect(ANSWER).toBe(`${SESSION}${ANSWER_SUFFIX}`);
		expect(isValidUuid(ID)).toBe(true);
		expect(isValidUuid("not-a-uuid")).toBe(false);
		expect(isValidUuid(undefined)).toBe(false);
	});

	test("rejects unknown versions, broken JSON, invalid shape and oversized bodies", () => {
		expect(parsePending("not json")).toBeNull();
		expect(parsePending(JSON.stringify({ ...pending, v: 2 }))).toBeNull();
		expect(parsePending(JSON.stringify({ ...pending, id: "nope" }))).toBeNull();
		expect(parsePending(JSON.stringify({ ...pending, question: "   " }))).toBeNull();
		expect(parsePending(JSON.stringify({ ...pending, options: ["A"] }))).toBeNull();
		expect(parsePending(JSON.stringify({ v: 1, id: ID, question: "Q" }))).toBeNull();
		expect(parsePending(`${"x".repeat(MAX_PENDING_BYTES + 1)}`)).toBeNull();
		const long = JSON.stringify({ ...pending, question: "a".repeat(MAX_QUESTION_CODEPOINTS + 1) });
		expect(parsePending(long)).toBeNull();

		expect(parseAnswerFile("not json")).toBeNull();
		expect(parseAnswerFile(JSON.stringify({ v: 2, id: ID, answer: { kind: "option", label: "A" } }))).toBeNull();
		expect(parseAnswerFile(JSON.stringify({ v: 1, id: "nope", answer: { kind: "option", label: "A" } }))).toBeNull();
		expect(parseAnswerFile(JSON.stringify({ v: 1, id: ID, answer: { kind: "nope" } }))).toBeNull();
		expect(
			parseAnswerFile(JSON.stringify({ v: 1, id: ID, answer: { kind: "text", text: "bad\rreturn" } })),
		).toBeNull();
		expect(parseAnswerFile(`${"x".repeat(MAX_ANSWER_BYTES + 1)}`)).toBeNull();
	});

	test("an option must be offered; text needs free text or no options", () => {
		expect(validateAnswerForQuestion({ kind: "option", label: "A" }, ["A", "B"]).ok).toBe(true);
		expect(validateAnswerForQuestion({ kind: "option", label: "C" }, ["A", "B"]).ok).toBe(false);
		expect(validateAnswerForQuestion({ kind: "option", label: "A" }, null).ok).toBe(false);
		expect(validateAnswerForQuestion({ kind: "text", text: "hello" }, ["A", "B"]).ok).toBe(false);
		expect(validateAnswerForQuestion({ kind: "text", text: "  hello  " }, ["A", "B"], true)).toEqual({
			ok: true,
			value: { kind: "text", text: "hello" } satisfies AskAnswer,
		});
		expect(validateAnswerForQuestion({ kind: "text", text: "hello" }, null)).toEqual({
			ok: true,
			value: { kind: "text", text: "hello" } satisfies AskAnswer,
		});
	});
});

describe("TUI and Web race", () => {
	test("a TUI option is the answer and cleanup runs pending then answer", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog);

		expect(parsePending(h.files.get(PENDING) ?? "")).toEqual({
			v: FORMAT_VERSION,
			id: ID,
			question: "Which one?",
			options: ["A", "B"],
			recommended: "A",
			freeText: true,
		});
		expect(h.blocked).toEqual([true]);
		expect(h.pendingTimers()).toBe(1);

		dialog.answerOption("B");
		expect(await promise).toEqual({
			status: "answered",
			askId: ID,
			answer: { kind: "option", label: "B" },
			winner: "tui",
		});
		expect(h.blocked).toEqual([true, false]);
		expect(h.ops()).toEqual([
			`remove:${PENDING}`,
			`remove:${ANSWER}`,
			`write:${PENDING}`,
			`remove:${PENDING}`,
			`remove:${ANSWER}`,
		]);
		expect(h.files.size).toBe(0);
		expect(h.pendingTimers()).toBe(0);
	});

	test("a free-text TUI answer is trimmed and keeps inner whitespace", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog, { choices: null });
		expect(JSON.parse(h.files.get(PENDING) ?? "{}").options).toBeNull();
		dialog.answerText("  first\nsecond\t  ");
		expect(await promise).toEqual({
			status: "answered",
			askId: ID,
			answer: { kind: "text", text: "first\nsecond" },
			winner: "tui",
		});
	});

	test("closing the dialog is dismissed, not aborted, and still cleans up", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog);
		dialog.answer(undefined);
		expect(await promise).toEqual({ status: "dismissed", askId: ID });
		expect(h.blocked).toEqual([true, false]);
		expect(h.files.size).toBe(0);
	});

	test("an empty free-text dialog answer is dismissed", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog, { choices: null });
		dialog.answerText("   ");
		expect(await promise).toEqual({ status: "dismissed", askId: ID });
	});

	test("a Web answer wins while the dialog is open and aborts it", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog);

		h.files.set(ANSWER, serializeAnswer({ v: FORMAT_VERSION, id: ID, answer: { kind: "option", label: "A" } }));
		h.advance(POLL_INTERVAL_MS);

		expect(dialog.signal()?.aborted).toBe(true);
		expect(await promise).toEqual({
			status: "answered",
			askId: ID,
			answer: { kind: "option", label: "A" },
			winner: "file",
		});
		expect(h.blocked).toEqual([true, false]);
		expect(h.files.size).toBe(0);
		expect(h.pendingTimers()).toBe(0);
	});

	test("a mismatched answer id is ignored and left on disk while waiting", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog);

		h.files.set(
			ANSWER,
			serializeAnswer({ v: FORMAT_VERSION, id: OTHER_ID, answer: { kind: "option", label: "A" } }),
		);
		h.advance(POLL_INTERVAL_MS);
		expect(h.files.has(ANSWER)).toBe(true);
		expect(dialog.signal()?.aborted).toBe(false);

		// The same stale file is still there on the next poll.
		h.advance(POLL_INTERVAL_MS);
		expect(h.files.has(ANSWER)).toBe(true);
		expect(dialog.signal()?.aborted).toBe(false);

		h.files.set(ANSWER, serializeAnswer({ v: FORMAT_VERSION, id: ID, answer: { kind: "option", label: "B" } }));
		h.advance(POLL_INTERVAL_MS);
		expect(await promise).toEqual({
			status: "answered",
			askId: ID,
			answer: { kind: "option", label: "B" },
			winner: "file",
		});
	});

	test("an answer outside the offered options is ignored", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog, { freeText: false });

		h.files.set(ANSWER, serializeAnswer({ v: FORMAT_VERSION, id: ID, answer: { kind: "option", label: "C" } }));
		h.advance(POLL_INTERVAL_MS);
		expect(dialog.signal()?.aborted).toBe(false);

		h.files.set(ANSWER, serializeAnswer({ v: FORMAT_VERSION, id: ID, answer: { kind: "text", text: "C" } }));
		h.advance(POLL_INTERVAL_MS);
		expect(dialog.signal()?.aborted).toBe(false);

		dialog.answerOption("A");
		expect(await promise).toMatchObject({ winner: "tui" });
	});

	test("a Web text answer wins when the question allows free text", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog, { freeText: true });

		h.files.set(ANSWER, serializeAnswer({ v: FORMAT_VERSION, id: ID, answer: { kind: "text", text: "  custom  " } }));
		h.advance(POLL_INTERVAL_MS);

		expect(dialog.signal()?.aborted).toBe(true);
		expect(await promise).toEqual({
			status: "answered",
			askId: ID,
			answer: { kind: "text", text: "custom" },
			winner: "file",
		});
	});

	test("a TUI answer that lands before the next poll wins and removes the Web file", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog);
		h.files.set(ANSWER, serializeAnswer({ v: FORMAT_VERSION, id: ID, answer: { kind: "option", label: "A" } }));
		dialog.answerOption("B");
		expect(await promise).toEqual({
			status: "answered",
			askId: ID,
			answer: { kind: "option", label: "B" },
			winner: "tui",
		});
		expect(h.files.size).toBe(0);
	});

	test("external abort is an abort, not a dismissed dialog, and files are removed", async () => {
		const h = setup();
		const dialog = createDialog();
		const controller = new AbortController();
		const promise = request(h.controller, dialog, { signal: controller.signal });
		controller.abort();
		expect(dialog.signal()?.aborted).toBe(true);
		expect(await promise).toEqual({ status: "aborted", askId: ID });
		expect(h.blocked).toEqual([true, false]);
		expect(h.files.size).toBe(0);
		expect(h.pendingTimers()).toBe(0);
	});

	test("an already aborted call touches neither files nor the dialog and frees the slot", async () => {
		const h = setup();
		const dialog = createDialog();
		const controller = new AbortController();
		controller.abort();
		expect(await request(h.controller, dialog, { signal: controller.signal })).toEqual({ status: "aborted", askId: "" });
		expect(h.log).toEqual([]);
		expect(h.blocked).toEqual([]);
		expect(dialog.signals).toEqual([]);

		const next = request(h.controller, dialog);
		dialog.answerOption("A");
		expect((await next).status).toBe("answered");
	});

	test("a parallel second question returns busy without touching files or UI", async () => {
		const h = setup();
		const firstDialog = createDialog();
		const first = request(h.controller, firstDialog);
		const secondDialog = createDialog();
		expect(await request(h.controller, secondDialog)).toEqual({ status: "busy" });
		expect(secondDialog.signals).toEqual([]);
		expect(h.ops().filter((entry) => entry === `write:${PENDING}`)).toHaveLength(1);
		expect(h.blocked).toEqual([true]);

		firstDialog.answerOption("A");
		expect((await first).status).toBe("answered");
		expect(h.blocked).toEqual([true, false]);
	});

	test("without a route (non-Herdr, RPC, or --no-session) nothing is written or reported", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog, { route: null });
		dialog.answerOption("A");
		expect(await promise).toEqual({
			status: "answered",
			askId: "",
			answer: { kind: "option", label: "A" },
			winner: "tui",
		});
		expect(h.log).toEqual([]);
		expect(h.blocked).toEqual([]);
	});

	test("a failed pending write skips monitoring and blocked reporting but keeps the dialog", async () => {
		const h = setup({ failWrite: true });
		const dialog = createDialog();
		const promise = request(h.controller, dialog);
		expect(h.blocked).toEqual([]);
		expect(h.pendingTimers()).toBe(0);

		h.advance(POLL_INTERVAL_MS * 4);
		expect(h.ops().filter((entry) => entry.startsWith("read:"))).toEqual([]);

		dialog.answerOption("A");
		expect((await promise).status).toBe("answered");
		expect(h.blocked).toEqual([]);
		// Only the stale cleanup and the attempted write; no post-cleanup.
		expect(h.ops()).toEqual([
			`remove:${PENDING}`,
			`remove:${ANSWER}`,
			`write:${PENDING}`,
		]);
	});

	test("stale files are removed before the new pending file is written", async () => {
		const h = setup();
		h.files.set(PENDING, "old");
		h.files.set(ANSWER, "old");
		const dialog = createDialog();
		const promise = request(h.controller, dialog);
		expect(h.ops().slice(0, 3)).toEqual([
			`remove:${PENDING}`,
			`remove:${ANSWER}`,
			`write:${PENDING}`,
		]);
		dialog.answerOption("A");
		await promise;
	});

	test("a throwing read does not break the wait", async () => {
		const h = setup({ readThrows: true });
		const dialog = createDialog();
		const promise = request(h.controller, dialog);
		h.advance(POLL_INTERVAL_MS);
		expect(dialog.signal()?.aborted).toBe(false);
		dialog.answerOption("A");
		expect((await promise).status).toBe("answered");
	});

	test("an invalid TUI option is rejected instead of being returned", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog);
		dialog.answerOption("not offered");
		expect(await promise).toEqual({
			status: "invalid",
			askId: ID,
			error: "the answer is not one of the offered options",
		});
		expect(h.blocked).toEqual([true, false]);
	});

	test("an oversized TUI free-text answer is rejected", async () => {
		const h = setup();
		const dialog = createDialog();
		const promise = request(h.controller, dialog, { choices: null });
		dialog.answerText("x".repeat(MAX_ANSWER_CODEPOINTS + 1));
		expect(await promise).toMatchObject({ status: "invalid" });
	});
});

function createPi() {
	const tools = new Map<string, any>();
	const events: Array<{ channel: string; data: unknown }> = [];
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		events: {
			emit(channel: string, data: unknown) {
				events.push({ channel, data });
			},
			on() {
				return () => {};
			},
		},
	};
	return { pi, tools, events };
}

function createContext(options: {
	mode?: "tui" | "rpc" | "print" | "json";
	hasUI?: boolean;
	sessionFile?: string | null;
	select?: (title: string, choices: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
	input?: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
}) {
	const calls: Array<{ kind: "select" | "input"; title: string; choices?: string[] }> = [];
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		sessionManager: { getSessionFile: () => (options.sessionFile === undefined ? SESSION : options.sessionFile) },
		ui: {
			select: (title: string, choices: string[], opts?: { signal?: AbortSignal }) => {
				calls.push({ kind: "select", title, choices });
				return options.select ? options.select(title, choices, opts) : Promise.resolve(undefined);
			},
			input: (title: string, placeholder: string, opts?: { signal?: AbortSignal }) => {
				calls.push({ kind: "input", title });
				return options.input ? options.input(title, placeholder, opts) : Promise.resolve(undefined);
			},
		},
	};
	return { ctx, calls };
}

const HERDR_ENV = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "w1:p1" };

function register(options: { failWrite?: boolean; env?: Record<string, string | undefined> } = {}) {
	const h = setup({ failWrite: options.failWrite });
	const { pi, tools, events } = createPi();
	registerAskUser(pi as never, {
		fs: h.fs,
		scheduler: h.scheduler,
		randomUUID: () => ID,
		env: options.env ?? HERDR_ENV,
	});
	return { ...h, tools, events, tool: tools.get("ask_user") };
}

describe("extension adapter", () => {
	test("Herdr TUI writes the pending file, reports blocked, and cleans up on abort", async () => {
		const h = register();
		const dialog = createStringDialog();
		const { ctx } = createContext({ select: (_title, _choices, opts) => dialog.prompt(opts!.signal!) });
		const controller = new AbortController();
		const running = h.tool.execute(
			"call-1",
			{ question: "Deploy?", options: ["Yes", "No"], recommended: "Yes" },
			controller.signal,
			undefined,
			ctx,
		);

		expect(parsePending(h.files.get(PENDING) ?? "")).toEqual({
			v: FORMAT_VERSION,
			id: ID,
			question: "Deploy?",
			options: ["Yes", "No"],
			recommended: "Yes",
			freeText: true,
		});
		expect(h.events).toEqual([
			{ channel: "herdr:blocked", data: { active: true, label: BLOCKED_LABEL } },
		]);

		controller.abort();
		const result = await running;
		expect(result).toEqual({
			content: [{ type: "text", text: "ask_user was interrupted before the user answered." }],
			isError: true,
			details: { status: "aborted", askId: ID },
		});
		expect(h.events).toEqual([
			{ channel: "herdr:blocked", data: { active: true, label: BLOCKED_LABEL } },
			{ channel: "herdr:blocked", data: { active: false, label: BLOCKED_LABEL } },
		]);
		expect(h.files.size).toBe(0);
	});

	test("answered and dismissed results use the fixed tool text and always carry details", async () => {
		const option = register();
		const optionContext = createContext({ select: async () => "Yes" });
		expect(
			await option.tool.execute(
				"call-2",
				{ question: "Go?", options: ["Yes", "No"], recommended: "Yes" },
				undefined,
				undefined,
				optionContext.ctx,
			),
		).toEqual({
			content: [{ type: "text", text: "ユーザーの回答: Yes" }],
			details: { status: "answered", askId: ID, winner: "tui", kind: "option" },
		});

		const text = register();
		const textContext = createContext({ input: async () => " free form " });
		expect(
			await text.tool.execute("call-3", { question: "Why?" }, undefined, undefined, textContext.ctx),
		).toEqual({
			content: [{ type: "text", text: "ユーザーの回答: free form" }],
			details: { status: "answered", askId: ID, winner: "tui", kind: "text" },
		});

		const dismissed = register();
		const dismissedContext = createContext({ select: async () => undefined });
		expect(
			await dismissed.tool.execute(
				"call-4",
				{ question: "Go?", options: ["Yes", "No"], recommended: "Yes" },
				undefined,
				undefined,
				dismissedContext.ctx,
			),
		).toEqual({
			content: [{ type: "text", text: "ユーザーは回答しませんでした。" }],
			details: { status: "dismissed", askId: ID },
		});
	});

	test("the dialog receives the question, options and abort signal", async () => {
		const h = register();
		let signal: AbortSignal | undefined;
		const { ctx, calls } = createContext({
			select: async (_title, _choices, opts) => {
				signal = opts?.signal;
				return "No";
			},
		});
		await h.tool.execute(
			"call-5",
			{ question: "Go?", options: ["Yes", "No"], recommended: "Yes" },
			undefined,
			undefined,
			ctx,
		);
		expect(calls).toEqual([
			{
				kind: "select",
				title: "Go?",
				choices: [`${RECOMMENDED_PREFIX}Yes`, "No", FREE_TEXT_LABEL],
			},
		]);
		expect(signal).toBeInstanceOf(AbortSignal);
	});

	test("selecting the recommended row returns the raw label, not the decorated one", async () => {
		const h = register();
		const { ctx } = createContext({ select: async () => `${RECOMMENDED_PREFIX}Yes` });
		expect(
			await h.tool.execute(
				"call-14",
				{ question: "Go?", options: ["Yes", "No"], recommended: "Yes" },
				undefined,
				undefined,
				ctx,
			),
		).toEqual({
			content: [{ type: "text", text: "ユーザーの回答: Yes" }],
			details: { status: "answered", askId: ID, winner: "tui", kind: "option" },
		});
	});

	test("the last row opens free text even when options are present", async () => {
		const h = register();
		const { ctx, calls } = createContext({
			select: async () => FREE_TEXT_LABEL,
			input: async () => "  maybe  ",
		});
		expect(
			await h.tool.execute(
				"call-15",
				{ question: "Go?", options: ["Yes", "No"], recommended: "Yes" },
				undefined,
				undefined,
				ctx,
			),
		).toEqual({
			content: [{ type: "text", text: "ユーザーの回答: maybe" }],
			details: { status: "answered", askId: ID, winner: "tui", kind: "text" },
		});
		expect(calls).toEqual([
			{
				kind: "select",
				title: "Go?",
				choices: [`${RECOMMENDED_PREFIX}Yes`, "No", FREE_TEXT_LABEL],
			},
			{ kind: "input", title: "Go?" },
		]);
	});

	test("RPC and Herdr env still use only the dialog, with no file or blocked report", async () => {
		const h = register();
		const dialog = createStringDialog();
		const { ctx } = createContext({ mode: "rpc", select: (_title, _choices, opts) => dialog.prompt(opts!.signal!) });
		const running = h.tool.execute(
			"call-6",
			{ question: "Go?", options: ["Yes", "No"], recommended: "Yes" },
			undefined,
			undefined,
			ctx,
		);
		dialog.answer("Yes");
		expect(await running).toMatchObject({ details: { status: "answered", winner: "tui" } });
		expect(h.log).toEqual([]);
		expect(h.events).toEqual([]);
	});

	test("the Web contract stays off when any Herdr condition or the session path is missing", async () => {
		for (const env of [
			{ HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "w1:p1" },
			{ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
			{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
			{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "", HERDR_PANE_ID: "w1:p1" },
		]) {
			const h = register({ env });
			const { ctx } = createContext({ select: async () => "Yes" });
			expect(
				await h.tool.execute(
					"call-7",
					{ question: "Go?", options: ["Yes", "No"], recommended: "Yes" },
					undefined,
					undefined,
					ctx,
				),
			).toMatchObject({ details: { status: "answered" } });
			expect(h.log).toEqual([]);
			expect(h.events).toEqual([]);
		}

		const h = register();
		const { ctx } = createContext({ sessionFile: null, select: async () => "Yes" });
		expect(
			await h.tool.execute(
				"call-8",
				{ question: "Go?", options: ["Yes", "No"], recommended: "Yes" },
				undefined,
				undefined,
				ctx,
			),
		).toMatchObject({ details: { status: "answered" } });
		expect(h.log).toEqual([]);
		expect(h.events).toEqual([]);
	});

	test("headless modes refuse before the dialog or filesystem", async () => {
		const h = register();
		const { ctx, calls } = createContext({ mode: "print", hasUI: false });
		const result = await h.tool.execute("call-9", { question: "Go?" }, undefined, undefined, ctx);
		expect(result).toEqual({
			content: [{ type: "text", text: "ask_user requires an interactive session (TUI or RPC)." }],
			isError: true,
			details: { status: "unsupported" },
		});
		expect(calls).toEqual([]);
		expect(h.log).toEqual([]);
		expect(h.events).toEqual([]);
	});

	test("argument validation happens before the dialog and the slot", async () => {
		const h = register();
		const { ctx, calls } = createContext({});
		for (const params of [
			{ question: "" },
			{ question: "x", options: ["only"] },
			{ question: "x", options: ["A", "B"] },
			{ question: "x", options: ["A", "B"], recommended: "C" },
			{ question: "x", recommended: "A" },
			{ question: "x".repeat(MAX_QUESTION_CODEPOINTS + 1) },
			{ question: "ok\u0000" },
		]) {
			const result = await h.tool.execute("call-10", params, undefined, undefined, ctx);
			expect(result.isError).toBe(true);
			expect(result.details.status).toBe("invalid");
		}
		expect(calls).toEqual([]);
		expect(h.log).toEqual([]);
		expect(h.events).toEqual([]);
	});

	test("a failed pending write leaves the dialog working without blocked reports", async () => {
		const h = register({ failWrite: true });
		const { ctx } = createContext({ select: async () => "Yes" });
		expect(
			await h.tool.execute(
				"call-11",
				{ question: "Go?", options: ["Yes", "No"], recommended: "Yes" },
				undefined,
				undefined,
				ctx,
			),
		).toMatchObject({ details: { status: "answered", winner: "tui" } });
		expect(h.events).toEqual([]);
	});

	test("a second parallel call reports busy and the first keeps the slot", async () => {
		const h = register();
		const dialog = createStringDialog();
		const { ctx } = createContext({ select: (_title, _choices, opts) => dialog.prompt(opts!.signal!) });
		const first = h.tool.execute(
			"call-12",
			{ question: "One?", options: ["A", "B"], recommended: "A" },
			undefined,
			undefined,
			ctx,
		);
		expect(
			await h.tool.execute(
				"call-13",
				{ question: "Two?", options: ["A", "B"], recommended: "A" },
				undefined,
				undefined,
				ctx,
			),
		).toEqual({
			content: [
				{
					type: "text",
					text: "ask_user is already waiting for an answer in this session; answer or dismiss the open question first.",
				},
			],
			isError: true,
			details: { status: "busy" },
		});
		dialog.answer("A");
		expect((await first).details).toEqual({ status: "answered", askId: ID, winner: "tui", kind: "option" });
		expect(h.events).toHaveLength(2);
	});
});

test("a dialog exception after pending returns invalid with the pending id", async () => {
	const h = setup();
	const promise = h.controller.ask({
		question: "Which one?",
		options: ["A", "B"],
		recommended: "A",
		freeText: true,
		route: ROUTE,
		prompt: async () => {
			throw new Error("boom");
		},
	});
	expect(await promise).toEqual({ status: "invalid", askId: ID, error: "boom" });
	expect(h.files.size).toBe(0);
	expect(h.blocked).toEqual([true, false]);
});

test("argument validation and pre-pending failures carry an empty askId", async () => {
	const h = register();
	const { ctx } = createContext({});
	expect(
		await h.tool.execute("call-invalid", { question: "   " }, undefined, undefined, ctx),
	).toMatchObject({
		isError: true,
		details: { status: "invalid", askId: "" },
	});

	const { ctx: throwingCtx } = createContext({
		select: async () => {
			throw new Error("boom");
		},
	});
	expect(
		await h.tool.execute(
			"call-throw",
			{ question: "Go?", options: ["Yes", "No"], recommended: "Yes" },
			undefined,
			undefined,
			throwingCtx,
		),
	).toMatchObject({
		isError: true,
		details: { status: "invalid", askId: ID, error: "boom" },
	});
});
