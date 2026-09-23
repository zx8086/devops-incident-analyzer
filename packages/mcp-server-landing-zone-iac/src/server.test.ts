import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "./config.ts";
import { createServer } from "./server.ts";
import type { GitLabReadClient } from "./tools/repositories.ts";
import type { GitLabWriteClient } from "./tools/write.ts";

const forbiddenSurface = /\b(create|update|delete|commit|branch|merge|apply|import|state|unlock|mutat(?:e|ion))\b/i;
const projectPath = "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator";

function baseConfig(): Config {
	return {
		transport: { mode: "http", port: 1, host: "127.0.0.1", path: "/mcp" },
		gitlab: { baseUrl: "https://gitlab.example", token: undefined, timeoutMs: 30_000, maxResponseBytes: 200_000 },
		write: {
			enabled: false,
			allowedProjects: [],
			allowedPathPrefixes: {},
			backendProjects: [],
		},
	};
}

async function listedTools(config: Config, writeClient?: GitLabWriteClient) {
	const server = createServer(config, {} as GitLabReadClient, writeClient);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const mcpClient = new Client({ name: "landing-zone-surface-test", version: "0.0.0" });
	await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
	const result = await mcpClient.listTools();
	await mcpClient.close();
	return result.tools;
}

function enabledConfig(): Config {
	return {
		...baseConfig(),
		write: {
			enabled: true,
			token: "separate-write-token",
			reviewToken: "approved-review-token",
			allowedProjects: [projectPath],
			allowedPathPrefixes: { [projectPath]: ["accounts/"] },
			backendProjects: [],
		},
	};
}

describe("Landing Zone MCP server", () => {
	test("exposes only the ten approved read tools", async () => {
		const tools = await listedTools(baseConfig());

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			"lz_extract_terraform_topology",
			"lz_find_representative_examples",
			"lz_list_historical_merge_requests",
			"lz_list_merge_request_pipelines",
			"lz_list_open_changes",
			"lz_list_project_deployments",
			"lz_list_repositories",
			"lz_read_merge_request",
			"lz_read_pipeline_plan",
			"lz_read_repository_files",
		]);
		for (const tool of tools) {
			expect(`${tool.name} ${tool.description ?? ""}`).not.toMatch(forbiddenSurface);
			expect(tool.annotations?.readOnlyHint).toBe(true);
			expect(tool.annotations?.destructiveHint).toBe(false);
		}
	});

	test("adds exactly four governed GitOps tools only when write mode is enabled", async () => {
		const tools = await listedTools(enabledConfig(), {} as GitLabWriteClient);
		const byName = new Map(tools.map((tool) => [tool.name, tool]));

		expect(tools).toHaveLength(14);
		for (const name of ["lz_commit_allowed_files", "lz_create_branch", "lz_open_merge_request", "lz_watch_pipeline"]) {
			expect(byName.has(name)).toBe(true);
		}
		for (const name of ["lz_commit_allowed_files", "lz_create_branch", "lz_open_merge_request"]) {
			expect(byName.get(name)?.annotations?.readOnlyHint).toBe(false);
			expect(byName.get(name)?.annotations?.destructiveHint).toBe(false);
		}
		expect(byName.get("lz_watch_pipeline")?.annotations?.readOnlyHint).toBe(true);
		expect(byName.get("lz_watch_pipeline")?.annotations?.destructiveHint).toBe(false);
	});

	test("watches an existing pipeline and plan without exposing a trigger operation", async () => {
		const calls: string[] = [];
		const readClient = {
			project: async () => ({
				id: 42,
				path: projectPath,
				defaultBranch: "main",
				headSha: "a".repeat(40),
				lastActivityAt: "2026-09-23T00:00:00.000Z",
			}),
			mergeRequestPipelines: async () => {
				calls.push("mergeRequestPipelines");
				return {
					pipelines: [
						{
							id: 99,
							status: "success",
							webUrl: "https://gitlab.example/pipelines/99",
							createdAt: "2026-09-23T00:00:00.000Z",
							updatedAt: "2026-09-23T00:01:00.000Z",
						},
					],
				};
			},
			pipelineJobs: async () => {
				calls.push("pipelineJobs");
				return {
					jobs: [{ id: 100, name: "terraform-plan", status: "success", webUrl: "https://gitlab.example/jobs/100" }],
				};
			},
			jobTrace: async () => {
				calls.push("jobTrace");
				return "Plan: 1 to add, 0 to change, 0 to destroy.";
			},
		} as unknown as GitLabReadClient;
		const server = createServer(enabledConfig(), readClient, {} as GitLabWriteClient);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "landing-zone-watch-test", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		const result = await mcpClient.callTool({
			name: "lz_watch_pipeline",
			arguments: { repository: "aws-lz-account-creator", projectId: 42, iid: 7, pipelineId: 99 },
		});
		await mcpClient.close();

		expect(result.isError).not.toBe(true);
		expect(calls).toEqual(["mergeRequestPipelines", "pipelineJobs", "pipelineJobs", "jobTrace"]);
		expect(JSON.stringify(result.content)).toContain("1 to add, 0 to change, 0 to destroy");
	});
});
