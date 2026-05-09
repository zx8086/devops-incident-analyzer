/* src/tools/core/get_mappings.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getDiscoveryRequestOptions } from "../../utils/discoveryRequestOptions.js";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

// Direct JSON Schema definition
// FIXED: Original JSON Schema definition removed - now using Zod schema inline

// Zod validator for runtime validation
const getMappingsValidator = z.object({
	index: z.string().trim().min(1).optional(),
});

type GetMappingsParams = z.infer<typeof getMappingsValidator>;

// MCP error handling
function createGetMappingsMcpError(
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
		timeout: ErrorCode.RequestTimeout,
	};

	return new McpError(errorCodeMap[context.type], `[elasticsearch_get_mappings] ${message}`, context.details);
}

// Tool implementation
export const registerGetMappingsTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const getMappingsHandler = async (args: GetMappingsParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			// Validate parameters
			const params = getMappingsValidator.parse(args);
			const { index } = params;

			logger.debug({ index }, "Getting mappings");

			const response = await esClient.indices.getMapping({ index }, getDiscoveryRequestOptions());

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration }, "Slow mappings operation");
			}

			logger.debug({ index }, "Retrieved mappings");

			return {
				content: [
					{ type: "text", text: `Mappings for index: ${index || "*"}` },
					{ type: "text", text: JSON.stringify(response, null, 2) },
				],
			};
		} catch (error) {
			// Error handling
			if (error instanceof z.ZodError) {
				throw createGetMappingsMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error) {
				if (error.message.includes("index_not_found_exception")) {
					throw createGetMappingsMcpError(`Index not found: ${args?.index || "*"}`, {
						type: "index_not_found",
						details: { originalError: error.message },
					});
				}

				// SIO-690: discovery-call timeouts surface as `RequestTimeout` so the LLM agent can
				// route around the failed call instead of treating it as a generic internal error.
				if (/timeout/i.test(error.message)) {
					const { requestTimeout } = getDiscoveryRequestOptions();
					throw createGetMappingsMcpError(
						`elasticsearch_get_mappings timed out after ${requestTimeout}ms on index '${args?.index ?? "*"}' -- narrow the index pattern to a single backing index, or skip this tool and infer fields from a sampled search.`,
						{
							type: "timeout",
							details: { originalError: error.message, requestTimeout, args },
						},
					);
				}
			}

			throw createGetMappingsMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: {
					duration: performance.now() - perfStart,
					args,
				},
			});
		}
	};

	// Tool registration using modern registerTool method
	server.registerTool(
		"elasticsearch_get_mappings",
		{
			title: "Get Field Mappings",
			description:
				"Get field mappings for Elasticsearch indices. Uses direct JSON Schema and standardized MCP error codes. PARAMETER: 'index' (string, default '*'). Best for understanding document structure, field types, and analyzers. Example: {index: 'logs-*'}",
			inputSchema: getMappingsValidator.shape,
		},
		getMappingsHandler,
	);
};
