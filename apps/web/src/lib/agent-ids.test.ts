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

	test("with the console enabled, cycling visits all three in registry order", () => {
		const ids = AGENT_CHOICES.map((c) => c.id);
		const next = (current: string) => ids[(ids.indexOf(current as (typeof ids)[number]) + 1) % ids.length];
		expect(next("incident-analyzer")).toBe("elastic-iac");
		expect(next("elastic-iac")).toBe("pi-fleet-console");
		expect(next("pi-fleet-console")).toBe("incident-analyzer");
	});
});
