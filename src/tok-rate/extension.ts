import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createTokRateController,
	DEFAULT_FALLBACK_SPAN_MS,
	DEFAULT_MIN_SPAN_MS,
	DEFAULT_THROTTLE_MS,
	estimateTokens,
	formatThemedAverageTokRateStatus,
	formatThemedTokRateStatus,
	formatTokPerSecond,
	STATUS_KEY,
	type AssistantDeltaLike,
	type AssistantMessageLike,
	type TokRateContext,
} from "./core.ts";

// Re-export the pure pieces so they can be exercised without a Pi runtime.
export {
	createTokRateController,
	DEFAULT_FALLBACK_SPAN_MS,
	DEFAULT_MIN_SPAN_MS,
	DEFAULT_THROTTLE_MS,
	estimateTokens,
	formatThemedAverageTokRateStatus,
	formatThemedTokRateStatus,
	formatTokPerSecond,
	STATUS_KEY,
};
export type {
	AssistantDeltaLike,
	AssistantMessageLike,
	AssistantUsageLike,
	TokRateContext,
	TokRateController,
	TokRateControllerOptions,
	TokRateTheme,
	TokRateUi,
} from "./core.ts";

/**
 * Shows the generation speed of the latest assistant message as `4.6 tok/s`.
 *
 * The value updates a few times per second while deltas stream and is replaced
 * by the provider-reported `usage.output` rate at `message_end`.  When the
 * instruction settles, the footer switches to `avg 92 tok/s`: the successful
 * messages' combined output over their combined generation time.  A new
 * instruction clears it, and failed or aborted messages are excluded.
 */
export default function tokRateExtension(pi: ExtensionAPI): void {
	const controller = createTokRateController();

	const toContext = (ctx: ExtensionContext): TokRateContext => ({
		hasUI: ctx.hasUI,
		ui: {
			theme: ctx.ui.theme,
			setStatus: (key, text) => ctx.ui.setStatus(key, text),
		},
	});

	pi.on("before_agent_start", (_event, ctx) => {
		controller.reset(toContext(ctx));
	});

	pi.on("message_start", (event, ctx) => {
		controller.messageStart(event.message as AssistantMessageLike, toContext(ctx));
	});

	pi.on("message_update", (event, ctx) => {
		controller.messageUpdate(event.assistantMessageEvent as AssistantDeltaLike, toContext(ctx));
	});

	pi.on("message_end", (event, ctx) => {
		controller.messageEnd(event.message as AssistantMessageLike, toContext(ctx));
	});

	pi.on("agent_settled", (_event, ctx) => {
		controller.agentSettled(toContext(ctx));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		controller.sessionShutdown(toContext(ctx));
	});
}
