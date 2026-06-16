// agent/src/iac/fleet-upgrade.test.ts
import { describe, expect, mock, test } from "bun:test";
import {
	formatFleetUpgradeSummary,
	formatRolloutDuration,
	hasApplicableFleetUpgrade,
	intentFromText,
	parseFleetApplyOutcome,
	parseFleetUpgradeReport,
	parseSinglePipeline,
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
		const s = stateWith({
			fleetUpgradeReport: report({ deployment: "ap-cld", rolloutSeconds: 3600 }),
			fleetUpgradeResult: result,
		});
		const msg = formatFleetUpgradeSummary(s);
		expect(msg).toContain("started");
		expect(msg).not.toContain("failed");
		// expected duration surfaced from rolloutSeconds (3600s -> ~60 min)
		expect(msg).toContain("60 min");
		// the resumable follow-up affordance
		expect(msg.toLowerCase()).toContain("check");
		// pipeline link preserved for tracking
		expect(msg).toContain("2605468937");
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
});
