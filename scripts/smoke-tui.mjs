// Interactive, offline TUI check. All Pi settings/logs live in a disposable directory.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), "mypi-tui-"));
const log = join(sandbox, "tui.log");
const server = createServer(async (request, response) => {
	let body = "";
	for await (const chunk of request) body += chunk;
	const payload = JSON.parse(body);
	response.writeHead(200, { "Content-Type": "text/event-stream" });
	const send = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
		id: "fixture", object: "chat.completion.chunk", created: 1, model: payload.model,
		choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
	})}\n\n`);
	send({ role: "assistant", content: "" });
	await sleep(2200);
	const last = payload.messages.at(-1);
	if (last?.role === "user" && JSON.stringify(last.content).includes("save-default")) {
		send({ tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: {
			name: "set_default_model", arguments: JSON.stringify({ provider: "mypi-smoke", model: "fixture-model", thinkingLevel: "high" }),
		} }] });
		send({}, "tool_calls");
	} else {
		send({ content: "Offline fixture OK." });
		send({}, "stop");
	}
	send({}, null, { prompt_tokens: 1100, completion_tokens: 10, total_tokens: 1110, prompt_tokens_details: { cached_tokens: 1000 } });
	response.end("data: [DONE]\n\n");
});

try {
	let path = process.env.PATH;
	if (process.argv.includes("--git-fixture")) {
		const bin = join(sandbox, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "git"), '#!/bin/sh\nif [ "$1" = rev-parse ]; then echo fixture-branch; else printf "origin\\tgit@github.com:example/fixture.git (fetch)\\n"; fi\n', { mode: 0o700 });
		writeFileSync(join(bin, "gh"), '#!/bin/sh\nprintf \'{"number":7,"url":"https://github.com/example/fixture/pull/7"}\\n\'\n', { mode: 0o700 });
		path = `${bin}:${path}`;
	}
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	writeFileSync(join(sandbox, "settings.json"), JSON.stringify({
		theme: "dark", defaultThinkingLevel: "high", packages: [],
	}));
	writeFileSync(join(sandbox, "models.json"), JSON.stringify({ providers: {
		"mypi-smoke": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture",
			models: ["fixture-model", "other-model"].map((id) => ({
				id, name: id, reasoning: true, input: ["text"], contextWindow: 256000, maxTokens: 1024,
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
				compat: { supportsPromptCacheKey: true },
			})),
		},
	} }));
	console.log("Isolated TUI: try a prompt, save-default, /dm show, /dm mypi-smoke/other-model:high, /minimal-footer, /quit.");
	const child = spawn("pi", [
		"--no-extensions", "--no-session", "--verbose", "--offline", "--no-approve",
		"--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
		"--tui-mode", process.argv.includes("--fullscreen") ? "fullscreen" : "regular",
		"--provider", "mypi-smoke", "--model", "fixture-model", "--thinking", "high", "-e", root,
	], { cwd: root, stdio: "inherit", env: { ...process.env,
		PATH: path,
		PI_CODING_AGENT_DIR: sandbox, PI_TUI_WRITE_LOG: log,
		PI_HYPERLINKS: "1", PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
	} });
	const code = await new Promise((resolve, reject) => { child.on("exit", resolve); child.on("error", reject); });
	console.log(`Pi exited ${code}; isolated defaults: ${readFileSync(join(sandbox, "settings.json"), "utf8")}`);
	if (process.env.PI_SMOKE_TUI_LOG) {
		writeFileSync(process.env.PI_SMOKE_TUI_LOG, readFileSync(log));
		console.log(`ANSI log: ${process.env.PI_SMOKE_TUI_LOG}`);
	}
	process.exitCode = code ?? 1;
} finally {
	server.close();
	rmSync(sandbox, { recursive: true, force: true });
}
