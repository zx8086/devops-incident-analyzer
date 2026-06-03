// agent/src/iac/drift.test.ts
import { describe, expect, test } from "bun:test";
import {
	classifyStackByName,
	configStackFamily,
	driftFingerprint,
	explainStackDrift,
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
	shortAddress,
} from "./nodes.ts";
import type { IacStateType, StackDrift } from "./state.ts";

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
		expect(r.failureLog).toBe("");
	});
	// SIO-887: a failed run returns the job trace tail for the explainer to classify.
	test("extracts the failureLog on a failed run", () => {
		const r = parseDriftCheckResult(
			JSON.stringify({ status: "failed", report: "", failureLog: "Error: Error acquiring the state lock" }),
		);
		expect(r.status).toBe("failed");
		expect(r.report).toBe("");
		expect(r.failureLog).toContain("state lock");
	});
});

describe("parseDriftReport + isActionableDrift", () => {
	// The user's live eu-b2b/lifecycle-policies result: 1 change, but it's .alerts-ilm-policy
	// tagged known-noise (kibana-churn) -> has_actionable_drift false.
	const onlyNoise = JSON.stringify({
		stack: "lifecycle-policies",
		deployment: "eu-b2b",
		totals: { noop: 34, create: 0, update: 0, destroy: 0, replace: 0, "known-noise": 1 },
		resources: [
			{
				address: 'module.lifecycle_policies.elasticstack_elasticsearch_index_lifecycle.this["alerts-ilm-policy"]',
				type: "elasticstack_elasticsearch_index_lifecycle",
				actions: ["update"],
				category: "known-noise",
				changedKeys: ["hot", "metadata", "modified_date"],
				reason: "kibana-churn: keys changed = hot, metadata, modified_date",
				noiseTag: "kibana-churn",
			},
		],
		has_actionable_drift: false,
	});

	// The us-cld/deployments version drift: has_actionable_drift true.
	const realDrift = JSON.stringify({
		stack: "deployments",
		deployment: "us-cld",
		totals: { noop: 9, create: 0, update: 1, destroy: 0, replace: 0, "known-noise": 0 },
		resources: [
			{
				address: 'module.deployments["us-cld"].ec_deployment.this',
				type: "ec_deployment",
				actions: ["update"],
				category: "update",
				changedKeys: ["version"],
				reason: "attributes changed: version",
			},
		],
		has_actionable_drift: true,
	});

	test("uses has_actionable_drift + totals (real drift)", () => {
		const p = parseDriftReport(realDrift);
		expect(p).not.toBeNull();
		expect(p?.hasActionableDrift).toBe(true);
		expect(p?.totals.update).toBe(1);
		expect(p?.resources).toHaveLength(1);
	});

	test("the .alerts known-noise case is NOT actionable", () => {
		const p = parseDriftReport(onlyNoise);
		expect(p?.hasActionableDrift).toBe(false);
		expect(p?.totals.knownNoise).toBe(1);
		expect(p?.resources.filter(isActionableDrift)).toHaveLength(0);
	});

	test("isActionableDrift excludes known-noise, includes real changes", () => {
		expect(
			isActionableDrift({ address: "a", category: "update", actions: ["update"], changedKeys: [], reason: "" }),
		).toBe(true);
		expect(
			isActionableDrift({ address: "a", category: "destroy", actions: ["delete"], changedKeys: [], reason: "" }),
		).toBe(true);
		expect(
			isActionableDrift({
				address: "a",
				category: "known-noise",
				actions: ["update"],
				changedKeys: [],
				reason: "",
				noiseTag: "kibana-churn",
			}),
		).toBe(false);
	});

	test("returns null for an empty / unparseable report", () => {
		expect(parseDriftReport("")).toBeNull();
		expect(parseDriftReport("not json")).toBeNull();
	});
});

describe("classifyStackByName (defaults)", () => {
	test("config-json stacks resolve a path; only the deployment family is reconcile-to-live capable", () => {
		const dep = classifyStackByName("deployments", "eu-b2b");
		expect(dep.kind).toBe("config-json");
		expect(dep.configPath).toContain("eu-b2b");
		// SIO-886: the deployment-config stack CAN reconcile-to-live (version); driftCheckStack
		// narrows this to true only when version actually drifted.
		expect(dep.liveReconcilable).toBe(true);

		// ILM stays reconcile-to-json + skip (live ES ILM JSON -> repo policy-file mapping deferred).
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

// SIO-886: drift explainer helpers.
describe("shortAddress", () => {
	test("drops the module wrapper, keeps type.name and the index key", () => {
		expect(shortAddress('module.deployments["us-cld"].ec_deployment.this')).toBe('ec_deployment.this ["us-cld"]');
		expect(
			shortAddress('module.lifecycle_policies.elasticstack_elasticsearch_index_lifecycle.this["alerts-ilm-policy"]'),
		).toBe('elasticstack_elasticsearch_index_lifecycle.this ["alerts-ilm-policy"]');
	});
	test("passes a bare address through", () => {
		expect(shortAddress("ec_deployment.this")).toBe("ec_deployment.this");
	});
});

describe("explainStackDrift", () => {
	const stack = (over: Partial<StackDrift>): StackDrift => ({
		stack: "deployments",
		drifted: true,
		kind: "config-json",
		create: 0,
		update: 1,
		delete: 0,
		liveReconcilable: true,
		resources: [
			{
				address: 'module.deployments["us-cld"].ec_deployment.this',
				actions: ["update"],
				reason: "attributes changed: version",
				changedKeys: ["version"],
				category: "update",
			},
		],
		...over,
	});

	test("builds a grounded summary from the reason/changed keys", () => {
		const out = explainStackDrift(stack({}));
		expect(out).toContain("0 create / 1 update / 0 destroy");
		expect(out).toContain("update ec_deployment.this");
		expect(out).toContain("attributes changed: version");
	});
	test("falls back to changed keys when no reason is present", () => {
		const out = explainStackDrift(
			stack({
				resources: [{ address: "ec_deployment.this", actions: ["update"], changedKeys: ["version", "region"] }],
			}),
		);
		expect(out).toContain("changed: version, region");
	});
	test("empty for a non-drifted or resource-less stack", () => {
		expect(explainStackDrift(stack({ drifted: false }))).toBe("");
		expect(explainStackDrift(stack({ resources: [] }))).toBe("");
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
