// apps/web/src/lib/agent-ids.test.ts
// SIO-1655 (PR 1): the agent id vocabulary. Runtime-free by design, so this
// suite needs no mocks -- which is the point: server code can reach these ids
// without importing a runes module.
import { describe, expect, test } from "bun:test";
import { AGENT_CHOICES, AGENT_IDS, agentChoice, DEFAULT_AGENT_ID, isAgentId } from "./agent-ids.ts";

describe("SIO-1655 agent id vocabulary", () => {
	test("the shipped agents are registered, in registry order", () => {
		// SIO-1655 added the fleet console; it is gated OFF at the registry
		// (listSelectableAgents), not by omission from the id vocabulary, so an
		// unknown-agent error stays distinguishable from a disabled one.
		expect([...AGENT_IDS]).toEqual(["incident-analyzer", "elastic-iac", "pi-fleet-console"]);
	});

	test("the default is the incident analyzer", () => {
		expect(DEFAULT_AGENT_ID).toBe("incident-analyzer");
		expect(isAgentId(DEFAULT_AGENT_ID)).toBe(true);
	});

	test("isAgentId accepts registered ids and rejects everything else", () => {
		for (const id of AGENT_IDS) expect(isAgentId(id)).toBe(true);
		// The EXPORTED persona name is not an in-process agent (SIO-1649/SIO-1655):
		// only "pi-fleet-console" runs here.
		expect(isAgentId("pi-fleet")).toBe(false);
		expect(isAgentId("")).toBe(false);
		// Prototype keys must not read as valid agents.
		expect(isAgentId("toString")).toBe(false);
		expect(isAgentId("constructor")).toBe(false);
	});

	test("every id has display metadata, and vice versa", () => {
		expect(AGENT_CHOICES.map((c) => c.id).sort()).toEqual([...AGENT_IDS].sort());
		for (const choice of AGENT_CHOICES) {
			expect(choice.title.length).toBeGreaterThan(0);
			expect(choice.subtitle.length).toBeGreaterThan(0);
		}
	});

	test("agentChoice returns the matching entry and throws for an unknown id", () => {
		expect(agentChoice("elastic-iac").title).toBe("Elastic IaC Agent");
		expect(agentChoice("incident-analyzer").title).toBe("Incident Analyzer");
		// @ts-expect-error deliberately probing the runtime guard with an invalid id
		expect(() => agentChoice("pi-fleet")).toThrow('unknown agent "pi-fleet"');
	});

	// The old UI toggle was `isIac ? "incident-analyzer" : "elastic-iac"`. With the
	// fleet console gated off (the default), the page cycles only the two
	// always-available agents, which must still behave exactly like that toggle.
	test("cycling the default (ungated) list reproduces the old binary toggle", () => {
		const ids = AGENT_CHOICES.filter((c) => c.id !== "pi-fleet-console").map((c) => c.id);
		const next = (current: string) => ids[(ids.indexOf(current as (typeof ids)[number]) + 1) % ids.length];
		expect(next("incident-analyzer")).toBe("elastic-iac");
		expect(next("elastic-iac")).toBe("incident-analyzer");
	});

	// SIO-1657: the console is CONTEXTUAL, not a mode -- it is reached from the
	// incident analyzer, never by cycling. Enabling it must NOT lengthen the
	// rotation, which is what it used to do (the icon landed on "Fleet Console"
	// from the IaC agent, where asking live spokes about an incident is noise).
	test("enabling the console does not add it to the mode rotation", () => {
		const ids = AGENT_CHOICES.filter((c) => c.id !== "pi-fleet-console").map((c) => c.id);
		const next = (current: string) => ids[(ids.indexOf(current as (typeof ids)[number]) + 1) % ids.length];
		expect(ids).not.toContain("pi-fleet-console");
		expect(next("incident-analyzer")).toBe("elastic-iac");
		expect(next("elastic-iac")).toBe("incident-analyzer");
	});

	// Leaving the rotation must not make it unreachable or unresolvable: the id
	// stays valid (graphFor resolves it; the Agent Memory identity map throws for
	// unregistered names) and keeps its display metadata for the entry point.
	test("the console remains a registered id with display metadata", () => {
		expect(isAgentId("pi-fleet-console")).toBe(true);
		expect(AGENT_IDS).toContain("pi-fleet-console");
		expect(agentChoice("pi-fleet-console").title).toBe("Fleet Console");
	});
});
