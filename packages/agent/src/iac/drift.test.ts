// agent/src/iac/drift.test.ts
import { describe, expect, test } from "bun:test";
import {
	classifyStackByName,
	configStackFamily,
	driftFingerprint,
	extractLiveVersion,
	formatDriftSummary,
	isActionableDrift,
	parseAgentMrBySourceBranch,
	parseDriftCheckResult,
	parseDriftReport,
	parseEcDeploymentNames,
	parseRepoTreeDirs,
	parseTriggerResult,
	reconcileBranch,
} from "./nodes.ts";
import type { IacStateType } from "./state.ts";

// SIO-884: drift sub-flow pure helpers (GitLab + Elastic Cloud API; no local clone).

describe("parseRepoTreeDirs", () => {
	test("returns the tree (directory) names from a repo-tree response", () => {
		const body = `[200] ${JSON.stringify([
			{ id: "a", name: "deployments", type: "tree", path: "stacks/deployments" },
			{ id: "b", name: "lifecycle-policies", type: "tree", path: "stacks/lifecycle-policies" },
			{ id: "c", name: "README.md", type: "blob", path: "stacks/README.md" },
		])}`;
		expect(parseRepoTreeDirs(body)).toEqual(["deployments", "lifecycle-policies"]);
	});
	test("returns [] on a non-2xx / unparseable body", () => {
		expect(parseRepoTreeDirs("[404] not found")).toEqual([]);
	});
});

describe("parseEcDeploymentNames", () => {
	test("extracts deployment names from the EC list", () => {
		const body = `[200] ${JSON.stringify({ deployments: [{ name: "eu-b2b" }, { name: "us-cld" }] })}`;
		expect(parseEcDeploymentNames(body)).toEqual(["eu-b2b", "us-cld"]);
	});
});

describe("parseTriggerResult", () => {
	test("reads the pipeline id + status", () => {
		expect(
			parseTriggerResult(JSON.stringify({ stack: "x", deployment: "y", pipelineId: 42, status: "created" })),
		).toEqual({
			pipelineId: 42,
			status: "created",
			note: "",
		});
	});
	test("surfaces a lock with no pipeline id", () => {
		const r = parseTriggerResult(JSON.stringify({ pipelineId: null, status: "locked", note: "apply in progress" }));
		expect(r.pipelineId).toBeNull();
		expect(r.status).toBe("locked");
	});
});

describe("parseDriftCheckResult", () => {
	test("extracts the raw report text", () => {
		const r = parseDriftCheckResult(JSON.stringify({ status: "success", report: '{"resources":[]}' }));
		expect(r.status).toBe("success");
		expect(r.report).toBe('{"resources":[]}');
	});
});

describe("parseDriftReport + isActionableDrift", () => {
	const report = JSON.stringify({
		stack: "lifecycle-policies",
		deployment: "eu-b2b",
		resources: [
			{ address: "module.x.alerts", action: "update", category: "known-noise", noiseTag: "kibana-churn" },
			{ address: "module.x.real", action: "update", category: "substantive" },
			{ address: "module.x.noop", action: "no-op", category: "substantive" },
		],
	});

	test("parses every resource change", () => {
		expect(parseDriftReport(report)).toHaveLength(3);
	});

	test("known-noise and no-op are NOT actionable; the substantive update IS", () => {
		const actionable = parseDriftReport(report).filter(isActionableDrift);
		expect(actionable).toHaveLength(1);
		expect(actionable[0]?.address).toBe("module.x.real");
	});

	// The user's live result: eu-b2b lifecycle-policies has 1 change, but it's the
	// .alerts-ilm-policy tagged known-noise (kibana-churn) -> not real drift.
	test("the .alerts known-noise case yields no actionable drift", () => {
		const onlyNoise = JSON.stringify({
			resources: [
				{
					address: "module.lifecycle_policies.alerts-ilm-policy",
					action: "update",
					category: "known-noise",
					noiseTag: "kibana-churn",
				},
			],
		});
		expect(parseDriftReport(onlyNoise).filter(isActionableDrift)).toHaveLength(0);
	});

	test("returns [] for an empty / unparseable report", () => {
		expect(parseDriftReport("")).toEqual([]);
		expect(parseDriftReport("not json")).toEqual([]);
	});
});

describe("classifyStackByName (defaults)", () => {
	test("deployments -> config-json + liveReconcilable; lifecycle-policies -> config-json; others -> hcl", () => {
		const dep = classifyStackByName("deployments", "eu-b2b");
		expect(dep.kind).toBe("config-json");
		expect(dep.liveReconcilable).toBe(true);
		expect(dep.configPath).toContain("eu-b2b");

		const ilm = classifyStackByName("lifecycle-policies", "eu-b2b");
		expect(ilm.kind).toBe("config-json");
		expect(ilm.liveReconcilable).toBe(false);

		const hcl = classifyStackByName("templates", "eu-b2b");
		expect(hcl.kind).toBe("hcl");
		expect(hcl.liveReconcilable).toBe(false);
	});
});

describe("configStackFamily (defaults)", () => {
	test("maps the config-JSON stacks and treats the rest as HCL", () => {
		expect(configStackFamily("deployments")).toBe("deployment");
		expect(configStackFamily("lifecycle-policies")).toBe("ilm");
		expect(configStackFamily("templates")).toBeNull();
	});
});

describe("reconcileBranch", () => {
	test("is deterministic and DATE-FREE (idempotent across days)", () => {
		const a = reconcileBranch("eu-b2b", "templates", "reconcile-to-json");
		expect(reconcileBranch("eu-b2b", "templates", "reconcile-to-json")).toBe(a);
		expect(a).toBe("agent/reconcile-eu-b2b-templates-reconcile-to-json");
		expect(a).not.toMatch(/\d{8}/);
	});
	test("differs by direction", () => {
		expect(reconcileBranch("eu-b2b", "templates", "reconcile-to-live")).not.toBe(
			reconcileBranch("eu-b2b", "templates", "reconcile-to-json"),
		);
	});
});

describe("parseAgentMrBySourceBranch", () => {
	test("finds the web_url for a matching source branch", () => {
		const body = `[200] ${JSON.stringify([{ source_branch: "agent/reconcile-x", web_url: "https://gl/mr/1" }])}`;
		expect(parseAgentMrBySourceBranch(body, "agent/reconcile-x")).toBe("https://gl/mr/1");
	});
	test("returns empty when no branch matches", () => {
		expect(parseAgentMrBySourceBranch("[200] []", "agent/reconcile-x")).toBe("");
	});
});

describe("driftFingerprint", () => {
	test("is stable and order-independent", () => {
		const a = driftFingerprint({
			create: 0,
			update: 2,
			delete: 0,
			resources: [
				{ address: "b", actions: ["update"] },
				{ address: "a", actions: ["update"] },
			],
		});
		const b = driftFingerprint({
			create: 0,
			update: 2,
			delete: 0,
			resources: [
				{ address: "a", actions: ["update"] },
				{ address: "b", actions: ["update"] },
			],
		});
		expect(a).toBe(b);
	});
	test("changes when the drift changes", () => {
		expect(driftFingerprint({ create: 0, update: 1, delete: 0, resources: [] })).not.toBe(
			driftFingerprint({ create: 0, update: 2, delete: 0, resources: [] }),
		);
	});
});

describe("extractLiveVersion", () => {
	test("pulls the ES version from a deployment detail blob", () => {
		expect(extractLiveVersion('{"resources":{"elasticsearch":[{"info":{"version":"9.4.2"}}]}}')).toBe("9.4.2");
	});
	test("returns empty when absent", () => {
		expect(extractLiveVersion("{}")).toBe("");
	});
});

describe("formatDriftSummary", () => {
	const drifted = (over: Partial<IacStateType>): IacStateType =>
		({
			targetDeployment: "eu-b2b",
			driftReport: {
				deployment: "eu-b2b",
				generatedAt: "",
				stacks: [
					{
						stack: "templates",
						drifted: true,
						kind: "hcl",
						create: 0,
						update: 1,
						delete: 0,
						resources: [],
						liveReconcilable: false,
					},
					{
						stack: "deployments",
						drifted: true,
						kind: "config-json",
						create: 0,
						update: 1,
						delete: 0,
						resources: [],
						liveReconcilable: true,
					},
				],
			},
			reconcileResults: [],
			...over,
		}) as unknown as IacStateType;

	test("summarizes opened / skipped per stack", () => {
		const out = formatDriftSummary(
			drifted({
				reconcileResults: [
					{ stack: "templates", direction: "reconcile-to-json", status: "opened", mrUrl: "https://gl/mr/1" },
					{ stack: "deployments", direction: "skip", status: "skipped" },
				],
			}),
		);
		expect(out).toContain("Drift reconcile summary for eu-b2b");
		expect(out).toContain("templates: MR opened");
		expect(out).toContain("deployments: skipped");
	});

	test("reports no drift when nothing drifted", () => {
		const state = {
			targetDeployment: "eu-b2b",
			driftReport: {
				deployment: "eu-b2b",
				generatedAt: "",
				stacks: [
					{
						stack: "x",
						drifted: false,
						kind: "hcl",
						create: 0,
						update: 0,
						delete: 0,
						resources: [],
						liveReconcilable: false,
					},
				],
			},
			reconcileResults: [],
		} as unknown as IacStateType;
		expect(formatDriftSummary(state)).toContain("No drift detected");
	});

	test("surfaces plan-error stacks instead of falsely reporting them clean", () => {
		const state = {
			targetDeployment: "eu-b2b",
			driftReport: {
				deployment: "eu-b2b",
				generatedAt: "",
				stacks: [
					{
						stack: "ok",
						drifted: false,
						kind: "hcl",
						create: 0,
						update: 0,
						delete: 0,
						resources: [],
						liveReconcilable: false,
					},
					{
						stack: "broken",
						drifted: false,
						planError: true,
						kind: "hcl",
						create: 0,
						update: 0,
						delete: 0,
						resources: [],
						liveReconcilable: false,
					},
				],
			},
			reconcileResults: [],
		} as unknown as IacStateType;
		const out = formatDriftSummary(state);
		expect(out).toContain("could NOT be planned");
		expect(out).toContain("broken");
	});
});
