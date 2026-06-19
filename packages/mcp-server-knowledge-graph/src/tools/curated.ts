// src/tools/curated.ts
//
// SIO-967: the curated, read-only graph tools, one per packages/knowledge-graph
// reader. They are the MCP-standardized successor to the SIO-966 in-process
// local-tools.ts (createQueryKnowledgeGraphTool). No raw Cypher -> injection-safe;
// all values bind as params inside the readers. Each tool soft-fails to a friendly
// string when the graph is disabled/unavailable so a turn degrades instead of
// erroring (mirrors the SIO-966 runKnowledgeGraphQuery wording).

import {
	changeHistoryForStackInstance,
	deploymentsRunningStack,
	type GraphStore,
	getGraphStore,
	isKnowledgeGraphEnabled,
	priorChangesForDeployment,
	stacksUsingModule,
} from "@devops-agent/knowledge-graph";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { text } from "./shared.ts";

const GRAPH_DISABLED = "Knowledge graph is disabled (KNOWLEDGE_GRAPH_ENABLED is not set).";
const GRAPH_UNAVAILABLE = "Knowledge graph is unavailable right now.";

// Resolve the in-process store singleton (the one lbug lock holder). Returns a
// friendly string instead of throwing when the graph is off/unavailable.
async function resolveStore(): Promise<GraphStore | string> {
	if (!isKnowledgeGraphEnabled()) return GRAPH_DISABLED;
	try {
		return await getGraphStore();
	} catch {
		return GRAPH_UNAVAILABLE;
	}
}

export function registerCuratedTools(server: McpServer): void {
	server.tool(
		"kg_deployments_running_stack",
		"Blast radius: which Elastic deployments run a given stack (cross-deployment). Read-only; no Cypher.",
		{ stack: z.string().min(1).describe("Stack name, e.g. slos") },
		async ({ stack }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await deploymentsRunningStack(store, stack);
			return text(
				rows.length > 0
					? `Deployments running the ${stack} stack: ${rows.join(", ")}.`
					: `No deployments run the ${stack} stack (or none recorded yet).`,
			);
		},
	);

	server.tool(
		"kg_stacks_using_module",
		"Blast radius: which stacks wire a given module (cross-stack reuse). Read-only; no Cypher.",
		{ module: z.string().min(1).describe("Module name, e.g. lifecycle") },
		async ({ module }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await stacksUsingModule(store, module);
			return text(
				rows.length > 0
					? `Stacks using the ${module} module: ${rows.join(", ")}.`
					: `No stacks use the ${module} module (or none recorded yet).`,
			);
		},
	);

	server.tool(
		"kg_stack_instance_history",
		"Recent change history for one (deployment, stack) cell, with outcome. Read-only; no Cypher.",
		{
			deployment: z.string().min(1).describe("Deployment name, e.g. eu-b2b"),
			stack: z.string().min(1).describe("Stack name, e.g. slos"),
		},
		async ({ deployment, stack }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const id = `${deployment}/${stack}`;
			const rows = await changeHistoryForStackInstance(store, id);
			if (rows.length === 0) return text(`No recorded changes for ${id}.`);
			const lines = rows.map((c) => {
				const wf = c.workflow ? `${c.workflow}: ` : "";
				const mr = c.mrUrl ? ` (${c.mrUrl})` : "";
				return `- [${c.outcome}] ${wf}${c.summary}${mr}`;
			});
			return text(`Recent changes to ${id}:\n${lines.join("\n")}`);
		},
	);

	server.tool(
		"kg_deployment_history",
		"Recent IaC change history for one deployment, most-recent first. Read-only; no Cypher.",
		{ deployment: z.string().min(1).describe("Deployment name, e.g. eu-b2b") },
		async ({ deployment }) => {
			const store = await resolveStore();
			if (typeof store === "string") return text(store);
			const rows = await priorChangesForDeployment(store, deployment);
			if (rows.length === 0) return text(`No recorded changes for ${deployment}.`);
			const lines = rows.map((c) => {
				const wf = c.workflow ? `${c.workflow}: ` : "";
				const mr = c.mrUrl ? ` (${c.mrUrl})` : "";
				return `- ${wf}${c.summary}${mr}`;
			});
			return text(`Recent changes to ${deployment}:\n${lines.join("\n")}`);
		},
	);
}
