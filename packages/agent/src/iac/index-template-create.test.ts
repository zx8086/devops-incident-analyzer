// agent/src/iac/index-template-create.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, buildIndexTemplateConfig, parseIntentJson } from "./nodes.ts";
import type { IacRequest, IacStateType } from "./state.ts";

const asIacState = (partial: Partial<IacStateType>): IacStateType => partial as unknown as IacStateType;

// The eu-b2b metrics override the user asked for, as a parsed indexTemplates[] entry.
const METRICS_ENTRY = {
	name: "dev-staging-metrics-ilm-override",
	indexPatterns: ["metrics-*.dev-*", "metrics-*.stg-*"],
	composedOf: ["metrics@mappings", "data-streams@mappings", "metrics@settings", "metrics@custom"],
	ignoreMissingComponentTemplates: ["metrics@custom"],
	priority: 350,
	lifecycleName: "dev-staging-metrics",
	dataStreamHidden: false,
	dataStreamAllowCustomRouting: false,
};

const TRACES_ENTRY = {
	name: "dev-staging-traces-ilm-override",
	indexPatterns: ["traces-*.dev-*", "traces-*.stg-*"],
	composedOf: ["traces@mappings", "data-streams@mappings", "traces@custom", "ecs@mappings"],
	ignoreMissingComponentTemplates: ["traces@custom"],
	priority: 350,
	lifecycleName: "dev-staging-traces",
	dataStreamHidden: false,
	dataStreamAllowCustomRouting: false,
};

describe("buildIndexTemplateConfig", () => {
	test("emits the module's template-nested JSON shape for metrics", () => {
		const content = buildIndexTemplateConfig(METRICS_ENTRY);
		const parsed = JSON.parse(content) as {
			name: string;
			index_patterns: string[];
			composed_of: string[];
			priority: number;
			ignore_missing_component_templates: string[];
			data_stream: Record<string, unknown>;
			template: { settings: { index: { lifecycle: { name: string } } } };
		};
		expect(parsed.name).toBe("dev-staging-metrics-ilm-override");
		expect(parsed.index_patterns).toEqual(["metrics-*.dev-*", "metrics-*.stg-*"]);
		expect(parsed.composed_of).toEqual([
			"metrics@mappings",
			"data-streams@mappings",
			"metrics@settings",
			"metrics@custom",
		]);
		expect(parsed.priority).toBe(350);
		expect(parsed.ignore_missing_component_templates).toEqual(["metrics@custom"]);
		// ILM bind is carried via template.settings (no separate provider arg).
		expect(parsed.template.settings.index.lifecycle.name).toBe("dev-staging-metrics");
	});

	test("data_stream carries hidden but OMITS allow_custom_routing when false (8.x-only field, eu-b2b is 9.x)", () => {
		const content = buildIndexTemplateConfig(METRICS_ENTRY);
		const parsed = JSON.parse(content) as { data_stream: Record<string, unknown> };
		expect(parsed.data_stream).toHaveProperty("hidden", false);
		expect(parsed.data_stream).not.toHaveProperty("allow_custom_routing");
	});

	test("data_stream includes allow_custom_routing only when explicitly true", () => {
		const content = buildIndexTemplateConfig({ ...METRICS_ENTRY, dataStreamAllowCustomRouting: true });
		const parsed = JSON.parse(content) as { data_stream: Record<string, unknown> };
		expect(parsed.data_stream).toHaveProperty("allow_custom_routing", true);
	});

	test("does NOT include metrics@tsdb-settings (keep custom metrics out of time_series mode)", () => {
		const content = buildIndexTemplateConfig(METRICS_ENTRY);
		expect(content).not.toContain("tsdb-settings");
	});

	test("traces entry composes traces@custom + ecs@mappings and binds dev-staging-traces", () => {
		const content = buildIndexTemplateConfig(TRACES_ENTRY);
		const parsed = JSON.parse(content) as {
			composed_of: string[];
			template: { settings: { index: { lifecycle: { name: string } } } };
		};
		expect(parsed.composed_of).toContain("traces@custom");
		expect(parsed.composed_of).toContain("ecs@mappings");
		expect(parsed.template.settings.index.lifecycle.name).toBe("dev-staging-traces");
	});

	test("preserves 2-space indent + trailing newline (repo house style)", () => {
		const content = buildIndexTemplateConfig(METRICS_ENTRY);
		expect(content.endsWith("}\n")).toBe(true);
		expect(content).toContain('\n  "name"');
	});

	test("omits the data_stream block entirely when no data-stream flags are set", () => {
		const content = buildIndexTemplateConfig({
			name: "plain",
			indexPatterns: ["plain-*"],
			composedOf: [],
			priority: 100,
		});
		const parsed = JSON.parse(content) as Record<string, unknown>;
		expect(parsed).not.toHaveProperty("data_stream");
	});
});

describe("parseIntentJson — index-template-create", () => {
	test("extracts the indexTemplates[] array", () => {
		const raw = JSON.stringify({
			workflow: "index-template-create",
			cluster: "eu-b2b",
			indexTemplates: [METRICS_ENTRY, TRACES_ENTRY],
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("index-template-create");
		expect(req.cluster).toBe("eu-b2b");
		expect(req.indexTemplates).toHaveLength(2);
		expect(req.indexTemplates?.[0]?.name).toBe("dev-staging-metrics-ilm-override");
		expect(req.indexTemplates?.[1]?.lifecycleName).toBe("dev-staging-traces");
		expect(req.clarification).toBeUndefined();
	});
});

describe("branchSlug — index-template-create", () => {
	test("uses cluster + first template name + workflow", () => {
		const req: IacRequest = {
			workflow: "index-template-create",
			isProd: false,
			cluster: "eu-b2b",
			indexTemplates: [METRICS_ENTRY, TRACES_ENTRY],
		};
		// cluster + joined template names + workflow, capped at 40 chars (the join truncates mid-list,
		// leaving the same trailing-hyphen the multi-file ILM slug produces -- harmless in a branch name).
		expect(branchSlug(req)).toBe("eu-b2b-dev-staging-metrics-ilm-override-");
		expect(branchSlug(req).length).toBe(40);
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

describe("draftChange -> proposeIndexTemplateCreate", () => {
	test("happy path: creates two files on ONE branch, sets diff + proposedFiles", async () => {
		const { draftChange } = await import("./nodes.ts");
		const committed: Array<Record<string, unknown>> = [];
		let branchCreates = 0;
		mockTools({
			// both files are new -> 404 means "go ahead and create".
			gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}',
			gitlab_create_branch: () => {
				branchCreates += 1;
				return "[201] {}";
			},
			gitlab_commit_file: (args) => {
				committed.push(args);
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "index-template-create" as const,
				isProd: false,
				cluster: "eu-b2b",
				indexTemplates: [METRICS_ENTRY, TRACES_ENTRY],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.precheckPassed).toBe(true);
		expect(branchCreates).toBe(1); // ONE shared branch
		expect(committed).toHaveLength(2);
		expect(committed.every((c) => c.action === "create")).toBe(true);
		expect(result.proposedFiles).toEqual([
			"environments/eu-b2b/index-templates/dev-staging-metrics-ilm-override.json",
			"environments/eu-b2b/index-templates/dev-staging-traces-ilm-override.json",
		]);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/index-templates/dev-staging-metrics-ilm-override.json");
		// full-file diff on create
		expect(result.proposedDiff).toContain("dev-staging-metrics-ilm-override");
		expect(result.proposedDiff).toContain("dev-staging-traces-ilm-override");
	});

	test("skips an entry whose file already exists (no-op create), keeps the other", async () => {
		const { draftChange } = await import("./nodes.ts");
		const committed: Array<Record<string, unknown>> = [];
		const existing = `[200] ${JSON.stringify({ content: Buffer.from("{}").toString("base64"), encoding: "base64" })}`;
		mockTools({
			gitlab_get_file_content: (args) =>
				String(args.filePath).includes("metrics") ? existing : '[404] {"message":"404 File Not Found"}',
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: (args) => {
				committed.push(args);
				return "[201] {}";
			},
		});
		const state = {
			iacRequest: {
				workflow: "index-template-create" as const,
				isProd: false,
				cluster: "eu-b2b",
				indexTemplates: [METRICS_ENTRY, TRACES_ENTRY],
			},
		};
		const result = await draftChange(asIacState(state));
		// only traces committed; metrics skipped as already-existing
		expect(committed).toHaveLength(1);
		expect(String(committed[0]?.file_path)).toContain("traces");
		expect(result.proposedFiles).toEqual(["environments/eu-b2b/index-templates/dev-staging-traces-ilm-override.json"]);
	});

	test("blocks when an entry is missing name or index patterns", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: {
				workflow: "index-template-create" as const,
				isProd: false,
				cluster: "eu-b2b",
				indexTemplates: [{ name: "", indexPatterns: [], composedOf: [], priority: 350 }],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("index template");
	});

	test("blocks when every requested file already exists (nothing to create)", async () => {
		const { draftChange } = await import("./nodes.ts");
		const existing = `[200] ${JSON.stringify({ content: Buffer.from("{}").toString("base64"), encoding: "base64" })}`;
		mockTools({
			gitlab_get_file_content: () => existing,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "index-template-create" as const,
				isProd: false,
				cluster: "eu-b2b",
				indexTemplates: [METRICS_ENTRY, TRACES_ENTRY],
			},
		};
		const result = await draftChange(asIacState(state));
		expect(result.blockedReason).toContain("already exist");
	});
});
