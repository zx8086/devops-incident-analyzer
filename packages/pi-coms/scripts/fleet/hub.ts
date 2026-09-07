// scripts/fleet/hub.ts
// SIO-1653: read-only view of a hub's registry for rollout polling and status,
// through the SSM port-forward the CLI opens to that environment's hub.
import type { AgentCard, AgentListing } from "../../contracts/wire.ts";

// `project` must be the namespace the spokes register under (hubs.<env>.project
// in the manifest). It was hardcoded to "default", so once a fleet moved to a
// per-environment project the rollout poll read an empty namespace and waited
// out its 10-minute deadline reporting "not registered" for agents that were
// online the whole time. Defaults to "default" for fleets that never set one.
export async function listAgents(baseUrl: string, token: string, project = "default"): Promise<AgentCard[]> {
	const resp = await fetch(`${baseUrl}/v1/agents?project=${encodeURIComponent(project)}&include_explicit=true`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!resp.ok) throw new Error(`GET /v1/agents: ${resp.status} ${await resp.text()}`);
	const listing = (await resp.json()) as AgentListing;
	return listing.agents ?? [];
}

export type Expectation = { bundle?: string; persona?: string };

// What a converged spoke looks like on the hub: agent and monitor online, the
// agent's purpose carrying the bundle sha (via the digest) and persona version.
export function missingOnHub(agents: AgentCard[], name: string, expect: Expectation): string[] {
	const problems: string[] = [];
	const agent = agents.find((a) => a.name === name);
	const monitor = agents.find((a) => a.name === `monitor-${name}`);
	if (!agent) problems.push(`${name} not registered`);
	else if (agent.status !== "online") problems.push(`${name} is ${agent.status}`);
	else if (expect.persona && !agent.purpose.includes(`persona=pi-fleet-v${expect.persona}`)) {
		problems.push(`${name} purpose lacks persona=pi-fleet-v${expect.persona} (${agent.purpose})`);
	}
	if (!monitor) problems.push(`monitor-${name} not registered`);
	else if (monitor.status !== "online") problems.push(`monitor-${name} is ${monitor.status}`);
	return problems;
}
