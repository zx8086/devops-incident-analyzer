// agent/src/iac/dataview-clusterdefault.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, parseIntentJson, reviewPlan, setClusterDefaultShards, setDataviewFields } from "./nodes.ts";
import type { IacRequest } from "./state.ts";

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
		// biome-ignore lint/suspicious/noExplicitAny: SIO-917 - partial IacState test stub
		const result = await draftChange(state as any);
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
		// biome-ignore lint/suspicious/noExplicitAny: SIO-917 - partial IacState test stub
		const result = await draftChange(state as any);
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
		// biome-ignore lint/suspicious/noExplicitAny: SIO-917 - partial IacState test stub
		const result = await draftChange(state as any);
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
		// biome-ignore lint/suspicious/noExplicitAny: SIO-917 - partial IacState test stub
		const result = await draftChange(state as any);
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
		// biome-ignore lint/suspicious/noExplicitAny: SIO-917 - partial IacState test stub
		const result = await draftChange(state as any);
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
		// biome-ignore lint/suspicious/noExplicitAny: SIO-917 - partial IacState test stub
		const result = await draftChange(state as any);
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
		// biome-ignore lint/suspicious/noExplicitAny: SIO-917 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("already has total_shards_per_node");
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
		// biome-ignore lint/suspicious/noExplicitAny: SIO-917 - partial IacState test stub
		const result = await reviewPlan(state as any);
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
		// biome-ignore lint/suspicious/noExplicitAny: SIO-917 - partial IacState test stub
		const result = await reviewPlan(state as any);
		expect(result.risks?.[0]).toContain("LOWERED");
	});
});
