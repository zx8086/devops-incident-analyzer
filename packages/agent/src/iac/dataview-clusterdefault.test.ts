// agent/src/iac/dataview-clusterdefault.test.ts
import { describe, expect, mock, test } from "bun:test";
import {
	branchSlug,
	mergeClusterDefaultSettings,
	parseIntentJson,
	reviewPlan,
	setClusterDefaultShards,
	setDataviewFields,
} from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

const DATAVIEW = JSON.stringify(
	{
		id: "a9ec5e9c-57c7-44a6-b50e-18ec6bea0eea",
		title: "logs-*",
		name: "Logs | All",
		time_field_name: "@timestamp",
		namespaces: ["default", "developer-experience"],
		runtime_field_map: { service: { type: "keyword", script_source: "emit('x')" } },
		override: true,
	},
	null,
	2,
);

const CLUSTER_DEFAULT = JSON.stringify(
	{ name: "logs@custom", settings: { index: { routing: { allocation: { total_shards_per_node: 2 } } } } },
	null,
	2,
);

describe("setDataviewFields", () => {
	test("adds a runtime field in CONFIG form (script_source, not script:{source})", () => {
		const { content, runtimeFieldExisted } = setDataviewFields(DATAVIEW, {
			runtimeField: { name: "host", type: "keyword", script: "emit('h')" },
		});
		const parsed = JSON.parse(content) as { runtime_field_map: Record<string, Record<string, unknown>> };
		expect(parsed.runtime_field_map.host).toEqual({ type: "keyword", script_source: "emit('h')" });
		// the footgun: must NOT be nested `script: { source }`
		expect(parsed.runtime_field_map.host).not.toHaveProperty("script");
		expect(runtimeFieldExisted).toBe(false);
	});

	test("replacing an existing runtime field flags runtimeFieldExisted", () => {
		const { runtimeFieldExisted } = setDataviewFields(DATAVIEW, {
			runtimeField: { name: "service", type: "keyword", script: "emit('y')" },
		});
		expect(runtimeFieldExisted).toBe(true);
	});

	test("a script-less runtime field omits script_source (Optional+Computed adopt-live)", () => {
		const { content } = setDataviewFields(DATAVIEW, { runtimeField: { name: "tag", type: "keyword" } });
		const parsed = JSON.parse(content) as { runtime_field_map: Record<string, Record<string, unknown>> };
		expect(parsed.runtime_field_map.tag).toEqual({ type: "keyword" });
		expect(parsed.runtime_field_map.tag).not.toHaveProperty("script_source");
	});

	test("sets title and name, capturing previous", () => {
		const { content, previousTitle, previousName } = setDataviewFields(DATAVIEW, {
			title: "logs2-*",
			displayName: "Logs2",
		});
		const parsed = JSON.parse(content) as { title: string; name: string };
		expect(parsed.title).toBe("logs2-*");
		expect(parsed.name).toBe("Logs2");
		expect(previousTitle).toBe("logs-*");
		expect(previousName).toBe("Logs | All");
	});

	test("leaves id/namespaces/override untouched + preserves formatting", () => {
		const { content } = setDataviewFields(DATAVIEW, { runtimeField: { name: "host", type: "keyword" } });
		const parsed = JSON.parse(content) as { id: string; override: boolean; namespaces: string[] };
		expect(parsed.id).toBe("a9ec5e9c-57c7-44a6-b50e-18ec6bea0eea");
		expect(parsed.override).toBe(true);
		expect(parsed.namespaces).toEqual(["default", "developer-experience"]);
		expect(content.endsWith("}\n")).toBe(true);
	});

	test("throws on non-object JSON", () => {
		expect(() => setDataviewFields("[]", { title: "x" })).toThrow("not an object");
	});
});

describe("setClusterDefaultShards", () => {
	test("sets the nested total_shards_per_node, capturing previous", () => {
		const { content, previous, changed } = setClusterDefaultShards(CLUSTER_DEFAULT, 3);
		const parsed = JSON.parse(content) as {
			settings: { index: { routing: { allocation: { total_shards_per_node: number } } } };
		};
		expect(parsed.settings.index.routing.allocation.total_shards_per_node).toBe(3);
		expect(previous).toBe(2);
		expect(changed).toBe(true);
	});

	test("creates the nested path when settings is empty", () => {
		const { content } = setClusterDefaultShards(JSON.stringify({ name: "x@custom" }), 4);
		const parsed = JSON.parse(content) as {
			settings: { index: { routing: { allocation: { total_shards_per_node: number } } } };
		};
		expect(parsed.settings.index.routing.allocation.total_shards_per_node).toBe(4);
	});

	test("changed=false when already at the value", () => {
		expect(setClusterDefaultShards(CLUSTER_DEFAULT, 2).changed).toBe(false);
	});

	test("preserves the name + trailing newline", () => {
		const { content } = setClusterDefaultShards(CLUSTER_DEFAULT, 3);
		expect(JSON.parse(content).name).toBe("logs@custom");
		expect(content.endsWith("}\n")).toBe(true);
	});

	test("throws on non-object JSON", () => {
		expect(() => setClusterDefaultShards("[]", 3)).toThrow("not an object");
	});
});

// SIO-979: freeform settingsPatch deep-merged into settings.index. The patch is relative to
// settings.index (the LLM emits `{ refresh_interval: "30s" }`), preserving every other key.
describe("mergeClusterDefaultSettings", () => {
	test("adds a top-level index setting, preserving siblings", () => {
		const { content, previous, changed } = mergeClusterDefaultSettings(CLUSTER_DEFAULT, { refresh_interval: "30s" });
		const parsed = JSON.parse(content) as {
			settings: { index: { refresh_interval: string; routing: { allocation: { total_shards_per_node: number } } } };
		};
		expect(parsed.settings.index.refresh_interval).toBe("30s");
		// the existing sibling must survive the merge
		expect(parsed.settings.index.routing.allocation.total_shards_per_node).toBe(2);
		expect(previous.refresh_interval).toBeUndefined(); // wasn't set before
		expect(changed).toBe(true);
	});

	test("captures the previous value when overwriting an existing setting", () => {
		const withRefresh = JSON.stringify(
			{ name: "logs@custom", settings: { index: { refresh_interval: "10s" } } },
			null,
			2,
		);
		const { content, previous, changed } = mergeClusterDefaultSettings(withRefresh, { refresh_interval: "30s" });
		expect(
			(JSON.parse(content) as { settings: { index: { refresh_interval: string } } }).settings.index.refresh_interval,
		).toBe("30s");
		expect(previous.refresh_interval).toBe("10s");
		expect(changed).toBe(true);
	});

	test("deep-merges a nested patch, preserving unrelated nested keys", () => {
		const { content } = mergeClusterDefaultSettings(CLUSTER_DEFAULT, {
			routing: { allocation: { total_shards_per_node: 5 } },
		});
		const parsed = JSON.parse(content) as {
			settings: { index: { routing: { allocation: { total_shards_per_node: number } } } };
		};
		expect(parsed.settings.index.routing.allocation.total_shards_per_node).toBe(5);
	});

	test("creates the settings.index path when absent", () => {
		const { content } = mergeClusterDefaultSettings(JSON.stringify({ name: "x@custom" }), { refresh_interval: "30s" });
		expect(
			(JSON.parse(content) as { settings: { index: { refresh_interval: string } } }).settings.index.refresh_interval,
		).toBe("30s");
	});

	test("changed=false when the patch matches current values", () => {
		const withRefresh = JSON.stringify(
			{ name: "logs@custom", settings: { index: { refresh_interval: "10s" } } },
			null,
			2,
		);
		expect(mergeClusterDefaultSettings(withRefresh, { refresh_interval: "10s" }).changed).toBe(false);
	});

	test("preserves the name + trailing newline", () => {
		const { content } = mergeClusterDefaultSettings(CLUSTER_DEFAULT, { refresh_interval: "30s" });
		expect((JSON.parse(content) as { name: string }).name).toBe("logs@custom");
		expect(content.endsWith("}\n")).toBe(true);
	});

	test("throws on non-object JSON", () => {
		expect(() => mergeClusterDefaultSettings("[]", { refresh_interval: "30s" })).toThrow("not an object");
	});
});

describe("parseIntentJson — dataview-edit + cluster-default-edit", () => {
	test("dataview-edit extracts dataviewName + runtime field", () => {
		const raw = JSON.stringify({
			workflow: "dataview-edit",
			cluster: "eu-b2b",
			dataviewName: "logs",
			runtimeFieldName: "service",
			runtimeFieldType: "keyword",
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("dataview-edit");
		expect(req.dataviewName).toBe("logs");
		expect(req.runtimeFieldName).toBe("service");
		expect(req.clarification).toBeUndefined();
	});

	test("cluster-default-edit extracts templateName + totalShardsPerNode", () => {
		const raw = JSON.stringify({
			workflow: "cluster-default-edit",
			cluster: "eu-b2b",
			templateName: "logs",
			totalShardsPerNode: 3,
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("cluster-default-edit");
		expect(req.templateName).toBe("logs");
		expect(req.totalShardsPerNode).toBe(3);
	});

	// SIO-979: a freeform settingsPatch on a single template.
	test("cluster-default-edit extracts a freeform settingsPatch", () => {
		const raw = JSON.stringify({
			workflow: "cluster-default-edit",
			cluster: "eu-b2b",
			templateName: "logs",
			settingsPatch: { refresh_interval: "30s" },
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("cluster-default-edit");
		expect(req.templateName).toBe("logs");
		expect(req.settingsPatch).toEqual({ refresh_interval: "30s" });
	});

	// SIO-979: >=2 clusterDefaults entries keep the array (multi-file -> one MR, like ilmPolicies).
	test("cluster-default-edit keeps a clusterDefaults array with >=2 entries", () => {
		const raw = JSON.stringify({
			workflow: "cluster-default-edit",
			cluster: "eu-b2b",
			clusterDefaults: [
				{ templateName: "logs", settingsPatch: { refresh_interval: "30s" } },
				{ templateName: "metrics", settingsPatch: { refresh_interval: "30s" } },
				{ templateName: "traces-apm.json", settingsPatch: { refresh_interval: "30s" } },
			],
		});
		const req = parseIntentJson(raw);
		expect(req.clusterDefaults).toHaveLength(3);
		// trailing .json stripped from the basename (mirrors ilmPolicies / metrics.json.json footgun)
		expect(req.clusterDefaults?.[2]?.templateName).toBe("traces-apm");
	});

	// SIO-979: a single-entry clusterDefaults folds back to the singular fields (back-compat path).
	test("cluster-default-edit folds a 1-entry clusterDefaults to templateName + settingsPatch", () => {
		const raw = JSON.stringify({
			workflow: "cluster-default-edit",
			cluster: "eu-b2b",
			clusterDefaults: [{ templateName: "logs", settingsPatch: { refresh_interval: "30s" } }],
		});
		const req = parseIntentJson(raw);
		expect(req.clusterDefaults).toBeUndefined();
		expect(req.templateName).toBe("logs");
		expect(req.settingsPatch).toEqual({ refresh_interval: "30s" });
	});
});

describe("branchSlug — dataview + cluster-default", () => {
	test("dataview-edit uses cluster + dataview + workflow", () => {
		const req: IacRequest = { workflow: "dataview-edit", isProd: false, cluster: "eu-b2b", dataviewName: "logs" };
		expect(branchSlug(req)).toBe("eu-b2b-logs-dataview-edit");
	});
	test("cluster-default-edit uses cluster + template + workflow", () => {
		const req: IacRequest = {
			workflow: "cluster-default-edit",
			isProd: false,
			cluster: "eu-b2b",
			templateName: "logs",
			totalShardsPerNode: 3,
		};
		expect(branchSlug(req)).toBe("eu-b2b-logs-cluster-default-edit");
	});

	// SIO-979: a multi-file clusterDefaults request joins the template names (like ilmPolicies),
	// capped at 40 chars by branchSlug (so a long list truncates, same as ilm/index-template).
	test("cluster-default-edit multi-file joins template names in the slug (40-char cap)", () => {
		const req: IacRequest = {
			workflow: "cluster-default-edit",
			isProd: false,
			cluster: "eu-b2b",
			clusterDefaults: [
				{ templateName: "logs", settingsPatch: { refresh_interval: "30s" } },
				{ templateName: "metrics", settingsPatch: { refresh_interval: "30s" } },
				{ templateName: "traces-apm", settingsPatch: { refresh_interval: "30s" } },
			],
		};
		const slug = branchSlug(req);
		expect(slug.startsWith("eu-b2b-logs-metrics-traces-apm")).toBe(true);
		expect(slug.length).toBeLessThanOrEqual(40);
	});
});

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

describe("draftChange -> proposeDataviewChange", () => {
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(DATAVIEW).toString("base64"), encoding: "base64" })}`;

	test("happy path: adds a runtime field, commits, sets diff", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				committed = args;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "dataview-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dataviewName: "logs",
				runtimeFieldName: "host",
				runtimeFieldType: "keyword",
				runtimeFieldScript: "emit('h')",
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/dataviews/logs.json");
		expect(result.proposedDiff).toContain("runtime_field_map");
		// committed body uses config-form script_source
		const written = JSON.parse(String(committed.content)) as {
			runtime_field_map: Record<string, Record<string, unknown>>;
		};
		expect(written.runtime_field_map.host).toHaveProperty("script_source");
		expect(written.runtime_field_map.host).not.toHaveProperty("script");
	});

	test("blocks when no dataview name / no change", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: { workflow: "dataview-edit" as const, isProd: false, cluster: "eu-b2b", dataviewName: "logs" },
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("at least one of runtime field");
	});

	test("blocks (no create) on 404", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({ gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}' });
		const state = {
			iacRequest: {
				workflow: "dataview-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dataviewName: "nope",
				runtimeFieldName: "x",
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("not found");
	});
});

describe("draftChange -> proposeClusterDefaultChange", () => {
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(CLUSTER_DEFAULT).toString("base64"), encoding: "base64" })}`;

	test("happy path: sets total_shards_per_node, commits", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				committed = args;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				templateName: "logs",
				totalShardsPerNode: 3,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/cluster-defaults/logs.json");
		expect(result.shardsLowered).toBe(false);
		const written = JSON.parse(String(committed.content)) as {
			settings: { index: { routing: { allocation: { total_shards_per_node: number } } } };
		};
		expect(written.settings.index.routing.allocation.total_shards_per_node).toBe(3);
	});

	test("flags shardsLowered when lowering", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				templateName: "logs",
				totalShardsPerNode: 1,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.shardsLowered).toBe(true); // 2 -> 1
	});

	test("blocks on invalid value", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				templateName: "logs",
				totalShardsPerNode: 0,
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("Invalid total_shards_per_node");
	});

	test("no-op guard when already at the value", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				templateName: "logs",
				totalShardsPerNode: 2,
			},
		};
		const result = await draftChange(asIacState(state));
		// SIO-1020: a no-op surfaces as noopReason (neutral "No change needed"), not blockedReason.
		expect(result.noopReason).toContain("already has total_shards_per_node");
		expect(String(result.messages?.[0]?.content ?? "")).toContain("REPO file only"); // SIO-1196
		expect(result.blockedReason).toBeFalsy();
	});

	// SIO-979: a freeform single-template settingsPatch routes to the new proposer and commits
	// via the atomic multi-file tool (one file here, but the same path).
	test("freeform settingsPatch on one template: merges + commits via gitlab_commit_files", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_files: (args) => {
				committed = args;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				templateName: "logs",
				settingsPatch: { refresh_interval: "30s" },
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/cluster-defaults/logs.json");
		// one atomic commit carrying one file
		const files = committed.files as Array<{ file_path: string; content: string }>;
		expect(files).toHaveLength(1);
		const written = JSON.parse(files[0]?.content ?? "{}") as {
			settings: { index: { refresh_interval: string; routing: { allocation: { total_shards_per_node: number } } } };
		};
		expect(written.settings.index.refresh_interval).toBe("30s");
		// preserves the existing sibling setting
		expect(written.settings.index.routing.allocation.total_shards_per_node).toBe(2);
		// full-file diff shows the whole resulting file (nothing hidden)
		expect(result.proposedDiff).toContain("refresh_interval");
		expect(result.proposedDiff).toContain("total_shards_per_node");
	});

	// SIO-979: three templates -> ONE branch, ONE atomic commit, three files (reproduces MR !182).
	test("multi-file clusterDefaults: one atomic commit over three files", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		let branchCreated = 0;
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => {
				branchCreated++;
				return "[201] {}";
			},
			gitlab_commit_files: (args) => {
				committed = args;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				clusterDefaults: [
					{ templateName: "logs", settingsPatch: { refresh_interval: "30s" } },
					{ templateName: "metrics", settingsPatch: { refresh_interval: "30s" } },
					{ templateName: "traces-apm", settingsPatch: { refresh_interval: "30s" } },
				],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(branchCreated).toBe(1); // ONE shared branch
		const files = committed.files as Array<{ file_path: string }>;
		expect(files).toHaveLength(3); // ONE commit, three files
		expect(result.proposedFiles).toEqual([
			"environments/eu-b2b/cluster-defaults/logs.json",
			"environments/eu-b2b/cluster-defaults/metrics.json",
			"environments/eu-b2b/cluster-defaults/traces-apm.json",
		]);
	});

	// SIO-979: atomic all-or-nothing -- a read failure on any file blocks the whole batch, no MR.
	test("multi-file blocks atomically when one file read fails", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: (args) =>
				String(args.filePath).includes("metrics") ? '[500] {"message":"server error"}' : fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_files: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				clusterDefaults: [
					{ templateName: "logs", settingsPatch: { refresh_interval: "30s" } },
					{ templateName: "metrics", settingsPatch: { refresh_interval: "30s" } },
				],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toBeDefined();
		expect(result.precheckPassed).toBeUndefined();
	});

	// SIO-1020: a no-op file in a MIXED batch is skipped (not a block); the real-change file(s) still
	// proceed to one MR. Only when EVERY file is a no-op does the whole batch read "No change needed".
	test("multi-file: a no-op file is skipped; the real change still commits", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed: Record<string, unknown> = {};
		mockTools({
			gitlab_get_file_content: () => fileResult, // settings.index.routing.allocation.total_shards_per_node=2
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_files: (args) => {
				committed = args;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				clusterDefaults: [
					// no-op: the file already has total_shards_per_node=2
					{ templateName: "logs", settingsPatch: { routing: { allocation: { total_shards_per_node: 2 } } } },
					// real change: refresh_interval is absent
					{ templateName: "metrics", settingsPatch: { refresh_interval: "30s" } },
				],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(result.noopReason).toBeFalsy();
		const files = committed.files as Array<{ file_path: string }>;
		expect(files).toHaveLength(1); // only the metrics change
		expect(result.proposedFiles).toEqual(["environments/eu-b2b/cluster-defaults/metrics.json"]);
	});

	// SIO-1020: when EVERY file in the batch is a no-op, the turn reads neutral "No change needed".
	test("multi-file: all files no-op -> noopReason, no MR", async () => {
		const { draftChange } = await import("./nodes.ts");
		let committed = false;
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_files: () => {
				committed = true;
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				clusterDefaults: [
					{ templateName: "logs", settingsPatch: { routing: { allocation: { total_shards_per_node: 2 } } } },
					{ templateName: "metrics", settingsPatch: { routing: { allocation: { total_shards_per_node: 2 } } } },
				],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.noopReason).toContain("already have the requested settings");
		expect(result.blockedReason).toBeFalsy();
		expect(result.precheckPassed).toBeUndefined();
		expect(committed).toBe(false);
	});
});

describe("reviewPlan — dataview + cluster-default", () => {
	test("dataview: config-edit kind + dataview risk + descriptor", async () => {
		const state = {
			iacRequest: {
				workflow: "dataview-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				dataviewName: "logs",
				runtimeFieldName: "service",
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.planReview?.kind).toBe("config-edit");
		expect(result.planReview?.title).toContain("logs");
		expect(result.planReview?.title).toContain("dataview-edit");
		expect(result.risks?.some((r) => r.includes("computed at query time"))).toBe(true);
	});

	test("cluster-default: lowering surfaces a leading risk line", async () => {
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				templateName: "logs",
				totalShardsPerNode: 1,
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
			shardsLowered: true,
		};
		const result = await reviewPlan(asIacState(state));
		expect(result.risks?.[0]).toContain("LOWERED");
	});

	// SIO-979: a freeform single-template change titles by the settings keys, NOT
	// "total_shards_per_node ?" (the hardcoded single-field descriptor).
	test("cluster-default: freeform settingsPatch title names the settings keys", async () => {
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				templateName: "logs",
				settingsPatch: { refresh_interval: "30s" },
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
		};
		const result = await reviewPlan(asIacState(state));
		const title = result.planReview?.title ?? "";
		expect(title).toContain("logs");
		expect(title).toContain("refresh_interval");
		expect(title).not.toContain("total_shards_per_node ?");
	});

	// SIO-979: a freeform multi-file change titles by all the template names.
	test("cluster-default: freeform multi-file title names all templates", async () => {
		const state = {
			iacRequest: {
				workflow: "cluster-default-edit" as const,
				isProd: false,
				cluster: "eu-b2b",
				clusterDefaults: [
					{ templateName: "logs", settingsPatch: { refresh_interval: "30s" } },
					{ templateName: "metrics", settingsPatch: { refresh_interval: "30s" } },
				],
			},
			branch: "b",
			proposedDiff: "(diff)",
			proposedFiles: [
				"environments/eu-b2b/cluster-defaults/logs.json",
				"environments/eu-b2b/cluster-defaults/metrics.json",
			],
			precheckPassed: true,
		};
		const result = await reviewPlan(asIacState(state));
		const title = result.planReview?.title ?? "";
		expect(title).toContain("logs");
		expect(title).toContain("metrics");
		expect(title).toContain("refresh_interval");
	});
});
