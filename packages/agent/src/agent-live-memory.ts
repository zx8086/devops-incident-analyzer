// agent/src/agent-live-memory.ts
//
// SIO-1888: the Live Memory prompt section for ANY top-level agent. The
// orchestrator builds its own through prompt-context.ts (buildLiveMemorySection,
// read by the aggregator). elastic-iac, landing-zone-terraform and
// pi-fleet-console ran load_live_memory at bootstrap, stashed the semantic recall
// per thread (lifecycle.ts) and then never read it: sessionBootstrap discards the
// BootstrapResult. This is the one seam that reads the agent's own runtime files
// plus that stash, keyed on the current request's thread.
import { getCurrentRequestContext } from "@devops-agent/shared";
import { getRecalledMemoryContext } from "./lifecycle.ts";
import { renderLiveMemorySection } from "./live-memory-section.ts";
import { readLiveMemory } from "./memory-writer.ts";
import { getAgentsDir } from "./paths.ts";

// Empty string when live memory is disabled AND nothing was recalled, so every
// caller can append it unconditionally without changing the happy path.
export function buildAgentLiveMemorySection(
	agentName: string,
	threadId: string | undefined = getCurrentRequestContext()?.threadId,
): string {
	return renderLiveMemorySection(readLiveMemory(getAgentsDir(agentName)), getRecalledMemoryContext(threadId));
}
