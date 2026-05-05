/* src/tools/index_management/create_index.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { OperationType, withReadOnlyCheck } from "../../utils/readOnlyMode.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

const createIndexValidator = z.object({
	index: z.string().min(1, "Index cannot be empty").describe("Name of the index to create"),
	aliases: z.object({}).passthrough().optional().describe("Index aliases to set during creation"),
	mappings: z.object({}).passthrough().optional().describe("Field mappings for the index"),
	settings: z.object({}).passthrough().optional().describe("Index settings configuration"),
	timeout: z.string().optional().describe("Operation timeout (e.g., '30s')"),
	masterTimeout: z.string().optional().describe("Master node timeout (e.g., '30s')"),
	waitForActiveShards: z
		.union([z.literal("all"), z.number().min(1).max(9)])
		.optional()
		.describe("Number of active shards to wait for"),
});

type CreateIndexParams = z.infer<typeof createIndexValidator>;

function createCreateIndexMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "index_already_exists" | "resource_already_exists";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		index_already_exists: ErrorCode.InvalidRequest,
		resource_already_exists: ErrorCode.InvalidRequest,
	};

	return new McpError(
		errorCodeMap[context.type] || ErrorCode.InternalError,
		`[elasticsearch_create_index] ${message}`,
		context.details,
	);
}

// Tool implementation
export const registerCreateIndexTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const createIndexHandler = async (args: CreateIndexParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			const params = createIndexValidator.parse(args);

			const result = await esClient.indices.create(
				{
					index: params.index,
					aliases: params.aliases as unknown as Record<string, estypes.IndicesAlias> | undefined,
					mappings: params.mappings as unknown as estypes.MappingTypeMapping | undefined,
					settings: params.settings as unknown as estypes.IndicesIndexSettings | undefined,
					timeout: params.timeout,
					master_timeout: params.masterTimeout,
					wait_for_active_shards: params.waitForActiveShards,
				},
				{
					opaqueId: "elasticsearch_create_index",
				},
			);

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, index: params.index }, "Slow index creation operation");
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
				throw createCreateIndexMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			// Handle index already exists error
			if (error instanceof Error && error.message.includes("resource_already_exists_exception")) {
				throw createCreateIndexMcpError(`Index already exists: ${args.index}`, {
					type: "index_already_exists",
					details: { index: args.index },
				});
			}

			throw createCreateIndexMcpError(error instanceof Error ? error.message : String(error), {
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
		"elasticsearch_create_index",

		{
			title: "Create Index",

			description:
				"Create an index in Elasticsearch with custom settings and mappings. Best for index initialization, schema definition, data structure setup. Use when you need to create new Elasticsearch indices with specific configurations for document storage. Uses direct JSON Schema and standardized MCP error codes.",

			inputSchema: createIndexValidator.shape,
		},

		withReadOnlyCheck("elasticsearch_create_index", createIndexHandler, OperationType.WRITE),
	);
};
