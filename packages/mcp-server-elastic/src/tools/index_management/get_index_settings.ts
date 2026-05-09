/* src/tools/index_management/get_index_settings.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDiscoveryRequestOptions } from "../../utils/discoveryRequestOptions.js";
import { logger } from "../../utils/logger.js";
import { coerceBoolean } from "../../utils/zodHelpers.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

// Direct JSON Schema definition
// FIXED: Original JSON Schema definition removed - now using Zod schema inline

// Zod validator for runtime validation
const getIndexSettingsValidator = z.object({
	index: z.string().min(1, "Index cannot be empty").describe("Name of the index to get settings for"),
	name: z.string().optional().describe("Specific setting name to retrieve"),
	ignoreUnavailable: coerceBoolean.optional().describe("Ignore unavailable indices"),
	allowNoIndices: coerceBoolean.optional().describe("Allow wildcards that match no indices"),
	expandWildcards: z
		.enum(["all", "open", "closed", "hidden", "none"])
		.optional()
		.describe("Which indices to expand wildcards to"),
	flatSettings: coerceBoolean.optional().describe("Return settings in flat format"),
	includeDefaults: coerceBoolean.optional().describe("Include default settings"),
	local: coerceBoolean.optional().describe("Return local information only"),
	masterTimeout: z.string().optional().describe("Master node timeout (e.g., '30s')"),
});

type GetIndexSettingsParams = z.infer<typeof getIndexSettingsValidator>;

function createGetIndexSettingsMcpError(
	error: Error | string,
	context: { type: "validation" | "execution" | "index_not_found"; details?: unknown },
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		index_not_found: ErrorCode.InvalidParams,
	};

	return new McpError(
		errorCodeMap[context.type] || ErrorCode.InternalError,
		`[elasticsearch_get_index_settings] ${message}`,
		context.details,
	);
}

// Tool implementation
export const registerGetIndexSettingsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const getIndexSettingsHandler = async (args: GetIndexSettingsParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			// Validate parameters
			const params = getIndexSettingsValidator.parse(args);

			const result = await esClient.indices.getSettings(
				{
					index: params.index,
					name: params.name,
					ignore_unavailable: params.ignoreUnavailable,
					allow_no_indices: params.allowNoIndices,
					expand_wildcards: params.expandWildcards,
					flat_settings: params.flatSettings,
					include_defaults: params.includeDefaults,
					local: params.local,
					master_timeout: params.masterTimeout,
				},
				getDiscoveryRequestOptions(),
			);

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, index: params.index }, "Slow index settings retrieval operation");
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
				throw createGetIndexSettingsMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			// Handle index not found error
			if (error instanceof Error && error.message.includes("index_not_found_exception")) {
				throw createGetIndexSettingsMcpError(`Index not found: ${args.index}`, {
					type: "index_not_found",
					details: { index: args.index },
				});
			}

			throw createGetIndexSettingsMcpError(error instanceof Error ? error.message : String(error), {
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
		"elasticsearch_get_index_settings",

		{
			title: "Get Index Settings",

			description:
				"Get index settings from Elasticsearch. Best for configuration review, performance analysis, troubleshooting. Use when you need to inspect index-level settings and configurations in Elasticsearch. Uses direct JSON Schema and standardized MCP error codes.",

			inputSchema: getIndexSettingsValidator.shape,
		},

		getIndexSettingsHandler,
	);
};
