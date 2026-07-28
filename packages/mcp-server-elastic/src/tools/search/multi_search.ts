/* src/tools/search/multi_search.ts */
/* FIXED: Uses Zod Schema instead of JSON Schema for MCP compatibility */

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { ProgressTracker } from "../../utils/notifications.js";
import { createProgressTracker, notificationManager } from "../../utils/notifications.js";
import { booleanField } from "../../utils/zodHelpers.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

// Direct JSON Schema definition
// FIXED: Original JSON Schema definition removed - now using Zod schema inline

// SIO-1265: msearch's wire format is an ALTERNATING array -- metadata line, body line, repeating.
// The old schema was `z.array(z.object({}).passthrough())`, which said nothing at all, and neither
// did the tool description. Run 2445908e guessed the natural-looking `{header, body}` shape and ES
// answered `illegal_argument_exception: key [header] is not supported in the metadata section`.
// The failed search was then published in the report as "0 hits" -- a fabricated negative.
//
// Rather than document the alternating contract and hope, accept one object per LOGICAL search and
// build the alternating array here (see toMsearchBody). The footgun is removed instead of labelled:
// there is no longer a wrong-but-natural shape for the model to reach for. Nothing in the repo
// depended on the raw alternating form -- there are no programmatic callers and the two existing
// tests are `test.skip` -- so no compatibility union is offered; a union would re-open the footgun
// by making the wrong shape look plausible again.
//
// Per SIO-1085, the .describe() carries a literal copy-pasteable example, not prose.
const searchSpec = z
	.object({
		index: z
			.string()
			.optional()
			.describe("Index or pattern for THIS search. Falls back to the top-level `index` when omitted."),
		// SIO-1265: the message is the recovery instruction. A bare "expected record, received
		// undefined" tells the model the shape is wrong but not what the right one is, and the whole
		// point of this ticket is that the model could not see the contract.
		query: z
			.record(z.string(), z.unknown(), {
				error:
					'Each entry in `searches` must be {index?, query}, where `query` is the search body. Do NOT use {header, body} and do NOT pass an alternating metadata/body array. Example: {"index":"logs-*","query":{"query":{"match_all":{}},"size":5}}',
			})
			.describe(
				'The search body for THIS search, exactly as you would POST to _search. Example: {"query":{"match_all":{}},"size":10}',
			),
	})
	.describe(
		'ONE search. Do NOT pass an alternating metadata/body array and do NOT use {header, body}. Example: {"index":"logs-*","query":{"query":{"term":{"level":"error"}},"size":5}}',
	);

// Zod validator for runtime validation
const multiSearchValidator = z.object({
	searches: z
		.array(searchSpec)
		.describe(
			'One entry per search. Example: [{"index":"logs-*","query":{"query":{"match_all":{}},"size":1}},{"index":"metrics-*","query":{"query":{"term":{"host":"a"}},"size":5}}]',
		),
	index: z.string().optional(),
	maxConcurrentSearches: z.number().optional(),
	ccsMinimizeRoundtrips: booleanField().optional(),
	restTotalHitsAsInt: booleanField().optional(),
	typedKeys: booleanField().optional(),
});

// SIO-1265: expand the per-search objects into msearch's alternating metadata/body array. A search
// with no `index` of its own gets an EMPTY metadata object and inherits the request-level `index`,
// which is exactly how ES resolves it.
export function toMsearchBody(
	searches: Array<{ index?: string; query: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
	return searches.flatMap((s) => [s.index ? { index: s.index } : {}, s.query]);
}

type MultiSearchParams = z.infer<typeof multiSearchValidator>;

// MCP error handling
function createMultiSearchMcpError(
	error: Error | string,
	context: { type: "validation" | "execution"; details?: unknown },
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
	};

	return new McpError(errorCodeMap[context.type], `[elasticsearch_multi_search] ${message}`, context.details);
}

// Tool implementation
export const registerMultiSearchTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const multiSearchHandler = async (args: MultiSearchParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		let tracker: ProgressTracker | undefined;
		let params: z.infer<typeof multiSearchValidator> | undefined;

		try {
			// Validate parameters
			params = multiSearchValidator.parse(args);

			const searchCount = params.searches?.length || 0;

			// Create progress tracker for multi-search operation
			tracker = await createProgressTracker(
				"multi_search",
				100, // percentage-based for parallel execution
				`Executing ${searchCount} searches${params.index ? ` on ${params.index}` : " across indices"}`,
			);

			logger.debug(
				{
					searchCount,
					index: params.index,
					maxConcurrentSearches: params.maxConcurrentSearches,
				},
				"Starting multi-search operation",
			);

			// Send initial notification with multi-search details
			await notificationManager.sendInfo(`Starting multi-search: ${searchCount} parallel searches`, {
				operation_type: "multi_search",
				total_searches: searchCount,
				target_index: params.index,
				max_concurrent_searches: params.maxConcurrentSearches,
				ccs_minimize_roundtrips: params.ccsMinimizeRoundtrips,
			});

			// Warn about large batch operations
			if (searchCount > 20) {
				await notificationManager.sendWarning(
					`Large multi-search batch: ${searchCount} searches may impact cluster performance`,
					{
						operation_type: "multi_search",
						search_count: searchCount,
						performance_warning: true,
						recommendation: "Consider reducing batch size or using lower concurrency for better cluster stability",
						suggested_concurrency: Math.min(5, Math.ceil(searchCount / 4)),
					},
				);
			}

			if (!searchCount || searchCount === 0) {
				await tracker.complete({ searches_count: 0 }, "No searches provided for multi-search operation");

				await notificationManager.sendWarning("Multi-search called with no search queries", {
					operation_type: "multi_search",
					warning: "No searches array provided or empty searches array",
					recommendation: "Provide at least one search query in the searches array",
				});

				return {
					content: [{ type: "text", text: "No searches provided" }],
				};
			}

			await tracker.updateProgress(25, `Submitting ${searchCount} searches for parallel execution`);

			const result = await esClient.msearch({
				// SIO-1265: searchCount is now the LOGICAL search count. It used to be the raw array
				// length, i.e. 2x the real count under the alternating form, and it is the denominator
				// for every "N/M successful" string and for failure_rate.
				searches: toMsearchBody(params.searches) as unknown as estypes.MsearchRequestItem[],
				index: params.index,
				max_concurrent_searches: params.maxConcurrentSearches,
				ccs_minimize_roundtrips: params.ccsMinimizeRoundtrips,
				rest_total_hits_as_int: params.restTotalHitsAsInt,
				typed_keys: params.typedKeys,
			});

			await tracker.updateProgress(80, "Processing multi-search results");

			const duration = performance.now() - perfStart;

			// Analyze results
			const responses = result.responses || [];
			let successfulSearches = 0;
			let failedSearches = 0;
			let totalHits = 0;

			for (const response of responses) {
				if ("error" in response && response.error) {
					failedSearches++;
				} else if ("hits" in response) {
					successfulSearches++;
					if (response.hits?.total) {
						totalHits += typeof response.hits.total === "number" ? response.hits.total : response.hits.total.value || 0;
					}
				}
			}

			const searchSummary = {
				total_searches: searchCount,
				successful_searches: successfulSearches,
				failed_searches: failedSearches,
				total_hits_across_searches: totalHits,
				duration_ms: duration,
				avg_time_per_search: searchCount > 0 ? Math.round(duration / searchCount) : 0,
				concurrency_used: params.maxConcurrentSearches,
			};

			await tracker.complete(
				searchSummary,
				`Multi-search completed: ${successfulSearches}/${searchCount} searches successful in ${Math.round(duration)}ms`,
			);

			if (duration > 5000) {
				logger.warn({ duration }, "Slow operation");

				await notificationManager.sendWarning(
					`Slow multi-search: ${Math.round(duration / 1000)}s for ${searchCount} searches`,
					{
						operation_type: "multi_search",
						...searchSummary,
						performance_warning: true,
						recommendation:
							searchCount > 10
								? "Consider reducing batch size, optimizing queries, or increasing cluster resources"
								: "Multi-search took longer than expected - check query complexity and cluster health",
					},
				);
			} else {
				await notificationManager.sendInfo(
					`Multi-search completed: ${successfulSearches}/${searchCount} searches successful`,
					{
						operation_type: "multi_search",
						...searchSummary,
						performance_note: duration > 1000 ? "Standard execution time" : "Fast execution",
					},
				);
			}

			// Send failure notification if any searches failed
			if (failedSearches > 0) {
				const failedDetails = responses
					.map((response, index) =>
						"error" in response && response.error ? { search_index: index, error: response.error } : null,
					)
					.filter(Boolean)
					.slice(0, 5); // Show first 5 failures

				await notificationManager.sendWarning(`${failedSearches} out of ${searchCount} searches failed`, {
					operation_type: "multi_search",
					failed_searches: failedSearches,
					successful_searches: successfulSearches,
					failure_rate: `${((failedSearches / searchCount) * 100).toFixed(1)}%`,
					failed_details: failedDetails,
					recommendation: "Review failed search queries and check index availability",
				});
			}

			// SIO-1265: state the failure IN THE TOOL RESULT. notificationManager never reaches the
			// sub-agent -- sendMessage (utils/notifications.ts) logs locally and deliberately does not
			// transmit, and only sendProgress hits the wire (a numeric token/progress/total, no text).
			// The model reads `content` and nothing else. On run 2445908e every per-response error sat
			// buried in the raw msearch JSON with no summary line, the model skimmed it as an empty
			// result, and the report published "0 hits ... in exact window" -- asserting a measured
			// negative that was never measured. A failed search is not a zero-hit search.
			const failureHeader =
				failedSearches > 0
					? `WARNING: ${failedSearches} of ${searchCount} searches FAILED and returned NO results.\n` +
						'A failed search is NOT a zero-hit search. Do NOT report absence, "0 hits", or ' +
						'"no matches found" on the basis of a failed search -- the query never ran, so nothing ' +
						"was measured. Read the per-response `error` objects below, fix the query, and retry; " +
						"if you cannot, report it as a failed query.\n\n"
					: "";

			return {
				content: [{ type: "text", text: failureHeader + JSON.stringify(result, null, 2) }],
			};
		} catch (error) {
			await tracker?.fail(error instanceof Error ? error : new Error(String(error)), "Multi-search operation failed");

			await notificationManager.sendError(
				"Multi-search operation failed",
				error instanceof Error ? error : new Error(String(error)),
				{
					operation_type: "multi_search",
					total_searches: params?.searches?.length || 0,
					target_index: params?.index,
					duration_ms: performance.now() - perfStart,
					failure_context: "Multi-search execution failed - check search queries and cluster connectivity",
				},
			);

			// Error handling
			if (error instanceof z.ZodError) {
				throw createMultiSearchMcpError(`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`, {
					type: "validation",
					details: { validationErrors: error.issues, providedArgs: args },
				});
			}

			throw createMultiSearchMcpError(error instanceof Error ? error.message : String(error), {
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
		"elasticsearch_multi_search",

		{
			title: "Multi Search",

			description:
				'Perform multiple searches in Elasticsearch in a single request. Best for batch search operations, dashboard queries, parallel search execution. Pass ONE object per search in `searches`, each with an optional `index` and a `query` body -- this tool builds the msearch metadata/body pairs for you, so do NOT pass an alternating array and do NOT use {header, body}. Example: {"searches":[{"index":"logs-*","query":{"query":{"match_all":{}},"size":1}}]}. If any search fails, the result begins with a WARNING line naming the failure count; a failed search is not a zero-hit search.',

			inputSchema: multiSearchValidator.shape,
		},

		multiSearchHandler,
	);
};
