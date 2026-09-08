// apps/web/src/lib/agent-surface.test.ts
// SIO-1657: the header's agent-selector rules, as pure functions of the
// /api/agents payload + the current agent.
//
// +page.svelte holds these as $derived runes, which are not unit-testable
// outside a component (reference_web_store_runes_not_unit_testable). The rules
// are mirrored here so the two decisions that matter -- what the mode control
// cycles, and where the console is offered -- have deterministic coverage on a
// machine with no pi-coms hub, where the button cannot render at all.
import { describe, expect, test } from "bun:test";
import { type AgentId, DEFAULT_AGENT_ID } from "./agent-ids.ts";

type AgentRow = { id: string; surface?: string; hasTriageGraph?: boolean };

// Mirrors loadSelectableAgents (+page.svelte).
const modeIdsFrom = (agents: AgentRow[]): string[] => agents.filter((a) => a.surface === "mode").map((a) => a.id);
const consoleAvailableFrom = (agents: AgentRow[]): boolean => agents.some((a) => a.id === "pi-fleet-console");
// SIO-1665: mirrors triageIds + the triageOffered derived. A row without the
// flag keeps the pane offered.
const triageIdsFrom = (agents: AgentRow[]): string[] =>
	agents.filter((a) => a.hasTriageGraph !== false).map((a) => a.id);
const triageOffered = (agents: AgentRow[], current: string): boolean => triageIdsFrom(agents).includes(current);
// Mirrors the consoleOffered / onContextualAgent deriveds.
const consoleOffered = (agents: AgentRow[], current: string): boolean =>
	consoleAvailableFrom(agents) && current === "incident-analyzer";
const onContextualAgent = (agents: AgentRow[], current: string): boolean => !modeIdsFrom(agents).includes(current);

// Mirrors cycleAgent.
function nextAgent(agents: AgentRow[], current: string): string | undefined {
	const ids = modeIdsFrom(agents);
	if (ids.length === 0) return undefined;
	if (onContextualAgent(agents, current)) return ids.includes(DEFAULT_AGENT_ID) ? DEFAULT_AGENT_ID : ids[0];
	return ids[(ids.indexOf(current) + 1) % ids.length];
}

const HUB_CONFIGURED: AgentRow[] = [
	{ id: "incident-analyzer", surface: "mode", hasTriageGraph: true },
	{ id: "elastic-iac", surface: "mode", hasTriageGraph: true },
	{ id: "pi-fleet-console", surface: "contextual", hasTriageGraph: false },
];
const NO_HUB: AgentRow[] = [
	{ id: "incident-analyzer", surface: "mode" },
	{ id: "elastic-iac", surface: "mode" },
];

describe("SIO-1657 mode rotation", () => {
	test("cycles the two modes and never reaches the console", () => {
		let current: string = DEFAULT_AGENT_ID;
		const visited: string[] = [current];
		for (let i = 0; i < 5; i++) {
			current = nextAgent(HUB_CONFIGURED, current) as AgentId;
			visited.push(current);
		}
		expect(visited).not.toContain("pi-fleet-console");
		expect(new Set(visited)).toEqual(new Set(["incident-analyzer", "elastic-iac"]));
	});

	// The trap: the console is not in the rotation, so the control has to be a
	// way back or switching to it would strand the operator.
	test("from the console, the control returns to the incident analyzer", () => {
		expect(onContextualAgent(HUB_CONFIGURED, "pi-fleet-console")).toBe(true);
		expect(nextAgent(HUB_CONFIGURED, "pi-fleet-console")).toBe("incident-analyzer");
	});

	test("rotation is unchanged when no hub is configured", () => {
		expect(nextAgent(NO_HUB, "incident-analyzer")).toBe("elastic-iac");
		expect(nextAgent(NO_HUB, "elastic-iac")).toBe("incident-analyzer");
	});
});

describe("SIO-1657 console entry point", () => {
	test("offered in the incident analyzer, hidden in the IaC agent", () => {
		expect(consoleOffered(HUB_CONFIGURED, "incident-analyzer")).toBe(true);
		// The whole point: asking live spokes about an incident is noise beside an
		// Elastic Cloud config maker.
		expect(consoleOffered(HUB_CONFIGURED, "elastic-iac")).toBe(false);
	});

	test("never offered when the deployment has no hub", () => {
		for (const current of ["incident-analyzer", "elastic-iac"]) {
			expect(consoleOffered(NO_HUB, current)).toBe(false);
		}
	});

	// Availability comes from the server (flag AND hub); the client must not
	// re-derive it from the id list alone.
	test("availability follows the payload, not a hardcoded list", () => {
		expect(consoleAvailableFrom(HUB_CONFIGURED)).toBe(true);
		expect(consoleAvailableFrom(NO_HUB)).toBe(false);
	});
});

describe("SIO-1665 live graph triage pane", () => {
	test("offered on the modes, not on the fleet console", () => {
		expect(triageOffered(HUB_CONFIGURED, "incident-analyzer")).toBe(true);
		expect(triageOffered(HUB_CONFIGURED, "elastic-iac")).toBe(true);
		// The console's two-node graph is redundant next to the fleet pane.
		expect(triageOffered(HUB_CONFIGURED, "pi-fleet-console")).toBe(false);
	});

	// A server that predates the flag returns rows without it; the pane must
	// not vanish from the analyzer because a field is missing.
	test("a row without the flag keeps the pane offered", () => {
		expect(triageOffered(NO_HUB, "incident-analyzer")).toBe(true);
		expect(triageOffered(NO_HUB, "elastic-iac")).toBe(true);
	});
});
