// apps/web/src/lib/server/graph-registry.ts
//
// SIO-1655 (PR 1): one place that knows which agents exist. Before this, the
// web layer encoded "there are exactly two agents" in a dozen spots -- six
// `agentName === "elastic-iac"` ternaries, a two-member AgentId union, a
// hardcoded Zod enum, a binary UI toggle. Adding a third agent meant editing
// every one of them and hoping none were missed.
//
// The registry replaces the ones that are pure lookups ("which compiled graph
// does this name mean?") and the ones that are capability questions wearing a
// name check ("does this agent have a confidence score?"). It deliberately does
// NOT try to absorb the two sites in invokeAgent/iacResume where the agent name
// selects a whole different code path over a different state shape (IacState vs
// AgentState); collapsing those would hide a real difference behind a lookup.

import { isPiFleetGraphEnabled } from "@devops-agent/agent";
import { AGENT_IDS, type AgentId, DEFAULT_AGENT_ID, isAgentId } from "$lib/agent-ids";
import { getGraph, getIacGraph, getPiFleetGraph } from "./agent";

// What a caller needs to know about an agent without naming it. Each flag
// replaces a name comparison that was really asking this question:
//   hasConfidence   -- readCompletedTurn/readCompletedTurnOutcome skip agents
//                      with no confidence signal (was: !== "incident-analyzer")
//   hasDataSources  -- same sites, datasource attribution
//   streamsTokens   -- false for graphs that append a final AIMessage instead
//                      of streaming (the SSE handler then reads terminal state)
export interface AgentDescriptor {
	readonly id: AgentId;
	readonly label: string;
	readonly hasConfidence: boolean;
	readonly hasDataSources: boolean;
	readonly streamsTokens: boolean;
	// Resolves this agent's compiled graph. Kept as a thunk so registering an
	// agent never eagerly compiles its graph or connects MCP.
	readonly graph: () => Promise<Awaited<ReturnType<typeof getGraph>> | Awaited<ReturnType<typeof getIacGraph>>>;
}

const REGISTRY: Readonly<Record<AgentId, AgentDescriptor>> = {
	"incident-analyzer": {
		id: "incident-analyzer",
		label: "Incident Analyzer",
		hasConfidence: true,
		hasDataSources: true,
		streamsTokens: true,
		graph: getGraph,
	},
	// SIO-1655 (Phase 2c). Registered always so the id resolves and routes give a
	// coherent error; SELECTABLE only when PI_FLEET_GRAPH_ENABLED is set and a hub
	// is configured (see listSelectableAgents) -- the edge-gate idiom applied to a
	// whole agent rather than a node.
	"pi-fleet-console": {
		id: "pi-fleet-console",
		label: "Fleet Console",
		hasConfidence: false,
		hasDataSources: false,
		// The console composes one answer at the end rather than streaming tokens.
		streamsTokens: false,
		graph: getPiFleetGraph,
	},
	"elastic-iac": {
		id: "elastic-iac",
		label: "Elastic IaC",
		hasConfidence: false,
		hasDataSources: false,
		// The IaC graph appends its output as AIMessages rather than streaming
		// tokens through an output node.
		streamsTokens: false,
		graph: getIacGraph,
	},
};

export type { AgentId };
// Re-exported so server callers reach the id vocabulary and the registry from
// one import.
export { AGENT_IDS, DEFAULT_AGENT_ID, isAgentId };

export function describeAgent(agentName: string = DEFAULT_AGENT_ID): AgentDescriptor {
	const descriptor = REGISTRY[agentName as AgentId];
	// Unknown names are refused rather than silently defaulted: a typo'd agent
	// name that quietly ran the incident analyzer would be a confusing bug.
	if (!descriptor) throw new Error(`unknown agent "${agentName}"`);
	return descriptor;
}

export function listAgents(): readonly AgentDescriptor[] {
	return Object.values(REGISTRY);
}

// The agents a user may actually pick this deployment. The fleet console is
// hidden unless its flag is on: it needs a configured pi-coms hub, and offering
// an agent whose graph cannot build would be a dead end in the UI.
export function listSelectableAgents(env: NodeJS.ProcessEnv = process.env): readonly AgentDescriptor[] {
	return listAgents().filter((a) => a.id !== "pi-fleet-console" || isPiFleetGraphEnabled(env));
}

// The lookup that replaces `agentName === "elastic-iac" ? getIacGraph() : getGraph()`.
export function graphFor(agentName: string = DEFAULT_AGENT_ID) {
	return describeAgent(agentName).graph();
}
