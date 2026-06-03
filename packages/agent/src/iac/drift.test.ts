// agent/src/iac/drift.test.ts
import { describe, expect, mock, test } from "bun:test";
import {
	classifyStackByName,
	configStackFamily,
	detectLostIlmActions,
	driftFingerprint,
	explainStackDrift,
	extractLiveTopology,
	extractLiveVersion,
	formatDriftSummary,
	ilmPolicyFromAddress,
	ilmRepoShapeToFile,
	isActionableDrift,
	liveIlmToRepoShape,
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

		// ILM is now live-reconcilable as a static capability (rewrite each policy file from the
		// live ILM policy); driftCheckStack narrows it to stacks with a parseable policy address.
		const ilm = classifyStackByName("lifecycle-policies", "eu-b2b");
		expect(ilm.kind).toBe("config-json");
		expect(ilm.liveReconcilable).toBe(true);

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
			elastic_ilm_get_lifecycle: () =>
				"[cluster 'eu-b2b' not configured: set ELASTIC_IAC_CLUSTER_DEPLOYMENTS + ELASTIC_IAC_CLUSTER_<ID>_URL]",
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
