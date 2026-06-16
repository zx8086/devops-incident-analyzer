// agent/src/iac/fleet-integration.test.ts
import { describe, expect, mock, test } from "bun:test";
import { branchSlug, isMajorVersionBump, parseIntentJson, reviewPlan, setIntegrationVersion } from "./nodes.ts";
import type { IacRequest } from "./state.ts";

const INTEGRATIONS = JSON.stringify(
	{
		aws: { name: "aws", version: "6.14.2", force: false },
		kafka: { name: "kafka", version: "1.27.0", force: false },
		system: { name: "system", version: "2.17.0", force: false },
	},
	null,
	2,
);

describe("setIntegrationVersion", () => {
	type IntMap = Record<string, { version: string; force: boolean } | undefined>;

	test("sets one alias's version and captures the previous, preserving siblings", () => {
		const { content, previousVersion } = setIntegrationVersion(INTEGRATIONS, "aws", "6.15.0");
		const parsed = JSON.parse(content) as IntMap;
		expect(parsed.aws?.version).toBe("6.15.0");
		expect(parsed.kafka?.version).toBe("1.27.0"); // untouched
		expect(previousVersion).toBe("6.14.2");
	});

	test("sets force when provided and captures the previous force", () => {
		const { content, previousForce } = setIntegrationVersion(INTEGRATIONS, "aws", "6.15.0", true);
		const parsed = JSON.parse(content) as IntMap;
		expect(parsed.aws?.force).toBe(true);
		expect(previousForce).toBe(false);
	});

	test("leaves force untouched when not provided", () => {
		const { content } = setIntegrationVersion(INTEGRATIONS, "aws", "6.15.0");
		const parsed = JSON.parse(content) as IntMap;
		expect(parsed.aws?.force).toBe(false);
	});

	test("preserves 2-space indent and a trailing newline", () => {
		const { content } = setIntegrationVersion(INTEGRATIONS, "aws", "6.15.0");
		expect(content.endsWith("}\n")).toBe(true);
		expect(content).toContain('\n  "aws": {');
	});

	test("throws on an unknown integration alias", () => {
		expect(() => setIntegrationVersion(INTEGRATIONS, "nginx", "1.0.0")).toThrow("unknown integration 'nginx'");
	});

	test("throws on non-object JSON", () => {
		expect(() => setIntegrationVersion("[]", "aws", "6.15.0")).toThrow("not an object");
	});
});

describe("isMajorVersionBump", () => {
	test("true when the leading integer increases", () => {
		expect(isMajorVersionBump("6.14.2", "7.0.0")).toBe(true);
	});
	test("false for a minor/patch bump", () => {
		expect(isMajorVersionBump("6.14.2", "6.15.0")).toBe(false);
	});
	test("false for a downgrade", () => {
		expect(isMajorVersionBump("7.0.0", "6.15.0")).toBe(false);
	});
	test("false when there is no prior version", () => {
		expect(isMajorVersionBump(undefined, "7.0.0")).toBe(false);
	});
	test("false when unparseable", () => {
		expect(isMajorVersionBump("latest", "stable")).toBe(false);
	});
});

describe("parseIntentJson — fleet-integration", () => {
	test("extracts workflow/cluster/integration/integrationVersion and does not clarify", () => {
		const raw = JSON.stringify({
			workflow: "fleet-integration",
			cluster: "eu-b2b",
			integration: "aws",
			integrationVersion: "6.15.0",
		});
		const req = parseIntentJson(raw);
		expect(req.workflow).toBe("fleet-integration");
		expect(req.cluster).toBe("eu-b2b");
		expect(req.integration).toBe("aws");
		expect(req.integrationVersion).toBe("6.15.0");
		expect(req.clarification).toBeUndefined();
	});

	test("carries force when the planner sets it, normalizing explicit null elsewhere", () => {
		const raw = JSON.stringify({
			workflow: "fleet-integration",
			cluster: "eu-b2b",
			integration: "aws",
			integrationVersion: "6.15.0",
			force: true,
			tier: null,
		});
		const req = parseIntentJson(raw);
		expect(req.force).toBe(true);
		expect(req.tier).toBeUndefined();
	});
});

describe("branchSlug — fleet-integration", () => {
	test("uses cluster + integration alias + workflow", () => {
		const req: IacRequest = {
			workflow: "fleet-integration",
			isProd: false,
			cluster: "eu-b2b",
			integration: "aws",
			integrationVersion: "6.15.0",
		};
		expect(branchSlug(req)).toBe("eu-b2b-aws-fleet-integration");
	});
});

// Mirror ilm-rollout.test.ts: stub mcp-bridge, dynamic-import so callTool resolves.
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

describe("draftChange -> proposeFleetIntegration", () => {
	const fileResult = `[200] ${JSON.stringify({ content: Buffer.from(INTEGRATIONS).toString("base64"), encoding: "base64" })}`;

	test("happy path: edits the one version, commits, sets precheckPassed + diff", async () => {
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
				workflow: "fleet-integration" as const,
				isProd: false,
				cluster: "eu-b2b",
				integration: "aws",
				integrationVersion: "6.15.0",
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-914 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.precheckPassed).toBe(true);
		expect(result.proposedFilePath).toBe("environments/eu-b2b/fleet-integrations/integrations.json");
		expect(result.proposedDiff).toContain('"version"');
		expect(result.proposedDiff).toContain("6.15.0");
		expect(result.integrationMajorBump).toBe(false);
		// committed body changed only aws.version; kafka untouched
		const written = JSON.parse(String(committed.content)) as Record<string, { version: string } | undefined>;
		expect(written.aws?.version).toBe("6.15.0");
		expect(written.kafka?.version).toBe("1.27.0");
	});

	test("flags a MAJOR bump", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "fleet-integration" as const,
				isProd: false,
				cluster: "eu-b2b",
				integration: "aws",
				integrationVersion: "7.0.0",
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-914 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.integrationMajorBump).toBe(true);
	});

	test("blocks when integration or version is missing", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({});
		const state = {
			iacRequest: { workflow: "fleet-integration" as const, isProd: false, cluster: "eu-b2b", integration: "aws" },
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-914 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("target version");
	});

	test("clarifies on an unknown integration alias (no broken commit)", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "fleet-integration" as const,
				isProd: false,
				cluster: "eu-b2b",
				integration: "nginx",
				integrationVersion: "1.0.0",
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-914 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("nginx");
		expect(result.precheckPassed).toBeUndefined();
	});

	test("no-op guard: blocks when already at the requested version", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => fileResult,
			gitlab_create_branch: () => "[201] {}",
			gitlab_commit_file: () => "[201] {}",
		});
		const state = {
			iacRequest: {
				workflow: "fleet-integration" as const,
				isProd: false,
				cluster: "eu-b2b",
				integration: "aws",
				integrationVersion: "6.14.2", // already the current value
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-914 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("already at 6.14.2");
	});

	test("blocks when the integrations file 404s (deployment has no Fleet integrations)", async () => {
		const { draftChange } = await import("./nodes.ts");
		mockTools({
			gitlab_get_file_content: () => '[404] {"message":"404 File Not Found"}',
		});
		const state = {
			iacRequest: {
				workflow: "fleet-integration" as const,
				isProd: false,
				cluster: "gl-testing",
				integration: "aws",
				integrationVersion: "6.15.0",
			},
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-914 - partial IacState test stub
		const result = await draftChange(state as any);
		expect(result.blockedReason).toContain("No fleet-integrations file");
	});
});

describe("reviewPlan — fleet-integration", () => {
	test("config-edit kind, fleet-integration risk line, descriptor in title", async () => {
		const state = {
			iacRequest: {
				workflow: "fleet-integration" as const,
				isProd: false,
				cluster: "eu-b2b",
				integration: "aws",
				integrationVersion: "6.15.0",
			},
			branch: "agent/eu-b2b-aws-fleet-integration-20260616",
			proposedDiff: "(diff)",
			precheckPassed: true,
			integrationMajorBump: false,
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-914 - partial IacState test stub
		const result = await reviewPlan(state as any);
		expect(result.planReview?.kind).toBe("config-edit");
		expect(result.planReview?.title).toContain("aws -> 6.15.0");
		expect(result.planReview?.title).toContain("fleet-integration");
		expect(result.risks?.some((r) => r.includes("Fleet EPM install"))).toBe(true);
	});

	test("MAJOR bump surfaces a HIGH-priority risk line first", async () => {
		const state = {
			iacRequest: {
				workflow: "fleet-integration" as const,
				isProd: false,
				cluster: "eu-b2b",
				integration: "aws",
				integrationVersion: "7.0.0",
			},
			branch: "b",
			proposedDiff: "(diff)",
			precheckPassed: true,
			integrationMajorBump: true,
		};
		// biome-ignore lint/suspicious/noExplicitAny: SIO-914 - partial IacState test stub
		const result = await reviewPlan(state as any);
		expect(result.risks?.[0]).toContain("MAJOR version bump");
	});
});
