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
	listProjectDeployments,
	readMergeRequest,
	readPipelinePlan,
} from "./tools/evidence.ts";
import {
	createGitLabReadClient,
	type GitLabReadClient,
	LANDING_ZONE_REPOSITORIES,
	readRepositoryFiles,
	resolveRepository,
} from "./tools/repositories.ts";
import { extractTerraformTopology } from "./tools/topology.ts";
import {
	CommitAllowedFilesInputSchema,
	CreateBranchInputSchema,
	commitAllowedFiles,
	createAllowedBranch,
	createGitLabWriteClient,
	type GitLabWriteClient,
	OpenMergeRequestInputSchema,
	openAllowedMergeRequest,
} from "./tools/write.ts";

const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false };
const GOVERNED_WRITE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
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
			description:
				"List one bounded, resumable page of historical Landing Zone review records after an explicit timestamp.",
			inputSchema: {
				repository: RepositoryParam,
				updatedAfter: z.string().datetime().describe("Explicit UTC checkpoint or backfill start timestamp"),
				updatedBefore: z.string().datetime().optional().describe("Fixed UTC upper bound for a resumable import window"),
				page: z.number().int().positive().optional().describe("GitLab page number; defaults to 1"),
				perPage: z.number().int().min(1).max(100).optional().describe("Bounded page size; defaults to 20"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => listHistoricalMergeRequests(client, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_read_merge_request",
		{
			description: "Read bounded current metadata for one approved Landing Zone review record.",
			inputSchema: {
				repository: RepositoryParam,
				iid: z.number().int().positive().describe("GitLab merge request IID"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => readMergeRequest(client, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_list_merge_request_pipelines",
		{
			description:
				"List bounded CI pipeline and Terraform plan-job metadata for one review record without plan content.",
			inputSchema: {
				repository: RepositoryParam,
				iid: z.number().int().positive().describe("GitLab merge request IID"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => listMergeRequestPipelines(client, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_list_project_deployments",
		{
			description: "List bounded successful deployment metadata for one exact SHA without environment payloads.",
			inputSchema: {
				repository: RepositoryParam,
				commitSha: z.string().min(1).max(128).describe("Exact merge commit SHA to correlate"),
				page: z.number().int().positive().optional().describe("Resumable GitLab deployment page"),
				updatedBefore: z
					.string()
					.datetime()
					.optional()
					.describe("Fixed deployment snapshot boundary reused across resumed pages"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => listProjectDeployments(client, args).then(textResult).catch(errorResult),
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

function registerGovernedWrites(
	server: McpServer,
	readClient: GitLabReadClient,
	writeClient: GitLabWriteClient,
	policy: Config["write"],
): void {
	server.registerTool(
		"lz_create_branch",
		{
			description: "Create an isolated agent branch from an exact, current default-branch SHA after policy review.",
			inputSchema: CreateBranchInputSchema.shape,
			annotations: GOVERNED_WRITE_ANNOTATIONS,
		},
		async (args) => createAllowedBranch(writeClient, policy, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_commit_allowed_files",
		{
			description:
				"Commit a bounded allowlist of reviewed files with branch and per-file optimistic concurrency checks.",
			inputSchema: CommitAllowedFilesInputSchema.shape,
			annotations: GOVERNED_WRITE_ANNOTATIONS,
		},
		async (args) => commitAllowedFiles(writeClient, policy, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_open_merge_request",
		{
			description:
				"Open a ready-for-review merge request with evidence, validation, risk, and expected Terraform plan details.",
			inputSchema: OpenMergeRequestInputSchema.shape,
			annotations: GOVERNED_WRITE_ANNOTATIONS,
		},
		async (args) => openAllowedMergeRequest(writeClient, policy, args).then(textResult).catch(errorResult),
	);

	server.registerTool(
		"lz_watch_pipeline",
		{
			description:
				"Observe existing merge-request pipelines and optional Terraform plan evidence without triggering CI.",
			inputSchema: {
				repository: RepositoryParam,
				projectId: z.number().int().positive().describe("Verified GitLab project ID"),
				iid: z.number().int().positive().describe("Existing merge request IID"),
				pipelineId: z.number().int().positive().optional().describe("Existing pipeline ID whose plan evidence to read"),
			},
			annotations: READ_ONLY_ANNOTATIONS,
		},
		async (args) => {
			try {
				const repository = resolveRepository(args.repository);
				if (!policy.allowedProjects.includes(repository.projectPath)) {
					throw new Error(`${repository.projectPath} is not write-allowlisted`);
				}
				const project = await readClient.project(repository.projectPath);
				if (project.id !== args.projectId || project.path !== repository.projectPath) {
					throw new Error("GitLab project identity did not match the approved catalog entry");
				}
				const pipelines = await listMergeRequestPipelines(readClient, {
					repository: repository.name,
					iid: args.iid,
				});
				if (args.pipelineId && !pipelines.pipelines.some((pipeline) => pipeline.id === args.pipelineId)) {
					throw new Error(`Pipeline ${args.pipelineId} does not belong to merge request !${args.iid}`);
				}
				const plan = args.pipelineId
					? await readPipelinePlan(readClient, { repository: repository.name, pipelineId: args.pipelineId })
					: undefined;
				return textResult({ pipelines, ...(plan && { plan }) });
			} catch (error) {
				return errorResult(error);
			}
		},
	);
}

function createBareServer(): McpServer {
	return new McpServer({
		name: "landing-zone-iac-mcp-server",
		version: pkg.version,
		description: "PVH Landing Zone evidence with an optional, policy-gated GitOps proposal facade.",
	});
}

export function createMcpServerFactory(
	config: Config,
	injectedClient?: GitLabReadClient,
	injectedWriteClient?: GitLabWriteClient,
): () => McpServer {
	const readClient = injectedClient ?? createGitLabReadClient(config.gitlab);
	const writeClient = config.write.enabled
		? (injectedWriteClient ?? createGitLabWriteClient({ ...config.gitlab, token: config.write.token ?? "" }))
		: undefined;
	return createCachedServerFactory({
		createBareServer,
		registerAll: (server) => {
			registerAll(server, readClient);
			if (writeClient) registerGovernedWrites(server, readClient, writeClient, config.write);
		},
	});
}

export function createServer(
	config: Config,
	injectedClient?: GitLabReadClient,
	injectedWriteClient?: GitLabWriteClient,
): McpServer {
	const server = createBareServer();
	const readClient = injectedClient ?? createGitLabReadClient(config.gitlab);
	registerAll(server, readClient);
	if (config.write.enabled) {
		const writeClient =
			injectedWriteClient ?? createGitLabWriteClient({ ...config.gitlab, token: config.write.token ?? "" });
		registerGovernedWrites(server, readClient, writeClient, config.write);
	}
	return server;
}
