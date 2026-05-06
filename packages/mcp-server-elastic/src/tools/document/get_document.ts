/* src/tools/document/get_document.ts */
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

const getDocumentValidator = z.object({
	index: z
		.string()
		.min(1, "Index cannot be empty")
		.describe("REQUIRED: Name of the Elasticsearch index containing the document. Example: 'users', 'logs-2024.01'"),
	id: z
		.string()
		.min(1, "Document ID cannot be empty")
		.describe("REQUIRED: Unique identifier of the document to retrieve. Example: '123', 'user-456'"),
	source: booleanField().optional().describe("Whether to return the _source field"),
	sourceExcludes: z.array(z.string()).optional().describe("Fields to exclude from the _source"),
	sourceIncludes: z.array(z.string()).optional().describe("Fields to include in the _source"),
	routing: z.string().optional().describe("Custom routing value"),
	preference: z.string().optional().describe("Preference for shard selection"),
	realtime: booleanField().optional().describe("Whether to perform a real-time get"),
	refresh: booleanField().optional().describe("Whether to refresh before retrieval"),
	version: z.number().optional().describe("Expected document version for optimistic concurrency control"),
	versionType: z
		.enum(["internal", "external", "external_gte"])
		.optional()
		.describe("Version type for concurrency control"),
});

type GetDocumentParams = z.infer<typeof getDocumentValidator>;

function createGetDocumentMcpError(
	error: Error | string,
	context: { type: "validation" | "execution" | "document_not_found" | "version_conflict"; details?: unknown },
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		document_not_found: ErrorCode.InvalidParams,
		version_conflict: ErrorCode.InvalidRequest,
	};

	return new McpError(
		errorCodeMap[context.type] || ErrorCode.InternalError,
		`[elasticsearch_get_document] ${message}`,
		context.details,
	);
}

// Tool implementation
export const registerGetDocumentTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const getDocumentHandler = async (args: GetDocumentParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			// Validate parameters
			const params = getDocumentValidator.parse(args);

			const result = await esClient.get({
				index: params.index,
				id: params.id,
				_source: params.source,
				_source_excludes: params.sourceExcludes,
				_source_includes: params.sourceIncludes,
				routing: params.routing,
				preference: params.preference,
				realtime: params.realtime,
				refresh: params.refresh,
				version: params.version,
				version_type: params.versionType,
			});

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration }, "Slow document retrieval");
			}

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		} catch (error) {
			// Error handling
			if (error instanceof z.ZodError) {
				throw createGetDocumentMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			// Handle document not found error
			if (error instanceof Error && error.message.includes("document_not_found")) {
				throw createGetDocumentMcpError("Document not found", {
					type: "document_not_found",
					details: {
						duration: performance.now() - perfStart,
						args,
					},
				});
			}

			throw createGetDocumentMcpError(error instanceof Error ? error.message : String(error), {
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
		"elasticsearch_get_document",

		{
			title: "Get Document",

			description:
				"Get a document from Elasticsearch by index and id. Best for retrieving specific JSON documents, document validation, real-time data access. This tool REQUIRES both 'index' and 'id' parameters - it cannot work with empty {}. Use when you need to fetch individual documents by their unique identifier from Elasticsearch indices. Uses direct JSON Schema and standardized MCP error codes.",

			inputSchema: getDocumentValidator.shape,
		},

		getDocumentHandler,
	);
};
