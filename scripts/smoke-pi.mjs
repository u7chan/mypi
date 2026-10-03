// Offline integration check against the installed Pi, not a second bundled Pi.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const host = process.env.PI_SMOKE_PACKAGE_ROOT ?? resolve(dirname(realpathSync(
	execFileSync("which", ["pi"], { encoding: "utf8" }).trim(),
)), "../..");
const sdk = await import(pathToFileURL(join(host, "dist/index.js")));
const ai = await import(pathToFileURL(join(host, "node_modules/@earendil-works/pi-ai/dist/index.js")));
const tui = await import(pathToFileURL(join(host, "node_modules/@earendil-works/pi-tui/dist/index.js")));
const sandbox = mkdtempSync(join(tmpdir(), "mypi-smoke-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const oldPath = process.env.PATH;
const oldOffline = process.env.PI_OFFLINE;
process.env.PI_CODING_AGENT_DIR = sandbox;
process.env.PI_OFFLINE = "1";
const bin = join(sandbox, "bin");
mkdirSync(bin);
// Test repository/PR results without contacting GitHub or modifying a checkout.
writeFileSync(join(bin, "git"), '#!/bin/sh\nif [ "$1" = rev-parse ]; then echo fixture-branch; else printf "origin\\tgit@github.com:example/fixture.git (fetch)\\n"; fi\n', { mode: 0o700 });
writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf \'{"number":7,"url":"https://github.com/example/fixture/pull/7"}\\n\'\n', { mode: 0o700 });
process.env.PATH = `${bin}:${oldPath}`;
const settingsPath = join(sandbox, "settings.json");
writeFileSync(settingsPath, JSON.stringify({ theme: "dark", packages: ["keep-this"], defaultThinkingLevel: "high" }));
let session;
let component;
let branchSubscriptions = 0;
const statuses = new Map();
const working = [];
const errors = [];
const notices = [];
const timeline = [];
let attempt = 0;

try {
	const settingsManager = sdk.SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1100 },
	});
	const loader = new sdk.DefaultResourceLoader({
		cwd: sandbox, agentDir: sandbox, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [root],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.equal(extension.path, join(root, "extensions/index.ts"));
	assert.equal(extension.handlers.get("session_start").length, 4);
	assert.equal(extension.handlers.get("message_end").length, 2);
	assert.equal(extension.handlers.get("agent_settled").length, 2);
	assert.deepEqual([...extension.commands.keys()], ["minimal-footer", "dm", "default-model"]);
	assert.deepEqual([...extension.tools.keys()], ["set_default_model"]);

	const modelRuntime = await sdk.ModelRuntime.create({
		authPath: join(sandbox, "auth.json"), modelsPath: null,
		modelsStorePath: join(sandbox, "models-cache.json"), refreshOnCreate: false,
	});
	modelRuntime.registerProvider("mypi-smoke", {
		api: "mypi-smoke-api", apiKey: "fixture", baseUrl: "http://localhost.invalid",
		models: ["fixture-model", "other-model"].map((id) => ({ id, name: id, reasoning: true, input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 256000, maxTokens: 1024 })),
		streamSimple(model, _context, options) {
			const stream = ai.createAssistantMessageEventStream();
			void (async () => {
				const current = ++attempt;
				await options?.onPayload?.({ model: model.id, prompt_cache_retention: "1m" }, model);
				const message = {
					role: "assistant", api: model.api, provider: model.provider, model: model.id,
					content: [], timestamp: Date.now(), stopReason: "pending",
					usage: { input: 100, output: 1, cacheRead: 1000, cacheWrite: 0, totalTokens: 1101,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				stream.push({ type: "start", partial: message });
				await sleep(current === 1 ? 1100 : 2200);
				if (current === 1) {
					message.stopReason = "error";
					message.errorMessage = "503 Service unavailable";
					stream.push({ type: "error", reason: "error", error: message });
				} else {
					message.content.push({ type: "text", text: "fixture OK" });
					stream.push({ type: "text_start", contentIndex: 0, partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "fixture OK", partial: message });
					stream.push({ type: "text_end", contentIndex: 0, content: "fixture OK", partial: message });
					ai.calculateCost(model, message.usage);
					message.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message });
				}
				stream.end();
			})().catch((error) => { errors.push(error); stream.end(); });
			return stream;
		},
	});
	const model = modelRuntime.getModel("mypi-smoke", "fixture-model");
	({ session } = await sdk.createAgentSession({
		cwd: sandbox, agentDir: sandbox, resourceLoader: loader, modelRuntime, model,
		thinkingLevel: "high", settingsManager, sessionManager: sdk.SessionManager.inMemory(sandbox),
		tools: ["set_default_model"],
	}));
	const theme = { fg: (_color, text) => text };
	const uiContext = {
		theme,
		setStatus(key, text) { if (text === undefined) statuses.delete(key); else statuses.set(key, text); },
		setWorkingMessage(message) { working.push(message); },
		notify(message, type) { notices.push({ message, type }); },
		setFooter(factory) {
			component?.dispose(); component = undefined;
			if (factory) component = factory({ requestRender() {} }, theme, {
				getGitBranch: () => "fixture-branch", getExtensionStatuses: () => statuses,
				getAvailableProviderCount: () => 2,
				onBranchChange: () => { branchSubscriptions++; return () => { branchSubscriptions--; }; },
			});
		},
	};
	await session.bindExtensions({ mode: "tui", uiContext, onError: (error) => errors.push(error) });
	await sleep(100);
	assert.match(statuses.get("git"), /example\/fixture.*PR #7/);
	assert.equal(statuses.get("cache-ttl"), "CACHE pending");
	assert.equal(branchSubscriptions, 1);

	// Pi's real retry loop must keep elapsed live past the first agent_end.
	session.subscribe((event) => {
		if (["agent_end", "agent_settled", "auto_retry_start"].includes(event.type)) {
			timeline.push({ type: event.type, elapsed: statuses.get("elapsed") });
		}
	});
	const started = Date.now();
	await session.prompt("offline retry fixture");
	const duration = Date.now() - started;
	assert.equal(attempt, 2);
	assert(timeline.some((event) => event.type === "auto_retry_start"));
	assert.equal(timeline.find((event) => event.type === "agent_end").elapsed, undefined);
	assert(working.includes("Working (1s)"));
	assert.equal(statuses.get("elapsed"), `ELAPSED ${Math.floor(duration / 1000)}s`);
	assert.match(statuses.get("cache-ttl"), /^CACHE 00:/);
	assert.match(statuses.get("cache-savings"), /^SAVED 1k tok ~\$/);
	assert.match(component.render(160)[2], /SAVED .*CACHE .*ELAPSED .*example\/fixture.*PR #7/);
	// OSC 8 link widths and closing are checked with the host's actual parser.
	session.setSessionName("確認👩‍💻é".repeat(50));
	for (const width of [0, 1, 2, 20, 40, 80, 160]) {
		for (const line of component.render(width)) assert(tui.visibleWidth(line) <= width);
	}
	session.setSessionName("fixture");
	await session.prompt("/minimal-footer"); assert.equal(component, undefined);
	assert.equal(branchSubscriptions, 0);
	await session.prompt("/minimal-footer"); assert(component);
	await session.prompt("/dm mypi-smoke/other-model:high");
	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
		theme: "dark", packages: ["keep-this"], defaultProvider: "mypi-smoke",
		defaultModel: "other-model", defaultThinkingLevel: "high",
	});
	assert.equal(statuses.get("cache-ttl"), "CACHE pending");
	assert.equal(statuses.has("cache-savings"), false);
	const ctx = session.extensionRunner.createToolContext("fixture-tool");
	const result = await extension.tools.get("set_default_model").definition.execute(
		"fixture-tool", { provider: "mypi-smoke", model: "fixture-model" }, undefined, undefined, ctx,
	);
	assert.match(result.content[0].text, /Saved mypi-smoke\/fixture-model/);
	assert.equal(result.isError, undefined);
	assert.equal(notices.at(-1).type, "info");
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	assert.equal(statuses.size, 0);
	component?.dispose(); component = undefined;
	assert.equal(branchSubscriptions, 0);
	assert.deepEqual(errors, []);
	console.log(`Pi ${JSON.parse(readFileSync(join(host, "package.json"), "utf8")).version}: one entry, six features, retry ${duration}ms, isolated settings, cleanup OK`);
} finally {
	if (session) {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
	component?.dispose();
	for (const [key, value] of [["PI_CODING_AGENT_DIR", oldAgentDir], ["PATH", oldPath], ["PI_OFFLINE", oldOffline]]) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	rmSync(sandbox, { recursive: true, force: true });
}
