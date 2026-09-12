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

// The manifest pins `persona.min_version` -- a FLOOR, not an exact version.
// Comparing it with `purpose.includes("persona=pi-fleet-v" + min)` made every
// rollout wait out its full deadline once the persona moved past the pin: a
// spoke correctly running v0.2.0 never matches the literal string "v0.1.0", so
// a healthy fleet reported "lacks persona=pi-fleet-v0.1.0 (... persona=
// pi-fleet-v0.2.0)" until the 10-minute timeout. Observed on the prd rollout of
// bundle 26115abb, with all six spokes online the whole time.
//
// Parsed here rather than imported: `scripts/` is a nested NON-workspace package
// (SIO-1632), so it cannot reach gitagent-bridge's parseSemver.
const PERSONA_RE = /persona=pi-fleet-v(\d+)\.(\d+)\.(\d+)/;

function parseTriple(v: string): [number, number, number] | undefined {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
	return m?.[1] && m[2] && m[3] ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** The persona version an agent advertises, or undefined when it carries none. */
export function personaVersion(purpose: string): string | undefined {
	const found = PERSONA_RE.exec(purpose);
	return found?.[1] && found[2] && found[3] ? `${found[1]}.${found[2]}.${found[3]}` : undefined;
}

/**
 * True when the agent's advertised persona is at least `min`.
 *
 * An unreadable version on either side is NOT treated as satisfied: a purpose
 * carrying no persona, or a malformed pin, must keep failing rather than let a
 * rollout declare success it cannot see.
 */
export function personaAtLeast(purpose: string, min: string): boolean {
	const floor = parseTriple(min);
	const advertised = personaVersion(purpose);
	const actual = advertised ? parseTriple(advertised) : undefined;
	if (!floor || !actual) return false;
	for (let i = 0; i < 3; i++) {
		const a = actual[i] as number;
		const f = floor[i] as number;
		if (a !== f) return a > f;
	}
	return true;
}

// What a converged spoke looks like on the hub: agent and monitor online, the
// agent's purpose carrying the bundle sha (via the digest) and persona version.
export function missingOnHub(agents: AgentCard[], name: string, expect: Expectation): string[] {
	const problems: string[] = [];
	const agent = agents.find((a) => a.name === name);
	const monitor = agents.find((a) => a.name === `monitor-${name}`);
	if (!agent) problems.push(`${name} not registered`);
	else if (agent.status !== "online") problems.push(`${name} is ${agent.status}`);
	else if (expect.persona && !personaAtLeast(agent.purpose, expect.persona)) {
		problems.push(`${name} persona is below pi-fleet-v${expect.persona} (${agent.purpose})`);
	}
	if (!monitor) problems.push(`monitor-${name} not registered`);
	else if (monitor.status !== "online") problems.push(`monitor-${name} is ${monitor.status}`);
	return problems;
}
