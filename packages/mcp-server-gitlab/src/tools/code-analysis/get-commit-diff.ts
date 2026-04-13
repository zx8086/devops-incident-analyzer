// src/tools/code-analysis/get-commit-diff.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitLabRestClient } from "../../gitlab-client/index.js";
import { traceToolCall } from "../../utils/tracing.js";

const GetCommitDiffParams = z.object({
	project_id: z.string().describe("GitLab project ID or URL-encoded path"),
	sha: z.string().describe("Commit SHA to get the diff for"),
});

export function registerGetCommitDiffTool(server: McpServer, client: GitLabRestClient) {
	server.tool(
		"gitlab_get_commit_diff",
		"Get the diff for a specific commit showing all file changes",
		GetCommitDiffParams.shape,
		async (args) => {
			return traceToolCall("gitlab_get_commit_diff", async () => {
				const params = GetCommitDiffParams.parse(args);
				const result = await client.getCommitDiff(params.project_id, params.sha);

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
