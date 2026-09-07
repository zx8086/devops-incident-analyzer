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

import { isPiComsConfigured, isPiFleetGraphEnabled } from "@devops-agent/agent";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StateSnapshot } from "@langchain/langgraph";
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
	// SIO-1657: whether the header's mode control cycles this agent.
	//   "mode"       -- a top-level way of working the operator switches between.
	//   "contextual" -- a capability reached from the agent whose work it belongs
	//                   to, not a peer mode. The fleet console asks live account
	//                   spokes about an incident, which only means anything while
	//                   analyzing one; offering it from the IaC agent (an Elastic
	//                   Cloud config maker) is noise.
	// Selectability (listSelectableAgents) is a separate question -- CAN this
	// deployment run it at all -- and both still apply.
	readonly surface: "mode" | "contextual";
	// Resolves this agent's compiled graph. Kept as a thunk so registering an
	// agent never eagerly compiles its graph or connects MCP.
	//
	// Typed by what registry CALLERS use, not as a union of concrete graph types.
	// A CompiledStateGraph's type parameters include its own node-name literals,
	// so a union would have to be widened for every agent added -- and adding an
	// agent is exactly what this registry exists to make cheap. Callers that need
	// a specific graph's state shape (invokeAgent, iacResume) go on calling
	// getGraph/getIacGraph directly, which is also why those two sites keep their
	// explicit branch.
	readonly graph: () => Promise<CompiledGraphLike>;
}

// The surface every graphFor() caller uses: read a thread's state, write pruning
// removals back, and draw the topology. Deliberately structural.
export interface CompiledGraphLike {
	getState: (config: RunnableConfig) => Promise<StateSnapshot>;
	// pruneThreadState writes RemoveMessage entries back after a turn.
	updateState: (config: RunnableConfig, values: unknown, asNode?: string) => Promise<RunnableConfig>;
	getGraphAsync: (config?: RunnableConfig) => Promise<{ nodes: Record<string, unknown>; edges: DrawableEdge[] }>;
}

export interface DrawableEdge {
	source: string;
	target: string;
	conditional?: boolean;
}

const REGISTRY: Readonly<Record<AgentId, AgentDescriptor>> = {
	"incident-analyzer": {
		id: "incident-analyzer",
		label: "Incident Analyzer",
		hasConfidence: true,
		hasDataSources: true,
		streamsTokens: true,
		surface: "mode",
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
		// SIO-1657: asking live account spokes about an incident belongs to the
		// incident analyzer's context, so it is offered from there rather than
		// cycled as a peer of the IaC config maker.
		surface: "contextual",
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
		surface: "mode",
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

// The agents a user may actually pick this deployment.
//
// SIO-1655: the fleet console's CAPABILITY is on by default, but its
// AVAILABILITY follows the infrastructure that serves it. Without a configured
// pi-coms hub its graph cannot build, so offering it would be a dead end in the
// UI -- the flag says whether the feature is wanted, isPiComsConfigured says
// whether it can work, and both must hold.
export function listSelectableAgents(env: NodeJS.ProcessEnv = process.env): readonly AgentDescriptor[] {
	return listAgents().filter(
		(a) => a.id !== "pi-fleet-console" || (isPiFleetGraphEnabled(env) && isPiComsConfigured(env)),
	);
}

// SIO-1657: the agents the header's mode control cycles -- selectable AND a
// top-level mode. Derived from the registry rather than listed again, so a new
// agent is one entry here and nowhere else (the duplication SIO-1655 removed).
// A contextual agent stays selectable: it is still switched to, just not cycled.
export function listModeAgents(env: NodeJS.ProcessEnv = process.env): readonly AgentDescriptor[] {
	return listSelectableAgents(env).filter((a) => a.surface === "mode");
}

// The lookup that replaces `agentName === "elastic-iac" ? getIacGraph() : getGraph()`.
export function graphFor(agentName: string = DEFAULT_AGENT_ID) {
	return describeAgent(agentName).graph();
}
