/* src/tools/index_management/index_exists.ts */
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
const indexExistsValidator = z.object({
	index: z.string().min(1, "Index cannot be empty").describe("Name of the index to check existence for"),
	ignoreUnavailable: coerceBoolean.optional().describe("Ignore unavailable indices"),
	allowNoIndices: coerceBoolean.optional().describe("Allow wildcards that match no indices"),
	expandWildcards: z
		.enum(["all", "open", "closed", "hidden", "none"])
		.optional()
		.describe("Which indices to expand wildcards to"),
	flatSettings: coerceBoolean.optional().describe("Return settings in flat format"),
	includeDefaults: coerceBoolean.optional().describe("Include default settings"),
	local: coerceBoolean.optional().describe("Return local information only"),
});

type IndexExistsParams = z.infer<typeof indexExistsValidator>;

function createIndexExistsMcpError(
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
		`[elasticsearch_index_exists] ${message}`,
		context.details,
	);
}

// Tool implementation
export const registerIndexExistsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const indexExistsHandler = async (args: IndexExistsParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			// Validate parameters
			const params = indexExistsValidator.parse(args);

			const exists = await esClient.indices.exists(
				{
					index: params.index,
					ignore_unavailable: params.ignoreUnavailable,
					allow_no_indices: params.allowNoIndices,
					expand_wildcards: params.expandWildcards,
					flat_settings: params.flatSettings,
					include_defaults: params.includeDefaults,
					local: params.local,
				},
				getDiscoveryRequestOptions(),
			);

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, index: params.index }, "Slow index existence check operation");
			}

			return {
				content: [
					{
						type: "text",
						text: `Exists: ${exists}`,
					},
				],
			};
		} catch (error) {
			// Error handling
			if (error instanceof z.ZodError) {
				throw createIndexExistsMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			throw createIndexExistsMcpError(error instanceof Error ? error.message : String(error), {
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
		"elasticsearch_index_exists",

		{
			title: "Index Exists",

			description:
				"Check if an index exists in Elasticsearch. Best for index validation, conditional operations, deployment checks. Use when you need to verify index presence in Elasticsearch clusters before performing operations or creating indices. Uses direct JSON Schema and standardized MCP error codes.",

			inputSchema: indexExistsValidator.shape,
		},

		indexExistsHandler,
	);
};
