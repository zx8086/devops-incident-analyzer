// src/tools/search/async_search.ts
// SIO-1391: async search submit/get/delete. Targets the recurring failure where a heavy aggregation
// over a wide window (now-30d) on billion-doc traces-apm* indices exceeds the search timeout --
// SIO-708 already had to raise elasticsearch_search's per-call timeout to 60s for exactly this.
// Async search is the principled alternative: submit, poll, retrieve, and delete when done.

import type { Client, estypes } from "@elastic/elasticsearch";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import type { SearchResult, ToolRegistrationFunction } from "../types.js";

function createAsyncSearchMcpError(
	toolName: string,
	error: Error | string,
	context: { type: "validation" | "execution"; details?: unknown },
): McpError {
	const message = error instanceof Error ? error.message : error;

	const errorCodeMap = {
		validation: ErrorCode.InvalidParams,
		execution: ErrorCode.InternalError,
	};

	return new McpError(errorCodeMap[context.type], `[${toolName}] ${message}`, context.details);
}

// Shared across all three tools: an async search that is still running has NOT proven absence, so
// the caller must never read a partial/empty response as a finished result. Every response carries
// these flags explicitly rather than leaving them buried in the raw payload.
function summarizeAsyncResponse(raw: unknown): Record<string, unknown> {
	const r = raw as {
		id?: string;
		is_running?: boolean;
		is_partial?: boolean;
		start_time_in_millis?: number;
		expiration_time_in_millis?: number;
		response?: unknown;
	};
	return {
		id: r.id,
		is_running: r.is_running,
		is_partial: r.is_partial,
		...(r.is_running || r.is_partial
			? {
					_warning:
						"Results are INCOMPLETE (is_running or is_partial is true). Poll elasticsearch_async_search_get with this id until is_running is false. A partial result is NOT a valid basis for an absence conclusion.",
				}
			: {}),
		expiration_time_in_millis: r.expiration_time_in_millis,
		response: r.response,
	};
}

const submitValidator = z.object({
	index: z.string().min(1).describe("Index or index pattern to search, e.g. 'traces-apm*' or 'logs-*'."),
	query: z.object({}).passthrough().optional().describe("Query DSL query clause."),
	aggs: z.object({}).passthrough().optional().describe("Aggregations clause. The usual reason to go async."),
	size: z.number().int().min(0).optional().describe("Number of hits to return. Use 0 for aggregation-only."),
	waitForCompletionTimeout: z
		.string()
		.optional()
		.describe(
			"How long to wait inline before returning an id, e.g. '5s'. Short waits let fast searches return results immediately without a second call. Default '1s'.",
		),
	keepAlive: z
		.string()
		.optional()
		.describe("How long the cluster retains the results, e.g. '5m'. Keep short; always delete when done."),
});

type SubmitParams = z.infer<typeof submitValidator>;

export const registerAsyncSearchSubmitTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: SubmitParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		try {
			const params = submitValidator.parse(args);

			const result = await esClient.asyncSearch.submit(
				{
					index: params.index,
					// Same double-cast as core/search.ts: query/aggs come from Zod passthrough
					// validators, which TS sees as Record<string, unknown>, while the SDK types them
					// strictly. The runtime structure is user-supplied either way.
					...(params.query && { query: params.query as unknown as estypes.QueryDslQueryContainer }),
					...(params.aggs && {
						aggs: params.aggs as unknown as Record<string, estypes.AggregationsAggregationContainer>,
					}),
					...(params.size !== undefined && { size: params.size }),
					wait_for_completion_timeout: params.waitForCompletionTimeout ?? "1s",
					keep_alive: params.keepAlive ?? "5m",
					// Without this, a search that finishes inside wait_for_completion_timeout is NOT
					// retained, so a follow-up _get on the returned id 404s. Keeping it makes the
					// submit -> get -> delete lifecycle uniform whether or not the search was fast.
					keep_on_completion: true,
				},
				{ opaqueId: "elasticsearch_async_search_submit" },
			);

			const duration = performance.now() - perfStart;
			if (duration > 5000) logger.warn({ duration }, "Slow operation");

			return {
				content: [{ type: "text", text: JSON.stringify(summarizeAsyncResponse(result), null, 2) }],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createAsyncSearchMcpError(
					"elasticsearch_async_search_submit",
					`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`,
					{ type: "validation", details: { validationErrors: error.issues, providedArgs: args } },
				);
			}
			// SIO-1391 (Layer 2, per SIO-1388): rethrow the RAW ES error so the central interceptor
			// classifies it structurally instead of from a rebuilt message.
			throw error;
		}
	};

	server.registerTool(
		"elasticsearch_async_search_submit",
		{
			title: "Submit Async Search",
			description:
				"Start a long-running search that would otherwise time out -- heavy aggregations over wide windows (now-30d) on very large indices such as traces-apm*. Returns an id plus is_running/is_partial. If is_running is true, poll elasticsearch_async_search_get with that id, then call elasticsearch_async_search_delete when finished. For normal searches use elasticsearch_search; only reach for this when a search has already timed out or is expected to.",
			inputSchema: submitValidator.shape,
		},
		handler,
	);
};

const getValidator = z.object({
	id: z.string().min(1).describe("Async search id returned by elasticsearch_async_search_submit."),
	waitForCompletionTimeout: z
		.string()
		.optional()
		.describe("How long this call blocks waiting for completion, e.g. '5s'. Default '1s'."),
});

type GetParams = z.infer<typeof getValidator>;

export const registerAsyncSearchGetTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: GetParams): Promise<SearchResult> => {
		const perfStart = performance.now();
		try {
			const params = getValidator.parse(args);

			const result = await esClient.asyncSearch.get(
				{
					id: params.id,
					wait_for_completion_timeout: params.waitForCompletionTimeout ?? "1s",
				},
				{ opaqueId: "elasticsearch_async_search_get" },
			);

			const duration = performance.now() - perfStart;
			if (duration > 5000) logger.warn({ duration }, "Slow operation");

			return {
				content: [{ type: "text", text: JSON.stringify(summarizeAsyncResponse(result), null, 2) }],
			};
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createAsyncSearchMcpError(
					"elasticsearch_async_search_get",
					`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`,
					{ type: "validation", details: { validationErrors: error.issues, providedArgs: args } },
				);
			}
			// SIO-1391 (Layer 2, per SIO-1388): rethrow the RAW ES error so the central interceptor
			// classifies it structurally instead of from a rebuilt message.
			throw error;
		}
	};

	server.registerTool(
		"elasticsearch_async_search_get",
		{
			title: "Get Async Search Results",
			description:
				"Retrieve results for an async search id from elasticsearch_async_search_submit. Check is_running: while true the results are INCOMPLETE and must not be treated as a final or absent answer -- poll again. Once is_running is false, call elasticsearch_async_search_delete to release the results.",
			inputSchema: getValidator.shape,
		},
		handler,
	);
};

const deleteValidator = z.object({
	id: z.string().min(1).describe("Async search id to delete."),
});

type DeleteParams = z.infer<typeof deleteValidator>;

export const registerAsyncSearchDeleteTool: ToolRegistrationFunction = (server: McpServer, esClient: Client) => {
	const handler = async (args: DeleteParams): Promise<SearchResult> => {
		try {
			const params = deleteValidator.parse(args);

			const result = await esClient.asyncSearch.delete(
				{ id: params.id },
				{ opaqueId: "elasticsearch_async_search_delete" },
			);

			return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
		} catch (error) {
			if (error instanceof z.ZodError) {
				throw createAsyncSearchMcpError(
					"elasticsearch_async_search_delete",
					`Validation failed: ${error.issues.map((e) => e.message).join(", ")}`,
					{ type: "validation", details: { validationErrors: error.issues, providedArgs: args } },
				);
			}
			// SIO-1391 (Layer 2, per SIO-1388): rethrow the RAW ES error so the central interceptor
			// classifies it structurally instead of from a rebuilt message.
			throw error;
		}
	};

	server.registerTool(
		"elasticsearch_async_search_delete",
		{
			title: "Delete Async Search",
			description:
				"Delete a stored async search by id, releasing its results on the cluster. Call this once you have retrieved what you need from elasticsearch_async_search_get. Deletes only the saved search results -- it never deletes indexed data.",
			inputSchema: deleteValidator.shape,
		},
		handler,
	);
};
