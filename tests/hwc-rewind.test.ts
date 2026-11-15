import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import hwcRewindExtension, {
	CAPABILITY_TYPE,
	FORMAT_VERSION,
	hasCapability,
	ID_PATTERN,
	MARKER_TYPE,
	parseRewindArgs,
	planRewind,
} from "../src/hwc-rewind/extension.ts";

type Entry = {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
	message?: { role?: string };
};

type SessionOptions = {
	entries?: Entry[];
	leafId?: string | null;
	/** `null` models `--no-session`. */
	sessionFile?: string | null;
};

function createSession(options: SessionOptions = {}) {
	const entries: Entry[] = [...(options.entries ?? [])];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	let leafId = options.leafId ?? null;
	let nextId = 1;
	const sessionFile = options.sessionFile === undefined ? "/fixture/session.jsonl" : options.sessionFile;

	return {
		entries,
		getSessionFile: () => sessionFile ?? undefined,
		getEntries: () => [...entries],
		getEntry: (id: string) => byId.get(id),
		getLeafId: () => leafId,
		getBranch: () => {
			const branch: Entry[] = [];
			let id = leafId;
			while (id !== null) {
				const entry = byId.get(id);
				if (!entry) break;
				branch.push(entry);
				id = entry.parentId;
			}
			return branch.reverse();
		},
		appendCustomEntry(customType: string, data: unknown) {
			const entry: Entry = {
				type: "custom",
				customType,
				data,
				id: `c${nextId++}`,
				parentId: leafId,
			};
			entries.push(entry);
			byId.set(entry.id, entry);
			leafId = entry.id;
			return entry.id;
		},
		setLeaf(id: string | null) {
			leafId = id;
		},
	};
}

type NavigateResult = { cancelled: boolean };

function createHarness(options: SessionOptions & {
	herdr?: boolean;
	navigate?: (targetId: string, navigateOptions: { summarize?: boolean }) => Promise<NavigateResult>;
	/** One-based call numbers of `appendEntry` that must throw. */
	failAppends?: number[];
} = {}) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, any>();
	const session = createSession(options);
	const editorTexts: string[] = [];
	const notices: Array<{ message: string; type?: string }> = [];
	const navigations: Array<{ targetId: string; options: { summarize?: boolean } }> = [];
	const appended: Array<{ customType: string; data: any }> = [];
	const timeline: string[] = [];
	const failures = new Set(options.failAppends ?? []);
	let appendCalls = 0;

	const appendEntry = (customType: string, data: unknown) => {
		appendCalls++;
		if (failures.has(appendCalls)) {
			timeline.push(`append-failed:${customType}`);
			throw new Error("session write failed");
		}
		appended.push({ customType, data });
		session.appendCustomEntry(customType, data);
		timeline.push(`append:${customType}`);
	};

	const navigateTree = async (
		targetId: string,
		navigateOptions: { summarize?: boolean },
	): Promise<NavigateResult> => {
		navigations.push({ targetId, options: navigateOptions });
		timeline.push(`navigate:${targetId}`);
		const result = await (options.navigate?.(targetId, navigateOptions) ?? Promise.resolve({ cancelled: false }));
		if (!result.cancelled) {
			// Pi folds a user message's leaf back to its parent.
			const target = session.getEntry(targetId);
			session.setLeaf(target ? target.parentId : null);
		}
		return result;
	};

	const ctx = {
		sessionManager: {
			getSessionFile: session.getSessionFile,
			getEntries: session.getEntries,
			getBranch: session.getBranch,
			getEntry: session.getEntry,
			getLeafId: session.getLeafId,
		},
		ui: {
			setEditorText(text: string) {
				editorTexts.push(text);
			},
			notify(message: string, type?: string) {
				notices.push({ message, type });
			},
		},
		navigateTree,
	};

	const pi = {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		appendEntry,
	};

	// The extension reads the env at registration time.  Keep every test's
	// mutation local so the inherited Herdr pane does not leak into others.
	const previous = process.env.HERDR_PANE_ID;
	if (options.herdr === false) delete process.env.HERDR_PANE_ID;
	else process.env.HERDR_PANE_ID = "fixture:p1";
	try {
		hwcRewindExtension(pi as unknown as ExtensionAPI);
	} finally {
		if (previous === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = previous;
	}

	return {
		handlers,
		commands,
		session,
		editorTexts,
		notices,
		navigations,
		appended,
		timeline,
		appendCalls: () => appendCalls,
		async emit(type: string, data: object = {}) {
			for (const handler of handlers.get(type) ?? []) await handler({ type, ...data }, ctx);
		},
		async rewind(args: string) {
			await commands.get("hwc-rewind")!.handler(args, ctx);
		},
	};
}

const USER = (id: string, parentId: string | null, role = "user"): Entry => ({
	type: "message",
	id,
	parentId,
	message: { role },
});

/**
 * u1 ─ a1 ─ u2 ─ a2          (active; a2 is the leaf)
 *  └─ s1                     (other branch)
 */
function branchSession(): SessionOptions {
	return {
		entries: [USER("u1", null), USER("a1", "u1", "assistant"), USER("u2", "a1"), USER("a2", "u2", "assistant"), USER("s1", "u1")],
		leafId: "a2",
	};
}

function marker(id: string, parentId: string, data: unknown): Entry {
	return { type: "custom", id, parentId, customType: MARKER_TYPE, data };
}

describe("parseRewindArgs", () => {
	test("accepts exactly two id-shaped arguments", () => {
		expect(parseRewindArgs("entry_1 request-2")).toEqual({
			ok: true,
			request: { entryId: "entry_1", requestId: "request-2" },
		});
		expect(parseRewindArgs("  entry_1\trequest-2  ")).toEqual({
			ok: true,
			request: { entryId: "entry_1", requestId: "request-2" },
		});
	});

	test("rejects the wrong count", () => {
		for (const args of ["", "entry", "entry request extra"]) {
			const parsed = parseRewindArgs(args);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.error).toContain("expected 2 arguments");
		}
	});

	test("rejects ids outside the shared alphabet and length", () => {
		for (const args of ["entry/1 request", "entry request.1", "é request", `${"a".repeat(65)} request`]) {
			const parsed = parseRewindArgs(args);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.error).toContain("invalid");
		}
		expect(ID_PATTERN.test("a".repeat(64))).toBe(true);
	});
});

describe("planRewind", () => {
	const branch: Entry[] = [USER("u1", null), USER("a1", "u1", "assistant"), USER("u2", "a1")];

	test("a completed request for the same target stays successful", () => {
		const completed = marker("m1", "u2", {
			v: FORMAT_VERSION,
			requestId: "req",
			targetId: "u2",
			leafId: "a1",
		});
		expect(planRewind({
			branch: [...branch, completed],
			target: USER("u2", "a1"),
			leafId: "m1",
			entryId: "u2",
			requestId: "req",
		})).toEqual({ action: "ignore" });
	});

	test("a completed request for another target is rejected", () => {
		const completed = marker("m1", "u2", {
			v: FORMAT_VERSION,
			requestId: "req",
			targetId: "u2",
			leafId: "a1",
		});
		expect(planRewind({
			branch: [...branch, completed],
			target: USER("u1", null),
			leafId: "m1",
			entryId: "u1",
			requestId: "req",
		})).toMatchObject({ action: "reject" });
	});

	test("distinguishes navigation from a marker-only retry", () => {
		expect(planRewind({ branch, target: USER("u2", "a1"), leafId: "a2", entryId: "u2", requestId: "r" }))
			.toEqual({ action: "navigate" });
		// u2 is no longer on the branch, but its parent is the current leaf.
		expect(planRewind({ branch: branch.slice(0, 2), target: USER("u2", "a1"), leafId: "a1", entryId: "u2", requestId: "r" }))
			.toEqual({ action: "marker-only" });
	});

	test("rejects a target that matches neither case", () => {
		expect(planRewind({ branch: branch.slice(0, 2), target: USER("u2", "a1"), leafId: "u1", entryId: "u2", requestId: "r" }))
			.toMatchObject({ action: "reject" });
	});
});

describe("hwc-rewind command", () => {
	test("navigates before appending the marker, then clears the editor", async () => {
		const h = createHarness(branchSession());
		await h.rewind("u2 req-1");

		expect(h.navigations).toEqual([{ targetId: "u2", options: { summarize: false } }]);
		expect(h.timeline).toEqual(["navigate:u2", `append:${MARKER_TYPE}`]);
		expect(h.editorTexts).toEqual([""]);
		expect(h.notices).toEqual([]);
		expect(h.appended).toEqual([{
			customType: MARKER_TYPE,
			data: { v: FORMAT_VERSION, requestId: "req-1", targetId: "u2", leafId: "a1" },
		}]);
		// The marker itself becomes the leaf, and its parent is the rewritten
		// point (target parent).  hwc reads the last entry as the leaf.
		expect(h.session.getLeafId()).toBe("c1");
		expect(h.session.getEntry("c1")?.parentId).toBe("a1");
	});

	test("records a null leaf when the target has no parent", async () => {
		const h = createHarness(branchSession());
		await h.rewind("u1 req-first");

		expect(h.navigations).toEqual([{ targetId: "u1", options: { summarize: false } }]);
		expect(h.appended).toEqual([{
			customType: MARKER_TYPE,
			data: { v: FORMAT_VERSION, requestId: "req-first", targetId: "u1", leafId: null },
		}]);
		expect(h.session.getEntry("c1")?.parentId).toBeNull();
	});

	test("records the real parent when the first user message follows an existing entry", async () => {
		// Pi 1.5.2 appends a system-message entry before the first user message,
		// so the rewind point is that entry rather than null.
		const h = createHarness({
			entries: [
				{ type: "custom", id: "cap", parentId: null, customType: CAPABILITY_TYPE, data: { v: FORMAT_VERSION, rewind: true } },
				{ type: "message", id: "sys", parentId: "cap", message: { role: "system" } },
				USER("u1", "sys"),
				USER("a1", "u1", "assistant"),
			],
			leafId: "a1",
		});
		await h.rewind("u1 req-parent");

		expect(h.appended).toEqual([{
			customType: MARKER_TYPE,
			data: { v: FORMAT_VERSION, requestId: "req-parent", targetId: "u1", leafId: "sys" },
		}]);
		expect(h.session.getEntry("c1")?.parentId).toBe("sys");
	});

	test("the same requestId and target is an idempotent no-op", async () => {
		const options = branchSession();
		options.entries = [...options.entries!, marker("m1", "a2", {
			v: FORMAT_VERSION,
			requestId: "req-1",
			targetId: "u2",
			leafId: "a1",
		})];
		options.leafId = "m1";
		const h = createHarness(options);

		await h.rewind("u2 req-1");

		expect(h.navigations).toEqual([]);
		expect(h.appended).toEqual([]);
		expect(h.editorTexts).toEqual([]);
		expect(h.notices).toEqual([]);
	});

	test("the same requestId for another target is rejected", async () => {
		const options = branchSession();
		options.entries = [...options.entries!, marker("m1", "a2", {
			v: FORMAT_VERSION,
			requestId: "req-1",
			targetId: "u2",
			leafId: "a1",
		})];
		options.leafId = "m1";
		const h = createHarness(options);

		await h.rewind("u1 req-1");

		expect(h.navigations).toEqual([]);
		expect(h.appended).toEqual([]);
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0].type).toBe("error");
		expect(h.notices[0].message).toContain("already rewound");
	});

	test("rejects a missing entry, a non-user entry and the current leaf", async () => {
		const cases = [
			["missing req", "was not found"],
			["a2 req", "not a user message"],
			["u2 req", "is the current leaf"],
		] as const;
		for (const [args, reason] of cases) {
			const options = branchSession();
			if (args.startsWith("u2")) options.leafId = "u2";
			const h = createHarness(options);
			await h.rewind(args);
			expect(h.navigations).toEqual([]);
			expect(h.appended).toEqual([]);
			expect(h.editorTexts).toEqual([]);
			expect(h.notices).toHaveLength(1);
			expect(h.notices[0].message).toContain(reason);
		}
	});

	test("rejects a user message on another branch", async () => {
		const h = createHarness(branchSession());
		await h.rewind("s1 req-side");

		expect(h.navigations).toEqual([]);
		expect(h.appended).toEqual([]);
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0].message).toContain("not on the active branch");
	});

	test("a cancelled or throwing navigation writes no marker", async () => {
		for (const navigate of [
			async () => ({ cancelled: true }),
			async () => {
				throw new Error("branch summary busy");
			},
		]) {
			const h = createHarness({ ...branchSession(), navigate });
			await h.rewind("u2 req-1");
			expect(h.navigations).toEqual([{ targetId: "u2", options: { summarize: false } }]);
			expect(h.appended).toEqual([]);
			expect(h.editorTexts).toEqual([]);
			expect(h.notices).toHaveLength(1);
			expect(h.notices[0].type).toBe("error");
		}
	});

	test("a failed marker append leaves navigation done, and the retry appends only the marker", async () => {
		const h = createHarness({ ...branchSession(), failAppends: [1] });
		await h.rewind("u2 req-retry");

		expect(h.navigations).toEqual([{ targetId: "u2", options: { summarize: false } }]);
		expect(h.appended).toEqual([]);
		expect(h.session.getLeafId()).toBe("a1");
		expect(h.notices).toHaveLength(1);
		expect(h.notices[0].message).toContain("could not record the rewind marker");

		await h.rewind("u2 req-retry");

		expect(h.navigations).toHaveLength(1);
		expect(h.appended).toEqual([{
			customType: MARKER_TYPE,
			data: { v: FORMAT_VERSION, requestId: "req-retry", targetId: "u2", leafId: "a1" },
		}]);
		expect(h.session.getLeafId()).toBe("c1");
	});
});

describe("registration and capability", () => {
	test("a normal pi start (no HERDR_PANE_ID) registers nothing", () => {
		const h = createHarness({ ...branchSession(), herdr: false });
		expect([...h.commands.keys()]).toEqual([]);
		expect([...h.handlers.keys()]).toEqual([]);
	});

	test("a Herdr pane registers the command and one session_start handler", () => {
		const h = createHarness(branchSession());
		expect([...h.commands.keys()]).toEqual(["hwc-rewind"]);
		expect(h.commands.get("hwc-rewind").description).toContain("hwc");
		expect(h.handlers.get("session_start")).toHaveLength(1);
	});

	test("session_start appends the capability once and only when a session file exists", async () => {
		const h = createHarness(branchSession());
		await h.emit("session_start");
		await h.emit("session_start");

		expect(h.appended).toEqual([{ customType: CAPABILITY_TYPE, data: { v: FORMAT_VERSION, rewind: true } }]);
		expect(hasCapability(h.session.getEntries())).toBe(true);

		const headless = createHarness({ ...branchSession(), sessionFile: null });
		await headless.emit("session_start");
		expect(headless.appended).toEqual([]);
	});

	test("an existing capability anywhere in the session suppresses a second one", async () => {
		const options = branchSession();
		options.entries = [...options.entries!, {
			type: "custom",
			id: "cap",
			parentId: "u1",
			customType: CAPABILITY_TYPE,
			data: { v: FORMAT_VERSION, rewind: true },
		}];
		const h = createHarness(options);
		await h.emit("session_start");
		expect(h.appended).toEqual([]);
	});

	test("a capability append failure is swallowed", async () => {
		const h = createHarness({ ...branchSession(), failAppends: [1] });
		await expect(h.emit("session_start")).resolves.toBeUndefined();
		expect(h.appended).toEqual([]);
	});
});
