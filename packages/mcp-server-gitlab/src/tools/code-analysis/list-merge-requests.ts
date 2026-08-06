// src/tools/code-analysis/list-merge-requests.ts

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GitLabRestClient } from "../../gitlab-client/index.js";
import { traceToolCall } from "../../utils/tracing.js";
import { LOCAL_READ_ONLY_ANNOTATIONS } from "../annotations.js";
import { restErrorResult } from "../error-envelope.js";
import { NumericPreferredProjectIdParam } from "./project-id-param.js";

const ListMergeRequestsParams = z.object({
	project_id: NumericPreferredProjectIdParam,
	state: z
		.enum(["merged", "opened", "closed", "all"])
		.optional()
		.default("merged")
		.describe("MR state filter; default 'merged' for the deploy-vs-runtime correlation use case."),
	updated_after: z
		.string()
		.optional()
		.describe("ISO-8601 timestamp; only return MRs updated after this (server-side filter)."),
	per_page: z.number().int().min(1).max(100).optional().default(20).describe("Pagination size (1-100, default 20)."),
});

export function registerListMergeRequestsTool(server: McpServer, client: GitLabRestClient): void {
	server.registerTool(
		"gitlab_list_merge_requests",
		{
			description:
				"List merge requests for a GitLab project. Defaults to state=merged for the deploy-vs-datastore-runtime correlation flow. Use updated_after to bound the result set by recency.",
			inputSchema: ListMergeRequestsParams.shape,
			annotations: LOCAL_READ_ONLY_ANNOTATIONS,
		},
		async (args) => {
			return traceToolCall("gitlab_list_merge_requests", async () => {
				const params = ListMergeRequestsParams.parse(args);
				const result = await client.listMergeRequests(params.project_id, {
					state: params.state,
					updated_after: params.updated_after,
					per_page: params.per_page,
				});
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
