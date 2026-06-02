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
});
