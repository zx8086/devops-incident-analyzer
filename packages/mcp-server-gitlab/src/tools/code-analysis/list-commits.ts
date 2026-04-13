// src/tools/code-analysis/list-commits.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitLabRestClient } from "../../gitlab-client/index.js";
import { traceToolCall } from "../../utils/tracing.js";

const ListCommitsParams = z.object({
	project_id: z.string().describe("GitLab project ID or URL-encoded path"),
	ref_name: z.string().optional().describe("Branch or tag name (default: default branch)"),
	since: z.string().optional().describe("ISO 8601 date to list commits after"),
	until: z.string().optional().describe("ISO 8601 date to list commits before"),
	path: z.string().optional().describe("File path to filter commits by"),
	per_page: z.number().optional().describe("Number of commits per page (max 100)"),
	page: z.number().optional().describe("Page number for pagination"),
});

export function registerListCommitsTool(server: McpServer, client: GitLabRestClient) {
	server.tool(
		"gitlab_list_commits",
		"List commits in a GitLab repository with optional filters for branch, date range, and file path",
		ListCommitsParams.shape,
		async (args) => {
			return traceToolCall("gitlab_list_commits", async () => {
				const params = ListCommitsParams.parse(args);
				const result = await client.listCommits(params.project_id, {
					ref_name: params.ref_name,
					since: params.since,
					until: params.until,
					path: params.path,
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
