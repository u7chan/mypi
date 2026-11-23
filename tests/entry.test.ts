import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mypi from "../extensions/index.ts";

interface HarnessOptions {
	mode?: string;
	hasUI?: boolean;
	herdr?: boolean;
	sessionFile?: string;
	/** Receives `select` with choices and `input` with `undefined`. */
	dialog?: (
		title: string,
		options: string[] | undefined,
		opts?: { signal?: AbortSignal },
	) => Promise<string | undefined>;
}

// Arrays are deliberate: a Map<event, handler> would mask handler clobbering.
function createHarness(options: HarnessOptions = {}) {
	const mode = options.mode ?? "tui";
	const hasUI = options.hasUI ?? true;
	const herdr = options.herdr ?? false;
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const statuses = new Map<string, string>();
	const updates: Array<[string, string | undefined]> = [];
	const working: Array<string | undefined> = [];
	const footerCalls: Array<any> = [];
	const execCalls: string[] = [];
	const editorTexts: string[] = [];
	const notices: Array<{ message: string; type?: string }> = [];
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const events: Array<{ channel: string; data: unknown }> = [];
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const dialogCalls: Array<{ title: string; options: string[] | undefined }> = [];
	let branchSubscriptions = 0;
	let component: any;
	const ctx = {
		mode, hasUI, cwd: "/fixture",
		model: { id: "fixture-model", provider: "fixture", reasoning: true, contextWindow: 256_000,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
		thinkingLevel: "high",
		sessionManager: {
			getCwd: () => "/fixture", getSessionName: () => "integration",
			getSessionFile: () => options.sessionFile,
			getEntries: () => [], getBranch: () => [], getEntry: () => undefined, getLeafId: () => null,
		},
		getContextUsage: () => ({ tokens: 1000, contextWindow: 256_000, percent: 1 }),
		navigateTree: async () => ({ cancelled: false }),
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			select(title: string, choices: string[], opts?: { signal?: AbortSignal }) {
				dialogCalls.push({ title, options: choices });
				return options.dialog ? options.dialog(title, choices, opts) : Promise.resolve(undefined);
			},
			input(title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) {
				dialogCalls.push({ title, options: undefined });
				return options.dialog ? options.dialog(title, undefined, opts) : Promise.resolve(undefined);
			},
			setEditorText(text: string) { editorTexts.push(text); },
			notify(message: string, type?: string) { notices.push({ message, type }); },
			setStatus(key: string, text: string | undefined) {
				if (!hasUI) throw new Error("headless UI access");
				updates.push([key, text]);
				if (text === undefined) statuses.delete(key); else statuses.set(key, text);
			},
			setWorkingMessage(message?: string) { working.push(message); },
			setFooter(factory: any) {
				component?.dispose();
				component = undefined;
				footerCalls.push(factory);
				if (factory) component = factory({ requestRender() {} }, ctx.ui.theme, {
					getGitBranch: () => "fixture-branch",
					getExtensionStatuses: () => statuses,
					getAvailableProviderCount: () => 2,
					onBranchChange: () => { branchSubscriptions++; return () => { branchSubscriptions--; }; },
				});
			},
		},
	};
	const pi = {
		on(event: string, handler: any) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(name: string, command: any) {
			if (commands.has(name)) throw new Error(`duplicate command ${name}`);
			commands.set(name, command);
		},
		registerTool(tool: any) {
			if (tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
			tools.set(tool.name, tool);
		},
		async exec(command: string, args: string[]) {
			execCalls.push(`${command} ${args.join(" ")}`);
			return { code: 0, stderr: "", stdout: command === "gh"
				? JSON.stringify({ number: 7, url: "https://github.com/example/fixture/pull/7" })
				: args[0] === "rev-parse" ? "fixture-branch\n"
				: "origin\tgit@github.com:example/fixture.git (fetch)\n" };
		},
		appendEntry(customType: string, data: unknown) {
			appendedEntries.push({ customType, data });
		},
		events: {
			emit(channel: string, data: unknown) {
				events.push({ channel, data });
				for (const handler of eventHandlers.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				const list = eventHandlers.get(channel) ?? [];
				list.push(handler);
				eventHandlers.set(channel, list);
				return () => {
					const index = list.indexOf(handler);
					if (index >= 0) list.splice(index, 1);
				};
			},
		},
	};
	// The hwc bridge registers only inside Herdr.  Keep the inherited pane id
	// out of the base tests and restore it for the bridge check.
	const inheritedPaneId = process.env.HERDR_PANE_ID;
	if (herdr) process.env.HERDR_PANE_ID = "fixture:p1";
	else delete process.env.HERDR_PANE_ID;
	try {
		mypi(pi as never);
	} finally {
		if (inheritedPaneId === undefined) delete process.env.HERDR_PANE_ID;
		else process.env.HERDR_PANE_ID = inheritedPaneId;
	}
	return {
		handlers, commands, tools, statuses, updates, working, footerCalls, execCalls, ctx,
		editorTexts, notices, appendedEntries, events, dialogCalls,
		get component() { return component; },
		get branchSubscriptions() { return branchSubscriptions; },
		async emit(type: string, data: object = {}) {
			for (const handler of handlers.get(type) ?? []) await handler({ type, ...data }, ctx);
		},
		disposeFooter() { component?.dispose(); component = undefined; },
	};
}

test("manifest exposes one entry, which registers exactly the nine feature signatures", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	expect(manifest.pi.extensions).toEqual(["extensions/index.ts"]);
	expect(manifest.dependencies).toBeUndefined();
	const h = createHarness();
	expect([...h.commands.keys()]).toEqual(["minimal-footer", "dm", "default-model"]);
	expect([...h.tools.keys()]).toEqual(["set_default_model", "ask_user"]);
	expect(Object.fromEntries([...h.handlers].map(([event, list]) => [event, list.length]))).toEqual({
		session_start: 5, message_start: 2, message_end: 4, model_select: 2, session_shutdown: 6,
		before_provider_request: 1, tool_execution_end: 2, tool_execution_start: 1, agent_settled: 4,
		before_agent_start: 3, message_update: 2, agent_start: 1, turn_start: 1, session_before_compact: 1,
		session_compact: 1, session_compact_failed: 1, ui_prompt_start: 1, ui_prompt_end: 1, agent_end: 1,
	});
	// `agent_end` is live-thinking's: elapsed deliberately ends at `agent_settled`,
	// because an automatic retry follows `agent_end` without a new start.
	expect(h.handlers.get("agent_end")).toHaveLength(1);
	expect(h.commands.has("hwc-rewind")).toBe(false);
});

test("Herdr panes additionally register the hwc bridge and its session_start handler", () => {
	const h = createHarness({ herdr: true });
	expect([...h.commands.keys()]).toEqual(["minimal-footer", "dm", "default-model", "hwc-rewind"]);
	expect(h.handlers.get("session_start")).toHaveLength(6);
	expect(h.commands.get("hwc-rewind").description).toContain("hwc");
});

test("shared events compose, statuses coexist in minimal footer, and shutdown stops timers", async () => {
	const h = createHarness();
	try {
		await h.emit("session_start");
		await Bun.sleep(10); // async PR lookup
		expect(h.statuses.has("cache-ttl")).toBe(false);
		expect(h.statuses.get("git")).toContain("PR #7");
		expect(h.branchSubscriptions).toBe(1);
		await h.emit("before_agent_start");
		await h.emit("before_provider_request", { payload: { prompt_cache_retention: "1m" } });
		await h.emit("message_end", { message: { role: "assistant", usage: { cacheRead: 1000 } } });
		await h.emit("agent_end");
		expect(h.statuses.has("elapsed")).toBe(false);
		await Bun.sleep(1050);
		expect(h.working.at(-1)).toMatch(/^Working \([1-9]\d*s\)$/);
		await h.emit("agent_settled");
		expect(h.statuses.get("elapsed")).toMatch(/^elapsed [1-9]\d*s$/);
		const lines = h.component.render(160);
		expect(lines[1]).toMatch(/elapsed .* · ttl .* · cached 1k · .*example\/fixture.*PR #7/);
		expect(lines[1]).not.toMatch(/\$|SAVED|CACHE|ELAPSED/);
		expect(lines[1]).not.toMatch(/[↑↓]|CH|\$/);
		await h.commands.get("minimal-footer").handler("", h.ctx);
		expect(h.component).toBeUndefined();
		expect(h.branchSubscriptions).toBe(0);
		await h.commands.get("minimal-footer").handler("", h.ctx);
		expect(h.component.render(160)[1]).toContain("PR #7");
		await h.emit("model_select");
		expect(h.statuses.has("cache-ttl")).toBe(false);
		expect(h.statuses.has("cache-reuse")).toBe(false);
		expect(h.statuses.has("git")).toBe(true);
		await h.emit("before_agent_start");
		expect(h.statuses.has("elapsed")).toBe(false);
		await h.emit("before_provider_request", { payload: { prompt_cache_retention: "1m" } });
		await h.emit("session_shutdown");
		expect(h.statuses.size).toBe(0);
		const updates = h.updates.length;
		const working = h.working.length;
		const execs = h.execCalls.length;
		await Bun.sleep(1100);
		expect(h.updates.length).toBe(updates);
		expect(h.working.length).toBe(working);
		expect(h.execCalls.length).toBe(execs);
	} finally {
		await h.emit("session_shutdown");
		h.disposeFooter();
	}
});

test("separate entry instances do not share controller state or footer toggle state", async () => {
	const a = createHarness();
	const b = createHarness();
	try {
		await a.emit("session_start"); await b.emit("session_start");
		await Bun.sleep(10);
		await a.emit("message_end", { message: { role: "assistant", usage: { cacheRead: 1500 } } });
		expect(a.statuses.get("cache-ttl")).toBe("cache hit");
		expect(b.statuses.has("cache-ttl")).toBe(false);
		expect(a.statuses.has("cache-reuse")).toBe(true);
		expect(b.statuses.has("cache-reuse")).toBe(false);
		await a.commands.get("minimal-footer").handler("", a.ctx);
		expect(a.component).toBeUndefined();
		expect(b.component).toBeDefined();
		await a.emit("session_shutdown");
		expect(b.statuses.get("git")).toContain("PR #7");
		await b.emit("session_start");
		expect(b.branchSubscriptions).toBe(1);
	} finally {
		await a.emit("session_shutdown"); await b.emit("session_shutdown");
		a.disposeFooter(); b.disposeFooter();
	}
});

test("headless modes avoid UI/timers/git commands; RPC preserves statuses without a custom footer", async () => {
	for (const [mode, hasUI] of [["print", false], ["json", false], ["rpc", true]] as const) {
		const h = createHarness({ mode, hasUI });
		try {
			await h.emit("session_start");
			await h.emit("before_agent_start");
			await h.emit("before_provider_request", { payload: { prompt_cache_retention: "1m" } });
			await h.emit("message_end", { message: { role: "assistant", usage: { cacheRead: 1500 } } });
			await h.emit("agent_settled");
			await h.commands.get("minimal-footer").handler("", h.ctx);
			expect(h.footerCalls).toEqual([]);
			if (!hasUI) {
				expect(h.updates).toEqual([]);
				expect(h.working).toEqual([]);
				expect(h.execCalls).toEqual([]);
			} else {
				expect(h.statuses.has("cache-reuse")).toBe(true);
				expect(h.statuses.has("elapsed")).toBe(true);
			}
		} finally { await h.emit("session_shutdown"); }
	}
});

test("ask_user reports herdr:blocked only while a Herdr TUI question waits", async () => {
	const directory = mkdtempSync(join(tmpdir(), "mypi-ask-"));
	const herdrSession = join(directory, "herdr.jsonl");
	const plainSession = join(directory, "plain.jsonl");
	const saved = {
		HERDR_ENV: process.env.HERDR_ENV,
		HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
		HERDR_PANE_ID: process.env.HERDR_PANE_ID,
	};
	const restore = () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	const blocked = (events: Array<{ channel: string; data: unknown }>) =>
		events.filter((event) => event.channel === "herdr:blocked").map((event) => event.data);

	try {
		let signal: AbortSignal | undefined;
		const h = createHarness({
			herdr: true,
			sessionFile: herdrSession,
			dialog: (_title, _options, opts) => {
				signal = opts?.signal;
				return new Promise((resolve) => {
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				});
			},
		});
		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = "/tmp/mypi-entry-herdr.sock";
		process.env.HERDR_PANE_ID = "fixture:p1";

		const controller = new AbortController();
		const running = h.tools.get("ask_user").execute(
			"entry-ask",
			{ question: "Deploy?", options: ["Yes", "No"], recommended: "Yes" },
			controller.signal,
			undefined,
			h.ctx,
		);
		await Bun.sleep(0);
		expect(blocked(h.events)).toEqual([{ active: true, label: "ユーザーの回答待ち" }]);
		expect(JSON.parse(readFileSync(`${herdrSession}.ask.json`, "utf8"))).toMatchObject({
			v: 1,
			question: "Deploy?",
			options: ["Yes", "No"],
			recommended: "Yes",
			freeText: true,
		});
		expect(h.dialogCalls).toEqual([
			{ title: "Deploy?", options: ["推奨💡 Yes", "No", "その他（自由入力）"] },
		]);

		controller.abort();
		const result = await running;
		expect(result.isError).toBe(true);
		expect(result.details).toEqual({ status: "aborted" });
		expect(blocked(h.events)).toEqual([
			{ active: true, label: "ユーザーの回答待ち" },
			{ active: false, label: "ユーザーの回答待ち" },
		]);
		expect(signal?.aborted).toBe(true);
		expect(existsSync(`${herdrSession}.ask.json`)).toBe(false);
		expect(existsSync(`${herdrSession}.ask.answer.json`)).toBe(false);

		// Without all three Herdr variables, the same call uses only the dialog.
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_PANE_ID;
		const plain = createHarness({ sessionFile: plainSession, dialog: async () => "Yes" });
		const plainResult = await plain.tools.get("ask_user").execute(
			"entry-ask-plain",
			{ question: "Deploy?", options: ["Yes", "No"], recommended: "Yes" },
			undefined,
			undefined,
			plain.ctx,
		);
		expect(plainResult.details).toEqual({ status: "answered", winner: "tui", kind: "option" });
		expect(plain.events).toEqual([]);
		expect(existsSync(`${plainSession}.ask.json`)).toBe(false);
	} finally {
		restore();
		rmSync(directory, { recursive: true, force: true });
	}
});
