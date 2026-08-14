// agent/src/iac/drift.test.ts
import { describe, expect, mock, test } from "bun:test";
import {
	addressIndexKey,
	allStacksBlockedReason,
	applyReportChangesToConfig,
	applyReportValuesToConfig,
	classifyStackByName,
	configStackFamily,
	deploymentClarifyQuestion,
	detectLostIlmActions,
	driftFingerprint,
	elasticDeploymentNamesFromEnv,
	explainStackDrift,
	extractLiveTopology,
	extractLiveVersion,
	formatDriftSummary,
	formatLeafChange,
	ilmPolicyFromAddress,
	ilmRepoShapeToFile,
	isActionableDrift,
	liveIlmToRepoShape,
	matchDeploymentName,
	parseAgentMrBySourceBranch,
	parseDriftCheckResult,
	parseDriftReport,
	parseEcDeploymentList,
	parseEcDeploymentNames,
	parseLeafPath,
	parseRepoTreeDirs,
	parseTriggerResult,
	reconcileBranch,
	shortAddress,
} from "./nodes.ts";
import type { IacStateType, StackDrift } from "./state.ts";

// Build a fake tool set so callTool() inside nodes.ts resolves against our stubs.
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

// A StackDrift stub for the reconcile builders (only the fields they read).
function stackDrift(over: Partial<StackDrift>): StackDrift {
	return {
		stack: "deployments",
		drifted: true,
		kind: "config-json",
		create: 0,
		update: 1,
		delete: 0,
		resources: [],
		liveReconcilable: true,
		...over,
	};
}

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

// SIO-1463: a failed list call must be distinguishable from "org has no deployments" -- a dead
// EC_API_KEY previously collapsed into names:[] and surfaced as the generic deployment clarify.
describe("parseEcDeploymentList", () => {
	test("healthy 200 body yields names and no listError", () => {
		const body = `[200] ${JSON.stringify({ deployments: [{ name: "eu-b2b" }] })}`;
		expect(parseEcDeploymentList(body)).toEqual({ names: ["eu-b2b"] });
	});
	test("a 200 with no deployments key is an empty org, not an error", () => {
		expect(parseEcDeploymentList("[200] {}")).toEqual({ names: [] });
	});
	test("a 401 body flags authentication and points at EC_API_KEY", () => {
		const body =
			'[401] {"errors":[{"code":"root.unauthenticated","message":"The supplied authentication is invalid"}]}';
		const r = parseEcDeploymentList(body);
		expect(r.names).toEqual([]);
		expect(r.listError).toContain("401");
		expect(r.listError).toContain("EC_API_KEY");
	});
	test("a 5xx body flags the status without the auth hint", () => {
		const r = parseEcDeploymentList("[503] upstream unavailable");
		expect(r.listError).toContain("503");
		expect(r.listError).not.toContain("EC_API_KEY");
	});
	test("the not-configured placeholder from cloudFetch is an error", () => {
		const r = parseEcDeploymentList("[elastic cloud api key not configured: set EC_API_KEY]");
		expect(r.listError).toBe("EC_API_KEY not configured");
	});
	test("the fetch-threw placeholder from cloudFetch is an error", () => {
		const r = parseEcDeploymentList("[elastic cloud request failed: fetch failed]");
		expect(r.listError).toBe("Elastic Cloud API unreachable");
	});
	test("the callTool server-not-connected placeholder is an error", () => {
		const r = parseEcDeploymentList("[elastic_cloud_list_deployments unavailable - elastic-iac server not connected]");
		expect(r.listError).toBe("elastic-iac server not connected");
	});
	test("the callTool invoke-threw placeholder is an error", () => {
		const r = parseEcDeploymentList("[elastic_cloud_list_deployments error: socket hang up]");
		expect(r.listError).toBe("deployment list call failed");
	});
});

describe("deploymentClarifyQuestion (SIO-1463)", () => {
	const base = "Which deployment's Fleet agents should I upgrade? (e.g. eu-b2b)";
	test("no listError leaves the question unchanged", () => {
		expect(deploymentClarifyQuestion(base)).toBe(base);
	});
	test("a listError leads with the cause and keeps the question", () => {
		const q = deploymentClarifyQuestion(
			base,
			"HTTP 401 from the Elastic Cloud API -- authentication invalid; check EC_API_KEY",
		);
		expect(q).toContain("couldn't list Elastic Cloud deployments");
		expect(q).toContain("401");
		expect(q).toContain(base);
	});
	// SIO-1466: when the env fallback also missed, the clarify names the known deployments so it
	// is answerable without the live API.
	test("appends the known deployments when the env fallback also had no match", () => {
		const q = deploymentClarifyQuestion(base, "Elastic Cloud API unreachable", ["eu-cld", "us-cld"]);
		expect(q).toContain("Known deployments: eu-cld, us-cld.");
	});
	test("no known-deployments suffix when the fallback list is empty or absent", () => {
		expect(deploymentClarifyQuestion(base, "Elastic Cloud API unreachable", [])).not.toContain("Known deployments");
		expect(deploymentClarifyQuestion(base, "Elastic Cloud API unreachable")).not.toContain("Known deployments");
	});
	test("known deployments are only named alongside a listError", () => {
		expect(deploymentClarifyQuestion(base, undefined, ["eu-cld"])).toBe(base);
	});
});

// SIO-1466: the shared matcher behind resolveDriftDeployment (live list and env fallback).
describe("matchDeploymentName", () => {
	const names = ["eu-cld", "us-cld", "eu-b2b"];
	test("exact (case-insensitive) whole-query match wins", () => {
		expect(matchDeploymentName("eu-cld", names)).toBe("eu-cld");
		expect(matchDeploymentName("eu-cld", ["EU-CLD"])).toBe("EU-CLD");
		// Greptile PR #658 P1: the query is normalized INSIDE the helper -- a mixed-case caller
		// must resolve without pre-lowercasing.
		expect(matchDeploymentName("EU-CLD", names)).toBe("eu-cld");
		expect(matchDeploymentName("In the EU-CLD deployment, upgrade the agent", names)).toBe("eu-cld");
	});
	test("a name embedded in a longer message resolves when unique", () => {
		expect(matchDeploymentName("in the eu-cld deployment, upgrade the fleet elastic agent to 9.5.1", names)).toBe(
			"eu-cld",
		);
	});
	test("ambiguous partial (query contained in several names) resolves to nothing", () => {
		expect(matchDeploymentName("eu-b2b", ["eu-b2b-prod", "eu-b2b-stg"])).toBe("");
		expect(matchDeploymentName("cld", names)).toBe("");
	});
	test("no match and empty candidate list resolve to nothing", () => {
		expect(matchDeploymentName("check ap-cld for drift", names)).toBe("");
		expect(matchDeploymentName("eu-cld", [])).toBe("");
	});
	// Greptile PR #658 round-2 P1: n.includes("") is true for every name, so a blank query with a
	// single candidate silently selected that deployment the user never named.
	test("a blank query never matches, even against a sole candidate", () => {
		expect(matchDeploymentName("", ["eu-cld"])).toBe("");
		expect(matchDeploymentName("   ", ["eu-cld"])).toBe("");
	});
});

describe("elasticDeploymentNamesFromEnv (SIO-1466)", () => {
	test("returns the trimmed comma-separated names from ELASTIC_DEPLOYMENTS", () => {
		const prev = process.env.ELASTIC_DEPLOYMENTS;
		process.env.ELASTIC_DEPLOYMENTS = "eu-cld, us-cld ,eu-b2b";
		try {
			expect(elasticDeploymentNamesFromEnv()).toEqual(["eu-cld", "us-cld", "eu-b2b"]);
		} finally {
			if (prev === undefined) delete process.env.ELASTIC_DEPLOYMENTS;
			else process.env.ELASTIC_DEPLOYMENTS = prev;
		}
	});
	test("returns [] when the var is unset (no undefined sentinel leaks through)", () => {
		const prev = process.env.ELASTIC_DEPLOYMENTS;
		delete process.env.ELASTIC_DEPLOYMENTS;
		try {
			expect(elasticDeploymentNamesFromEnv()).toEqual([]);
		} finally {
			if (prev !== undefined) process.env.ELASTIC_DEPLOYMENTS = prev;
		}
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
		expect(r.stateLocked).toBe(false);
	});
	// SIO-904: the MCP's full-trace state-lock verdict is surfaced as a boolean.
	test("surfaces stateLocked from the MCP result", () => {
		const r = parseDriftCheckResult(
			JSON.stringify({ status: "failed", report: "", failureLog: "...tail without signature...", stateLocked: true }),
		);
		expect(r.stateLocked).toBe(true);
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

	// SIO-889: the agent-policies/eu-b2b live run -- name.before carries the live value (a
	// trailing space) the agent reconciles to; values keys are 1:1 with changedKeys.
	test("keeps the values field (before=live, after=declared) keyed by changedKeys", () => {
		const withValues = JSON.stringify({
			stack: "agent-policies",
			deployment: "eu-b2b",
			totals: { noop: 58, create: 0, update: 1, destroy: 0, replace: 0, "known-noise": 0 },
			has_actionable_drift: true,
			resources: [
				{
					address: 'module.agent_policies.elasticstack_fleet_agent_policy.this["eu-oit-prd"]',
					category: "update",
					actions: ["update"],
					changedKeys: ["name"],
					reason: "attributes changed: name",
					values: { name: { before: "eu-oit.prd - SM ", after: "eu-oit.prd - SM" } },
				},
			],
		});
		const p = parseDriftReport(withValues);
		expect(p?.resources[0]?.values).toEqual({
			name: { before: "eu-oit.prd - SM ", after: "eu-oit.prd - SM" },
		});
	});

	test("values is undefined when absent and preserves redaction sentinels", () => {
		expect(parseDriftReport(realDrift)?.resources[0]?.values).toBeUndefined();
		const redacted = JSON.stringify({
			has_actionable_drift: true,
			totals: { noop: 0, create: 0, update: 1, destroy: 0, replace: 0, "known-noise": 0 },
			resources: [
				{
					address: 'module.action_connectors.elasticstack_kibana_action_connector.this["slack"]',
					category: "update",
					actions: ["update"],
					changedKeys: ["secrets"],
					reason: "attributes changed: secrets",
					values: { secrets: { before: "<redacted:sensitive>", after: "<redacted:sensitive>" } },
				},
			],
		});
		expect(parseDriftReport(redacted)?.resources[0]?.values?.secrets?.before).toBe("<redacted:sensitive>");
	});
});

describe("classifyStackByName (defaults)", () => {
	test("deployment + ilm are config-json/live-reconcilable; every other stack is report-sourced by default", () => {
		const dep = classifyStackByName("deployments", "eu-b2b");
		expect(dep.kind).toBe("config-json");
		expect(dep.configPath).toContain("eu-b2b");
		expect(dep.liveReconcilable).toBe(true);

		const ilm = classifyStackByName("lifecycle-policies", "eu-b2b");
		expect(ilm.kind).toBe("config-json");
		expect(ilm.liveReconcilable).toBe(true);

		// SIO-890: an arbitrary stack is report-sourced by DEFAULT (no allowlist) -> config-json +
		// live-reconcilable static capability; driftCheckStack narrows it to drift with writable values.
		const arbitrary = classifyStackByName("templates", "eu-b2b");
		expect(arbitrary.kind).toBe("config-json");
		expect(arbitrary.liveReconcilable).toBe(true);
	});

	test("SIO-890: an excluded stack is unwired (no reconcile-to-live)", () => {
		process.env.ELASTIC_IAC_REPORT_STACKS_EXCLUDE = "templates";
		try {
			const excluded = classifyStackByName("templates", "eu-b2b");
			expect(excluded.kind).toBe("unwired");
			expect(excluded.liveReconcilable).toBe(false);
		} finally {
			delete process.env.ELASTIC_IAC_REPORT_STACKS_EXCLUDE;
		}
	});
});

describe("configStackFamily (defaults)", () => {
	test("deployment/ilm map by name; every other stack is its own report-sourced family by default", () => {
		expect(configStackFamily("deployments")).toBe("deployment");
		expect(configStackFamily("lifecycle-policies")).toBe("ilm");
		expect(configStackFamily("alerting")).toBe("alerting");
	});

	test("SIO-890: an excluded stack has no family", () => {
		process.env.ELASTIC_IAC_REPORT_STACKS_EXCLUDE = "alerting";
		try {
			expect(configStackFamily("alerting")).toBeNull();
		} finally {
			delete process.env.ELASTIC_IAC_REPORT_STACKS_EXCLUDE;
		}
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
						kind: "unwired",
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
						kind: "unwired",
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
						kind: "unwired",
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
						kind: "unwired",
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

	// SIO-892: when every stack failed with the same GitLab permission wall, lead with the
	// infra blocker instead of the "No drift detected" headline.
	test("leads with the GitLab-permissions blocker when all stacks are permission-blocked", () => {
		const stack = (name: string): StackDrift => ({
			stack: name,
			drifted: false,
			planError: true,
			planErrorReason:
				"Could not trigger the drift-check: [400] You do not have sufficient permission to run a pipeline on 'main'.",
			kind: "config-json",
			create: 0,
			update: 0,
			delete: 0,
			resources: [],
			liveReconcilable: false,
		});
		const state = {
			targetDeployment: "eu-b2b",
			driftReport: { deployment: "eu-b2b", generatedAt: "", stacks: [stack("a"), stack("b"), stack("c")] },
			reconcileResults: [],
		} as unknown as IacStateType;
		const out = formatDriftSummary(state);
		expect(out).toContain("GitLab denied pipeline creation on 'main' for all 3 stack(s)");
		expect(out).toContain("Maintainer role");
		expect(out).not.toContain("No drift detected");
	});
});

describe("allStacksBlockedReason", () => {
	const permErr = (name: string): StackDrift => ({
		stack: name,
		drifted: false,
		planError: true,
		planErrorReason: "Could not trigger the drift-check: insufficient permission to run a pipeline on 'main'.",
		kind: "config-json",
		create: 0,
		update: 0,
		delete: 0,
		resources: [],
		liveReconcilable: false,
	});
	const stateLockErr = (name: string): StackDrift => ({
		...permErr(name),
		planErrorReason: "Apply in progress (state lock); re-check once it clears.",
	});
	const clean = (name: string): StackDrift => ({
		stack: name,
		drifted: false,
		kind: "config-json",
		create: 0,
		update: 0,
		delete: 0,
		resources: [],
		liveReconcilable: false,
	});

	test("returns a blocker when every stack is permission-blocked", () => {
		const out = allStacksBlockedReason("eu-b2b", [permErr("a"), permErr("b")]);
		expect(out).toContain("all 2 stack(s)");
		expect(out).toContain("Maintainer role");
	});

	test("null when some stacks were assessed (mixed)", () => {
		expect(allStacksBlockedReason("eu-b2b", [permErr("a"), clean("b")])).toBeNull();
	});

	test("null when all errored but the cause is not permission (state lock)", () => {
		expect(allStacksBlockedReason("eu-b2b", [stateLockErr("a"), stateLockErr("b")])).toBeNull();
	});

	test("null for an empty stack list", () => {
		expect(allStacksBlockedReason("eu-b2b", [])).toBeNull();
	});
});

// reconcile-to-live: deployment tier topology extraction from the live EC deployment GET.
describe("extractLiveTopology", () => {
	const body = `[200] ${JSON.stringify({
		resources: {
			elasticsearch: [
				{
					info: {
						plan_info: {
							current: {
								plan: {
									cluster_topology: [
										{ id: "hot_content", size: { value: 8192, resource: "memory" }, zone_count: 2 },
										{ id: "warm", size: { value: 15360, resource: "memory" }, zone_count: 1 },
									],
								},
							},
						},
					},
				},
			],
		},
	})}`;

	test("maps EC node-role ids -> repo tier keys and MB-RAM -> GB", () => {
		const topo = extractLiveTopology(body);
		expect(topo.hot).toEqual({ sizeGb: 8, zoneCount: 2 }); // hot_content -> hot
		expect(topo.warm).toEqual({ sizeGb: 15, zoneCount: 1 });
	});

	test("returns {} when the body has no topology / is unparseable", () => {
		expect(extractLiveTopology("[200] {}")).toEqual({});
		expect(extractLiveTopology("not json")).toEqual({});
	});

	test("skips an element with no id and ignores non-memory size", () => {
		const b = `[200] ${JSON.stringify({
			resources: {
				elasticsearch: [
					{
						info: {
							plan_info: {
								current: {
									plan: {
										cluster_topology: [
											{ size: { value: 4096, resource: "memory" } }, // no id -> skipped
											{ id: "cold", size: { value: 2, resource: "storage" }, zone_count: 1 }, // non-memory size ignored
										],
									},
								},
							},
						},
					},
				],
			},
		})}`;
		expect(extractLiveTopology(b)).toEqual({ cold: { zoneCount: 1 } });
	});
});

describe("ilmPolicyFromAddress", () => {
	test("extracts the policy name from the trailing index key", () => {
		expect(
			ilmPolicyFromAddress(
				'module.lifecycle_policies.elasticstack_elasticsearch_index_lifecycle.this["alerts-ilm-policy"]',
			),
		).toBe("alerts-ilm-policy");
	});
	test("preserves @ and . in the policy name", () => {
		expect(ilmPolicyFromAddress('module.x.this["90-days@lifecycle"]')).toBe("90-days@lifecycle");
	});
	test("returns empty for an address with no index key", () => {
		expect(ilmPolicyFromAddress("ec_deployment.this")).toBe("");
	});
});

describe("liveIlmToRepoShape", () => {
	const live = `[200] ${JSON.stringify({
		"90-days@lifecycle": {
			version: 3,
			modified_date: "2026-01-01",
			policy: {
				phases: {
					hot: {
						min_age: "0ms",
						actions: {
							rollover: { max_age: "30d", max_primary_shard_size: "50gb", min_docs: 1 },
							set_priority: { priority: 100 },
						},
					},
					warm: { min_age: "2d", actions: { forcemerge: { max_num_segments: 1 }, set_priority: { priority: 50 } } },
					delete: { min_age: "90d", actions: { delete: { delete_searchable_snapshot: true } } },
				},
			},
		},
	})}`;

	test("projects live phases onto the repo flattened shape", () => {
		expect(liveIlmToRepoShape(live, "90-days@lifecycle")).toEqual({
			name: "90-days@lifecycle",
			hot: { rollover: true, max_age: "30d", max_primary_shard_size: "50gb", min_docs: 1 },
			warm: { min_age: "2d", forcemerge: { max_num_segments: 1 } },
			delete: { min_age: "90d", delete_searchable_snapshot: true },
		});
	});

	test("drops hot min_age (0ms) and unmodeled set_priority", () => {
		const shape = liveIlmToRepoShape(live, "90-days@lifecycle") as Record<string, Record<string, unknown>>;
		expect(shape.hot?.min_age).toBeUndefined();
		expect(shape.hot?.set_priority).toBeUndefined();
		expect(shape.warm?.set_priority).toBeUndefined();
	});

	test("null on a missing policy key / unparseable body", () => {
		expect(liveIlmToRepoShape(live, "no-such-policy")).toBeNull();
		expect(liveIlmToRepoShape("[404] not found", "x")).toBeNull();
	});
});

describe("ilmRepoShapeToFile", () => {
	test("serializes with 2-space indent and a trailing newline", () => {
		const out = ilmRepoShapeToFile({ name: "x", delete: { min_age: "90d" } });
		expect(out.endsWith("}\n")).toBe(true);
		expect(out).toContain('\n  "delete": {');
	});
});

describe("detectLostIlmActions", () => {
	test("lists live action keys the repo file shape can't represent (sorted, deduped)", () => {
		const live = `[200] ${JSON.stringify({
			p: {
				policy: {
					phases: {
						hot: { actions: { rollover: {}, set_priority: { priority: 100 } } },
						warm: { actions: { allocate: { number_of_replicas: 1 }, forcemerge: {}, set_priority: {} } },
					},
				},
			},
		})}`;
		expect(detectLostIlmActions(live)).toEqual(["allocate", "set_priority"]);
	});
	test("empty when only modeled actions are present, and on an unparseable body", () => {
		const live = `[200] ${JSON.stringify({ p: { policy: { phases: { delete: { actions: { delete: {} } } } } } })}`;
		expect(detectLostIlmActions(live)).toEqual([]);
		expect(detectLostIlmActions("nope")).toEqual([]);
	});
});

// Build the reconcile-to-live change through mocked tools (the proven pattern: mock mcp-bridge,
// then dynamic-import the flow function so callTool resolves against the stubs).
const b64 = (s: string) =>
	`[200] ${JSON.stringify({ content: Buffer.from(s).toString("base64"), encoding: "base64" })}`;

describe("buildLiveReconcile — deployment family", () => {
	const ecList = `[200] ${JSON.stringify({ deployments: [{ id: "dep-1", name: "eu-b2b" }] })}`;

	test("version drift: writes the live version into the per-deployment JSON", async () => {
		mockTools({
			elastic_cloud_list_deployments: () => ecList,
			elastic_cloud_get_deployment: () =>
				`[200] ${JSON.stringify({ resources: { elasticsearch: [{ info: { version: "9.4.2" } }] } })}`,
			gitlab_get_file_content: () => b64(`${JSON.stringify({ name: "eu-b2b", version: "9.4.1" }, null, 2)}\n`),
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "deployments",
				configPath: "environments/_deployments/eu-b2b.json",
				resources: [
					{ address: 'module.deployments["eu-b2b"].ec_deployment.this', actions: ["update"], changedKeys: ["version"] },
				],
			}),
		);
		expect("files" in built).toBe(true);
		if ("files" in built) {
			expect(built.files).toHaveLength(1);
			expect(built.files[0]?.path).toBe("environments/_deployments/eu-b2b.json");
			expect(JSON.parse(built.files[0]?.content ?? "{}").version).toBe("9.4.2");
			expect(built.summary).toContain("version 9.4.1 -> 9.4.2");
		}
	});

	test("elasticsearch drift: writes live tier max_size + zone_count, leaves current size", async () => {
		mockTools({
			elastic_cloud_list_deployments: () => ecList,
			elastic_cloud_get_deployment: () =>
				`[200] ${JSON.stringify({
					resources: {
						elasticsearch: [
							{
								info: {
									plan_info: {
										current: {
											plan: {
												cluster_topology: [{ id: "warm", size: { value: 8192, resource: "memory" }, zone_count: 3 }],
											},
										},
									},
								},
							},
						],
					},
				})}`,
			gitlab_get_file_content: () =>
				b64(
					`${JSON.stringify({ name: "eu-b2b", elasticsearch: { warm: { size: "8g", max_size: "15g", zone_count: 2 } } }, null, 2)}\n`,
				),
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "deployments",
				configPath: "environments/_deployments/eu-b2b.json",
				resources: [
					{
						address: 'module.deployments["eu-b2b"].ec_deployment.this',
						actions: ["update"],
						changedKeys: ["elasticsearch"],
					},
				],
			}),
		);
		expect("files" in built).toBe(true);
		if ("files" in built) {
			const p = JSON.parse(built.files[0]?.content ?? "{}");
			expect(p.elasticsearch.warm.max_size).toBe("8g"); // 8192MB -> 8g
			expect(p.elasticsearch.warm.zone_count).toBe(3);
			expect(p.elasticsearch.warm.size).toBe("8g"); // current size untouched
			expect(built.summary).toContain("warm");
		}
	});

	test("empty-diff guard: blocks when live already matches the repo", async () => {
		const repo = `${JSON.stringify({ name: "eu-b2b", version: "9.4.1" }, null, 2)}\n`;
		mockTools({
			elastic_cloud_list_deployments: () => ecList,
			elastic_cloud_get_deployment: () =>
				`[200] ${JSON.stringify({ resources: { elasticsearch: [{ info: { version: "9.4.1" } }] } })}`,
			gitlab_get_file_content: () => b64(repo),
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "deployments",
				configPath: "environments/_deployments/eu-b2b.json",
				resources: [{ address: "x", actions: ["update"], changedKeys: ["version"] }],
			}),
		);
		expect("blocked" in built).toBe(true);
		if ("blocked" in built) expect(built.blocked).toContain("already matches live");
	});
});

describe("buildLiveReconcile — ilm family", () => {
	const ilmAddr = (p: string) => `module.lifecycle_policies.elasticstack_elasticsearch_index_lifecycle.this["${p}"]`;

	test("rewrites the policy file from the live ILM policy", async () => {
		const live = `[200] ${JSON.stringify({
			"90-days@lifecycle": {
				policy: { phases: { delete: { min_age: "90d", actions: { delete: { delete_searchable_snapshot: true } } } } },
			},
		})}`;
		mockTools({
			elastic_ilm_get_lifecycle: () => live,
			gitlab_get_file_content: () =>
				b64(`${JSON.stringify({ name: "90-days@lifecycle", delete: { min_age: "30d" } }, null, 2)}\n`),
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "lifecycle-policies",
				resources: [{ address: ilmAddr("90-days@lifecycle"), actions: ["update"], changedKeys: ["delete"] }],
			}),
		);
		expect("files" in built).toBe(true);
		if ("files" in built) {
			expect(built.files[0]?.path).toBe("environments/eu-b2b/lifecycle-policies/90-days@lifecycle.json");
			const p = JSON.parse(built.files[0]?.content ?? "{}");
			expect(p.delete.min_age).toBe("90d");
			expect(p.delete.delete_searchable_snapshot).toBe(true);
		}
	});

	test("blocks when the live cluster read is not authoritative (e.g. cluster not configured)", async () => {
		mockTools({
			elastic_ilm_get_lifecycle: () => "[cluster 'eu-b2b' not configured: set ELASTIC_DEPLOYMENTS + ELASTIC_<ID>_URL]",
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "lifecycle-policies",
				resources: [{ address: ilmAddr("logs"), actions: ["update"], changedKeys: ["hot"] }],
			}),
		);
		expect("blocked" in built).toBe(true);
		if ("blocked" in built) expect(built.blocked).toContain("Could not read live ILM policy");
	});

	test("empty-diff guard: blocks when the repo file already matches live", async () => {
		const live = `[200] ${JSON.stringify({ logs: { policy: { phases: { delete: { min_age: "90d", actions: {} } } } } })}`;
		const matching = ilmRepoShapeToFile({ name: "logs", delete: { min_age: "90d" } });
		mockTools({
			elastic_ilm_get_lifecycle: () => live,
			gitlab_get_file_content: () => b64(matching),
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "lifecycle-policies",
				resources: [{ address: ilmAddr("logs"), actions: ["update"], changedKeys: ["delete"] }],
			}),
		);
		expect("blocked" in built).toBe(true);
		if ("blocked" in built) expect(built.blocked).toContain("already match");
	});
});

describe("addressIndexKey", () => {
	test("extracts the last bracket key, unquoted; empty when none", () => {
		expect(addressIndexKey('module.agent_policies.elasticstack_fleet_agent_policy.this["eu-oit-prd"]')).toBe(
			"eu-oit-prd",
		);
		expect(addressIndexKey("module.x.this")).toBe("");
	});
});

describe("applyReportValuesToConfig (SIO-889 Approach-B projection)", () => {
	const file = `${JSON.stringify({ name: "old", namespace: "prd", count: 1 }, null, 2)}\n`;

	test("writes live before-values into top-level keys; lists applied; trailing newline", () => {
		const r = applyReportValuesToConfig(file, {
			name: { before: "new", after: "old" },
			count: { before: 3, after: 1 },
		});
		expect(r.applied.sort()).toEqual(["count", "name"]);
		expect(JSON.parse(r.content)).toEqual({ name: "new", namespace: "prd", count: 3 });
		expect(r.content.endsWith("}\n")).toBe(true);
	});

	test("skips redaction/oversize sentinels and undefined before (never writes a sentinel)", () => {
		const r = applyReportValuesToConfig(file, {
			name: { before: "<redacted:sensitive>" },
			namespace: { before: "<omitted:too-large>" },
			count: { after: 5 },
		});
		expect(r.applied).toEqual([]);
		expect(JSON.parse(r.content)).toEqual({ name: "old", namespace: "prd", count: 1 });
	});

	test("per-key empty-diff: a key already equal to live is not applied", () => {
		expect(applyReportValuesToConfig(file, { name: { before: "old" } }).applied).toEqual([]);
	});

	test("throws on unparseable JSON", () => {
		expect(() => applyReportValuesToConfig("not json", { a: { before: 1 } })).toThrow();
	});
});

// SIO-1315: agent-policies moved to the nested (composite-key) family; the generic
// report-sourced family is exercised with a per-key stack (dataviews).
describe("buildLiveReconcile — report-sourced family (per-key stacks)", () => {
	test("writes the live before-value into the per-resource config file (top-level key)", async () => {
		mockTools({
			gitlab_get_file_content: () => b64(`${JSON.stringify({ name: "eu-oit.prd - SM", namespace: "prd" }, null, 2)}\n`),
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "dataviews",
				configPath: "environments/eu-b2b/dataviews",
				resources: [
					{
						address: 'module.agent_policies.elasticstack_fleet_agent_policy.this["eu-oit-prd"]',
						actions: ["update"],
						category: "update",
						changedKeys: ["name"],
						values: { name: { before: "eu-oit.prd - SM ", after: "eu-oit.prd - SM" } },
					},
				],
			}),
		);
		expect("files" in built).toBe(true);
		if ("files" in built) {
			expect(built.files).toHaveLength(1);
			expect(built.files[0]?.path).toBe("environments/eu-b2b/dataviews/eu-oit-prd.json");
			expect(JSON.parse(built.files[0]?.content ?? "{}").name).toBe("eu-oit.prd - SM ");
			expect(built.summary).toContain("eu-oit-prd: name");
		}
	});

	test("blocks when the only drift is a redacted secret (never writes the sentinel)", async () => {
		mockTools({
			gitlab_get_file_content: () => b64(`${JSON.stringify({ name: "x", secrets: "real" }, null, 2)}\n`),
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "dataviews",
				resources: [
					{
						address: 'module.agent_policies.elasticstack_fleet_agent_policy.this["p1"]',
						actions: ["update"],
						category: "update",
						changedKeys: ["secrets"],
						values: { secrets: { before: "<redacted:sensitive>", after: "<redacted:sensitive>" } },
					},
				],
			}),
		);
		expect("blocked" in built).toBe(true);
	});
});

// SIO-900: Increment 2 -- leaf-level changes[] parsing, path projection, explainer, and formatter.
describe("parseDriftReport changes[] (SIO-900)", () => {
	test("keeps changes[] + changeCount; drops truncated:false", () => {
		const withChanges = JSON.stringify({
			has_actionable_drift: true,
			totals: { noop: 0, create: 0, update: 1, destroy: 0, replace: 0, "known-noise": 0 },
			resources: [
				{
					address: 'module.agent_policies.elasticstack_fleet_integration_policy.this["k8s"]',
					category: "update",
					actions: ["update"],
					changedKeys: ["inputs"],
					changeCount: 1,
					truncated: false,
					changes: [{ path: 'inputs["kubelet/metrics"].period', op: "update", before: "10s", after: "30s" }],
				},
			],
		});
		const r = parseDriftReport(withChanges)?.resources[0];
		expect(r?.changes).toEqual([
			{ path: 'inputs["kubelet/metrics"].period', op: "update", before: "10s", after: "30s" },
		]);
		expect(r?.changeCount).toBe(1);
		expect(r?.truncated).toBeUndefined();
	});

	test("sets truncated when the report flags it", () => {
		const t = JSON.stringify({
			has_actionable_drift: true,
			totals: { noop: 0, create: 0, update: 1, destroy: 0, replace: 0, "known-noise": 0 },
			resources: [
				{
					address: "a",
					category: "update",
					actions: ["update"],
					changedKeys: ["x"],
					changeCount: 51,
					truncated: true,
					changes: [{ path: "x.y", op: "update", before: 1, after: 2 }],
				},
			],
		});
		const r = parseDriftReport(t)?.resources[0];
		expect(r?.truncated).toBe(true);
		expect(r?.changeCount).toBe(51);
	});

	test("drops malformed change entries (no path / bad op) -> changes undefined; tolerates absence", () => {
		const m = JSON.stringify({
			has_actionable_drift: true,
			totals: { noop: 0, create: 0, update: 1, destroy: 0, replace: 0, "known-noise": 0 },
			resources: [
				{
					address: "a",
					category: "update",
					actions: ["update"],
					changedKeys: ["x"],
					changes: [{ op: "update" }, { path: "x", op: "nope" }],
				},
			],
		});
		expect(parseDriftReport(m)?.resources[0]?.changes).toBeUndefined();
		const noChanges = JSON.stringify({
			has_actionable_drift: true,
			totals: { noop: 0, create: 0, update: 1, destroy: 0, replace: 0, "known-noise": 0 },
			resources: [{ address: "a", category: "update", actions: ["update"], changedKeys: ["version"] }],
		});
		expect(parseDriftReport(noChanges)?.resources[0]?.changes).toBeUndefined();
	});
});

describe("parseLeafPath", () => {
	test("dot notation -> key segments", () => {
		expect(parseLeafPath("policy.hot.actions.rollover.max_age")).toEqual([
			{ kind: "key", key: "policy" },
			{ kind: "key", key: "hot" },
			{ kind: "key", key: "actions" },
			{ kind: "key", key: "rollover" },
			{ kind: "key", key: "max_age" },
		]);
	});
	test("identity-bracket notation -> id segment", () => {
		expect(parseLeafPath('inputs["kubelet/metrics"].period')).toEqual([
			{ kind: "key", key: "inputs" },
			{ kind: "id", id: "kubelet/metrics" },
			{ kind: "key", key: "period" },
		]);
	});
	test("numeric index -> index segment; empty path -> []", () => {
		expect(parseLeafPath("tags[0].value")).toEqual([
			{ kind: "key", key: "tags" },
			{ kind: "index", index: 0 },
			{ kind: "key", key: "value" },
		]);
		expect(parseLeafPath("")).toEqual([]);
	});
});

describe("applyReportChangesToConfig (SIO-900 path projection)", () => {
	const file = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;

	test("update: writes the live before at a nested object path", () => {
		const r = applyReportChangesToConfig(file({ policy: { hot: { rollover: { max_age: "14d" } } } }), [
			{ path: "policy.hot.rollover.max_age", op: "update", before: "30d", after: "14d" },
		]);
		expect(r.applied).toEqual(["policy.hot.rollover.max_age"]);
		expect(JSON.parse(r.content).policy.hot.rollover.max_age).toBe("30d");
	});

	test("update: resolves an identity-keyed array element and writes the leaf, leaving siblings", () => {
		const r = applyReportChangesToConfig(
			file({
				inputs: [
					{ name: "kubelet/metrics", period: "30s" },
					{ name: "other", period: "1m" },
				],
			}),
			[{ path: 'inputs["kubelet/metrics"].period', op: "update", before: "10s", after: "30s" }],
		);
		expect(r.applied).toEqual(['inputs["kubelet/metrics"].period']);
		const inputs = JSON.parse(r.content).inputs;
		expect(inputs[0].period).toBe("10s");
		expect(inputs[1].period).toBe("1m");
	});

	test("remove: re-adds a live-only array element", () => {
		const r = applyReportChangesToConfig(file({ inputs: [{ name: "keep" }] }), [
			{ path: 'inputs["audit-logs"]', op: "remove", before: { name: "audit-logs", enabled: true } },
		]);
		expect(r.applied).toEqual(['inputs["audit-logs"]']);
		expect(JSON.parse(r.content).inputs).toHaveLength(2);
	});

	test("add: deletes a declared-only leaf", () => {
		const r = applyReportChangesToConfig(file({ inputs: [{ name: "x", enabled: false, extra: 1 }] }), [
			{ path: 'inputs["x"].extra', op: "add", after: 1 },
		]);
		expect(r.applied).toEqual(['inputs["x"].extra']);
		expect(JSON.parse(r.content).inputs[0]).toEqual({ name: "x", enabled: false });
	});

	test("skips redaction/oversize sentinels and unstableIndex paths; never writes them", () => {
		const r = applyReportChangesToConfig(file({ secret: "real", tags: [{ value: "a" }] }), [
			{ path: "secret", op: "update", before: "<redacted:sensitive>", after: "<redacted:sensitive>" },
			{ path: "tags[0].value", op: "update", before: "b", after: "a", unstableIndex: true },
		]);
		expect(r.applied).toEqual([]);
		expect(JSON.parse(r.content)).toEqual({ secret: "real", tags: [{ value: "a" }] });
	});

	test("per-leaf empty-diff: a leaf already equal to live is not applied", () => {
		const r = applyReportChangesToConfig(file({ a: { b: "x" } }), [
			{ path: "a.b", op: "update", before: "x", after: "y" },
		]);
		expect(r.applied).toEqual([]);
	});

	test("skips a path that does not resolve (never synthesizes structure)", () => {
		const r = applyReportChangesToConfig(file({ a: 1 }), [
			{ path: 'b["missing"].c', op: "update", before: 9, after: 8 },
		]);
		expect(r.applied).toEqual([]);
		expect(JSON.parse(r.content)).toEqual({ a: 1 });
	});

	test("throws on unparseable JSON", () => {
		expect(() => applyReportChangesToConfig("not json", [{ path: "a", op: "update", before: 1 }])).toThrow();
	});
});

describe("formatLeafChange", () => {
	test("update shows live -> declared", () => {
		expect(formatLeafChange({ path: "schedule.interval", op: "update", before: "10m", after: "5m" })).toBe(
			"~ schedule.interval: 10m -> 5m",
		);
	});
	test("add shows declared; remove shows live", () => {
		expect(formatLeafChange({ path: "x", op: "add", after: 1 })).toBe("+ x = 1");
		expect(formatLeafChange({ path: 'inputs["a"]', op: "remove", before: { n: 1 } })).toBe(
			'- inputs["a"] (live: {"n":1})',
		);
	});
	test("renders sentinels as short labels, never the raw secret", () => {
		const out = formatLeafChange({
			path: "secrets.token",
			op: "update",
			before: "<redacted:sensitive>",
			after: "<redacted:sensitive>",
		});
		expect(out).toContain("<redacted>");
		expect(out).not.toContain("sensitive");
	});
});

describe("explainStackDrift with changes[] (SIO-900)", () => {
	test("expands leaf-level changes and notes 'and N more' when capped", () => {
		const out = explainStackDrift({
			stack: "dataviews",
			drifted: true,
			kind: "config-json",
			create: 0,
			update: 1,
			delete: 0,
			liveReconcilable: true,
			resources: [
				{
					address: 'module.agent_policies.elasticstack_fleet_integration_policy.this["k8s"]',
					actions: ["update"],
					category: "update",
					changedKeys: ["inputs"],
					changeCount: 5,
					truncated: true,
					changes: [
						{ path: 'inputs["kubelet/metrics"].period', op: "update", before: "10s", after: "30s" },
						{ path: 'inputs["audit-logs"]', op: "remove", before: { name: "audit-logs" } },
					],
				},
			],
		});
		expect(out).toContain("(5 changes)");
		expect(out).toContain('~ inputs["kubelet/metrics"].period: 10s -> 30s');
		expect(out).toContain("...and 3 more change(s)");
	});
});

describe("buildLiveReconcile — report-sourced via changes[] (SIO-900)", () => {
	test("writes the live before at a nested identity-keyed leaf path", async () => {
		mockTools({
			gitlab_get_file_content: () =>
				b64(`${JSON.stringify({ name: "k8s", inputs: [{ name: "kubelet/metrics", period: "30s" }] }, null, 2)}\n`),
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "dataviews",
				configPath: "environments/eu-b2b/dataviews",
				resources: [
					{
						address: 'module.agent_policies.elasticstack_fleet_integration_policy.this["k8s"]',
						actions: ["update"],
						category: "update",
						changedKeys: ["inputs"],
						changeCount: 1,
						changes: [{ path: 'inputs["kubelet/metrics"].period', op: "update", before: "10s", after: "30s" }],
					},
				],
			}),
		);
		expect("files" in built).toBe(true);
		if ("files" in built) {
			expect(built.files[0]?.path).toBe("environments/eu-b2b/dataviews/k8s.json");
			expect(JSON.parse(built.files[0]?.content ?? "{}").inputs[0].period).toBe("10s");
			expect(built.summary).toContain('k8s: inputs["kubelet/metrics"].period');
		}
	});

	test("falls back to attribute-grain values when changes[] is truncated", async () => {
		mockTools({
			gitlab_get_file_content: () => b64(`${JSON.stringify({ name: "eu-oit.prd - SM", namespace: "prd" }, null, 2)}\n`),
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "dataviews",
				configPath: "environments/eu-b2b/dataviews",
				resources: [
					{
						address: 'module.agent_policies.elasticstack_fleet_agent_policy.this["eu-oit-prd"]',
						actions: ["update"],
						category: "update",
						changedKeys: ["name"],
						truncated: true,
						changeCount: 99,
						changes: [{ path: "name", op: "update", before: "eu-oit.prd - SM ", after: "eu-oit.prd - SM" }],
						values: { name: { before: "eu-oit.prd - SM ", after: "eu-oit.prd - SM" } },
					},
				],
			}),
		);
		expect("files" in built).toBe(true);
		if ("files" in built) {
			expect(JSON.parse(built.files[0]?.content ?? "{}").name).toBe("eu-oit.prd - SM ");
		}
	});
});

describe("buildReportSourcedReconcile — skip-on-unreadable (SIO-901)", () => {
	test("reconciles readable files, skips unreadable ones with a note, does NOT block the whole stack", async () => {
		// agent-policies mixes fleet_agent_policy (flat <key>.json, readable) + fleet_integration_policy
		// (not at the flat path -> unreadable). The readable one must still reconcile.
		mockTools({
			gitlab_get_file_content: (args) => {
				const fp = String(args.filePath ?? "");
				return fp.endsWith("eu-oit-prd.json")
					? b64(`${JSON.stringify({ name: "eu-oit.prd - SM" }, null, 2)}\n`)
					: "[404] not found";
			},
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "dataviews",
				configPath: "environments/eu-b2b/dataviews",
				resources: [
					{
						address: 'module.agent_policies.elasticstack_fleet_agent_policy.this["eu-oit-prd"]',
						actions: ["update"],
						category: "update",
						changedKeys: ["name"],
						values: { name: { before: "eu-oit.prd - SM ", after: "eu-oit.prd - SM" } },
					},
					{
						address:
							'module.agent_policies.elasticstack_fleet_integration_policy.this["eu-mendix-platform-dev-cloud_security_posture"]',
						actions: ["update"],
						category: "update",
						changedKeys: ["description"],
						values: { description: { before: "live-desc", after: "declared-desc" } },
					},
				],
			}),
		);
		expect("files" in built).toBe(true);
		if ("files" in built) {
			expect(built.files).toHaveLength(1);
			expect(built.files[0]?.path).toBe("environments/eu-b2b/dataviews/eu-oit-prd.json");
			expect(built.note).toContain("Skipped 1 unreadable");
			expect(built.note).toContain("eu-mendix-platform-dev-cloud_security_posture.json");
		}
	});

	test("blocks only when EVERY file is unreadable", async () => {
		mockTools({ gitlab_get_file_content: () => "[404] not found" });
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "dataviews",
				resources: [
					{
						address: 'module.agent_policies.elasticstack_fleet_agent_policy.this["p1"]',
						actions: ["update"],
						category: "update",
						changedKeys: ["name"],
						values: { name: { before: "x", after: "y" } },
					},
				],
			}),
		);
		expect("blocked" in built).toBe(true);
		if ("blocked" in built) expect(built.blocked).toContain("Could not read any config file");
	});

	test("readable-but-already-in-sync + unreadable -> 'no reconcilable values' (not 'could not read any')", async () => {
		mockTools({
			gitlab_get_file_content: (args) => {
				const fp = String(args.filePath ?? "");
				// in-sync.json reads OK but the live value already equals the repo (applied = []);
				// missing.json is unreadable. files.length stays 0, but NOT every file was unreadable.
				return fp.endsWith("in-sync.json") ? b64(`${JSON.stringify({ name: "same" }, null, 2)}\n`) : "[404] not found";
			},
		});
		const { buildLiveReconcile } = await import("./nodes.ts");
		const built = await buildLiveReconcile(
			"eu-b2b",
			stackDrift({
				stack: "dataviews",
				resources: [
					{
						address: 'module.agent_policies.elasticstack_fleet_agent_policy.this["in-sync"]',
						actions: ["update"],
						category: "update",
						changedKeys: ["name"],
						values: { name: { before: "same", after: "same" } },
					},
					{
						address: 'module.agent_policies.elasticstack_fleet_agent_policy.this["missing"]',
						actions: ["update"],
						category: "update",
						changedKeys: ["name"],
						values: { name: { before: "x", after: "y" } },
					},
				],
			}),
		);
		expect("blocked" in built).toBe(true);
		if ("blocked" in built) {
			expect(built.blocked).toContain("No reconcilable live values");
			expect(built.blocked).not.toContain("Could not read any config file");
			expect(built.blocked).toContain("Skipped 1 unreadable"); // skip note still surfaced
		}
	});
});

import { attachDriftExplanations } from "./nodes.ts";

// SIO-1196: a pre-set explanation (the version-drift seed carries MR/apply attribution the
// generic explainer cannot reconstruct) must survive explainDrift; unset ones are computed.
describe("attachDriftExplanations (SIO-1196)", () => {
	const base: StackDrift = {
		stack: "deployments",
		drifted: true,
		kind: "config-json",
		create: 0,
		update: 1,
		delete: 0,
		liveReconcilable: false,
		resources: [
			{
				address: 'module.deployments["us-cld"].ec_deployment.this',
				actions: ["update"],
				reason: "attributes changed: version",
				changedKeys: ["version"],
				category: "update",
			},
		],
	};

	test("keeps a pre-set explanation verbatim", () => {
		const seeded = { ...base, explanation: "MR !346 merged but its apply never ran." };
		const [out] = attachDriftExplanations([seeded]);
		expect(out?.explanation).toBe("MR !346 merged but its apply never ran.");
	});

	test("computes the explanation for stacks without one", () => {
		const [out] = attachDriftExplanations([base]);
		expect(out?.explanation).toContain("0 create / 1 update / 0 destroy");
	});
});
