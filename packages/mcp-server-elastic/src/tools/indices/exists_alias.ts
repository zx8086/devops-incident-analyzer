/* src/tools/indices/exists_alias.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { booleanField } from "../../utils/zodHelpers.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

// Direct JSON Schema definition
// FIXED: Original JSON Schema definition removed - now using Zod schema inline

// Zod validator for runtime validation
const existsAliasValidator = z.object({
	name: z
		.union([z.string(), z.array(z.string())])
		.describe("Alias name(s) to check existence for. Examples: 'logs', ['alias1', 'alias2']"),
	index: z
		.union([z.string(), z.array(z.string())])
		.optional()
		.describe("Index name(s) or pattern(s) to check for aliases"),
	allowNoIndices: booleanField()
		.optional()
		.describe("Whether to ignore if a wildcard indices expression resolves into no concrete indices"),
	expandWildcards: z
		.enum(["all", "open", "closed", "hidden", "none"])
		.or(z.array(z.enum(["all", "open", "closed", "hidden", "none"])))
		.optional()
		.describe("Type of index that wildcard patterns can match"),
	ignoreUnavailable: booleanField()
		.optional()
		.describe("Whether specified concrete indices should be ignored when unavailable"),
	masterTimeout: z.string().optional().describe("Timeout for connection to master node"),
});

type ExistsAliasParams = z.infer<typeof existsAliasValidator>;

function createExistsAliasMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "index_not_found" | "timeout";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		index_not_found: ErrorCode.InvalidParams,
		timeout: ErrorCode.InternalError,
	};

	return new McpError(errorCodeMap[context.type], `[elasticsearch_exists_alias] ${message}`, context.details);
}

// Tool implementation
export const registerExistsAliasTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const existsAliasHandler = async (args: ExistsAliasParams): Promise<SearchResult> => {
		try {
			// Validate parameters
			const params = existsAliasValidator.parse(args);

			logger.debug({ name: params.name, index: params.index }, "Checking if alias exists");

			const result = await esClient.indices.existsAlias(
				{
					name: params.name,
					index: params.index,
					allow_no_indices: params.allowNoIndices,
					expand_wildcards: params.expandWildcards,
					ignore_unavailable: params.ignoreUnavailable,
					master_timeout: params.masterTimeout,
				},
				{
					opaqueId: "elasticsearch_exists_alias",
				},
			);

			return {
				content: [{ type: "text", text: JSON.stringify({ exists: result }, null, 2) }],
			};
		} catch (error) {
			// Error handling
			if (error instanceof z.ZodError) {
				throw createExistsAliasMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error) {
				if (error.message.includes("index_not_found_exception")) {
					throw createExistsAliasMcpError(`Index not found: ${args?.index}`, {
						type: "index_not_found",
						details: { originalError: error.message },
					});
				}

				if (error.message.includes("timeout") || error.message.includes("timed_out")) {
					throw createExistsAliasMcpError(`Operation timed out: ${error.message}`, {
						type: "timeout",
						details: { originalError: error.message },
					});
				}
			}

			throw createExistsAliasMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: { args },
			});
		}
	};

	// Tool registration
	// Tool registration using modern registerTool method

	server.registerTool(
		"elasticsearch_exists_alias",

		{
			title: "Exists Alias",

			description:
				"Check if index or data stream aliases exist in Elasticsearch. Best for alias validation, deployment verification, configuration checks. Use when you need to verify alias presence before operations in Elasticsearch.",

			inputSchema: existsAliasValidator.shape,
		},

		existsAliasHandler,
	);
};
