// tests/unit/tools/search-shard-failure.test.ts

import { describe, expect, test } from "bun:test";
import type { Client, estypes } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerSearchTool } from "../../../src/tools/core/search.js";
import { getToolFromServer } from "../../utils/elasticsearch-client.js";

type SearchArgs = { index?: string; query?: unknown; size?: number; aggs?: unknown };
type SearchResult = { content: Array<{ type: string; text: string }> };
type Handler = (args: SearchArgs) => Promise<SearchResult>;

// SIO-1328: the exact response shape Elasticsearch returns when a `terms` agg targets a
// match_only_text field -- allow_partial_search_results=true (the default) means the
// request still returns HTTP 200 with a per-shard failure list, NOT a thrown error, so the
// search.ts catch block never runs; the shard-failure check must live in the success path.
// LIVE-VERIFIED shape (against eu-b2b): NOT all shards fail identically -- some
// shards report `successful` simply because they had zero matching base-filter documents to
// run the illegal aggregation against, not because they tolerated the bad field. A 6-of-8
// partial failure still reported hits.total:0, an undercounted/untrustworthy result, so the
// fix triggers on ANY shard failure of this kind, not only a total (0-successful) wipeout.
function shardFailureResponse(opts: { total: number; successful: number; failed: number }): estypes.SearchResponse {
	return {
		took: 5,
		timed_out: false,
		_shards: {
			total: opts.total,
			successful: opts.successful,
			skipped: 0,
			failed: opts.failed,
			failures: [
				{
					shard: 0,
					index: ".ds-logs-apm.error-default-2026.07.30-000472",
					node: "node-1",
					reason: {
						type: "illegal_argument_exception",
						reason: "match_only_text fields do not support sorting and aggregations",
					},
				},
			],
		},
		hits: { total: { value: 0, relation: "eq" }, max_score: null, hits: [] },
		aggregations: {},
	} as unknown as estypes.SearchResponse;
}

function makeStub(searchResponse: estypes.SearchResponse): Client {
	return {
		indices: {
			getMapping: async () => ({}),
		},
		search: async () => searchResponse,
	} as unknown as Client;
}

function makeHandler(searchResponse: estypes.SearchResponse): Handler {
	const server = new McpServer({ name: "test", version: "1.0.0" });
	registerSearchTool(server, makeStub(searchResponse));
	const tool = getToolFromServer(server, "elasticsearch_search");
	if (!tool) throw new Error("tool not registered");
	return tool.handler as Handler;
}

const ErrorEnvelopeSchema = z.object({
	_error: z.object({
		kind: z.string(),
		category: z.string(),
		message: z.string(),
		advice: z.string().optional(),
	}),
});
type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

// McpError's own message is `MCP error -32602: <json>` (or similar) -- the envelope is the
// SECOND constructor arg (JSON.stringify(envelope)), which the SDK folds into `.message`.
function parseErrorEnvelope(err: McpError): ErrorEnvelope {
	const jsonStart = err.message.indexOf("{");
	if (jsonStart === -1) throw new Error(`expected a JSON envelope in the error message, got: ${err.message}`);
	return ErrorEnvelopeSchema.parse(JSON.parse(err.message.slice(jsonStart)));
}

describe("elasticsearch_search shard-failure detection (SIO-1328)", () => {
	test("throws a bad-query envelope when every shard failed, instead of returning a phantom empty success", async () => {
		const handler = makeHandler(shardFailureResponse({ total: 8, successful: 0, failed: 8 }));
		await expect(
			handler({
				index: "logs-apm.error-*",
				size: 0,
				query: { match_all: {} },
				aggs: { by_message: { terms: { field: "error.exception.message", size: 5 } } },
			}),
		).rejects.toThrow(McpError);
	});

	// LIVE-VERIFIED: a real eu-b2b query against this exact agg shape returned 6-of-8 shards
	// failed (NOT 8-of-8) -- the 2 "successful" shards simply had no matching base-filter
	// documents, not tolerance for the bad field. hits.total was still 0 despite those two
	// shards succeeding, so a partial failure is exactly as untrustworthy as a total one.
	test("throws even on a PARTIAL shard failure -- every shard runs the same broken agg, so a partial result is still untrustworthy", async () => {
		const handler = makeHandler(shardFailureResponse({ total: 8, successful: 2, failed: 6 }));
		try {
			await handler({
				index: "logs-apm.error-*",
				size: 0,
				query: { match_all: {} },
				aggs: { by_message: { terms: { field: "error.exception.message", size: 5 } } },
			});
			throw new Error("expected handler to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			const envelope = parseErrorEnvelope(err as McpError);
			expect(envelope._error.kind).toBe("bad-query");
			expect(envelope._error.category).toBe("bad-query");
			expect(envelope._error.message).toContain("illegal_argument_exception");
			expect(envelope._error.message).toContain("6");
			expect(envelope._error.message).toContain("8");
		}
	});

	// SIO-1328 (CodeRabbit on PR #559): parse the structured { _error } envelope instead of
	// substring-matching the message -- a substring check can pass even if the envelope shape is
	// wrong (missing/renamed fields), which is exactly the class of bug this tool exists to
	// prevent agents from silently tripping over.
	test("the thrown error surfaces the real per-shard reason as a structured _error envelope, not a generic message", async () => {
		const handler = makeHandler(shardFailureResponse({ total: 8, successful: 0, failed: 8 }));
		try {
			await handler({
				index: "logs-apm.error-*",
				size: 0,
				query: { match_all: {} },
				aggs: { by_message: { terms: { field: "error.exception.message", size: 5 } } },
			});
			throw new Error("expected handler to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			const envelope = parseErrorEnvelope(err as McpError);
			expect(envelope._error.kind).toBe("bad-query");
			expect(envelope._error.category).toBe("bad-query");
			expect(envelope._error.message).toContain("illegal_argument_exception");
			expect(envelope._error.message).toContain("8 shard");
		}
	});

	test("classifies a genuine infra-level shard failure (node lost) as network, not bad-query", async () => {
		const infraFailure = shardFailureResponse({ total: 8, successful: 0, failed: 8 });
		(infraFailure._shards.failures as Array<{ reason: { type: string; reason: string } }>)[0].reason = {
			type: "node_not_connected_exception",
			reason: "[node-1][10.0.0.1:9300] Node not connected",
		};
		const handler = makeHandler(infraFailure);
		try {
			await handler({ index: "logs-apm.error-*", size: 0, query: { match_all: {} } });
			throw new Error("expected handler to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			const envelope = parseErrorEnvelope(err as McpError);
			expect(envelope._error.kind).toBe("network");
			expect(envelope._error.category).not.toBe("bad-query");
		}
	});

	test("rejects a timed_out:true response even when _shards.failed is 0", async () => {
		const timedOut: estypes.SearchResponse = {
			took: 30000,
			timed_out: true,
			_shards: { total: 8, successful: 8, skipped: 0, failed: 0 },
			hits: { total: { value: 0, relation: "eq" }, max_score: null, hits: [] },
			aggregations: {},
		} as unknown as estypes.SearchResponse;
		const handler = makeHandler(timedOut);
		try {
			await handler({ index: "logs-*", size: 0, query: { match_all: {} } });
			throw new Error("expected handler to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			const envelope = parseErrorEnvelope(err as McpError);
			expect(envelope._error.message).toContain("timed out");
		}
	});

	test("does NOT throw on a genuine clean zero-hit result (all shards succeeded, no failures)", async () => {
		const clean: estypes.SearchResponse = {
			took: 3,
			timed_out: false,
			_shards: { total: 8, successful: 8, skipped: 0, failed: 0 },
			hits: { total: { value: 0, relation: "eq" }, max_score: null, hits: [] },
			aggregations: {},
		} as unknown as estypes.SearchResponse;
		const handler = makeHandler(clean);
		const result = await handler({ index: "logs-*", size: 0, query: { match_all: {} } });
		expect(result.content[0]?.text).toContain("0 total hits");
	});

	test("does NOT throw on a genuine real result with all shards succeeding (no failures list)", async () => {
		const clean: estypes.SearchResponse = {
			took: 5,
			timed_out: false,
			_shards: { total: 8, successful: 8, skipped: 0, failed: 0 },
			hits: { total: { value: 42, relation: "eq" }, max_score: 1, hits: [] },
			aggregations: { by_host: { buckets: [] } },
		} as unknown as estypes.SearchResponse;
		const handler = makeHandler(clean);
		const result = await handler({ index: "logs-*", size: 0, query: { match_all: {} } });
		expect(result.content[0]?.text).toContain("42 total hits");
	});
});
