// src/tools/code-analysis/get-repository-tree.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitLabRestClient } from "../../gitlab-client/index.js";
import { traceToolCall } from "../../utils/tracing.js";

const GetRepositoryTreeParams = z.object({
	project_id: z.string().describe("GitLab project ID or URL-encoded path"),
	path: z.string().optional().describe("Directory path to list (default: root)"),
	ref: z.string().optional().describe("Branch, tag, or commit SHA (default: default branch)"),
	recursive: z.boolean().optional().describe("List files recursively (default: false)"),
	per_page: z.number().optional().describe("Number of entries per page (max 100)"),
	page: z.number().optional().describe("Page number for pagination"),
});

export function registerGetRepositoryTreeTool(server: McpServer, client: GitLabRestClient) {
	server.tool(
		"gitlab_get_repository_tree",
		"Browse the file and directory structure of a GitLab repository",
		GetRepositoryTreeParams.shape,
		async (args) => {
			return traceToolCall("gitlab_get_repository_tree", async () => {
				const params = GetRepositoryTreeParams.parse(args);
				const result = await client.getRepositoryTree(params.project_id, {
					path: params.path,
					ref: params.ref,
					recursive: params.recursive,
					per_page: params.per_page,
					page: params.page,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(result, null, 2),
						},
					],
				};
			});
		},
	);
}
