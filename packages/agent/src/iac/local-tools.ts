// agent/src/iac/local-tools.ts
//
// SIO-966: LLM-callable read tools that let the elastic-iac agent PULL from the
// knowledge graph and Agent Memory on demand (vs. SIO-965's push-only auto-inject).
// These are LOCAL LangChain tools (not MCP) appended to infoTools(); they wrap the
// existing tested KG readers (no raw Cypher -> injection-safe) and the agent-memory
// search wrapper. Both soft-fail to a friendly string so a disabled graph / non-
// agent-memory backend degrades gracefully instead of erroring the turn.

import {
	changeHistoryForStackInstance,
	deploymentsRunningStack,
	getGraphStore,
	isKnowledgeGraphEnabled,
	priorChangesForDeployment,
	stacksUsingModule,
} from "@devops-agent/knowledge-graph";
import { tool as createTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { searchAgentMemory } from "../memory-backend.ts";

export const QUERY_KNOWLEDGE_GRAPH_TOOL = "query_knowledge_graph";
export const SEARCH_MEMORY_TOOL = "search_memory";

const KgQuerySchema = z.object({
	query_type: z
		.enum(["deployments_running_stack", "stacks_using_module", "stack_instance_history", "deployment_history"])
		.describe("Which curated knowledge-graph query to run."),
	deployment: z.string().optional().describe("Cluster/deployment name, e.g. eu-b2b (for *_history)."),
	stack: z
		.string()
		.optional()
		.describe("Stack name, e.g. slos (for deployments_running_stack / stack_instance_history)."),
	module: z.string().optional().describe("Module name, e.g. lifecycle (for stacks_using_module)."),
});

type KgQueryArgs = z.infer<typeof KgQuerySchema>;

// Pure handler: runs one curated reader and renders a compact string. Exported for tests.
export async function runKnowledgeGraphQuery(args: KgQueryArgs): Promise<string> {
	if (!isKnowledgeGraphEnabled()) return "Knowledge graph is disabled (KNOWLEDGE_GRAPH_ENABLED is not set).";
	let store: Awaited<ReturnType<typeof getGraphStore>>;
	try {
		store = await getGraphStore();
	} catch {
		return "Knowledge graph is unavailable right now.";
	}
	switch (args.query_type) {
		case "deployments_running_stack": {
			if (!args.stack) return "deployments_running_stack needs a stack name.";
			const rows = await deploymentsRunningStack(store, args.stack);
			return rows.length > 0
				? `Deployments running the ${args.stack} stack: ${rows.join(", ")}.`
				: `No deployments run the ${args.stack} stack (or none recorded yet).`;
		}
		case "stacks_using_module": {
			if (!args.module) return "stacks_using_module needs a module name.";
			const rows = await stacksUsingModule(store, args.module);
			return rows.length > 0
				? `Stacks using the ${args.module} module: ${rows.join(", ")}.`
				: `No stacks use the ${args.module} module (or none recorded yet).`;
		}
		case "stack_instance_history": {
			if (!args.deployment || !args.stack) return "stack_instance_history needs both deployment and stack.";
			const id = `${args.deployment}/${args.stack}`;
			const rows = await changeHistoryForStackInstance(store, id);
			if (rows.length === 0) return `No recorded changes for ${id}.`;
			const lines = rows.map((c) => {
				const wf = c.workflow ? `${c.workflow}: ` : "";
				const mr = c.mrUrl ? ` (${c.mrUrl})` : "";
				return `- [${c.outcome}] ${wf}${c.summary}${mr}`;
			});
			return `Recent changes to ${id}:\n${lines.join("\n")}`;
		}
		case "deployment_history": {
			if (!args.deployment) return "deployment_history needs a deployment name.";
			const rows = await priorChangesForDeployment(store, args.deployment);
			if (rows.length === 0) return `No recorded changes for ${args.deployment}.`;
			const lines = rows.map((c) => {
				const wf = c.workflow ? `${c.workflow}: ` : "";
				const mr = c.mrUrl ? ` (${c.mrUrl})` : "";
				return `- ${wf}${c.summary}${mr}`;
			});
			return `Recent changes to ${args.deployment}:\n${lines.join("\n")}`;
		}
		default:
			return `Unknown query_type.`;
	}
}

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

export function createQueryKnowledgeGraphTool(): StructuredToolInterface {
	return createTool(async (args: unknown) => runKnowledgeGraphQuery(KgQuerySchema.parse(args)), {
		name: QUERY_KNOWLEDGE_GRAPH_TOOL,
		description:
			"Query the infrastructure knowledge graph for change history and blast radius. " +
			"Use it to answer 'what changed on <deployment>/<stack>', 'which deployments run <stack>', " +
			"or 'which stacks use the <module> module'. Read-only; no Cypher.",
		schema: KgQuerySchema,
	}) as unknown as StructuredToolInterface;
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
