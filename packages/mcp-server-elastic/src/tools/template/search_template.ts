/* src/tools/template/search_template.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

import type { Client } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, TextContent, ToolRegistrationFunction } from "../types.js";

// Direct JSON Schema definition
// FIXED: Original JSON Schema definition removed - now using Zod schema inline

// Zod validator for runtime validation
const searchTemplateValidator = z.object({
	index: z.string().optional(),
	id: z.string().optional(),
	source: z.string().optional(),
	params: z.object({}).passthrough().optional(),
	explain: z.boolean().optional(),
	profile: z.boolean().optional(),
	allowNoIndices: z.boolean().optional(),
	expandWildcards: z.enum(["all", "open", "closed", "hidden", "none"]).optional(),
	ignoreUnavailable: z.boolean().optional(),
	ignoreThrottled: z.boolean().optional(),
	preference: z.string().optional(),
	routing: z.string().optional(),
	scroll: z.string().optional(),
	searchType: z.enum(["query_then_fetch", "dfs_query_then_fetch"]).optional(),
	typedKeys: z.boolean().optional(),
});

type SearchTemplateParams = z.infer<typeof searchTemplateValidator>;

// MCP error handling
function createSearchTemplateMcpError(
	error: Error | string,
	context: {
		type: "validation" | "execution" | "template_not_found" | "query_parsing" | "index_not_found";
		details?: unknown;
	},
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
		template_not_found: ErrorCode.InvalidParams,
		query_parsing: ErrorCode.InvalidParams,
		index_not_found: ErrorCode.InvalidParams,
	};

	return new McpError(errorCodeMap[context.type], `[elasticsearch_search_template] ${message}`, context.details);
}

// Tool implementation
export const registerSearchTemplateTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const searchTemplateHandler = async (args: SearchTemplateParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			// Validate parameters
			const params = searchTemplateValidator.parse(args);
			const {
				index,
				id,
				source,
				params: templateParams,
				explain,
				profile,
				allowNoIndices,
				expandWildcards,
				ignoreUnavailable,
				ignoreThrottled,
				preference,
				routing,
				scroll,
				searchType,
				typedKeys,
			} = params;

			logger.debug({ index, id, hasSource: !!source }, "Executing search template");

			const result = await esClient.searchTemplate(
				{
					index,
					id,
					source,
					params: templateParams,
					explain,
					profile,
					allow_no_indices: allowNoIndices,
					expand_wildcards: expandWildcards,
					ignore_unavailable: ignoreUnavailable,
					ignore_throttled: ignoreThrottled,
					preference,
					routing,
					scroll,
					search_type: searchType,
					typed_keys: typedKeys,
				},
				{
					opaqueId: "elasticsearch_search_template",
				},
			);

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration }, "Slow search template operation");
			}

			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) } as TextContent],
			};
		} catch (error) {
			// Error handling
			if (error instanceof z.ZodError) {
				throw createSearchTemplateMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error) {
				if (
					error.message.includes("resource_not_found_exception") ||
					error.message.includes("template_missing_exception")
				) {
					throw createSearchTemplateMcpError(`Template not found: ${args?.id || "inline template"}`, {
						type: "template_not_found",
						details: { originalError: error.message },
					});
				}

				if (error.message.includes("parsing_exception") || error.message.includes("query_shard_exception")) {
					throw createSearchTemplateMcpError(`Template parsing failed: ${error.message}`, {
						type: "query_parsing",
						details: { template: args?.source, params: args?.params },
					});
				}

				if (error.message.includes("index_not_found_exception")) {
					throw createSearchTemplateMcpError(`Index not found: ${args?.index || "*"}`, {
						type: "index_not_found",
						details: { originalError: error.message },
					});
				}
			}

			throw createSearchTemplateMcpError(error instanceof Error ? error.message : String(error), {
				type: "execution",
				details: {
					duration: performance.now() - perfStart,
					args,
				},
			});
		}
	};

	// Tool registration - READ operation
	// Tool registration using modern registerTool method

	server.registerTool(
		"elasticsearch_search_template",

		{
			title: "Search Template",

			description:
				"Execute a search template in Elasticsearch. Uses direct JSON Schema and standardized MCP error codes. Best for parameterized queries, reusable search patterns, query standardization. Use when you need to run templated searches with dynamic parameters in Elasticsearch. TIP: Use either id for stored templates or source for inline templates, provide params for variable substitution.",

			inputSchema: searchTemplateValidator.shape,
		},

		searchTemplateHandler,
	);
};
