/* src/tools/template/multi_search_template.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, TextContent, ToolRegistrationFunction } from "../types.js";

// Direct JSON Schema definition
// FIXED: Original JSON Schema definition removed - now using Zod schema inline

// SIO-1265: identical defect to elasticsearch_multi_search, one directory over -- `searches` was
// `z.array(z.object({}).passthrough())`, so nothing told the model that msearch_template also takes
// an ALTERNATING metadata/body array. Same action group (`search` in
// agents/incident-analyzer/tools/elastic-logs.yaml), same sub-agent, same failure mode available.
// Accept one object per LOGICAL search and build the alternating array here.
const searchTemplateSpec = z
	.object({
		index: z
			.string()
			.optional()
			.describe("Index or pattern for THIS search. Falls back to the top-level `index` when omitted."),
		id: z.string().optional().describe("Id of a stored search template. Provide either `id` or `source`."),
		source: z
			.string()
			.optional()
			.describe("An inline template body, as a string. Provide either `id` or `source`, not both."),
		params: z
			.record(z.string(), z.unknown())
			.optional()
			.describe('Template parameter values for THIS search. Example: {"field":"level","value":"error"}'),
	})
	.refine((s) => Boolean(s.id) !== Boolean(s.source), {
		message: "Provide exactly one of `id` (a stored template) or `source` (an inline template).",
	})
	.describe(
		'ONE templated search. Do NOT pass an alternating metadata/body array. Example: {"index":"logs-*","id":"my-template","params":{"level":"error"}}',
	);

// Zod validator for runtime validation
const multiSearchTemplateValidator = z.object({
	searches: z
		.array(searchTemplateSpec)
		.describe('One entry per templated search. Example: [{"index":"logs-*","id":"my-template","params":{"n":5}}]'),
	index: z.string().optional(),
	maxConcurrentSearches: z.number().optional(),
	ccsMinimizeRoundtrips: z.boolean().optional(),
	restTotalHitsAsInt: z.boolean().optional(),
	typedKeys: z.boolean().optional(),
});

// SIO-1265: expand into msearch_template's alternating metadata/body array. Mirrors toMsearchBody in
// ../search/multi_search.ts; kept local because the body half is a template ref, not a query DSL.
export function toMsearchTemplateBody(
	searches: Array<{ index?: string; id?: string; source?: string; params?: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
	return searches.flatMap((s) => {
		const body: Record<string, unknown> = s.id ? { id: s.id } : { source: s.source };
		if (s.params) body.params = s.params;
		return [s.index ? { index: s.index } : {}, body];
	});
}

type MultiSearchTemplateParams = z.infer<typeof multiSearchTemplateValidator>;

// MCP error handling
function createMultiSearchTemplateMcpError(
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

	return new McpError(errorCodeMap[context.type], `[elasticsearch_multi_search_template] ${message}`, context.details);
}

// Tool implementation
export const registerMultiSearchTemplateTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const multiSearchTemplateHandler = async (args: MultiSearchTemplateParams): Promise<SearchResult> => {
		const perfStart = performance.now();

		try {
			// Validate parameters
			const params = multiSearchTemplateValidator.parse(args);
			const { searches, index, maxConcurrentSearches, ccsMinimizeRoundtrips, restTotalHitsAsInt, typedKeys } = params;

			logger.debug({ searchCount: searches.length, index }, "Executing multi-search template");

			// SIO-669: prefer top-level `search_templates` over deprecated `body` wrapper.
			const result = await esClient.msearchTemplate(
				{
					search_templates: toMsearchTemplateBody(searches) as unknown as estypes.MsearchTemplateRequestItem[],
					index,
					max_concurrent_searches: maxConcurrentSearches,
					ccs_minimize_roundtrips: ccsMinimizeRoundtrips,
					rest_total_hits_as_int: restTotalHitsAsInt,
					typed_keys: typedKeys,
				},
				{
					opaqueId: "elasticsearch_multi_search_template",
				},
			);

			const duration = performance.now() - perfStart;
			if (duration > 5000) {
				logger.warn({ duration, searchCount: searches.length }, "Slow multi-search template operation");
			}

			// SIO-1265: same failure-visibility gap as elasticsearch_multi_search. msearch_template also
			// answers 200 OK with per-response `error` objects buried in the body, and the sub-agent
			// only ever reads `content`. Without a summary line a failed template search is skimmed as
			// an empty one and published as a measured negative.
			const failedSearches = (result.responses ?? []).filter((r) => "error" in r && r.error).length;
			const failureHeader =
				failedSearches > 0
					? `WARNING: ${failedSearches} of ${searches.length} template searches FAILED and returned NO results.\n` +
						'A failed search is NOT a zero-hit search. Do NOT report absence or "0 hits" on the basis ' +
						"of a failed search -- the query never ran, so nothing was measured. Read the per-response " +
						"`error` objects below, fix the template or its params, and retry.\n\n"
					: "";

			return {
				content: [{ type: "text", text: failureHeader + JSON.stringify(result, null, 2) } as TextContent],
			};
		} catch (error) {
			// Error handling
			if (error instanceof z.ZodError) {
				throw createMultiSearchTemplateMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			if (error instanceof Error) {
				if (
					error.message.includes("resource_not_found_exception") ||
					error.message.includes("template_missing_exception")
				) {
					throw createMultiSearchTemplateMcpError("Template not found in one or more searches", {
						type: "template_not_found",
						details: { originalError: error.message },
					});
				}

				if (error.message.includes("parsing_exception") || error.message.includes("query_shard_exception")) {
					throw createMultiSearchTemplateMcpError(`Template parsing failed: ${error.message}`, {
						type: "query_parsing",
						details: { searches: args?.searches },
					});
				}

				if (error.message.includes("index_not_found_exception")) {
					throw createMultiSearchTemplateMcpError(`Index not found: ${args?.index || "one or more search indices"}`, {
						type: "index_not_found",
						details: { originalError: error.message },
					});
				}
			}

			throw createMultiSearchTemplateMcpError(error instanceof Error ? error.message : String(error), {
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
		"elasticsearch_multi_search_template",

		{
			title: "Multi Search Template",

			description:
				'Execute multiple search templates in Elasticsearch. Best for batch templated queries and parameterized searches. Pass ONE object per search in `searches`, each with an optional `index`, exactly one of `id` (stored template) or `source` (inline template), and optional `params` -- this tool builds the msearch_template metadata/body pairs for you, so do NOT pass an alternating array. Example: {"searches":[{"index":"logs-*","id":"my-template","params":{"level":"error"}}]}. If any search fails, the result begins with a WARNING line naming the failure count; a failed search is not a zero-hit search.',

			inputSchema: multiSearchTemplateValidator.shape,
		},

		multiSearchTemplateHandler,
	);
};
