import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCacheSavings from "../src/cache-savings/extension.ts";
import registerCacheTtl from "../src/cache-ttl/extension.ts";
import registerMinimalFooter from "../src/minimal-footer/extension.ts";
import registerDefaultModel from "../src/default-model/extension.ts";
import registerGitStatus from "../src/git-status/extension.ts";
import registerElapsed from "../src/elapsed/extension.ts";

/** The only Pi entry point. Each feature owns its own state and lifecycle. */
export default function mypi(pi: ExtensionAPI): void {
	registerCacheSavings(pi);
	registerCacheTtl(pi);
	registerMinimalFooter(pi);
	registerDefaultModel(pi);
	registerGitStatus(pi);
	registerElapsed(pi);
}
