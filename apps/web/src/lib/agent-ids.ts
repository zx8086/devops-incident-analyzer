// apps/web/src/lib/agent-ids.ts
//
// SIO-1655 (PR 1): the agent id union, in a runtime-free module both the server
// registry and the client store can import. It lived in agent.svelte.ts, but a
// runes module is not safe for server code to import just to reach a type, so
// the union moved here and the store re-exports it for its existing consumers.
//
// Adding an agent: add its id here, then one entry in
// lib/server/graph-registry.ts. Everything that used to hardcode the pair (the
// stream route's Zod enum, the topology route's guard, the UI selector) derives
// from those two places.

export const AGENT_IDS = ["incident-analyzer", "elastic-iac"] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export const DEFAULT_AGENT_ID: AgentId = "incident-analyzer";

export function isAgentId(name: string): name is AgentId {
	return (AGENT_IDS as readonly string[]).includes(name);
}

// Display metadata for the agent selector. Client-safe (no server imports), and
// the single place a new agent's user-facing name is written.
export interface AgentChoice {
	readonly id: AgentId;
	readonly title: string;
	readonly subtitle: string;
}

export const AGENT_CHOICES: readonly AgentChoice[] = [
	{
		id: "incident-analyzer",
		title: "Incident Analyzer",
		subtitle: "DevOps Incident Analysis Assistant",
	},
	{
		id: "elastic-iac",
		title: "Elastic IaC Agent",
		subtitle: "Elastic Cloud IaC change assistant",
	},
];

export function agentChoice(id: AgentId): AgentChoice {
	const choice = AGENT_CHOICES.find((c) => c.id === id);
	if (!choice) throw new Error(`unknown agent "${id}"`);
	return choice;
}
