// apps/web/src/routes/api/agent/topology/+server.ts

import { getLogger } from "@devops-agent/observability";
import { json } from "@sveltejs/kit";
import { DEFAULT_AGENT_ID, graphFor, isAgentId } from "$lib/server/graph-registry";
import { normalizeEdges } from "$lib/server/topology";
import type { RequestHandler } from "./$types";

const log = getLogger("api.agent.topology");

// SIO-1572: serves the compiled LangGraph's own drawable (getGraphAsync) so
// the graph triage chart is provably the topology the engine runs. Node ids
// match the node_start/node_end SSE events the stream route already forwards.
export const GET: RequestHandler = async ({ url }) => {
	const agent = url.searchParams.get("agent") ?? DEFAULT_AGENT_ID;
	if (!isAgentId(agent)) {
		return json({ error: "Unknown agent" }, { status: 400 });
	}
	try {
		const graph = await graphFor(agent);
		const drawable = await graph.getGraphAsync();
		const nodes = Object.keys(drawable.nodes);
		const edges = drawable.edges.map((edge) => ({
			source: edge.source,
			target: edge.target,
			conditional: edge.conditional === true,
		}));
		return json({ agent, nodes, edges: normalizeEdges(edges, nodes.length) });
	} catch (error) {
		log.error(
			{ agent, err: error instanceof Error ? { message: error.message } : { message: String(error) } },
			"agent.topology.error",
		);
		return json({ error: "Failed to read graph topology" }, { status: 500 });
	}
};
