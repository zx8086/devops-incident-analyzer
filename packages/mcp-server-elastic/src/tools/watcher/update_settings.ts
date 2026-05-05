/* src/tools/watcher/update_settings.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { OperationType, withReadOnlyCheck } from "../../utils/readOnlyMode.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

// Direct JSON Schema definition
// FIXED: Original JSON Schema definition removed - now using Zod schema inline

// Zod validator for runtime validation
const updateWatcherSettingsValidator = z.object({
	"index.auto_expand_replicas": z.string().optional().describe("Auto expand replicas setting"),
	"index.number_of_replicas": z.number().optional().describe("Number of replica shards"),
	master_timeout: z.string().optional().describe("Explicit operation timeout for connection to master node"),
	timeout: z.string().optional().describe("Explicit operation timeout"),
});

type UpdateWatcherSettingsParams = z.infer<typeof updateWatcherSettingsValidator>;

function createUpdateWatcherSettingsMcpError(
	error: Error | string,
	context: { type: "validation" | "execution"; details?: unknown },
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
	};

	return new McpError(
		errorCodeMap[context.type] || ErrorCode.InternalError,
		`[elasticsearch_watcher_update_settings] ${message}`,
		context.details,
	);
}

// Tool implementation
export const registerWatcherUpdateSettingsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const updateWatcherSettingsHandler = async (args: UpdateWatcherSettingsParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			// Validate parameters
			const params = updateWatcherSettingsValidator.parse(args);

			const result = await esClient.watcher.updateSettings({
				"index.auto_expand_replicas": params["index.auto_expand_replicas"],
				"index.number_of_replicas": params["index.number_of_replicas"],
				master_timeout: params.master_timeout,
				timeout: params.timeout,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration }, "Slow watcher operation");
			}

			return {
				content: [
					{
						type: "text",
						text: JSON.stringify(result, null, 2),
					},
				],
			};
		} catch (error) {
			// Error handling
			if (error instanceof z.ZodError) {
				throw createUpdateWatcherSettingsMcpError(
					`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`,
					{
						type: "validation",
						details: { validationErrors: error.issues, providedArgs: args },
					},
				);
			}

			throw createUpdateWatcherSettingsMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: {
					duration: performance.now() - perfStart,
					args,
				},
			});
		}
	};

	// Tool registration
	// Tool registration using modern registerTool method

	server.registerTool(
		"elasticsearch_watcher_update_settings",

		{
			title: "Watcher Update Settings",

			description:
				"Update Elasticsearch Watcher index settings for .watches index. Best for configuration management, performance tuning, allocation control. Use when you need to modify Watcher internal index settings like replicas and allocation in Elasticsearch. Uses direct JSON Schema and standardized MCP error codes.",

			inputSchema: updateWatcherSettingsValidator.shape,
		},

		withReadOnlyCheck("elasticsearch_watcher_update_settings", updateWatcherSettingsHandler, OperationType.WRITE),
	);
};
