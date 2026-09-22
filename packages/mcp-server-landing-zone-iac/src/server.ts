import { createCachedServerFactory } from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import type { Config } from "./config.ts";
import {
	findRepresentativeExamples,
	listHistoricalMergeRequests,
	listMergeRequestPipelines,
	listOpenChanges,
	readPipelinePlan,
} from "./tools/evidence.ts";
import {
	createGitLabReadClient,
	type GitLabReadClient,
	LANDING_ZONE_REPOSITORIES,
	readRepositoryFiles,
} from "./tools/repositories.ts";
import { extractTerraformTopology } from "./tools/topology.ts";

const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };
const RepositoryParam = z.string().min(1).describe("Approved Landing Zone repository name or catalog path");
const PathParam = z.string().min(1).max(500).describe("Repository-relative path");

function textResult(value: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): CallToolResult {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : "Landing Zone evidence read failed" }],
		isError: true,
	};
}

function registerAll(server: McpServer, client: GitLabReadClient): void {
	server.registerTool(
		"lz_list_repositories",
		{
			description: "List approved Landing Zone repository catalog entries.",
			inputSchema: {},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async () => textResult({ repositories: LANDING_ZONE_REPOSITORIES }),
	);

	server.registerTool(
		"lz_read_repository_files",
		{
			description: "Read bounded files with source, revision, freshness, and trust metadata.",
			inputSchema: {
				repository: RepositoryParam,
				paths: z.array(PathParam).min(1).max(20),
				ref: z.string().min(1).optional().describe("Revision identifier; defaults to the current catalog head"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => readRepositoryFiles(client, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_find_representative_examples",
		{
			description: "Aggregate contract files, three to five active examples, and relevant open review evidence.",
			inputSchema: {
				repository: RepositoryParam,
				path: z.string().max(500).optional().describe("Optional active configuration path prefix"),
				ref: z.string().min(1).optional().describe("Revision identifier; defaults to the current catalog head"),
				limit: z.number().int().min(3).max(5).optional().describe("Active example count, from three through five"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => findRepresentativeExamples(client, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_list_open_changes",
		{
			description: "List bounded open code-review evidence, optionally filtered by path prefix.",
			inputSchema: {
				repository: RepositoryParam,
				path: z.string().max(500).optional().describe("Optional repository path prefix"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => listOpenChanges(client, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_list_historical_merge_requests",
		{
			description: "List one bounded, resumable page of historical Landing Zone review records after an explicit timestamp.",
			inputSchema: {
				repository: RepositoryParam,
				updatedAfter: z.string().datetime().describe("Explicit UTC checkpoint or backfill start timestamp"),
				page: z.number().int().positive().optional().describe("GitLab page number; defaults to 1"),
				perPage: z.number().int().min(1).max(100).optional().describe("Bounded page size; defaults to 20"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => listHistoricalMergeRequests(client, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_list_merge_request_pipelines",
		{
			description: "List bounded pipeline metadata for a historical review record, including verified deployment and Terraform-plan signals without plan content.",
			inputSchema: {
				repository: RepositoryParam,
				iid: z.number().int().positive().describe("GitLab merge request IID"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => listMergeRequestPipelines(client, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_read_pipeline_plan",
		{
			description: "Read bounded Terraform plan job evidence from an existing pipeline.",
			inputSchema: {
				repository: RepositoryParam,
				pipelineId: z.number().int().positive().describe("Existing GitLab pipeline identifier"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => readPipelinePlan(client, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_extract_terraform_topology",
		{
			description: "Extract account, network, DNS, and module topology facts with file evidence identifiers.",
			inputSchema: {
				repository: RepositoryParam,
				paths: z.array(PathParam).min(1).max(20),
				ref: z.string().min(1).optional().describe("Revision identifier; defaults to the current catalog head"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => extractTerraformTopology(client, args).then(textResult).catch(errorResult),
	);
}

function createBareServer(): McpServer {
	return new McpServer({
		name: "landing-zone-iac-mcp-server",
		version: pkg.version,
		description: "Read-only PVH Landing Zone repository, review, pipeline, and topology evidence.",
	});
}

export function createMcpServerFactory(config: Config, injectedClient?: GitLabReadClient): () => McpServer {
	const client = injectedClient ?? createGitLabReadClient(config.gitlab);
	return createCachedServerFactory({
		createBareServer,
		registerAll: (server) => registerAll(server, client),
	});
}

export function createServer(config: Config, injectedClient?: GitLabReadClient): McpServer {
	const server = createBareServer();
	registerAll(server, injectedClient ?? createGitLabReadClient(config.gitlab));
	return server;
}
