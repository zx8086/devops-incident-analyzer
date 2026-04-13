// src/tools/code-analysis/get-blame.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitLabRestClient } from "../../gitlab-client/index.js";
import { traceToolCall } from "../../utils/tracing.js";

const GetBlameParams = z.object({
	project_id: z.string().describe("GitLab project ID or URL-encoded path"),
	file_path: z.string().describe("Path to the file in the repository"),
	ref: z.string().optional().describe("Branch, tag, or commit SHA (default: HEAD)"),
});

export function registerGetBlameTool(server: McpServer, client: GitLabRestClient) {
	server.tool(
		"gitlab_get_blame",
		"Get git blame information for a file showing who last modified each line",
		GetBlameParams.shape,
		async (args) => {
			return traceToolCall("gitlab_get_blame", async () => {
				const params = GetBlameParams.parse(args);
				const result = await client.getBlame(params.project_id, params.file_path, params.ref);

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
