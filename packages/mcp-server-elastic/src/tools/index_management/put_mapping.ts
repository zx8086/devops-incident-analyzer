/* src/tools/index_management/put_mapping.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { coerceBoolean } from "../../utils/zodHelpers.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

const putMappingValidator = z.object({
	index: z.string().min(1, "Index cannot be empty").describe("Name of the index to update mapping for"),
	properties: z.object({}).passthrough().optional().describe("Field mappings to add or update"),
	runtime: z.object({}).passthrough().optional().describe("Runtime fields configuration"),
	meta: z.object({}).passthrough().optional().describe("Metadata for the mapping"),
	dynamic: z.enum(["true", "false", "strict", "runtime"]).optional().describe("Dynamic mapping behavior"),
	dateDetection: coerceBoolean.optional().describe("Enable or disable date detection"),
	dynamicDateFormats: z.array(z.string()).optional().describe("Dynamic date formats"),
	dynamicTemplates: z.array(z.object({}).passthrough()).optional().describe("Dynamic mapping templates"),
	numericDetection: coerceBoolean.optional().describe("Enable or disable numeric detection"),
	timeout: z.string().optional().describe("Operation timeout (e.g., '30s')"),
	masterTimeout: z.string().optional().describe("Master node timeout (e.g., '30s')"),
	ignoreUnavailable: coerceBoolean.optional().describe("Ignore unavailable indices"),
	allowNoIndices: coerceBoolean.optional().describe("Allow wildcards that match no indices"),
	expandWildcards: z
		.enum(["all", "open", "closed", "hidden", "none"])
		.optional()
		.describe("Which indices to expand wildcards to"),
	writeIndexOnly: coerceBoolean.optional().describe("Update only the write index for aliases"),
});

type PutMappingParams = z.infer<typeof putMappingValidator>;

function createPutMappingMcpError(
	error: Error | string,
	context: { type: "validation" | "execution" | "index_not_found" | "resource_already_exists"; details?: unknown },
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		index_not_found: ErrorCode.InvalidParams,
		resource_already_exists: ErrorCode.InvalidRequest,
	};

	return new McpError(
		errorCodeMap[context.type] || ErrorCode.InternalError,
		`[elasticsearch_put_mapping] ${message}`,
		context.details,
	);
}

// Tool implementation
export const registerPutMappingTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const putMappingHandler = async (args: PutMappingParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			const params = putMappingValidator.parse(args);

			const result = await esClient.indices.putMapping({
				index: params.index,
				properties: params.properties as unknown as Record<string, estypes.MappingProperty> | undefined,
				runtime: params.runtime as unknown as Record<string, estypes.MappingRuntimeField> | undefined,
				_meta: params.meta as estypes.Metadata | undefined,
				dynamic: params.dynamic,
				date_detection: params.dateDetection,
				dynamic_date_formats: params.dynamicDateFormats,
				dynamic_templates: params.dynamicTemplates as unknown as
					| Record<string, estypes.MappingDynamicTemplate>[]
					| undefined,
				numeric_detection: params.numericDetection,
				timeout: params.timeout,
				master_timeout: params.masterTimeout,
				ignore_unavailable: params.ignoreUnavailable,
				allow_no_indices: params.allowNoIndices,
				expand_wildcards: params.expandWildcards,
				write_index_only: params.writeIndexOnly,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, index: params.index }, "Slow mapping update operation");
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
				throw createPutMappingMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			// Handle index not found error
			if (error instanceof Error && error.message.includes("index_not_found_exception")) {
				throw createPutMappingMcpError(`Index not found: ${args.index}`, {
					type: "index_not_found",
					details: { index: args.index },
				});
			}

			// Handle mapping conflicts
			if (error instanceof Error && error.message.includes("strict_dynamic_mapping_exception")) {
				throw createPutMappingMcpError(`Mapping conflict: ${error.message}`, {
					type: "resource_already_exists",
					details: { index: args.index },
				});
			}

			throw createPutMappingMcpError(error instanceof Error ? error.message : String(error), {
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
		"elasticsearch_put_mapping",

		{
			title: "Put Mapping",

			description:
				"Update index mappings in Elasticsearch. Best for schema evolution, field addition, mapping modifications. Use when you need to add new fields or update existing field mappings in Elasticsearch indices. Uses direct JSON Schema and standardized MCP error codes.",

			inputSchema: putMappingValidator.shape,
		},

		putMappingHandler,
	);
};
