// agent/src/iac/local-tools.ts
//
// SIO-966 / SIO-967: the durable-memory PULL tool for the elastic-iac agent. The
// knowledge-graph query tool that used to live here was promoted to the standard MCP
// surface (the curated kg_* tools served by packages/mcp-server-knowledge-graph) in
// SIO-967; only search_memory stays LOCAL because agent memory is REST infrastructure,
// not MCP-exposed. It soft-fails to a friendly string so a non-agent-memory backend
// degrades gracefully instead of erroring the turn.

import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { searchAgentMemory } from "../memory-backend.ts";

export const SEARCH_MEMORY_TOOL = "search_memory";

const SearchMemorySchema = z.object({
	query: z.string().describe("What to recall, e.g. 'eu-b2b warm tier resize outcome'."),
	deployment: z.string().optional().describe("Optional filter: only facts about this deployment/cluster."),
	stack: z.string().optional().describe("Optional filter: only facts about this stack."),
	kind: z
		.string()
		.optional()
		.describe("Optional filter: block kind, e.g. iac-change | fleet-upgrade-terminal | key-decision."),
});

type SearchMemoryArgs = z.infer<typeof SearchMemorySchema>;

// Pure handler: semantic recall across past sessions with an optional annotation
// filter that joins to the knowledge-graph node keys. Exported for tests.
export async function runMemorySearch(agentName: string, args: SearchMemoryArgs): Promise<string> {
	const filter: Record<string, string> = {};
	if (args.deployment) filter.deployment = args.deployment;
	if (args.stack) filter.stack = args.stack;
	if (args.kind) filter.kind = args.kind;
	const hits = await searchAgentMemory(agentName, args.query, filter);
	if (hits.length === 0) return "No matching memory found (or durable memory is not enabled for this agent).";
	const lines = hits.map((h) => {
		const a = h.annotations;
		const tags = [a.deployment, a.stack, a.version, a.outcome].filter(Boolean).join(" ");
		return tags ? `- ${h.text} [${tags}]` : `- ${h.text}`;
	});
	return lines.join("\n");
}

export function createSearchMemoryTool(agentName: string): StructuredToolInterface {
	return createTool(async (args: unknown) => runMemorySearch(agentName, SearchMemorySchema.parse(args)), {
		name: SEARCH_MEMORY_TOOL,
		description:
			"Search the agent's durable memory of past sessions for prior decisions, change outcomes, " +
			"versions, and pipeline results. Optionally filter by deployment, stack, or kind. " +
			"Use it to recall 'what was the outcome of the eu-b2b 9.4.2 upgrade' across sessions.",
		schema: SearchMemorySchema,
	}) as unknown as StructuredToolInterface;
}
