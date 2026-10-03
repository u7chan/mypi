import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import mypi from "../extensions/index.ts";

// Arrays are deliberate: a Map<event, handler> would mask handler clobbering.
function createHarness(mode = "tui", hasUI = true) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const statuses = new Map<string, string>();
	const updates: Array<[string, string | undefined]> = [];
	const working: Array<string | undefined> = [];
	const footerCalls: Array<any> = [];
	const execCalls: string[] = [];
	let branchSubscriptions = 0;
	let component: any;
	const ctx = {
		mode, hasUI, cwd: "/fixture",
		model: { id: "fixture-model", provider: "fixture", reasoning: true, contextWindow: 256_000,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
		thinkingLevel: "high",
		sessionManager: { getCwd: () => "/fixture", getSessionName: () => "integration" },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 256_000, percent: 1 }),
		ui: {
			theme: { fg: (_color: string, text: string) => text },
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
	};
	mypi(pi as never);
	return {
		handlers, commands, tools, statuses, updates, working, footerCalls, execCalls, ctx,
		get component() { return component; },
		get branchSubscriptions() { return branchSubscriptions; },
		async emit(type: string, data: object = {}) {
			for (const handler of handlers.get(type) ?? []) await handler({ type, ...data }, ctx);
		},
		disposeFooter() { component?.dispose(); component = undefined; },
	};
}

test("manifest exposes one entry, which registers exactly the six feature signatures", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	expect(manifest.pi.extensions).toEqual(["extensions/index.ts"]);
	expect(manifest.dependencies).toBeUndefined();
	const h = createHarness();
	expect([...h.commands.keys()]).toEqual(["minimal-footer", "dm", "default-model"]);
	expect([...h.tools.keys()]).toEqual(["set_default_model"]);
	expect(Object.fromEntries([...h.handlers].map(([event, list]) => [event, list.length]))).toEqual({
		session_start: 4, message_end: 2, model_select: 2, session_shutdown: 4,
		before_provider_request: 1, tool_execution_end: 1, agent_settled: 2, before_agent_start: 1,
	});
	expect(h.handlers.has("agent_end")).toBe(false);
});

test("shared events compose, statuses coexist in minimal footer, and shutdown stops timers", async () => {
	const h = createHarness();
	try {
		await h.emit("session_start");
		await Bun.sleep(10); // async PR lookup
		expect(h.statuses.get("cache-ttl")).toBe("CACHE pending");
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
		expect(h.statuses.get("elapsed")).toMatch(/^ELAPSED [1-9]\d*s$/);
		const lines = h.component.render(160);
		expect(lines[2]).toMatch(/SAVED .*CACHE .*ELAPSED .*example\/fixture.*PR #7/);
		expect(lines[1]).not.toMatch(/[↑↓]|CH|\$/);
		await h.commands.get("minimal-footer").handler("", h.ctx);
		expect(h.component).toBeUndefined();
		expect(h.branchSubscriptions).toBe(0);
		await h.commands.get("minimal-footer").handler("", h.ctx);
		expect(h.component.render(160)[2]).toContain("PR #7");
		await h.emit("model_select");
		expect(h.statuses.get("cache-ttl")).toBe("CACHE pending");
		expect(h.statuses.has("cache-savings")).toBe(false);
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
		expect(a.statuses.get("cache-ttl")).toBe("CACHE hit");
		expect(b.statuses.get("cache-ttl")).toBe("CACHE pending");
		expect(a.statuses.has("cache-savings")).toBe(true);
		expect(b.statuses.has("cache-savings")).toBe(false);
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
		const h = createHarness(mode, hasUI);
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
				expect(h.statuses.has("cache-savings")).toBe(true);
				expect(h.statuses.has("elapsed")).toBe(true);
			}
		} finally { await h.emit("session_shutdown"); }
	}
});
