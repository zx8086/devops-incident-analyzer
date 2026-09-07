// agent/src/iac/local-tools.ts
//
// SIO-966 / SIO-967: the durable-memory PULL tool for the elastic-iac agent. The
// knowledge-graph query tool that used to live here was promoted to the standard MCP
// surface (the curated kg_* tools served by packages/mcp-server-knowledge-graph) in
// SIO-967; only search_memory stays LOCAL because agent memory is REST infrastructure,
// not MCP-exposed. It soft-fails to a friendly string so a non-agent-memory backend
// degrades gracefully instead of erroring the turn.

import { fleetUpgradeHistory, getGraphStore, isKnowledgeGraphEnabled } from "@devops-agent/knowledge-graph";
import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { searchAgentMemory } from "../memory-backend.ts";
import { lifecycleTag } from "./lifecycle.ts";

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
	// SIO-998: this is a model-driven FUZZY recall, so keep the query (semantic ranking is the point).
	// But the annotation filter post-filters the top-relevant_k, so a small k can drop filter-matching
	// hits; use a wider window (25) so a deployment/stack/kind filter has a real candidate pool.
	const hits = await searchAgentMemory(agentName, args.query, filter, 25);
	if (hits.length === 0) return "No matching memory found (or durable memory is not enabled for this agent).";
	const lines = hits.map((h) => {
		const a = h.annotations;
		// SIO-1005: lifecycleTag instead of the raw outcome -- a reconciled iac-change shows its
		// lifecycle (applied/apply-failed), a still-proposed change reads "proposed" (not the misleading
		// "completed"), and the distinct outcomes (rejected/blocked/...) pass through unchanged.
		const tags = [a.deployment, a.stack, a.version, lifecycleTag(a)].filter(Boolean).join(" ");
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

// SIO-1664: fleet AGENT-BINARY upgrade history, answering the RETROSPECTIVE question
// ("what agent upgrades did we do today") that the durable-memory path cannot. Two reasons it
// reads the knowledge graph rather than agent memory: (1) recallInFlightFleetUpgrades collapses to
// a SINGLE upgrade, so a plural question was structurally unanswerable, and (2) memory facts carry
// no queryable date, while every fleet apply already writes a dated ConfigChange (SIO-1461).
// Soft-fails to a friendly string -- a disabled/cold graph degrades instead of erroring the turn.
export const FLEET_HISTORY_TOOL = "fleet_upgrade_history";

const FleetHistorySchema = z.object({
	since: z
		.string()
		.optional()
		.describe(
			"Optional ISO-8601 instant; only upgrades recorded at or after it are returned. " +
				"For 'today', pass today's date at midnight UTC, e.g. 2026-09-08T00:00:00.000Z.",
		),
	limit: z.number().int().positive().max(200).optional().describe("Max upgrades to return (default 50)."),
});

type FleetHistoryArgs = z.infer<typeof FleetHistorySchema>;

export async function runFleetUpgradeHistory(args: FleetHistoryArgs): Promise<string> {
	if (!isKnowledgeGraphEnabled()) return "Fleet upgrade history is unavailable (knowledge graph is disabled).";
	try {
		const store = await getGraphStore();
		const rows = await fleetUpgradeHistory(store, args.since, args.limit ?? 50);
		if (rows.length === 0) {
			return args.since
				? `No fleet agent upgrades recorded at or after ${args.since}.`
				: "No fleet agent upgrades recorded.";
		}
		// One line per upgrade -- the whole point is that this is a LIST, never a single row.
		return rows
			.map((r) => {
				const ver = r.version ? ` -> ${r.version}` : "";
				const outcome = r.outcome ? ` [${r.outcome}]` : "";
				return `- ${r.deployment}${ver}${outcome} (${r.createdAt})`;
			})
			.join("\n");
	} catch {
		return "Fleet upgrade history is unavailable right now (knowledge graph read failed).";
	}
}

export function createFleetHistoryTool(): StructuredToolInterface {
	return createTool(async (args: unknown) => runFleetUpgradeHistory(FleetHistorySchema.parse(args)), {
		name: FLEET_HISTORY_TOOL,
		description:
			"List Fleet AGENT-BINARY upgrades already carried out, newest first, across every deployment. " +
			"Use for retrospective questions such as 'what elastic agent updates did we do today', " +
			"'which deployments did we upgrade', or 'what agent upgrades ran this week'. " +
			"Pass `since` as an ISO instant to bound the window. Returns one line per upgrade.",
		schema: FleetHistorySchema,
	}) as unknown as StructuredToolInterface;
}
