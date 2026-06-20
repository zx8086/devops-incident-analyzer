// agent/src/iac/guards.test.ts
import { describe, expect, test } from "bun:test";
import { evaluateGuards } from "./guards.ts";
import type { IacClusterState, IacRequest } from "./state.ts";

function req(overrides: Partial<IacRequest>): IacRequest {
	return { workflow: "tier-resize", isProd: false, ...overrides };
}

function clusterState(overrides: Partial<IacClusterState>): IacClusterState {
	return { cluster: "eu-b2b", summary: "", alertsManaged: true, ...overrides };
}

describe("evaluateGuards", () => {
	test("allows a normal warm-tier downsize when alerts are managed", () => {
		const result = evaluateGuards(
			req({ tier: "warm", newSizeGb: 8, newMaxGb: 16 }),
			clusterState({ currentSizeGb: 16, alertsManaged: true }),
		);
		expect(result.blocked).toBe(false);
	});

	test("blocks when Maximum is below Current (max-first ordering is invalid)", () => {
		const result = evaluateGuards(req({ tier: "warm", newSizeGb: 16, newMaxGb: 8 }), clusterState({}));
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain("Max");
	});

	test("blocks hot-tier downsize while .alerts is unmanaged", () => {
		const result = evaluateGuards(
			req({ tier: "hot", newSizeGb: 8 }),
			clusterState({ currentSizeGb: 15, alertsManaged: false }),
		);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain(".alerts");
	});

	test("allows hot-tier downsize once .alerts is managed", () => {
		const result = evaluateGuards(
			req({ tier: "hot", newSizeGb: 8 }),
			clusterState({ currentSizeGb: 15, alertsManaged: true }),
		);
		expect(result.blocked).toBe(false);
	});

	test("does not gate a hot-tier upsize on .alerts", () => {
		const result = evaluateGuards(
			req({ tier: "hot", newSizeGb: 30 }),
			clusterState({ currentSizeGb: 15, alertsManaged: false }),
		);
		expect(result.blocked).toBe(false);
	});

	test("skips the hot gate when current size is unknown (cannot prove a downsize)", () => {
		const result = evaluateGuards(req({ tier: "hot", newSizeGb: 8 }), clusterState({ alertsManaged: false }));
		expect(result.blocked).toBe(false);
	});

	// SIO-980: cluster-defaults settingsPatch is freeform (any index key), so a SHORT danger denylist
	// guards valid-but-dangerous settings. Validity is left to CI's terraform plan.
	const cd = (settingsPatch: Record<string, unknown>): Partial<IacRequest> => ({
		workflow: "cluster-default-edit",
		cluster: "eu-b2b",
		templateName: "logs",
		settingsPatch,
	});

	test("allows a benign settingsPatch (refresh_interval)", () => {
		expect(evaluateGuards(req(cd({ refresh_interval: "30s" })), null).blocked).toBe(false);
	});

	test("blocks number_of_replicas: 0 (removes redundancy)", () => {
		const result = evaluateGuards(req(cd({ number_of_replicas: 0 })), null);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain("number_of_replicas");
	});

	test("blocks index blocks.* (locks the index)", () => {
		const result = evaluateGuards(req(cd({ blocks: { write: true } })), null);
		expect(result.blocked).toBe(true);
		expect(result.reason?.toLowerCase()).toContain("block");
	});

	test("blocks routing.allocation.enable: none (halts allocation)", () => {
		const result = evaluateGuards(req(cd({ routing: { allocation: { enable: "none" } } })), null);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain("allocation");
	});

	test("blocks a non-string refresh_interval (type error CI would reject)", () => {
		const result = evaluateGuards(req(cd({ refresh_interval: 30 })), null);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain("refresh_interval");
	});

	test("a normal number_of_replicas (>=1) is allowed", () => {
		expect(evaluateGuards(req(cd({ number_of_replicas: 1 })), null).blocked).toBe(false);
	});

	test("multi-file: a danger in ANY clusterDefaults entry blocks the whole batch", () => {
		const result = evaluateGuards(
			req({
				workflow: "cluster-default-edit",
				cluster: "eu-b2b",
				clusterDefaults: [
					{ templateName: "logs", settingsPatch: { refresh_interval: "30s" } },
					{ templateName: "metrics", settingsPatch: { number_of_replicas: 0 } },
				],
			}),
			null,
		);
		expect(result.blocked).toBe(true);
		expect(result.reason).toContain("metrics");
	});
});
