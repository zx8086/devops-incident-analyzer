// packages/agent/src/runbook-selector.ts
// SIO-640: Lazy runbook selection node. Runs between normalize and entityExtractor
// when knowledge/index.yaml contains a runbook_selection block. Asks the
// orchestrator LLM to pick 0-2 runbooks from the catalog and writes the
// selection to state.selectedRunbooks as a tri-state (null | [] | [names]).

import { getLogger } from "@devops-agent/observability";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { createLlm } from "./llm.ts";
import { extractTextFromContent } from "./message-utils.ts";
import { getRunbookCatalog, type RunbookCatalogEntry } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:runbook-selector");

// Thrown when the LLM router fails AND the severity tier fallback cannot be
// consulted because state.normalizedIncident.severity is missing. Deliberate
// hard-fail: silent "use all runbooks" would hide real normalize bugs.
export class RunbookSelectionFallbackError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunbookSelectionFallbackError";
	}
}

// Thrown at agent load time if selectRunbooks is wired into the graph but the
// loaded agent has no runbook_selection config. Opt-in all-or-nothing.
export class RunbookSelectionConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunbookSelectionConfigError";
	}
}

export const RunbookSelectionResponseSchema = z.object({
	filenames: z.array(z.string()).max(10),
	reasoning: z.string(),
});

export type RunbookSelectionResponse = z.infer<typeof RunbookSelectionResponseSchema>;

export type SelectionMode =
	| "llm"
	| "llm.partial"
	| "llm.empty"
	| "llm.truncated"
	| "fallback.parse_error"
	| "fallback.timeout"
	| "fallback.api_error"
	| "fallback.invalid_filenames"
	| "skip.empty_catalog"
	| "error.missing_severity";

// Exported for testing; real config comes from the loaded agent in later tasks.
export interface RunbookSelectorDeps {
	catalog: RunbookCatalogEntry[];
	fallbackBySeverity: Record<"critical" | "high" | "medium" | "low", string[]>;
}

export async function selectRunbooks(
	_state: AgentStateType,
	_config?: RunnableConfig,
): Promise<Partial<AgentStateType>> {
	// Placeholder. Implementation in Task 8.
	logger.warn("selectRunbooks called before implementation");
	void createLlm;
	void extractTextFromContent;
	void getRunbookCatalog;
	return {};
}
