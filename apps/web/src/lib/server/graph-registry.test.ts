// apps/web/src/lib/server/graph-registry.test.ts
// SIO-1657: the mode-vs-contextual split. The fleet console is selectable (it
// can be switched to) but never cycled by the header control, because asking
// live account spokes about an incident belongs to the incident analyzer's
// context, not beside an Elastic Cloud config maker.
//
// Two mocks, both required:
//   - the barrel, for the console's capability + hub gates.
//   - ./agent.ts, whose MODULE LOAD mounts the KG MCP server and starts the
//     schedulers. The registry only needs its three graph builders, and they are
//     thunks, so stubbing them keeps this a unit test of the registry rather
//     than a boot of the whole server.
import { describe, expect, mock, test } from "bun:test";

const hubConfigured = { value: true };
const graphEnabled = { value: true };

mock.module("@devops-agent/agent", () => ({
	isPiFleetGraphEnabled: () => graphEnabled.value,
	isPiComsConfigured: () => hubConfigured.value,
}));

mock.module("./agent.ts", () => ({
	getGraph: () => Promise.resolve({}),
	getIacGraph: () => Promise.resolve({}),
	getPiFleetGraph: () => Promise.resolve({}),
}));

const load = async () => await import("./graph-registry.ts");

describe("SIO-1657 listModeAgents", () => {
	test("cycles exactly the two modes, even with the console fully enabled", async () => {
		graphEnabled.value = true;
		hubConfigured.value = true;
		const { listModeAgents, listSelectableAgents } = await load();

		expect(listModeAgents().map((a) => a.id)).toEqual(["incident-analyzer", "elastic-iac"]);
		// Selectable is the wider set: the console is still switchable to.
		expect(listSelectableAgents().map((a) => a.id)).toContain("pi-fleet-console");
	});

	test("the console is never a mode, however it is gated", async () => {
		const { listModeAgents } = await load();
		for (const [flag, hub] of [
			[true, true],
			[true, false],
			[false, true],
			[false, false],
		] as const) {
			graphEnabled.value = flag;
			hubConfigured.value = hub;
			expect(listModeAgents().map((a) => a.id)).not.toContain("pi-fleet-console");
		}
	});

	// Availability still follows the infrastructure: without a hub the console
	// cannot be offered anywhere, so the entry point must not render either.
	test("an unconfigured hub removes the console from the selectable set", async () => {
		graphEnabled.value = true;
		hubConfigured.value = false;
		const { listSelectableAgents } = await load();
		expect(listSelectableAgents().map((a) => a.id)).not.toContain("pi-fleet-console");
	});

	test("every agent declares a surface, and modes are a subset of selectable", async () => {
		graphEnabled.value = true;
		hubConfigured.value = true;
		const { listAgents, listModeAgents, listSelectableAgents } = await load();

		for (const a of listAgents()) expect(["mode", "contextual"]).toContain(a.surface);
		const selectable = new Set(listSelectableAgents().map((a) => a.id));
		for (const a of listModeAgents()) expect(selectable.has(a.id)).toBe(true);
	});

	// Leaving the rotation must not break resolution: graphFor still has to
	// resolve the console (the route would otherwise 404) and describeAgent must
	// keep refusing genuinely unknown names.
	test("the console still resolves through the registry", async () => {
		const { describeAgent } = await load();
		expect(describeAgent("pi-fleet-console").label).toBe("Fleet Console");
		expect(() => describeAgent("pi-fleet")).toThrow('unknown agent "pi-fleet"');
	});
});
