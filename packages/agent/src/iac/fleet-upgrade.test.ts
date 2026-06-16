// agent/src/iac/fleet-upgrade.test.ts
import { describe, expect, test } from "bun:test";
import {
	formatFleetUpgradeSummary,
	hasApplicableFleetUpgrade,
	intentFromText,
	parseFleetApplyOutcome,
	parseFleetUpgradeReport,
	parseTargetVersion,
} from "./nodes.ts";
import type { FleetUpgradeReport, FleetUpgradeResult, IacStateType } from "./state.ts";

// SIO-913: a camelCase preview-report stub (post-parse shape).
function report(over: Partial<FleetUpgradeReport>): FleetUpgradeReport {
	return {
		deployment: "eu-b2b",
		targetVersion: "9.4.2",
		rolloutSeconds: 600,
		selector: "status:online",
		resolvedCount: 10,
		versionAvailable: true,
		maxAgents: 10000,
		crosstab: { upgradeable: 8, notUpgradeable: 2, byReason: [{ reason: "wolfi_container", count: 2 }] },
		generatedAt: "2026-06-16T00:00:00Z",
		...over,
	};
}

function stateWith(over: Partial<IacStateType>): IacStateType {
	return { targetDeployment: "eu-b2b", fleetUpgradeReport: null, fleetUpgradeResult: null, ...over } as IacStateType;
}

describe("parseFleetUpgradeReport", () => {
	const sample = JSON.stringify({
		schema: "fleet-upgrade-report/v1",
		mode: "preview",
		deployment: "eu-b2b",
		target_version: "9.4.2",
		rollout_seconds: 600,
		selector: "status:online",
		resolved_count: 128,
		version_available: true,
		max_agents: 10000,
		upgradeable_crosstab: {
			upgradeable: 120,
			not_upgradeable: 8,
			by_reason: [{ reason: "wolfi_container", count: 8 }],
		},
		action_id: null,
		generated_at: "2026-06-16T00:00:00Z",
	});

	test("maps snake_case artifact fields to the camelCase report", () => {
		const r = parseFleetUpgradeReport(sample);
		expect(r).not.toBeNull();
		expect(r?.deployment).toBe("eu-b2b");
		expect(r?.targetVersion).toBe("9.4.2");
		expect(r?.rolloutSeconds).toBe(600);
		expect(r?.resolvedCount).toBe(128);
		expect(r?.versionAvailable).toBe(true);
		expect(r?.crosstab.upgradeable).toBe(120);
		expect(r?.crosstab.notUpgradeable).toBe(8);
		expect(r?.crosstab.byReason).toEqual([{ reason: "wolfi_container", count: 8 }]);
	});

	test("version_available is strictly boolean true (missing -> false)", () => {
		const r = parseFleetUpgradeReport(JSON.stringify({ deployment: "x", target_version: "9.4.2" }));
		expect(r?.versionAvailable).toBe(false);
	});

	test("tolerates a missing crosstab (zeros, empty byReason)", () => {
		const r = parseFleetUpgradeReport(JSON.stringify({ deployment: "x", resolved_count: 3 }));
		expect(r?.crosstab).toEqual({ upgradeable: 0, notUpgradeable: 0, byReason: [] });
	});

	test("returns null on unparseable JSON", () => {
		expect(parseFleetUpgradeReport("not json")).toBeNull();
	});
});

describe("parseFleetApplyOutcome", () => {
	test("extracts action_id + apply block incl. failed_silent (the verify-sweep ground truth)", () => {
		const raw = JSON.stringify({
			mode: "apply",
			action_id: "abc-123",
			apply: { poll_status: "COMPLETE", acked: 120, created: 128, failed_silent: 2 },
		});
		expect(parseFleetApplyOutcome(raw)).toEqual({
			actionId: "abc-123",
			pollStatus: "COMPLETE",
			acked: 120,
			created: 128,
			failedSilent: 2,
		});
	});

	test("a preview report (no apply block) yields zeros", () => {
		const raw = JSON.stringify({ mode: "preview", action_id: null });
		expect(parseFleetApplyOutcome(raw)).toEqual({
			actionId: "",
			pollStatus: "",
			acked: 0,
			created: 0,
			failedSilent: 0,
		});
	});
});

describe("hasApplicableFleetUpgrade (graph-edge predicate)", () => {
	test("true when assessed, version available, and >=1 upgradeable", () => {
		expect(hasApplicableFleetUpgrade(report({}))).toBe(true);
	});
	test("false on a planError stub", () => {
		expect(
			hasApplicableFleetUpgrade(
				report({ planError: true, crosstab: { upgradeable: 5, notUpgradeable: 0, byReason: [] } }),
			),
		).toBe(false);
	});
	test("false when the target version is not available", () => {
		expect(hasApplicableFleetUpgrade(report({ versionAvailable: false }))).toBe(false);
	});
	test("false when nothing is upgradeable (only Wolfi/container agents)", () => {
		expect(hasApplicableFleetUpgrade(report({ crosstab: { upgradeable: 0, notUpgradeable: 8, byReason: [] } }))).toBe(
			false,
		);
	});
	test("false on null", () => {
		expect(hasApplicableFleetUpgrade(null)).toBe(false);
	});
});

describe("parseTargetVersion", () => {
	test("prefers the request's parsed version", () => {
		expect(parseTargetVersion("upgrade the agents", "9.4.2")).toBe("9.4.2");
	});
	test("extracts a semver from free text", () => {
		expect(parseTargetVersion("upgrade all elastic agents for eu-b2b to 9.4.2")).toBe("9.4.2");
	});
	test("accepts a two-part version and a snapshot suffix", () => {
		expect(parseTargetVersion("bump fleet agents to 8.15")).toBe("8.15");
		expect(parseTargetVersion("to 9.4.2-SNAPSHOT please")).toBe("9.4.2-SNAPSHOT");
	});
	test("empty when no version present", () => {
		expect(parseTargetVersion("upgrade the agents please")).toBe("");
	});
});

describe("intentFromText — fleet-upgrade vs version-upgrade discrimination", () => {
	test("the classifier's 'fleet-upgrade' word routes to fleet-upgrade", () => {
		expect(intentFromText("fleet-upgrade")).toBe("fleet-upgrade");
	});
	test("a direct 'fleet upgrade' phrasing routes to fleet-upgrade", () => {
		expect(intentFromText("fleet upgrade")).toBe("fleet-upgrade");
	});
	test("a bare 'gitops' still routes to gitops (cluster version path)", () => {
		expect(intentFromText("gitops")).toBe("gitops");
	});
	test("synthetics still wins its tiebreak (no fleet keyword)", () => {
		expect(intentFromText("synthetics-drift")).toBe("synthetics-drift");
	});
});

describe("formatFleetUpgradeSummary", () => {
	test("planError -> reports the reason, not a false 0-agents", () => {
		const s = stateWith({ fleetUpgradeReport: report({ planError: true, planErrorReason: "pipeline locked" }) });
		expect(formatFleetUpgradeSummary(s)).toContain("could not be completed");
		expect(formatFleetUpgradeSummary(s)).toContain("pipeline locked");
	});

	test("version unavailable -> refuses", () => {
		const s = stateWith({ fleetUpgradeReport: report({ versionAvailable: false }) });
		expect(formatFleetUpgradeSummary(s)).toContain("not in");
		expect(formatFleetUpgradeSummary(s)).toContain("refusing");
	});

	test("nothing upgradeable -> says so + notes the skipped non-upgradeable agents", () => {
		const s = stateWith({
			fleetUpgradeReport: report({ crosstab: { upgradeable: 0, notUpgradeable: 8, byReason: [] } }),
		});
		const msg = formatFleetUpgradeSummary(s);
		expect(msg).toContain("No Fleet agents");
		expect(msg).toContain("8 non-upgradeable");
	});

	test("declined (no result) -> reports eligible count remaining", () => {
		const s = stateWith({ fleetUpgradeReport: report({}) });
		expect(formatFleetUpgradeSummary(s)).toContain("declined");
	});

	test("applied + clean verify sweep -> notes 0 UPG_FAILED", () => {
		const result: FleetUpgradeResult = {
			status: "applied",
			pipelineId: 7,
			pollStatus: "COMPLETE",
			acked: 8,
			created: 8,
			failedSilent: 0,
		};
		const s = stateWith({ fleetUpgradeReport: report({}), fleetUpgradeResult: result });
		const msg = formatFleetUpgradeSummary(s);
		expect(msg).toContain("applied");
		expect(msg).toContain("Verify sweep clean");
	});

	test("applied with silent failures -> LEADS with the UPG_FAILED warning", () => {
		const result: FleetUpgradeResult = {
			status: "applied",
			pipelineId: 7,
			pollStatus: "COMPLETE",
			acked: 6,
			created: 8,
			failedSilent: 2,
		};
		const s = stateWith({ fleetUpgradeReport: report({}), fleetUpgradeResult: result });
		const msg = formatFleetUpgradeSummary(s);
		expect(msg).toContain("WARNING");
		expect(msg).toContain("2 agent(s) reached UPG_FAILED");
	});

	test("blocked -> surfaces the note", () => {
		const result: FleetUpgradeResult = {
			status: "blocked",
			pipelineId: null,
			note: "a fleet pipeline is already running",
		};
		const s = stateWith({ fleetUpgradeReport: report({}), fleetUpgradeResult: result });
		expect(formatFleetUpgradeSummary(s)).toContain("already running");
	});
});
