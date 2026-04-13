// src/tools/code-analysis/get-file-content.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitLabRestClient } from "../../gitlab-client/index.js";
import { traceToolCall } from "../../utils/tracing.js";

const GetFileContentParams = z.object({
	project_id: z.string().describe("GitLab project ID or URL-encoded path"),
	file_path: z.string().describe("Path to the file in the repository"),
	ref: z.string().optional().describe("Branch, tag, or commit SHA (default: HEAD)"),
});

export function registerGetFileContentTool(server: McpServer, client: GitLabRestClient) {
	server.tool(
		"gitlab_get_file_content",
		"Read the content of a file from a GitLab repository",
		GetFileContentParams.shape,
		async (args) => {
			return traceToolCall("gitlab_get_file_content", async () => {
				const params = GetFileContentParams.parse(args);
				const result = await client.getFileContent(params.project_id, params.file_path, params.ref);

				const content =
					result.encoding === "base64" ? Buffer.from(result.content, "base64").toString("utf-8") : result.content;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									file_name: result.file_name,
									file_path: result.file_path,
									size: result.size,
									ref: result.ref,
									content,
								},
								null,
								2,
							),
						},
					],
				};
			});
		},
	);
}
