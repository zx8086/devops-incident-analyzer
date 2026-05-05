/* src/tools/tasks/list_tasks.ts */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { booleanField } from "../../utils/zodHelpers.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

// Define the parameter schema
const ListTasksParams = z.object({
	actions: z.union([z.string(), z.array(z.string())]).optional(),
	detailed: booleanField().optional(),
	groupBy: z.enum(["nodes", "parents", "none"]).optional(),
	nodes: z.union([z.string(), z.array(z.string())]).optional(),
	parentTaskId: z.string().optional(),
	// Elasticsearch Duration accepts string ("30s") or special values -1/0; not arbitrary numbers.
	timeout: z.union([z.string(), z.literal(-1), z.literal(0)]).optional(),
	waitForCompletion: booleanField().optional(),
});

type ListTasksParamsType = z.infer<typeof ListTasksParams>;

export const registerListTasksTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	// Tool registration using modern registerTool method

	server.registerTool(
		"elasticsearch_list_tasks",

		{
			title: "List Tasks",

			description:
				"Get information about tasks currently running on Elasticsearch cluster nodes. Best for cluster monitoring, performance troubleshooting, operation tracking. Use when you need to monitor long-running operations like reindexing, searches, or bulk operations in Elasticsearch.",

			inputSchema: ListTasksParams.shape,
		},

		async (params: ListTasksParamsType): Promise<SearchResult> => {
			try {
				const result = await esClient.tasks.list({
					actions: params.actions,
					detailed: params.detailed,
					group_by: params.groupBy,
					nodes: params.nodes,
					parent_task_id: params.parentTaskId,
					timeout: params.timeout,
					wait_for_completion: params.waitForCompletion,
				});
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				};
			} catch (error) {
				logger.error(
					{
						error: error instanceof Error ? error.message : String(error),
					},
					"Failed to list tasks:",
				);
				return {
					content: [
						{
							type: "text",
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
				};
			}
		},
	);
};
