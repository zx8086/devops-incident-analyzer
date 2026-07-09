// agent/src/orchestrator-prompt-assembly.ts
//
// SIO-1040: pure assembly of the orchestrator prompt's stable/volatile split.
// Kept in its OWN module (no getAgent, no file IO) so its byte-identity unit test
// is immune to the process-global mock.module("./prompt-context.ts") that sibling
// suites register (see reference_prompt_context_mock_pollutes_direct_imports).
import { buildSystemPromptParts, type LoadedAgent } from "@devops-agent/gitagent-bridge";

export interface OrchestratorPromptParts {
	stable: string;
	volatile: string;
}

// The four turn-varying sections, already rendered by prompt-context.ts, in the
// exact order the pre-split buildOrchestratorPrompt concatenated them.
export interface VolatileSections {
	compliance: string;
	liveMemory: string;
	wiki: string;
	graph: string;
}

// Filter the knowledge array to remove non-selected runbooks when a filter is
// present. Other categories (systems-map, slo-policies) pass through unchanged.
// Shallow copy preserves referential equality for everything else so downstream
// consumers see the same identities as the cached agent. runbookFilter undefined
// -> no filter; [] -> suppress all runbooks; [names] -> keep just these.
export function filterAgentRunbooks(agent: LoadedAgent, runbookFilter: string[] | undefined): LoadedAgent {
	if (runbookFilter === undefined) return agent;
	const filterSet = new Set(runbookFilter);
	const filteredKnowledge = agent.knowledge.filter((entry) => {
		if (entry.category !== "runbooks") return true;
		return filterSet.has(entry.filename);
	});
	return { ...agent, knowledge: filteredKnowledge };
}

// stable   = system-prompt core (soul + shared context + rules + skills) -- the
//            turn-invariant cacheable prefix. Runbook filtering deliberately only
//            touches knowledge (volatile), so the cached prefix is stable across
//            turns with different selected runbooks.
// volatile = filtered knowledge + compliance + live memory + wiki + graph, in the
//            same order the pre-split prompt concatenated them, so
//            stable + volatile is byte-identical to the old output.
export function assembleOrchestratorPromptParts(
	agent: LoadedAgent,
	sections: VolatileSections,
): OrchestratorPromptParts {
	const { core, knowledge } = buildSystemPromptParts(agent);
	const volatile = knowledge + sections.compliance + sections.liveMemory + sections.wiki + sections.graph;
	return { stable: core, volatile };
}
