// src/tools/code-analysis/get-commit-diff.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitLabRestClient } from "../../gitlab-client/index.js";
import { traceToolCall } from "../../utils/tracing.js";
import { LOCAL_READ_ONLY_ANNOTATIONS } from "../annotations.js";
import { restErrorResult } from "../error-envelope.js";
import { ProjectIdParam } from "./project-id-param.js";

const GetCommitDiffParams = z.object({
	project_id: ProjectIdParam,
	sha: z.string().describe("Commit SHA to get the diff for"),
});

export function registerGetCommitDiffTool(server: McpServer, client: GitLabRestClient) {
	server.registerTool(
		"gitlab_get_commit_diff",
		{
			description: "Get the diff for a specific commit showing all file changes",
			inputSchema: GetCommitDiffParams.shape,
			annotations: LOCAL_READ_ONLY_ANNOTATIONS,
		},
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
			}).catch((error) => restErrorResult(error));
		},
	);
}
