import { describe, expect, test } from "bun:test";
import cacheReuseExtension, {
	computeCacheReuse,
	createCacheReuseController,
	formatCachedTokens,
	formatCacheReuseStatus,
	formatThemedCacheReuse,
	STATUS_KEY,
} from "../src/cache-reuse/extension.ts";

describe("computeCacheReuse", () => {
	test("returns the cached tokens of a real hit", () => {
		expect(computeCacheReuse({ input: 10_000, cacheRead: 200_000 })).toEqual({ cachedTokens: 200_000 });
		expect(computeCacheReuse({ cacheRead: 1 })).toEqual({ cachedTokens: 1 });
	});

	test("returns undefined without a usable positive cacheRead", () => {
		expect(computeCacheReuse(undefined)).toBeUndefined();
		expect(computeCacheReuse({})).toBeUndefined();
		expect(computeCacheReuse({ cacheRead: 0 })).toBeUndefined();
		expect(computeCacheReuse({ cacheRead: -5 })).toBeUndefined();
		expect(computeCacheReuse({ cacheRead: Number.NaN })).toBeUndefined();
		expect(computeCacheReuse({ cacheRead: "1000" })).toBeUndefined();
	});
});

describe("footer formatting", () => {
	test("formats token counts compactly", () => {
		expect(formatCachedTokens(128)).toBe("128");
		expect(formatCachedTokens(1000)).toBe("1k");
		expect(formatCachedTokens(12_345)).toBe("12.3k");
		expect(formatCachedTokens(120_000)).toBe("120k");
		expect(formatCachedTokens(1_234_567)).toBe("1.23M");
		expect(formatCachedTokens(0)).toBe("0");
	});

	test("renders the status without a dollar estimate", () => {
		expect(formatCacheReuseStatus({ cachedTokens: 200_000 })).toBe("cached 200k tok");
		expect(formatCacheReuseStatus({ cachedTokens: 12_345 })).toBe("cached 12.3k tok");
	});

	test("dims only the label", () => {
		const theme = {
			fg(color: "dim", text: string) {
				return `<${color}>${text}</${color}>`;
			},
		};
		expect(formatThemedCacheReuse("cached 200k tok", theme)).toBe(
			"<dim>cached</dim> 200k tok",
		);
		expect(formatThemedCacheReuse("cached 200k tok")).toBe("cached 200k tok");
	});
});

function createContext(updates: Array<[string, string | undefined]>) {
	return {
		hasUI: true,
		ui: {
			setStatus(key: string, text: string | undefined) {
				updates.push([key, text]);
			},
		},
	};
}

describe("controller lifecycle", () => {
	test("tracks the latest response and clears on hit-less responses and boundaries", () => {
		const updates: Array<[string, string | undefined]> = [];
		const controller = createCacheReuseController();
		const ctx = createContext(updates);

		controller.sessionStart(ctx);
		expect(updates).toEqual([[STATUS_KEY, undefined]]);
		expect(controller.getLatest()).toBeUndefined();

		// Non-assistant messages are ignored entirely.
		controller.messageEnd({ role: "user", usage: { cacheRead: 999 } }, ctx);
		expect(updates).toHaveLength(1);
		// An assistant message without usable usage tells nothing new either.
		controller.messageEnd({ role: "assistant" }, ctx);
		expect(updates).toHaveLength(1);

		controller.messageEnd({ role: "assistant", usage: { input: 10_000, cacheRead: 200_000 } }, ctx);
		expect(updates.at(-1)).toEqual([STATUS_KEY, "cached 200k tok"]);
		expect(controller.getLatest()).toEqual({ cachedTokens: 200_000 });

		// The latest response wins.
		controller.messageEnd({ role: "assistant", usage: { cacheRead: 1_500 } }, ctx);
		expect(updates.at(-1)).toEqual([STATUS_KEY, "cached 1.5k tok"]);

		// A hit-less response clears the stale hit display.
		controller.messageEnd({ role: "assistant", usage: { cacheRead: 0, input: 42 } }, ctx);
		expect(updates.at(-1)).toEqual([STATUS_KEY, undefined]);
		expect(controller.getLatest()).toBeUndefined();

		// Repeated renders of the same text do not touch the TUI.
		controller.messageEnd({ role: "assistant", usage: { cacheRead: 1_500 } }, ctx);
		const count = updates.length;
		controller.messageEnd({ role: "assistant", usage: { cacheRead: 1_500 } }, ctx);
		expect(updates).toHaveLength(count);

		// A session switch must clear the stale segment from the old session.
		controller.sessionStart(ctx);
		expect(updates.at(-1)).toEqual([STATUS_KEY, undefined]);

		// Model switches invalidate numbers that belonged to the old model.
		controller.messageEnd({ role: "assistant", usage: { cacheRead: 1_500 } }, ctx);
		controller.modelSelect(ctx);
		expect(updates.at(-1)).toEqual([STATUS_KEY, undefined]);

		controller.messageEnd({ role: "assistant", usage: { cacheRead: 1_500 } }, ctx);
		controller.sessionShutdown(ctx);
		expect(updates.at(-1)).toEqual([STATUS_KEY, undefined]);
		expect(controller.getLatest()).toBeUndefined();
	});

	test("does not touch the UI without one", () => {
		const controller = createCacheReuseController();
		const ctx = {
			hasUI: false,
			ui: {
				setStatus() {
					throw new Error("headless UI access");
				},
			},
		};

		controller.sessionStart(ctx);
		controller.messageEnd({ role: "assistant", usage: { cacheRead: 1_500 } }, ctx);
		expect(controller.getLatest()).toEqual({ cachedTokens: 1_500 });
		controller.sessionShutdown(ctx);
	});
});

test("extension registers the verified Pi lifecycle hooks", () => {
	const events: string[] = [];
	const pi = {
		on(event: string) {
			events.push(event);
		},
	};

	cacheReuseExtension(pi as never);

	expect(events).toEqual([
		"session_start",
		"message_end",
		"model_select",
		"session_shutdown",
	]);
});
