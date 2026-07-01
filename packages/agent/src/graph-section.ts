// agent/src/graph-section.ts
//
// SIO-1028: pure builder for the orchestrator prompt's knowledge-graph section.
// Kept in its own module (not prompt-context.ts) so unit tests import it without
// hitting the process-global mock.module("./prompt-context.ts") that many sibling
// test files register (Bun mocks are last-wins and not reset between files --
// see memory reference_mock_pollution_own_in_beforeeach).

// The graph block (## Knowledge Graph / ### Similar prior incidents from
// buildGraphContext) was previously inlined raw, so recall questions relied on LLM
// inference. Prepend a usage instruction so a "have we seen this before?" turn
// answers from the prior-incident entries. The "no record rather than guessing"
// clause follows the SIO-1013 grounded-gaps discipline. Empty graphContext -> ""
// so no instruction leaks when the knowledge graph is disabled/absent.
export function buildGraphSection(graphContext: string | undefined): string {
	if (!graphContext?.trim()) return "";
	return `\n\n---\n\n## Prior-Incident Recall\nWhen the user asks whether an incident has happened before, what prior incidents exist, or what previously resolved a similar issue, ANSWER FROM the "Similar prior incidents" entries in the Knowledge Graph section below (each may carry a prior root cause). If no such entries are present, say you have no prior-incident record rather than guessing.${graphContext}`;
}
