// agent/src/live-memory-section.ts
//
// SIO-1446: pure renderer for the orchestrator prompt's Live Memory section,
// extracted from prompt-context.ts's buildLiveMemorySection so it is testable
// without importing prompt-context.ts (which several sibling test files
// mock.module process-globally -- a direct import here would be load-order
// dependent in the full suite).
import type { LiveMemory } from "./memory-writer.ts";

// Inline only the tail of key-decisions so the prompt stays bounded as decisions
// accumulate (SIO-845).
const MAX_KEY_DECISION_CHARS = 4000;

export function renderLiveMemorySection(memory: LiveMemory, recalledContext?: string): string {
	const sections: string[] = [];

	if (memory.context?.trim()) {
		sections.push(memory.context.trim());
	}

	if (memory.keyDecisions?.trim()) {
		const full = memory.keyDecisions.trim();
		const tail = full.length > MAX_KEY_DECISION_CHARS ? `...\n${full.slice(-MAX_KEY_DECISION_CHARS)}` : full;
		sections.push(`### Recent Key Decisions\n\n${tail}`);
	}

	// SIO-1446: semantic recall over the agent's past sessions, gathered once at
	// bootstrap (agent-memory backend only) and stashed per thread in lifecycle.ts.
	// Rendered last and clearly labeled so the model can weigh it as background
	// from OTHER sessions, not this incident's own context. Already bounded at the
	// source (SIO-998 recall limit + SIO-973 dedup), so no re-truncation here.
	if (recalledContext?.trim()) {
		sections.push(`### Recalled From Past Sessions\n\n${recalledContext.trim()}`);
	}

	if (sections.length === 0) return "";
	return ["\n\n---\n\n## Live Memory", ...sections].join("\n\n");
}
