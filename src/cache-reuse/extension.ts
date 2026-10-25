import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	computeCacheReuse,
	createCacheReuseController,
	formatCachedTokens,
	formatCacheReuseStatus,
	formatThemedCacheReuse,
	STATUS_KEY,
} from "./core.ts";

// Re-export the pure pieces so they can be exercised without a Pi runtime.
export {
	computeCacheReuse,
	createCacheReuseController,
	formatCachedTokens,
	formatCacheReuseStatus,
	formatThemedCacheReuse,
	STATUS_KEY,
};
export type {
	CacheReuse,
	CacheReuseController,
	CacheReuseStatusContext,
	CacheReuseTheme,
} from "./core.ts";

/**
 * Shows how many tokens of the latest response came from the prompt cache.
 *
 * The segment reads `cached 1.5k` and only exists while the latest
 * assistant response reported a cache hit.  No dollar estimate is shown: the
 * usual subscription-backed setup never bills those catalogue rates.
 */
export default function cacheReuseExtension(pi: ExtensionAPI): void {
	const controller = createCacheReuseController();

	pi.on("session_start", (_event, ctx) => {
		controller.sessionStart(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		controller.messageEnd(event.message, ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		controller.modelSelect(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		controller.sessionShutdown(ctx);
	});
}
