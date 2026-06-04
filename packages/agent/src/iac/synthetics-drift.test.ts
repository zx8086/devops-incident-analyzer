// agent/src/iac/synthetics-drift.test.ts
import { describe, expect, mock, test } from "bun:test";
import {
	explainSyntheticsDrift,
	formatSyntheticsSummary,
	hasPushableSyntheticsDrift,
	parseSyntheticsDriftReport,
	pushableMonitors,
	pushProjectScope,
} from "./nodes.ts";
import type { IacStateType, SyntheticsDriftReport } from "./state.ts";

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

// A minimal report stub (camelCase, post-parse shape).
function report(over: Partial<SyntheticsDriftReport>): SyntheticsDriftReport {
	return {
		deployment: "eu-b2b",
		kibanaUrl: "https://x.es.io:443",
		kibanaSpace: "developer-experience",
		hasActionableDrift: true,
		totals: {
			projectsChecked: 1,
			monitorsInSource: 1,
			monitorsInKibana: 1,
			missingInKibana: 0,
			extraInKibana: 0,
			changed: 0,
		},
		drift: [],
		reconcilePlan: { pushToKibana: { command: "", monitors: [] }, addToSource: { action: "", monitors: [] } },
		generatedAt: "2026-06-04T00:00:00Z",
		...over,
	};
}

describe("parseSyntheticsDriftReport", () => {
	const sample = JSON.stringify({
		deployment: "eu-b2b",
		kibana_url: "https://x.es.io:443",
		kibana_space: "developer-experience",
		has_actionable_drift: true,
		totals: {
			projects_checked: 10,
			monitors_in_source: 81,
			monitors_in_kibana: 254,
			missing_in_kibana: 0,
			extra_in_kibana: 132,
			changed: 41,
		},
		drift: [
			{
				project: "eu-oit.prd",
				monitor_id: "Prana - API Health",
				monitor_name: "OIT - API Health",
				category: "changed",
				fields: [{ field: "name", source: "OIT - API Health", live: "Prana - API Health" }],
			},
			{
				project: "eu-shared-services.dev",
				monitor_id: "DS Kafka",
				monitor_name: "DS Kafka",
				category: "extra_in_kibana",
			},
		],
		reconcile_plan: {
			push_to_kibana: {
				command: "task synthetics:push DEPLOYMENT=eu-b2b PROJECT=eu-oit.prd",
				monitors: [{ project: "eu-oit.prd", monitor_id: "Prana - API Health", monitor_name: "OIT - API Health" }],
			},
			add_to_source: {
				action: "Create YAML, then push",
				monitors: [{ project: "eu-shared-services.dev", monitor_id: "DS Kafka", monitor_name: "DS Kafka" }],
			},
		},
	});

	test("maps snake_case to camelCase and parses drift + reconcile_plan", () => {
		const r = parseSyntheticsDriftReport(sample);
		expect(r).not.toBeNull();
		expect(r?.deployment).toBe("eu-b2b");
		expect(r?.kibanaSpace).toBe("developer-experience");
		expect(r?.hasActionableDrift).toBe(true);
		expect(r?.totals.monitorsInKibana).toBe(254);
		expect(r?.totals.extraInKibana).toBe(132);
		expect(r?.drift).toHaveLength(2);
		expect(r?.drift[0]?.category).toBe("changed");
		expect(r?.drift[0]?.fields?.[0]).toEqual({ field: "name", source: "OIT - API Health", live: "Prana - API Health" });
		expect(r?.reconcilePlan.pushToKibana.command).toContain("PROJECT=eu-oit.prd");
		expect(r?.reconcilePlan.addToSource.monitors).toHaveLength(1);
	});

	test("tolerates a prose prefix before the first brace", () => {
		const r = parseSyntheticsDriftReport(`some log noise\n${sample}`);
		expect(r?.deployment).toBe("eu-b2b");
	});

	test("returns null on empty/garbage input", () => {
		expect(parseSyntheticsDriftReport("")).toBeNull();
		expect(parseSyntheticsDriftReport("not json at all")).toBeNull();
		expect(parseSyntheticsDriftReport("{ broken")).toBeNull();
	});

	test("defaults missing totals/reconcile_plan to zeros/empty", () => {
		const r = parseSyntheticsDriftReport(JSON.stringify({ deployment: "eu-b2b", drift: [] }));
		expect(r?.totals.changed).toBe(0);
		expect(r?.reconcilePlan.pushToKibana.command).toBe("");
		expect(r?.reconcilePlan.pushToKibana.monitors).toEqual([]);
	});

	test("drops monitors with an unknown category or no id", () => {
		const r = parseSyntheticsDriftReport(
			JSON.stringify({
				deployment: "eu-b2b",
				drift: [
					{ project: "p", monitor_id: "ok", monitor_name: "ok", category: "changed" },
					{ project: "p", monitor_id: "bad", category: "unknown_thing" },
					{ project: "p", category: "changed" }, // no monitor_id
				],
			}),
		);
		expect(r?.drift).toHaveLength(1);
		expect(r?.drift[0]?.monitorId).toBe("ok");
	});

	test("has_actionable_drift is strictly === true", () => {
		expect(
			parseSyntheticsDriftReport(JSON.stringify({ deployment: "x", has_actionable_drift: "true" }))?.hasActionableDrift,
		).toBe(false);
		expect(
			parseSyntheticsDriftReport(JSON.stringify({ deployment: "x", has_actionable_drift: 1 }))?.hasActionableDrift,
		).toBe(false);
	});
});

describe("pushableMonitors + pushProjectScope (extra_in_kibana invariant)", () => {
	const mixed = report({
		drift: [
			{ project: "eu-oit.prd", monitorId: "a", monitorName: "a", category: "changed" },
			{ project: "eu-oit.prd", monitorId: "b", monitorName: "b", category: "missing_in_kibana" },
			{ project: "eu-other.prd", monitorId: "c", monitorName: "c", category: "extra_in_kibana" },
		],
	});

	test("pushableMonitors returns only changed + missing_in_kibana, NEVER extra_in_kibana", () => {
		const p = pushableMonitors(mixed);
		expect(p).toHaveLength(2);
		expect(p.every((m) => m.category !== "extra_in_kibana")).toBe(true);
	});

	test("pushProjectScope: single shared project across pushable -> that project", () => {
		expect(pushProjectScope(mixed)).toBe("eu-oit.prd");
	});

	test("pushProjectScope: extra_in_kibana in a third project does NOT widen scope to fleet", () => {
		// The extra monitor is in eu-other.prd; if it counted, scope would be undefined.
		expect(pushProjectScope(mixed)).toBe("eu-oit.prd");
	});

	test("pushProjectScope: mixed pushable projects -> undefined (fleet-wide)", () => {
		const multi = report({
			drift: [
				{ project: "eu-oit.prd", monitorId: "a", monitorName: "a", category: "changed" },
				{ project: "eu-ediservices.prd", monitorId: "b", monitorName: "b", category: "missing_in_kibana" },
			],
		});
		expect(pushProjectScope(multi)).toBeUndefined();
	});

	test("pushableMonitors empty when only extra_in_kibana", () => {
		const extraOnly = report({
			drift: [{ project: "p", monitorId: "a", monitorName: "a", category: "extra_in_kibana" }],
		});
		expect(pushableMonitors(extraOnly)).toHaveLength(0);
	});
});

describe("hasPushableSyntheticsDrift (graph edge)", () => {
	test("true with changed/missing", () => {
		expect(
			hasPushableSyntheticsDrift(
				report({ drift: [{ project: "p", monitorId: "a", monitorName: "a", category: "changed" }] }),
			),
		).toBe(true);
	});
	test("false when only extra_in_kibana (surface-only)", () => {
		expect(
			hasPushableSyntheticsDrift(
				report({
					totals: { ...report({}).totals, extraInKibana: 1 },
					drift: [{ project: "p", monitorId: "a", monitorName: "a", category: "extra_in_kibana" }],
				}),
			),
		).toBe(false);
	});
	test("false when clean", () => {
		expect(hasPushableSyntheticsDrift(report({ hasActionableDrift: false }))).toBe(false);
	});
	test("false on planError", () => {
		expect(hasPushableSyntheticsDrift(report({ planError: true, planErrorReason: "boom" }))).toBe(false);
	});
	test("false on null report", () => {
		expect(hasPushableSyntheticsDrift(null)).toBe(false);
	});
});

describe("explainSyntheticsDrift", () => {
	test("groups all three categories with field diffs + surface-only + browser caveat", () => {
		const text = explainSyntheticsDrift(
			report({
				drift: [
					{
						project: "eu-oit.prd",
						monitorId: "a",
						monitorName: "OIT API",
						category: "changed",
						fields: [{ field: "name", source: "OIT", live: "Prana" }],
					},
					{ project: "eu-edi.prd", monitorId: "b", monitorName: "SFTP", category: "missing_in_kibana" },
					{ project: "eu-ss.dev", monitorId: "c", monitorName: "Kafka", category: "extra_in_kibana" },
				],
			}),
		);
		expect(text).toContain("Changed (1)");
		expect(text).toContain("name: Prana -> OIT");
		expect(text).toContain("Missing in Kibana (1)");
		expect(text).toContain("Extra in Kibana (1)");
		expect(text).toContain("SURFACE-ONLY");
		expect(text).toContain("browser (journey) monitors are not covered");
	});

	test("empty string when not actionable", () => {
		expect(explainSyntheticsDrift(report({ hasActionableDrift: false }))).toBe("");
	});
});

describe("formatSyntheticsSummary", () => {
	const state = (over: Partial<IacStateType>): IacStateType =>
		({ targetDeployment: "eu-b2b", syntheticsDriftReport: null, syntheticsPushResult: null, ...over }) as IacStateType;

	test("planError leads with the reason", () => {
		const r = report({ planError: true, planErrorReason: "state lock" });
		expect(formatSyntheticsSummary(state({ syntheticsDriftReport: r }))).toContain("state lock");
	});

	test("clean -> in sync + browser caveat", () => {
		const r = report({
			hasActionableDrift: false,
			totals: { ...report({}).totals, monitorsInSource: 81, projectsChecked: 10 },
		});
		const text = formatSyntheticsSummary(state({ syntheticsDriftReport: r }));
		expect(text).toContain("in sync");
		expect(text).toContain("81 monitor(s) checked");
		expect(text).toContain("browser");
	});

	test("only extra_in_kibana -> nothing to push", () => {
		const r = report({
			totals: { ...report({}).totals, extraInKibana: 2 },
			drift: [
				{ project: "p", monitorId: "a", monitorName: "a", category: "extra_in_kibana" },
				{ project: "p", monitorId: "b", monitorName: "b", category: "extra_in_kibana" },
			],
		});
		expect(formatSyntheticsSummary(state({ syntheticsDriftReport: r }))).toContain("Nothing to push");
	});

	test("declined push", () => {
		const r = report({ drift: [{ project: "p", monitorId: "a", monitorName: "a", category: "changed" }] });
		const text = formatSyntheticsSummary(
			state({ syntheticsDriftReport: r, syntheticsPushResult: { status: "skipped", pushedCount: 0 } }),
		);
		expect(text).toContain("Push declined");
	});

	test("pushed -> count + scope + pipeline", () => {
		const r = report({ drift: [{ project: "eu-oit.prd", monitorId: "a", monitorName: "a", category: "changed" }] });
		const text = formatSyntheticsSummary(
			state({
				syntheticsDriftReport: r,
				syntheticsPushResult: {
					status: "pushed",
					pushedCount: 1,
					project: "eu-oit.prd",
					pipelineId: 42,
					pipelineStatus: "success",
				},
			}),
		);
		expect(text).toContain("Pushed 1 monitor(s)");
		expect(text).toContain("project 'eu-oit.prd'");
		expect(text).toContain("Pipeline #42");
	});

	test("blocked/failed -> note", () => {
		const r = report({ drift: [{ project: "p", monitorId: "a", monitorName: "a", category: "changed" }] });
		const text = formatSyntheticsSummary(
			state({
				syntheticsDriftReport: r,
				syntheticsPushResult: { status: "blocked", pushedCount: 1, note: "lock held" },
			}),
		);
		expect(text).toContain("blocked");
		expect(text).toContain("lock held");
	});
});

describe("detectSyntheticsDrift (mocked tools)", () => {
	const okReport = JSON.stringify({
		deployment: "eu-b2b",
		kibana_url: "https://x.es.io:443",
		kibana_space: "dev",
		has_actionable_drift: true,
		totals: {
			projects_checked: 1,
			monitors_in_source: 2,
			monitors_in_kibana: 2,
			missing_in_kibana: 0,
			extra_in_kibana: 0,
			changed: 1,
		},
		drift: [{ project: "eu-oit.prd", monitor_id: "a", monitor_name: "a", category: "changed" }],
		reconcile_plan: { push_to_kibana: { command: "c", monitors: [] }, add_to_source: { action: "", monitors: [] } },
	});

	test("happy path: parses + returns a report (targetDeployment preset skips clarify)", async () => {
		mockTools({
			gitlab_trigger_synthetics_drift_check: () =>
				`[200] ${JSON.stringify({ deployment: "eu-b2b", pipelineId: 99, status: "created" })}`,
			gitlab_get_synthetics_drift_result: () =>
				`[200] ${JSON.stringify({ pipelineId: 99, jobId: 1, status: "success", report: okReport })}`,
		});
		const { detectSyntheticsDrift } = await import("./nodes.ts");
		const out = await detectSyntheticsDrift({ targetDeployment: "eu-b2b", messages: [] } as unknown as IacStateType);
		expect(out.targetDeployment).toBe("eu-b2b");
		expect(out.syntheticsDriftReport?.hasActionableDrift).toBe(true);
		expect(out.syntheticsDriftReport?.planError).toBeUndefined();
	});

	test("locked trigger -> planError report", async () => {
		mockTools({
			gitlab_trigger_synthetics_drift_check: () =>
				`[200] ${JSON.stringify({ deployment: "eu-b2b", pipelineId: null, status: "locked", note: "running" })}`,
		});
		const { detectSyntheticsDrift } = await import("./nodes.ts");
		const out = await detectSyntheticsDrift({ targetDeployment: "eu-b2b", messages: [] } as unknown as IacStateType);
		expect(out.syntheticsDriftReport?.planError).toBe(true);
		expect(out.syntheticsDriftReport?.planErrorReason).toContain("already running");
	});

	test("non-success poll -> planError report", async () => {
		mockTools({
			gitlab_trigger_synthetics_drift_check: () =>
				`[200] ${JSON.stringify({ deployment: "eu-b2b", pipelineId: 99, status: "created" })}`,
			gitlab_get_synthetics_drift_result: () =>
				`[200] ${JSON.stringify({ pipelineId: 99, status: "running", note: "still running" })}`,
		});
		const { detectSyntheticsDrift } = await import("./nodes.ts");
		const out = await detectSyntheticsDrift({ targetDeployment: "eu-b2b", messages: [] } as unknown as IacStateType);
		expect(out.syntheticsDriftReport?.planError).toBe(true);
	});
});

describe("pushSynthetics (mocked tools)", () => {
	const changedReport = report({
		drift: [{ project: "eu-oit.prd", monitorId: "a", monitorName: "a", category: "changed" }],
	});

	test("single-project scope passes PROJECT to the trigger", async () => {
		let captured: Record<string, unknown> = {};
		mockTools({
			gitlab_trigger_synthetics_push: (args) => {
				captured = args;
				return `[200] ${JSON.stringify({ deployment: "eu-b2b", project: "eu-oit.prd", pipelineId: 7, status: "created" })}`;
			},
			gitlab_get_synthetics_push_result: () =>
				`[200] ${JSON.stringify({ pipelineId: 7, jobId: 1, status: "success" })}`,
		});
		const { pushSynthetics } = await import("./nodes.ts");
		const out = await pushSynthetics({ syntheticsDriftReport: changedReport } as unknown as IacStateType);
		expect(captured.project).toBe("eu-oit.prd");
		expect(out.syntheticsPushResult?.status).toBe("pushed");
		expect(out.syntheticsPushResult?.project).toBe("eu-oit.prd");
	});

	test("fleet-wide (mixed projects) omits PROJECT", async () => {
		let captured: Record<string, unknown> = {};
		mockTools({
			gitlab_trigger_synthetics_push: (args) => {
				captured = args;
				return `[200] ${JSON.stringify({ deployment: "eu-b2b", project: null, pipelineId: 8, status: "created" })}`;
			},
			gitlab_get_synthetics_push_result: () => `[200] ${JSON.stringify({ pipelineId: 8, status: "success" })}`,
		});
		const fleet = report({
			drift: [
				{ project: "eu-oit.prd", monitorId: "a", monitorName: "a", category: "changed" },
				{ project: "eu-edi.prd", monitorId: "b", monitorName: "b", category: "missing_in_kibana" },
			],
		});
		const { pushSynthetics } = await import("./nodes.ts");
		const out = await pushSynthetics({ syntheticsDriftReport: fleet } as unknown as IacStateType);
		expect("project" in captured).toBe(false);
		expect(out.syntheticsPushResult?.status).toBe("pushed");
	});

	test("locked trigger -> blocked", async () => {
		mockTools({
			gitlab_trigger_synthetics_push: () =>
				`[200] ${JSON.stringify({ pipelineId: null, status: "locked", note: "running" })}`,
		});
		const { pushSynthetics } = await import("./nodes.ts");
		const out = await pushSynthetics({ syntheticsDriftReport: changedReport } as unknown as IacStateType);
		expect(out.syntheticsPushResult?.status).toBe("blocked");
	});

	test("failed push pipeline -> failed", async () => {
		mockTools({
			gitlab_trigger_synthetics_push: () => `[200] ${JSON.stringify({ pipelineId: 9, status: "created" })}`,
			gitlab_get_synthetics_push_result: () =>
				`[200] ${JSON.stringify({ pipelineId: 9, jobId: 1, status: "failed", failureLog: "boom" })}`,
		});
		const { pushSynthetics } = await import("./nodes.ts");
		const out = await pushSynthetics({ syntheticsDriftReport: changedReport } as unknown as IacStateType);
		expect(out.syntheticsPushResult?.status).toBe("failed");
	});
});
