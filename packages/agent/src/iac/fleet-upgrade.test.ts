// agent/src/iac/fleet-upgrade.test.ts
//
// SIO-1045: this file OWNS a mock.module("../memory-backend.ts", ...) registered at file scope,
// BEFORE the static `import "./nodes.ts"` below (nodes.ts statically imports ../memory-backend.ts).
// bun's mock.module is process-global and last-registration-wins, so a sibling test file
// (iac-change-memory.test.ts / reconcile.test.ts) that mocks the same module path leaks into this
// file's tests unless THIS file re-claims the module at its own load time -- relying on the
// polluter's own afterEach/afterAll restore is insufficient (proven on Linux CI: bun schedules test
// files in a different order there than a local macOS run, so the polluter can register its stub
// AFTER this file has already loaded, or its restore can run before this file's tests execute in a
// way that still leaves the stub active for the intervening period). The factory below re-exports the
// REAL module's implementation for everything, so detectFleetUpgrade/bootstrapIac/watchPipeline/
// applyFleetUpgrade/recallPriorFleetUpgrades exercise the real searchAgentMemory/selectedBackend/
// dedupeHitsBy/dedupePreferring/recallInFlightFleetUpgrades logic; per-test control is layered on
// top via the real __setAgentMemoryClient injection seam (unchanged from before this fix).
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realMemoryBackendNs from "../memory-backend.ts";

// SIO-1045: a namespace import (`import * as ns`) is a LIVE VIEW -- when any file registers a
// mock.module() for this path, bun live-patches every existing namespace binding, INCLUDING this
// captured `realMemoryBackendNs` object, so re-claiming with `() => realMemoryBackendNs` would
// re-register the very poison it means to undo (a circular no-op). A value snapshot (spread into a
// plain object at load time, before any mock.module() call below runs) copies the function VALUES and
// is immune to that later live-patching.
const realMemoryBackend = { ...realMemoryBackendNs };

mock.module("../memory-backend.ts", () => realMemoryBackend);

import {
	buildFleetFactDecision,
	buildFleetFactRationale,
	buildFleetGateMessage,
	buildFleetHostSelector,
	buildFleetMemorySummary,
	classifyFleetApplyResult,
	dynamicRolloutSeconds,
	formatFleetUpgradeSummary,
	formatRolloutDuration,
	hasApplicableFleetUpgrade,
	intentFromText,
	parseExpectedAgentCount,
	parseFleetApplyOutcome,
	parseFleetHostList,
	parseFleetRawSelector,
	parseFleetUpgradeReport,
	parseSinglePipeline,
	parseTargetVersion,
	recallPriorFleetUpgrades,
} from "./nodes.ts";
import type { FleetUpgradeReport, FleetUpgradeResult, IacStateType } from "./state.ts";

// SIO-1045: re-claim ownership before AND after every test in this file. mockTools() (below) mocks a
// DIFFERENT module (../mcp-bridge.ts) via mock.restore()-surviving registration, and several tests in
// this file dynamically `await import("../memory-backend.ts")` mid-test to call
// __setAgentMemoryClient -- none of that re-registers this module's mock.module entry, but
// re-asserting in beforeEach makes this file self-claiming even if a sibling suite poisoned the module
// between this file's load and the first test's execution; the afterEach guards the same for the
// tests that follow within this same file/process.
beforeEach(() => {
	mock.module("../memory-backend.ts", () => realMemoryBackend);
});

afterEach(() => {
	mock.module("../memory-backend.ts", () => realMemoryBackend);
});

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
		// SIO-935: version partition. 100 already on target + 28 outdated == 128 resolved.
		version_crosstab: {
			already_on_target: 100,
			outdated: 28,
			version_unknown: 0,
			upgradeable_outdated: 6,
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
		// SIO-935: the version partition is mapped snake_case -> camelCase.
		expect(r?.versionCrosstab).toEqual({
			alreadyOnTarget: 100,
			outdated: 28,
			versionUnknown: 0,
			upgradeableOutdated: 6,
		});
	});

	// SIO-935: back-compat invariant -- an OLD v1 report (no version_crosstab) parses with the
	// field undefined, never a false all-zero block. This is what lets the agent PR merge before
	// the elastic-iac MR lands.
	test("a report without version_crosstab leaves versionCrosstab undefined (back-compat)", () => {
		const r = parseFleetUpgradeReport(
			JSON.stringify({
				deployment: "eu-b2b",
				target_version: "9.4.2",
				resolved_count: 10,
				upgradeable_crosstab: { upgradeable: 8, not_upgradeable: 2, by_reason: [] },
			}),
		);
		expect(r).not.toBeNull();
		expect(r?.versionCrosstab).toBeUndefined();
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
		expect(parseFleetApplyOutcome(raw)).toMatchObject({
			actionId: "abc-123",
			pollStatus: "COMPLETE",
			acked: 120,
			created: 128,
			failedSilent: 2,
		});
	});

	test("a preview report (no apply block) yields zeros", () => {
		const raw = JSON.stringify({ mode: "preview", action_id: null });
		expect(parseFleetApplyOutcome(raw)).toMatchObject({
			actionId: "",
			pollStatus: "",
			acked: 0,
			created: 0,
			failedSilent: 0,
			succeeded: 0,
			failed: 0,
			rolledBack: 0,
			unsettled: 0,
			failedAgents: [],
		});
	});

	// SIO-961: the real us-cld result -- the apply block carries the full breakdown
	// (succeeded/failed/rolled_back/unsettled) + per-agent failures. parseFleetApplyOutcome
	// must capture them, not just acked/created/failed_silent.
	test("captures the full count breakdown + per-agent failures (SIO-961)", () => {
		const raw = JSON.stringify({
			mode: "apply",
			action_id: "e67a5d4f-0a56-49d2-9cbd-baf72435da30",
			apply: {
				poll_status: "ROLLOUT_PASSED",
				acked: 7,
				created: 75,
				succeeded: 0,
				failed: 3,
				rolled_back: 3,
				in_progress: 69,
				unsettled: 69,
				failed_silent: 3,
				failed_agents: [
					{ hostname: "BWO-DT23-SHPT07", agent_id: "a508", failed_state: "UPG_DOWNLOADING", error: "binary not found" },
					{
						hostname: "mn1prdnetskope2",
						agent_id: "5c99",
						failed_state: "UPG_DOWNLOADING",
						error: "insufficient disk space",
					},
				],
			},
		});
		const out = parseFleetApplyOutcome(raw);
		expect(out).toMatchObject({
			actionId: "e67a5d4f-0a56-49d2-9cbd-baf72435da30",
			pollStatus: "ROLLOUT_PASSED",
			succeeded: 0,
			failed: 3,
			rolledBack: 3,
			unsettled: 69,
			failedSilent: 3,
		});
		expect(out.failedAgents).toHaveLength(2);
		expect(out.failedAgents[0]).toMatchObject({ hostname: "BWO-DT23-SHPT07", error: "binary not found" });
	});

	// SIO-975: the report's top-level CI failure reason (error_reason || error).
	test("captures error_reason (falls back to error) for a true infra failure", () => {
		expect(parseFleetApplyOutcome(JSON.stringify({ error_reason: "plan job OOM-killed" })).errorReason).toBe(
			"plan job OOM-killed",
		);
		expect(parseFleetApplyOutcome(JSON.stringify({ error: "raw stderr blob" })).errorReason).toBe("raw stderr blob");
		expect(parseFleetApplyOutcome(JSON.stringify({})).errorReason).toBe("");
	});
});

// SIO-975: the single source of truth shared by the main apply path and the SIO-926 follow-up
// re-poll. Before, the follow-up path produced a bare "failed for another reason" and dropped the
// rich report; now both classify identically.
describe("classifyFleetApplyResult (SIO-975)", () => {
	const outcome = (over: Partial<ReturnType<typeof parseFleetApplyOutcome>> = {}) => ({
		actionId: "act-1",
		pollStatus: "ROLLOUT_PASSED",
		acked: 3,
		created: 6,
		failedSilent: 3,
		succeeded: 0,
		failed: 3,
		rolledBack: 3,
		unsettled: 0,
		failedAgents: [
			{
				hostname: "BWO-DT23-SHPT07",
				agentId: "a1",
				failedState: "UPG_DOWNLOADING",
				error: "not enough space on the disk",
			},
		],
		errorReason: "",
		...over,
	});

	test("success -> applied (no note)", () => {
		expect(classifyFleetApplyResult("success", null, "", false)).toEqual({ status: "applied" });
	});

	// the live us-cld case: CI failed, but agents were actioned with disk-space failures -> partial
	test("failed CI with actioned agents -> partial with the per-agent breakdown", () => {
		const r = classifyFleetApplyResult("failed", outcome(), "", false);
		expect(r.status).toBe("partial");
		expect(r.note).toContain("not enough space on the disk");
		expect(r.note).toContain("BWO-DT23-SHPT07");
	});

	test("infra failure (created:0) names the report error_reason when present", () => {
		const r = classifyFleetApplyResult(
			"failed",
			outcome({ created: 0, errorReason: "plan job OOM-killed" }),
			"",
			false,
		);
		expect(r.status).toBe("failed");
		expect(r.note).toContain("plan job OOM-killed");
		expect(r.note).not.toContain("review the job log");
	});

	test("state lock -> failed via classifyPipelineFailure (no report error_reason)", () => {
		const r = classifyFleetApplyResult("failed", outcome({ created: 0 }), "Error acquiring the state lock", true);
		expect(r.status).toBe("failed");
		expect(r.note).toContain("state-lock");
	});

	test("failed with no report and a non-empty unclassified log -> generic 'review the job log'", () => {
		const r = classifyFleetApplyResult("failed", null, "some job output with no recognised pattern", false);
		expect(r.status).toBe("failed");
		expect(r.note).toContain("review the job log");
	});

	test("failed with no report and no log -> 'log was not available'", () => {
		const r = classifyFleetApplyResult("failed", null, "", false);
		expect(r.status).toBe("failed");
		expect(r.note).toContain("not available");
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

describe("dynamicRolloutSeconds (SIO-936)", () => {
	test("clamps to the 600s Fleet API minimum for small / zero / negative counts", () => {
		expect(dynamicRolloutSeconds(0)).toBe(600);
		expect(dynamicRolloutSeconds(-5)).toBe(600);
		expect(dynamicRolloutSeconds(4)).toBe(600); // 4*30=120 -> floored to 600
		expect(dynamicRolloutSeconds(20)).toBe(600); // 20*30=600 -> exactly the floor
	});
	test("scales at ~30s/agent between the floor and the cap", () => {
		expect(dynamicRolloutSeconds(25)).toBe(750); // 25*30
		expect(dynamicRolloutSeconds(100)).toBe(3000); // 100*30
	});
	test("caps at 3600s for large fleets (keeps a bounded stagger)", () => {
		expect(dynamicRolloutSeconds(120)).toBe(3600); // 120*30=3600 -> the cap
		expect(dynamicRolloutSeconds(801)).toBe(3600);
		expect(dynamicRolloutSeconds(10000)).toBe(3600);
	});
	test("non-finite input degrades to the floor (no NaN)", () => {
		expect(dynamicRolloutSeconds(Number.NaN)).toBe(600);
	});
});

describe("buildFleetGateMessage rollout display (SIO-936)", () => {
	test("uses the agent-count-scaled window, not the report's fixed 3600", () => {
		// 4 upgradeable-outdated agents (ap-cld), but the report carries the script default 3600.
		const { rollout, willUpgrade, message } = buildFleetGateMessage(
			report({
				deployment: "ap-cld",
				rolloutSeconds: 3600,
				crosstab: { upgradeable: 4, notUpgradeable: 245, byReason: [{ reason: "other", count: 245 }] },
				versionCrosstab: { alreadyOnTarget: 236, outdated: 13, versionUnknown: 0, upgradeableOutdated: 4 },
			}),
		);
		expect(willUpgrade).toBe(4); // version-aware: upgradeable-and-outdated, not the raw crosstab
		expect(rollout).toBe(600); // 4 agents -> floored, NOT the report's 3600
		expect(message).toContain("over 600s");
		expect(message).not.toContain("over 3600s");
		expect(message).toContain("236 are already on 9.4.2");
	});
	test("a large fleet keeps a long stagger (caps at 3600)", () => {
		const { rollout } = buildFleetGateMessage(
			report({ crosstab: { upgradeable: 801, notUpgradeable: 0, byReason: [] } }),
		);
		expect(rollout).toBe(3600);
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

	// SIO-935: with the version partition present, the summary states how many were already on
	// target. Absent (the default report()), the clause must NOT appear (back-compat).
	test("version partition present -> notes how many were already on target", () => {
		const withVc = stateWith({
			fleetUpgradeReport: report({
				versionCrosstab: { alreadyOnTarget: 100, outdated: 28, versionUnknown: 0, upgradeableOutdated: 6 },
			}),
		});
		expect(formatFleetUpgradeSummary(withVc)).toContain("100 were already on 9.4.2");
		// default report() has no versionCrosstab -> no "already on" clause.
		expect(formatFleetUpgradeSummary(stateWith({ fleetUpgradeReport: report({}) }))).not.toContain("already on");
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

	// SIO-926: a long-running apply that is still running at the status window is "dispatched"
	// (started, in flight), NOT "failed". The summary must read as in-progress, name the expected
	// duration, and offer the follow-up -- never the red failure copy.
	test("dispatched -> reads as started/in-progress, never 'failed'", () => {
		const result: FleetUpgradeResult = {
			status: "dispatched",
			pipelineId: 2605468937,
			pipelineUrl: "https://gitlab.com/p/-/pipelines/2605468937",
			pipelineStatus: "running",
			note: "Upgrade started and running; not finished within the status window.",
		};
		// SIO-1023: report.rolloutSeconds is the stale preview value (3600 -> "~60 min"); the prose ETA
		// must instead be the agent-count-scaled value applyFleetUpgrade actually sent to CI. With 8
		// upgradeable agents -> dynamicRolloutSeconds(8) = 600s -> "~10 min".
		const s = stateWith({
			fleetUpgradeReport: report({
				deployment: "ap-cld",
				rolloutSeconds: 3600,
				crosstab: { upgradeable: 8, notUpgradeable: 0, byReason: [] },
			}),
			fleetUpgradeResult: result,
		});
		const msg = formatFleetUpgradeSummary(s);
		expect(msg).toContain("started");
		expect(msg).not.toContain("failed");
		// SIO-1023: ETA derives from the agent count (8 -> 600s -> "~10 min"), NOT the stale 3600s preview value.
		expect(msg).toContain("10 min");
		expect(msg).not.toContain("60 min");
		// the resumable follow-up affordance
		expect(msg.toLowerCase()).toContain("check");
		// pipeline link preserved for tracking
		expect(msg).toContain("2605468937");
	});

	// SIO-1023: the dispatched prose ETA must equal the agent-count-scaled apply window
	// (formatRolloutDuration(dynamicRolloutSeconds(willUpgrade))), the same value the
	// "expected ~N min" pipeline-log step shows -- so the two never disagree. willUpgrade
	// prefers versionCrosstab.upgradeableOutdated when present, else crosstab.upgradeable.
	test("dispatched -> ETA matches the agent-count-scaled apply window for varying counts", () => {
		const result: FleetUpgradeResult = { status: "dispatched", pipelineId: 1, pipelineStatus: "running" };
		for (const willUpgrade of [8, 24, 19, 200]) {
			// 24 -> 720s -> "~12 min"; 200 -> 3600s ceil -> "~60 min".
			const expected = formatRolloutDuration(dynamicRolloutSeconds(willUpgrade));
			const s = stateWith({
				fleetUpgradeReport: report({
					rolloutSeconds: 3600, // stale preview value -- must be ignored
					crosstab: { upgradeable: willUpgrade, notUpgradeable: 0, byReason: [] },
				}),
				fleetUpgradeResult: result,
			});
			expect(formatFleetUpgradeSummary(s)).toContain(`over ${expected}.`);
		}
	});

	// SIO-1023: willUpgrade prefers the version partition's upgradeableOutdated when present.
	test("dispatched -> ETA uses versionCrosstab.upgradeableOutdated when present", () => {
		const result: FleetUpgradeResult = { status: "dispatched", pipelineId: 1, pipelineStatus: "running" };
		const s = stateWith({
			fleetUpgradeReport: report({
				rolloutSeconds: 3600,
				crosstab: { upgradeable: 200, notUpgradeable: 0, byReason: [] }, // would scale to the 3600s ceil
				// but the version partition narrows the real upgrade set to 24 -> 720s -> "~12 min".
				versionCrosstab: { alreadyOnTarget: 176, outdated: 24, versionUnknown: 0, upgradeableOutdated: 24 },
			}),
			fleetUpgradeResult: result,
		});
		const expected = formatRolloutDuration(dynamicRolloutSeconds(24));
		expect(formatFleetUpgradeSummary(s)).toContain(`over ${expected}.`);
		expect(formatFleetUpgradeSummary(s)).toContain("12 min");
	});

	// SIO-961: a deadline/env-failure apply is "partial", NOT "failed". The summary must lead with
	// the in-flight/pending majority, name the few agent-side failures, and offer the action re-check.
	test("partial -> reads as partial/in-progress with the breakdown, not a flat 'failed'", () => {
		const result: FleetUpgradeResult = {
			status: "partial",
			pipelineId: 2614422047,
			actionId: "e67a5d4f-0a56-49d2-9cbd-baf72435da30",
			created: 75,
			succeeded: 0,
			failed: 3,
			rolledBack: 3,
			unsettled: 69,
			failedSilent: 3,
			failedAgents: [
				{ hostname: "BWO-DT23-SHPT07", agentId: "a508", failedState: "UPG_DOWNLOADING", error: "binary not found" },
			],
			note:
				"Partial: 0/75 upgraded, 69 still pending (offline; upgrade when they reconnect), 3 failed, " +
				"3 rolled back (failed post-upgrade health check). The failures are agent-side (binary download / " +
				"disk / health check), not a bad upgrade. Re-check with action e67a5d4f-0a56-49d2-9cbd-baf72435da30 (valid ~30d).",
		};
		const s = stateWith({ fleetUpgradeReport: report({ deployment: "us-cld" }), fleetUpgradeResult: result });
		const msg = formatFleetUpgradeSummary(s);
		expect(msg).toContain("69 still pending");
		expect(msg).toContain("agent-side");
		expect(msg).toContain("e67a5d4f-0a56-49d2-9cbd-baf72435da30"); // re-check action id
		// must NOT present as a flat failure
		expect(msg).not.toMatch(/Fleet upgrade failed:/);
	});
});

// SIO-926: rolloutSeconds -> a human "expected duration" phrase set up front at apply time and in
// the dispatched summary. Pure; unit-tested.
describe("formatRolloutDuration", () => {
	test("hours render as minutes when under 2h (3600s -> ~60 min)", () => {
		expect(formatRolloutDuration(3600)).toContain("60 min");
	});
	test("sub-hour windows render in minutes (600s -> ~10 min)", () => {
		expect(formatRolloutDuration(600)).toContain("10 min");
	});
	test("multi-hour windows render in hours (7200s -> ~2 h / hours)", () => {
		expect(formatRolloutDuration(7200).toLowerCase()).toMatch(/2\s*h/);
	});
	test("a missing/zero window degrades gracefully (no NaN)", () => {
		const out = formatRolloutDuration(0);
		expect(out).not.toContain("NaN");
		expect(out.length).toBeGreaterThan(0);
	});
});

// Mirror drift.test.ts: stub mcp-bridge, then dynamic-import the flow so callTool resolves.
function mockTools(handlers: Record<string, (args: Record<string, unknown>) => string>) {
	const tools = Object.entries(handlers).map(([name, fn]) => ({
		name,
		invoke: async (args: Record<string, unknown>) => fn(args),
	}));
	mock.module("../mcp-bridge.ts", () => ({
		getToolsForDataSource: () => tools,
		getConnectedServers: () => ["elastic-iac-mcp"],
	}));
}

describe("detectFleetUpgrade deployment resolution (SIO-923)", () => {
	test("prefers the parsed iacRequest.cluster -- no clarify, no elastic_cloud_list_deployments call", async () => {
		const { detectFleetUpgrade } = await import("./nodes.ts");
		const seen: string[] = [];
		const triggerArgs: Array<Record<string, unknown>> = [];
		mockTools({
			// If resolution fell back to resolveDriftDeployment, THIS would be called -- assert it is not.
			elastic_cloud_list_deployments: () => {
				seen.push("elastic_cloud_list_deployments");
				return '[200] {"deployments":[{"name":"eu-b2b"}]}';
			},
			// Short-circuit the flow right after deployment resolution: a locked trigger (no pipelineId)
			// returns a planError report without polling -- enough to prove which deployment was used.
			gitlab_trigger_fleet_upgrade_preview: (args) => {
				triggerArgs.push(args);
				return '[423] {"status":"locked","note":"a fleet pipeline is already running"}';
			},
		});
		const state = {
			// The raw text is a full sentence (NOT an exact deployment name) -- the old whole-message
			// match in resolveDriftDeployment is exactly what spuriously clarified here.
			messages: [
				{ getType: () => "human", content: "upgrade all the fleet elastic agents to 9.4.2 in the eu-b2b deployment" },
			],
			iacRequest: { workflow: "fleet-upgrade", isProd: false, cluster: "eu-b2b", version: "9.4.2" },
		} as unknown as IacStateType;

		const result = await detectFleetUpgrade(state);

		// Used the parsed cluster verbatim...
		expect(triggerArgs).toHaveLength(1);
		expect(triggerArgs[0]?.deployment).toBe("eu-b2b");
		// ...and never went through the text/MCP fallback.
		expect(seen).not.toContain("elastic_cloud_list_deployments");
		// Locked trigger -> planError report for the resolved deployment (no spurious clarify).
		expect(result.targetDeployment).toBe("eu-b2b");
		expect(result.fleetUpgradeReport?.planError).toBe(true);
	});
});

describe("parseSinglePipeline (SIO-924)", () => {
	test("extracts status + web_url from a [200] pipeline body", () => {
		const r = parseSinglePipeline('[200] {"id":42,"status":"running","web_url":"https://gitlab.com/x/-/pipelines/42"}');
		expect(r?.status).toBe("running");
		expect(r?.webUrl).toBe("https://gitlab.com/x/-/pipelines/42");
	});
	test("defaults status to unknown + webUrl to empty when absent", () => {
		const r = parseSinglePipeline('[200] {"id":42}');
		expect(r?.status).toBe("unknown");
		expect(r?.webUrl).toBe("");
	});
	test("returns null on an unparseable body", () => {
		expect(parseSinglePipeline("[500] nope")).toBeNull();
	});
});

// SIO-960: on a FRESH session's first turn, the IaC agent proactively surfaces in-flight
// work (a dispatched fleet upgrade recovered from memory) so the user doesn't have to ask.
// It injects a SystemMessage (context for the turn's response), once per session, and stays
// silent on later turns and when nothing is in flight.
describe("bootstrapIac proactive in-flight surfacing (SIO-960)", () => {
	function withMemory(inFlight: { deployment: string; version: string; pipelineId: number }[]) {
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {},
			async addMessages() {},
			async searchMemory(_ref: unknown, _q: string, opts?: { annotations?: Record<string, string> }) {
				if (opts?.annotations?.kind !== "fleet-upgrade-dispatched") return [];
				return inFlight.map((u) => ({
					text: `Fleet agents on ${u.deployment} upgrade DISPATCHED to ${u.version}.`,
					score: 0.9,
					annotations: {
						kind: "fleet-upgrade-dispatched",
						deployment: u.deployment,
						version: u.version,
						pipeline_id: String(u.pipelineId),
					},
				}));
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
		});
	}

	test("first turn with an in-flight upgrade injects a SystemMessage mentioning it", async () => {
		mockTools({}); // getConnectedServers -> ["elastic-iac-mcp"], so connected
		const prev = process.env.LIVE_MEMORY_BACKEND;
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		withMemory([{ deployment: "us-cld", version: "9.4.2", pipelineId: 2614422047 }]);
		const { bootstrapIac } = await import("./nodes.ts");
		// fresh thread: only the human message, NO prior AIMessage
		const state = {
			messages: [{ getType: () => "human", content: "resize eu-b2b warm tier" }],
		} as unknown as IacStateType;

		const out = await bootstrapIac(state);

		expect(out.connected).toBe(true);
		const injected = (out.messages ?? []) as { getType?: () => string; content?: unknown }[];
		const sys = injected.find((m) => m.getType?.() === "system");
		expect(sys).toBeDefined();
		expect(String(sys?.content)).toContain("us-cld");
		expect(String(sys?.content)).toContain("2614422047");

		const { __setAgentMemoryClient } = await import("../memory-backend.ts");
		__setAgentMemoryClient(null);
		if (prev === undefined) delete process.env.LIVE_MEMORY_BACKEND;
		else process.env.LIVE_MEMORY_BACKEND = prev;
	});

	test("does NOT surface on a later turn (prior AIMessage present)", async () => {
		mockTools({});
		const prev = process.env.LIVE_MEMORY_BACKEND;
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		withMemory([{ deployment: "us-cld", version: "9.4.2", pipelineId: 2614422047 }]);
		const { bootstrapIac } = await import("./nodes.ts");
		// later turn: history already has an assistant reply
		const state = {
			messages: [
				{ getType: () => "human", content: "earlier question" },
				{ getType: () => "ai", content: "earlier answer" },
				{ getType: () => "human", content: "resize eu-b2b warm tier" },
			],
		} as unknown as IacStateType;

		const out = await bootstrapIac(state);
		const injected = (out.messages ?? []) as { getType?: () => string }[];
		expect(injected.find((m) => m.getType?.() === "system")).toBeUndefined();

		const { __setAgentMemoryClient } = await import("../memory-backend.ts");
		__setAgentMemoryClient(null);
		if (prev === undefined) delete process.env.LIVE_MEMORY_BACKEND;
		else process.env.LIVE_MEMORY_BACKEND = prev;
	});

	test("first turn with NOTHING in flight stays silent (no system message)", async () => {
		mockTools({});
		const prev = process.env.LIVE_MEMORY_BACKEND;
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		withMemory([]);
		const { bootstrapIac } = await import("./nodes.ts");
		const state = {
			messages: [{ getType: () => "human", content: "resize eu-b2b warm tier" }],
		} as unknown as IacStateType;

		const out = await bootstrapIac(state);
		const injected = (out.messages ?? []) as { getType?: () => string }[];
		expect(injected.find((m) => m.getType?.() === "system")).toBeUndefined();

		const { __setAgentMemoryClient } = await import("../memory-backend.ts");
		__setAgentMemoryClient(null);
		if (prev === undefined) delete process.env.LIVE_MEMORY_BACKEND;
		else process.env.LIVE_MEMORY_BACKEND = prev;
	});
});

describe("formatFleetUpgradeSummary — SIO-924 pipeline link", () => {
	test("applied result renders a clickable apply-pipeline markdown link when pipelineUrl is set", () => {
		const result: FleetUpgradeResult = {
			status: "applied",
			pipelineId: 99,
			pipelineUrl: "https://gitlab.com/x/-/pipelines/99",
			pollStatus: "COMPLETE",
			acked: 4,
			created: 4,
			failedSilent: 0,
		};
		const s = stateWith({ fleetUpgradeReport: report({}), fleetUpgradeResult: result });
		const msg = formatFleetUpgradeSummary(s);
		expect(msg).toContain("[#99](https://gitlab.com/x/-/pipelines/99)");
	});
	test("applied result falls back to a bare pipeline number when no url", () => {
		const result: FleetUpgradeResult = {
			status: "applied",
			pipelineId: 99,
			pollStatus: "COMPLETE",
			acked: 4,
			created: 4,
		};
		const s = stateWith({ fleetUpgradeReport: report({}), fleetUpgradeResult: result });
		expect(formatFleetUpgradeSummary(s)).toContain("Apply pipeline #99.");
	});
});

// SIO-926: a follow-up "how's the upgrade going?" (pipeline-status intent -> watchPipeline) must
// re-poll the PERSISTED fleet apply pipeline read-only -- never re-trigger -- since a binary
// upgrade has no MR to recover.
describe("watchPipeline re-polls a dispatched fleet apply (SIO-926)", () => {
	test("still running -> dispatched, reads gitlab_get_pipeline, never triggers or lists MRs", async () => {
		const { watchPipeline } = await import("./nodes.ts");
		const seen: string[] = [];
		mockTools({
			gitlab_get_pipeline: () => {
				seen.push("gitlab_get_pipeline");
				return '[200] {"id":2605468937,"status":"running","web_url":"https://gitlab.com/x/-/pipelines/2605468937"}';
			},
			// These MUST NOT be called on the fleet path.
			gitlab_list_agent_merge_requests: () => {
				seen.push("gitlab_list_agent_merge_requests");
				return "[200] []";
			},
			gitlab_trigger_fleet_upgrade_apply: () => {
				seen.push("gitlab_trigger_fleet_upgrade_apply");
				return '[201] {"pipelineId":1,"status":"created"}';
			},
		});
		const state = {
			intent: "pipeline-status",
			fleetApplyPipelineId: 2605468937,
			fleetUpgradeResult: { status: "dispatched", pipelineId: 2605468937 },
		} as unknown as IacStateType;

		const out = await watchPipeline(state);

		expect(seen).toContain("gitlab_get_pipeline");
		expect(seen).not.toContain("gitlab_list_agent_merge_requests"); // no MR recovery on the fleet path
		expect(seen).not.toContain("gitlab_trigger_fleet_upgrade_apply"); // never re-triggers
		expect(out.fleetUpgradeResult?.status).toBe("dispatched");
		// still in flight -> keep the id for the next check (not cleared)
		expect(out.fleetApplyPipelineId).toBeUndefined();
	});

	test("terminal success -> applied, fetches the apply result, clears the persisted id", async () => {
		const { watchPipeline } = await import("./nodes.ts");
		// The apply-result tool returns the report as a JSON STRING field (parseDriftCheckResult keeps
		// report only when typeof === "string"), and parseFleetApplyOutcome reads action_id/apply
		// from it at the top level.
		const reportStr = JSON.stringify({
			mode: "apply",
			action_id: "abc",
			apply: { poll_status: "COMPLETE", acked: 247, created: 247, failed_silent: 0 },
		});
		mockTools({
			gitlab_get_pipeline: () => '[200] {"id":2605468937,"status":"success"}',
			gitlab_get_fleet_upgrade_apply_result: () =>
				`[200] ${JSON.stringify({ pipelineId: 2605468937, status: "success", report: reportStr })}`,
		});
		const state = {
			intent: "pipeline-status",
			fleetApplyPipelineId: 2605468937,
			fleetUpgradeResult: { status: "dispatched", pipelineId: 2605468937 },
		} as unknown as IacStateType;

		const out = await watchPipeline(state);

		expect(out.fleetUpgradeResult?.status).toBe("applied");
		expect(out.fleetUpgradeResult?.failedSilent).toBe(0);
		// reached terminal -> clear the in-flight id so we don't keep re-checking
		expect(out.fleetApplyPipelineId).toBeNull();
	});

	// SIO-959: "how's the us-cld upgrade going?" in a NEW conversation -- no thread-local
	// fleetApplyPipelineId, and a fleet upgrade has no MR. watchPipeline must recover the
	// dispatched pipeline id from durable memory (structured annotations) and re-poll it,
	// instead of falling through to the (useless) MR lookup.
	test("recovers the dispatched pipeline from memory cross-session and re-polls it", async () => {
		const { __setAgentMemoryClient } = await import("../memory-backend.ts");
		const prevBackend = process.env.LIVE_MEMORY_BACKEND;
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		// Fake memory client: a search filtered to fleet-upgrade-dispatched returns the
		// us-cld upgrade with its pipeline id in the annotations.
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async addMessages() {
				return { blockIds: [], acceptedCount: 0, rejectedCount: 0 };
			},
			async searchMemory(_ref, _query, opts) {
				if (opts?.annotations?.kind !== "fleet-upgrade-dispatched") return [];
				return [
					{
						text: "Fleet agents on us-cld upgrade DISPATCHED to 9.4.2.",
						score: 0.9,
						annotations: {
							kind: "fleet-upgrade-dispatched",
							deployment: "us-cld",
							version: "9.4.2",
							pipeline_id: "2614422047",
						},
					},
				];
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
		});
		const { watchPipeline } = await import("./nodes.ts");
		const seen: string[] = [];
		mockTools({
			gitlab_get_pipeline: (args) => {
				seen.push(`gitlab_get_pipeline:${args.pipelineId}`);
				return '[200] {"id":2614422047,"status":"running","web_url":"https://gitlab.com/x/-/pipelines/2614422047"}';
			},
			gitlab_list_agent_merge_requests: () => {
				seen.push("gitlab_list_agent_merge_requests");
				return "[200] []";
			},
		});
		// New conversation: no thread-local fleet id, no MR. Query names us-cld.
		const state = {
			intent: "pipeline-status",
			fleetApplyPipelineId: null,
			mrIid: null,
			messages: [{ getType: () => "human", content: "how is the us-cld upgrade going?" }],
		} as unknown as IacStateType;

		const out = await watchPipeline(state);

		// re-polled the RECOVERED pipeline id, never hunted for an MR
		expect(seen).toContain("gitlab_get_pipeline:2614422047");
		expect(seen).not.toContain("gitlab_list_agent_merge_requests");
		expect(out.fleetUpgradeResult?.status).toBe("dispatched");

		__setAgentMemoryClient(null);
		if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
		else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	});
});

// SIO-927: an operator-approved apply must carry MAX_AGENTS = the previewed resolved_count so the
// CI script's blast-radius cap (default 500) does not refuse a fleet-wide upgrade. Approval at the
// gate == accepting that blast radius. The PREVIEW must stay uncapped (never send MAX_AGENTS), or
// it would refuse to report the true count for large fleets.
describe("fleet-upgrade MAX_AGENTS blast-radius override (SIO-927)", () => {
	test("applyFleetUpgrade passes maxAgents = report.resolvedCount to the apply trigger", async () => {
		const { applyFleetUpgrade } = await import("./nodes.ts");
		const applyArgs: Array<Record<string, unknown>> = [];
		mockTools({
			gitlab_trigger_fleet_upgrade_apply: (args) => {
				applyArgs.push(args);
				return '[201] {"deployment":"eu-cld","version":"9.4.2","pipelineId":2606400810,"status":"created"}';
			},
			// Terminal on the first status read -> the live-progress poll loop exits before any sleep.
			gitlab_get_pipeline: () => '[200] {"id":2606400810,"status":"success"}',
			gitlab_get_fleet_upgrade_apply_result: () =>
				`[200] ${JSON.stringify({
					pipelineId: 2606400810,
					status: "success",
					report: JSON.stringify({
						mode: "apply",
						action_id: "act-1",
						apply: { poll_status: "COMPLETE", acked: 1608, created: 1608, failed_silent: 0 },
					}),
				})}`,
		});
		// resolved_count 1793 > the script's 500 default -> without the override CI would refuse.
		const state = stateWith({
			fleetUpgradeReport: report({
				deployment: "eu-cld",
				resolvedCount: 1793,
				maxAgents: 500,
				crosstab: { upgradeable: 1608, notUpgradeable: 185, byReason: [{ reason: "wolfi_container", count: 3 }] },
			}),
		});

		const out = await applyFleetUpgrade(state);

		expect(applyArgs).toHaveLength(1);
		expect(applyArgs[0]?.deployment).toBe("eu-cld");
		expect(applyArgs[0]?.version).toBe("9.4.2");
		// the whole point of the ticket: the resolved set's size is forwarded as the cap override
		expect(applyArgs[0]?.maxAgents).toBe(1793);
		// SIO-936: the apply also forwards the agent-count-scaled rollout window (1608 upgradeable
		// -> capped at 3600) so Fleet staggers the bulk_upgrade over the right rollout_duration_seconds.
		expect(applyArgs[0]?.rolloutSeconds).toBe(3600);
		expect(out.fleetUpgradeResult?.status).toBe("applied");
	});

	test("detectFleetUpgrade never sends maxAgents on the PREVIEW trigger (preview stays uncapped)", async () => {
		const { detectFleetUpgrade } = await import("./nodes.ts");
		const previewArgs: Array<Record<string, unknown>> = [];
		mockTools({
			// Short-circuit right after the trigger: a locked (no pipelineId) result returns a planError
			// report without polling -- enough to inspect what the preview trigger was called with.
			gitlab_trigger_fleet_upgrade_preview: (args) => {
				previewArgs.push(args);
				return '[423] {"status":"locked","note":"a fleet pipeline is already running"}';
			},
		});
		const state = {
			messages: [{ getType: () => "human", content: "upgrade all the fleet agents in eu-cld to 9.4.2" }],
			iacRequest: { workflow: "fleet-upgrade", isProd: false, cluster: "eu-cld", version: "9.4.2" },
		} as unknown as IacStateType;

		await detectFleetUpgrade(state);

		expect(previewArgs).toHaveLength(1);
		expect(previewArgs[0]?.deployment).toBe("eu-cld");
		expect(previewArgs[0]).not.toHaveProperty("maxAgents");
	});
});

// SIO-928: the reported bug -- a follow-up about a dispatched fleet apply ("How is the rollout?")
// classified as info and re-printed the stale dispatched message instead of re-polling. The
// deterministic guard in classifyIacIntent routes it to pipeline-status BEFORE the LLM, but only
// when a fleet apply pipeline is actually in flight. These assert the routing without an LLM mock
// (the guard returns before createLlm is reached).
describe("classifyIacIntent fleet-status guard (SIO-928)", () => {
	const humanState = (content: string, fleetApplyPipelineId: number | null) =>
		({
			messages: [{ getType: () => "human", content }],
			fleetApplyPipelineId,
		}) as unknown as IacStateType;

	test("a rollout follow-up with a fleet apply in flight routes to pipeline-status (no LLM)", async () => {
		const { classifyIacIntent } = await import("./nodes.ts");
		for (const q of ["How is the rollout?", "check on it or watch the pipeline", "is the upgrade done yet"]) {
			const out = await classifyIacIntent(humanState(q, 2606647909));
			expect(out.intent).toBe("pipeline-status");
		}
	});

	test("a FRESH upgrade request does NOT trip the guard even with a pipeline in flight", async () => {
		// "upgrade ... to 9.5.0" names a version -> a NEW apply, not a status check. The guard predicate
		// (looksLikeFleetStatusCheck) must reject it so classifyIacIntent falls through to the LLM and a
		// second upgrade is never swallowed as pipeline-status. Asserted at the predicate the guard uses
		// -- avoiding a process-global createLlm mock that would pollute sibling tests (SIO-635 class).
		const { looksLikeFleetStatusCheck } = await import("./nodes.ts");
		expect(looksLikeFleetStatusCheck("upgrade the agents on eu-cld to 9.5.0")).toBe(false);
	});
});

// SIO-943: the breadcrumb + durable-fact content for a fleet upgrade. These are the pure
// string builders teardownIac feeds to appendDailyLog / recordKeyDecision; the gating (terminal
// status + agent-memory backend) lives in teardownIac and is exercised by the live flow.
describe("buildFleetMemorySummary", () => {
	test("captures version, deployment, counts, acked, and pipeline", () => {
		const s = stateWith({
			intent: "fleet-upgrade",
			targetDeployment: "eu-cld",
			fleetUpgradeReport: report({
				targetVersion: "9.4.2",
				crosstab: { upgradeable: 17, notUpgradeable: 1786, byReason: [] },
				versionCrosstab: { alreadyOnTarget: 1552, outdated: 17, versionUnknown: 0, upgradeableOutdated: 17 },
			}),
			fleetUpgradeResult: { status: "applied", pipelineId: 2610021206, acked: 0, created: 16, failedSilent: 0 },
		});
		const summary = buildFleetMemorySummary(s).join(" ");
		expect(summary).toContain("intent=fleet-upgrade");
		expect(summary).toContain("deployment=eu-cld");
		expect(summary).toContain("version=9.4.2");
		expect(summary).toContain("status=applied");
		expect(summary).toContain("upgradeable=17");
		expect(summary).toContain("already-on-target=1552");
		expect(summary).toContain("non-upgradeable=1786");
		expect(summary).toContain("acked=0/16");
		expect(summary).toContain("pipeline=2610021206");
	});

	test("omits non-upgradeable when zero and degrades gracefully with no report", () => {
		const withZero = stateWith({
			intent: "fleet-upgrade",
			targetDeployment: "eu-b2b",
			fleetUpgradeReport: report({ crosstab: { upgradeable: 8, notUpgradeable: 0, byReason: [] } }),
			fleetUpgradeResult: { status: "applied" },
		});
		expect(buildFleetMemorySummary(withZero).join(" ")).not.toContain("non-upgradeable");

		const bare = stateWith({
			intent: "fleet-upgrade",
			targetDeployment: "",
			fleetUpgradeReport: null,
			fleetUpgradeResult: null,
		});
		// Never throws; at minimum carries the intent tag.
		expect(buildFleetMemorySummary(bare)).toContain("intent=fleet-upgrade");
	});
});

describe("buildFleetFactDecision / buildFleetFactRationale", () => {
	test("applied -> durable, self-contained fact statement", () => {
		const s = stateWith({
			targetDeployment: "eu-cld",
			fleetUpgradeReport: report({ targetVersion: "9.4.2" }),
		});
		const result: FleetUpgradeResult = {
			status: "applied",
			pipelineId: 2610021206,
			acked: 16,
			created: 16,
			failedSilent: 0,
		};
		expect(buildFleetFactDecision(s, result)).toBe("Fleet agents on eu-cld upgraded to 9.4.2.");
		const rationale = buildFleetFactRationale(s, result);
		expect(rationale).toContain("upgradeable");
		expect(rationale).toContain("Apply pipeline #2610021206.");
	});

	test("failed -> states the failure and surfaces UPG_FAILED + note", () => {
		const s = stateWith({
			targetDeployment: "eu-cld",
			fleetUpgradeReport: report({ targetVersion: "9.4.2" }),
		});
		const result: FleetUpgradeResult = {
			status: "failed",
			pipelineId: 99,
			failedSilent: 3,
			note: "Apply pipeline failed. Terraform state lock.",
		};
		expect(buildFleetFactDecision(s, result)).toBe("Fleet agents on eu-cld upgrade FAILED to 9.4.2.");
		const rationale = buildFleetFactRationale(s, result);
		expect(rationale).toContain("3 reached UPG_FAILED");
		expect(rationale).toContain("Terraform state lock");
	});

	// SIO-957: a dispatched (still-running) upgrade gets a durable fact too, worded
	// as in-flight, so a later session recalls work the user kicked off even though
	// the apply pipeline outlived the dispatching turn.
	test("dispatched -> durable fact reads as in-flight (DISPATCHED), carries the pipeline", () => {
		const s = stateWith({
			targetDeployment: "us-cld",
			fleetUpgradeReport: report({ targetVersion: "9.4.2" }),
		});
		const result: FleetUpgradeResult = {
			status: "dispatched",
			pipelineId: 2614422047,
			note: "Upgrade started and running; not finished within the status window.",
		};
		expect(buildFleetFactDecision(s, result)).toBe("Fleet agents on us-cld upgrade DISPATCHED to 9.4.2.");
		const rationale = buildFleetFactRationale(s, result);
		expect(rationale).toContain("Apply pipeline #2614422047.");
		// never the terminal copy
		expect(buildFleetFactDecision(s, result)).not.toContain("upgraded to");
		expect(buildFleetFactDecision(s, result)).not.toContain("FAILED");
	});
});

// SIO-971: deployment-scoped recall of prior TERMINAL fleet upgrades for the gate card -- the
// fleet-path twin of SIO-970's memoryEnrichIac. Reads kind:"fleet-upgrade-terminal" (NOT the
// dispatched/in-flight facts that recallInFlightFleetUpgrades reads).
describe("recallPriorFleetUpgrades (SIO-971)", () => {
	const prevBackend = process.env.LIVE_MEMORY_BACKEND;
	function withTerminalFacts(
		rows: Array<{ deployment: string; version: string; outcome: string; pipelineId: number }>,
	) {
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		__setAgentMemoryClient({
			async ensureUser() {},
			async ensureSession() {},
			async addFacts() {},
			async addMessages() {},
			async searchMemory(_ref: unknown, _q: string, opts?: { annotations?: Record<string, string> }) {
				// proves the recall filters on the SAME keys the fleet write stamps
				expect(opts?.annotations).toEqual({ deployment: "us-cld", kind: "fleet-upgrade-terminal" });
				return rows.map((u) => ({
					text: `Fleet agents on ${u.deployment} upgraded to ${u.version}.`,
					score: 0.9,
					annotations: {
						kind: "fleet-upgrade-terminal",
						deployment: u.deployment,
						version: u.version,
						outcome: u.outcome,
						pipeline_id: String(u.pipelineId),
					},
				}));
			},
			async updateSession() {},
			async endSession() {},
			async checkHealth() {
				return { ok: true };
			},
			// biome-ignore lint/suspicious/noExplicitAny: SIO-971 - test stub for the AgentMemoryClient surface
		} as any);
	}
	function reset() {
		const { __setAgentMemoryClient } = require("../memory-backend.ts");
		__setAgentMemoryClient(null);
		if (prevBackend === undefined) delete process.env.LIVE_MEMORY_BACKEND;
		else process.env.LIVE_MEMORY_BACKEND = prevBackend;
	}

	test("renders prior terminal upgrades as markdown with version/outcome/pipeline tags", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		withTerminalFacts([{ deployment: "us-cld", version: "9.3.0", outcome: "applied", pipelineId: 2600000001 }]);
		const out = await recallPriorFleetUpgrades("us-cld", "9.4.2");
		expect(out).toContain("Fleet agents on us-cld upgraded to 9.3.0");
		expect(out).toContain("[9.3.0 applied pipeline 2600000001]");
		reset();
	});

	// SIO-973: a re-recorded upgrade (same pipeline_id) must render ONCE, not twice.
	test("dedups recall hits sharing a pipeline_id into a single bullet", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		withTerminalFacts([
			{ deployment: "us-cld", version: "9.3.0", outcome: "applied", pipelineId: 2600000001 },
			{ deployment: "us-cld", version: "9.3.0", outcome: "applied", pipelineId: 2600000001 },
		]);
		const out = await recallPriorFleetUpgrades("us-cld", "9.4.2");
		expect(out.split("\n")).toHaveLength(1);
		expect(out).toContain("[9.3.0 applied pipeline 2600000001]");
		reset();
	});

	test("returns '' when the agent-memory backend is not selected", async () => {
		delete process.env.LIVE_MEMORY_BACKEND;
		expect(await recallPriorFleetUpgrades("us-cld", "9.4.2")).toBe("");
		reset();
	});

	test("returns '' when no deployment is resolved", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		expect(await recallPriorFleetUpgrades("", "9.4.2")).toBe("");
		reset();
	});

	test("returns '' (no hits) when nothing prior exists", async () => {
		process.env.LIVE_MEMORY_BACKEND = "agent-memory";
		withTerminalFacts([]);
		expect(await recallPriorFleetUpgrades("us-cld", "9.4.2")).toBe("");
		reset();
	});
});

// SIO-1032: host-scoped fleet upgrade + expected-count guard. The repo already honors a SELECTOR
// (task fleet:bulk-upgrade-preview SELECTOR=...); these cover the AGENT side that was throwing the
// user's host list away and never enforcing "must resolve to exactly N".
describe("buildFleetHostSelector (SIO-1032)", () => {
	test("builds the upgradeable:true-scoped KQL from a host list, one quoted clause per host", () => {
		expect(buildFleetHostSelector(["eu1w2022amp40", "hwv00061", "amsctx514"])).toBe(
			'local_metadata.elastic.agent.upgradeable:true and local_metadata.host.hostname:("eu1w2022amp40" or "hwv00061" or "amsctx514")',
		);
	});
	test("preserves host-name case verbatim (Fleet hostnames are case-sensitive)", () => {
		expect(buildFleetHostSelector(["Hwv00153", "IT-A440TILL101"])).toBe(
			'local_metadata.elastic.agent.upgradeable:true and local_metadata.host.hostname:("Hwv00153" or "IT-A440TILL101")',
		);
	});
	test("trims whitespace and drops empty/blank entries", () => {
		expect(buildFleetHostSelector([" hostA ", "", "   ", "hostB"])).toBe(
			'local_metadata.elastic.agent.upgradeable:true and local_metadata.host.hostname:("hostA" or "hostB")',
		);
	});
	test("an empty list, an all-blank list, or undefined yields undefined (unscoped -> all agents)", () => {
		expect(buildFleetHostSelector([])).toBeUndefined();
		expect(buildFleetHostSelector(["", "  "])).toBeUndefined();
		expect(buildFleetHostSelector(undefined)).toBeUndefined();
	});
});

describe("fleet-upgrade raw-text scoping parsers (SIO-1032)", () => {
	// The reported prompt shape: a colon introduces a comma-run of host tokens, and the target
	// version 9.4.2 sits just before the colon -- it must NOT be captured as a host.
	const prompt =
		"In the eu-cld deployment, upgrade these Fleet agents to 9.4.2: " +
		"eu1w2022amp40, hwv00061, IT-A440TILL101, AMSDB063-CLONE, EU2DB01D. " +
		"Scope the selector to exactly these hosts and to upgradeable:true. " +
		"Preview first: it must resolve to 25 agents.";

	test("parseFleetHostList pulls the named hosts, excludes the version, preserves case", () => {
		const hosts = parseFleetHostList(prompt);
		expect(hosts).toEqual(["eu1w2022amp40", "hwv00061", "IT-A440TILL101", "AMSDB063-CLONE", "EU2DB01D"]);
		expect(hosts).not.toContain("9.4.2");
	});
	test("parseFleetHostList honors an explicit 'hosts:' / 'agents:' label", () => {
		expect(parseFleetHostList("upgrade agents: hostA, hostB, hostC to 9.4.2")).toEqual(["hostA", "hostB", "hostC"]);
	});
	test("parseFleetHostList de-dupes case-insensitively, keeping first-seen casing", () => {
		expect(parseFleetHostList("hosts: HostA, hosta, HOSTB")).toEqual(["HostA", "HOSTB"]);
	});
	test("parseFleetHostList returns [] for a plain upgrade with no host list", () => {
		expect(parseFleetHostList("upgrade all the fleet agents on eu-cld to 9.4.2")).toEqual([]);
	});

	test("parseExpectedAgentCount reads 'it must resolve to 25 agents'", () => {
		expect(parseExpectedAgentCount(prompt)).toBe(25);
	});
	test("parseExpectedAgentCount reads 'exactly 12 agents' and 'resolve to 7'", () => {
		expect(parseExpectedAgentCount("stop unless exactly 12 agents match")).toBe(12);
		expect(parseExpectedAgentCount("the selector should resolve to 7")).toBe(7);
	});
	test("parseExpectedAgentCount is undefined when the user states no count", () => {
		expect(parseExpectedAgentCount("upgrade the agents on eu-cld to 9.4.2")).toBeUndefined();
	});

	test("parseFleetRawSelector captures an inline local_metadata KQL clause", () => {
		const kql = 'local_metadata.host.hostname:("a" or "b")';
		expect(parseFleetRawSelector(`use this: ${kql} please`)).toBe(kql);
	});
	test("parseFleetRawSelector reads a 'SELECTOR=' prefix form", () => {
		const kql = 'local_metadata.elastic.agent.upgradeable:true and local_metadata.host.hostname:("x")';
		expect(parseFleetRawSelector(`SELECTOR=${kql}`)).toBe(kql);
	});
	test("parseFleetRawSelector is undefined when no KQL is present", () => {
		expect(parseFleetRawSelector("upgrade these hosts: a, b, c")).toBeUndefined();
	});
});

describe("buildFleetGateMessage count-mismatch warning (SIO-1032)", () => {
	test("warns when the resolved count differs from the user's expected count", () => {
		const { message } = buildFleetGateMessage(
			report({
				deployment: "eu-cld",
				resolvedCount: 1595,
				expectedAgentCount: 25,
				crosstab: { upgradeable: 40, notUpgradeable: 0, byReason: [] },
				versionCrosstab: { alreadyOnTarget: 1555, outdated: 40, versionUnknown: 0, upgradeableOutdated: 40 },
			}),
		);
		expect(message).toContain("WARNING");
		expect(message).toContain("you asked for exactly 25");
		expect(message).toContain("resolved to 1595");
		// the warning still says the approve upgrades only the scoped, upgradeable set
		expect(message).toContain("40 scoped");
	});
	test("no warning when the resolved count matches the expected count", () => {
		const { message } = buildFleetGateMessage(
			report({
				resolvedCount: 25,
				expectedAgentCount: 25,
				crosstab: { upgradeable: 25, notUpgradeable: 0, byReason: [] },
			}),
		);
		expect(message).not.toContain("WARNING");
		expect(message).not.toContain("you asked for exactly");
	});
	test("no warning when the user set no expected count (guard is opt-in)", () => {
		const { message } = buildFleetGateMessage(report({ resolvedCount: 1595 }));
		expect(message).not.toContain("WARNING");
	});
});

describe("fleet-upgrade selector threading (SIO-1032)", () => {
	test("detectFleetUpgrade builds the KQL from a host list parsed from the message text", async () => {
		const { detectFleetUpgrade } = await import("./nodes.ts");
		const previewArgs: Array<Record<string, unknown>> = [];
		mockTools({
			gitlab_trigger_fleet_upgrade_preview: (args) => {
				previewArgs.push(args);
				return '[423] {"status":"locked","note":"a fleet pipeline is already running"}';
			},
		});
		// The fleet-upgrade intent skips parseIntent, so the host list comes from the raw text; only
		// cluster/version are pre-parsed onto iacRequest (as the live classifier path provides them).
		const state = {
			messages: [{ getType: () => "human", content: "upgrade only these fleet agents to 9.4.2: hostA, hostB" }],
			iacRequest: { workflow: "other", isProd: false, cluster: "eu-cld", version: "9.4.2" },
		} as unknown as IacStateType;

		await detectFleetUpgrade(state);

		expect(previewArgs).toHaveLength(1);
		expect(previewArgs[0]?.deployment).toBe("eu-cld");
		expect(previewArgs[0]?.selector).toBe(
			'local_metadata.elastic.agent.upgradeable:true and local_metadata.host.hostname:("hostA" or "hostB")',
		);
	});

	test("a raw KQL selector pasted in the message wins and is sent verbatim", async () => {
		const { detectFleetUpgrade } = await import("./nodes.ts");
		const previewArgs: Array<Record<string, unknown>> = [];
		mockTools({
			gitlab_trigger_fleet_upgrade_preview: (args) => {
				previewArgs.push(args);
				return '[423] {"status":"locked"}';
			},
		});
		const rawKql = 'local_metadata.host.hostname:("only-this-one")';
		const state = {
			messages: [
				// a raw KQL clause AND a stray host token -- the raw selector must win.
				{ getType: () => "human", content: `upgrade eu-cld agents to 9.4.2 using ${rawKql} not: otherhost` },
			],
			iacRequest: { workflow: "other", isProd: false, cluster: "eu-cld", version: "9.4.2" },
		} as unknown as IacStateType;

		await detectFleetUpgrade(state);

		expect(previewArgs[0]?.selector).toBe(rawKql);
	});

	test("a plain upgrade (no scoping) sends NO selector -- CI resolves all outdated agents (back-compat)", async () => {
		const { detectFleetUpgrade } = await import("./nodes.ts");
		const previewArgs: Array<Record<string, unknown>> = [];
		mockTools({
			gitlab_trigger_fleet_upgrade_preview: (args) => {
				previewArgs.push(args);
				return '[423] {"status":"locked"}';
			},
		});
		const state = {
			messages: [{ getType: () => "human", content: "upgrade all the fleet agents in eu-cld to 9.4.2" }],
			iacRequest: { workflow: "fleet-upgrade", isProd: false, cluster: "eu-cld", version: "9.4.2" },
		} as unknown as IacStateType;

		await detectFleetUpgrade(state);

		expect(previewArgs[0]).not.toHaveProperty("selector");
	});

	test("applyFleetUpgrade resends report.requestedSelector so an approval stays scoped", async () => {
		const { applyFleetUpgrade } = await import("./nodes.ts");
		const applyArgs: Array<Record<string, unknown>> = [];
		mockTools({
			gitlab_trigger_fleet_upgrade_apply: (args) => {
				applyArgs.push(args);
				return '[201] {"deployment":"eu-cld","version":"9.4.2","pipelineId":2606400810,"status":"created"}';
			},
			gitlab_get_pipeline: () => '[200] {"id":2606400810,"status":"success"}',
			gitlab_get_fleet_upgrade_apply_result: () =>
				`[200] ${JSON.stringify({
					pipelineId: 2606400810,
					status: "success",
					report: JSON.stringify({
						mode: "apply",
						action_id: "act-1",
						apply: { poll_status: "COMPLETE", acked: 2, created: 2, failed_silent: 0 },
					}),
				})}`,
		});
		const scoped =
			'local_metadata.elastic.agent.upgradeable:true and local_metadata.host.hostname:("hostA" or "hostB")';
		const state = stateWith({
			fleetUpgradeReport: report({
				deployment: "eu-cld",
				resolvedCount: 2,
				requestedSelector: scoped,
				crosstab: { upgradeable: 2, notUpgradeable: 0, byReason: [] },
			}),
		});

		await applyFleetUpgrade(state);

		expect(applyArgs).toHaveLength(1);
		expect(applyArgs[0]?.selector).toBe(scoped);
	});

	test("applyFleetUpgrade sends NO selector when the upgrade was unscoped (back-compat)", async () => {
		const { applyFleetUpgrade } = await import("./nodes.ts");
		const applyArgs: Array<Record<string, unknown>> = [];
		mockTools({
			gitlab_trigger_fleet_upgrade_apply: (args) => {
				applyArgs.push(args);
				return '[201] {"pipelineId":2606400811,"status":"created"}';
			},
			gitlab_get_pipeline: () => '[200] {"id":2606400811,"status":"success"}',
			gitlab_get_fleet_upgrade_apply_result: () =>
				`[200] ${JSON.stringify({
					pipelineId: 2606400811,
					status: "success",
					report: JSON.stringify({
						mode: "apply",
						action_id: "act-2",
						apply: { poll_status: "COMPLETE", acked: 8, created: 8, failed_silent: 0 },
					}),
				})}`,
		});
		const state = stateWith({
			fleetUpgradeReport: report({
				deployment: "eu-cld",
				crosstab: { upgradeable: 8, notUpgradeable: 0, byReason: [] },
			}),
		});

		await applyFleetUpgrade(state);

		expect(applyArgs[0]).not.toHaveProperty("selector");
	});
});

// SIO-1032: the 40-vs-1595 bug -- the gate card headlined willUpgrade (40) but the dispatched
// summary reported crosstab.upgradeable (1595). Both must now report the same willUpgrade count.
describe("formatFleetUpgradeSummary count agrees with the gate card (SIO-1032)", () => {
	test("dispatched summary reports willUpgrade (upgradeableOutdated), not the full upgradeable count", () => {
		const result: FleetUpgradeResult = { status: "dispatched", pipelineId: 2662207800, pipelineStatus: "running" };
		const rep = report({
			deployment: "eu-cld",
			resolvedCount: 1807,
			crosstab: { upgradeable: 1595, notUpgradeable: 212, byReason: [{ reason: "wolfi_container", count: 3 }] },
			versionCrosstab: { alreadyOnTarget: 1555, outdated: 40, versionUnknown: 0, upgradeableOutdated: 40 },
		});
		const msg = formatFleetUpgradeSummary(stateWith({ fleetUpgradeReport: rep, fleetUpgradeResult: result }));
		// the gate card headline for the same report:
		expect(buildFleetGateMessage(rep).willUpgrade).toBe(40);
		// the summary agrees -- 40 agent(s), never the 1595 total
		expect(msg).toContain("40 agent(s) upgrading");
		expect(msg).not.toContain("1595 agent(s) upgrading");
	});
});
