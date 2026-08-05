// tests/unit/search-keyword-retry.test.ts
// SIO-1388: the `.keyword` auto-retry must fire ONLY on a shard-level fielddata/text-field
// rejection. The reference implementation this was adapted from retries on any failure; that would
// be actively harmful here, because SOUL.md records that `service.name` is a keyword with NO
// `.keyword` sub-field on our OTel/APM data streams -- appending it returns zero buckets and breaks
// the primary service-discovery aggregation. The negative cases below are the point of this file.
import { describe, expect, test } from "bun:test";
import { registerSearchTool } from "../../src/tools/core/search.js";

type Handler = (args: unknown, extra: unknown) => Promise<unknown>;

const FIELDDATA_FAILURE = {
	failed: 1,
	total: 2,
	successful: 1,
	skipped: 0,
	failures: [
		{
			shard: 0,
			index: "logs-x",
			reason: {
				type: "illegal_argument_exception",
				reason: "Fielddata is disabled on text fields by default. Set fielddata=true on [message] instead.",
			},
		},
	],
};

const CLEAN_SHARDS = { failed: 0, total: 2, successful: 2, skipped: 0 };

// Captures each outbound search so the test can assert what was actually sent to ES.
function harness(responses: Array<Record<string, unknown>>) {
	const sent: Array<Record<string, unknown>> = [];
	let call = 0;
	const esClient = {
		search: async (request: Record<string, unknown>) => {
			sent.push(request);
			const response = responses[Math.min(call, responses.length - 1)];
			call += 1;
			return response;
		},
	} as never;

	let handler: Handler | undefined;
	const server = {
		registerTool: (_name: string, _config: unknown, h: Handler) => {
			handler = h;
			return {};
		},
	} as never;

	registerSearchTool(server, esClient);
	if (!handler) throw new Error("search tool did not register");
	return { handler, sent };
}

const baseHits = { hits: { total: { value: 0, relation: "eq" }, hits: [] }, took: 5, timed_out: false };

describe("elasticsearch_search .keyword auto-retry", () => {
	test("retries with .keyword when a shard rejects the agg for fielddata", async () => {
		const { handler, sent } = harness([
			{ ...baseHits, _shards: FIELDDATA_FAILURE },
			{ ...baseHits, _shards: CLEAN_SHARDS, aggregations: { svc: { buckets: [{ key: "checkout", doc_count: 3 }] } } },
		]);

		await handler({ index: "logs-x", size: 0, aggs: { svc: { terms: { field: "message" } } } }, {});

		expect(sent).toHaveLength(2);
		// First attempt uses the field as given; the retry appends .keyword.
		expect(JSON.stringify(sent[0]?.aggs)).toContain('"field":"message"');
		expect(JSON.stringify(sent[1]?.aggs)).toContain('"field":"message.keyword"');
	});

	test("does NOT retry on a clean zero-bucket result (the APM service.name case)", async () => {
		// SOUL.md: service.name has no .keyword sub-field. An empty-but-successful aggregation is a
		// valid answer -- retrying it with .keyword would return zero buckets and look like absence.
		const { handler, sent } = harness([{ ...baseHits, _shards: CLEAN_SHARDS, aggregations: { svc: { buckets: [] } } }]);

		await handler({ index: "logs-apm.app-x", size: 0, aggs: { svc: { terms: { field: "service.name" } } } }, {});

		expect(sent).toHaveLength(1);
		expect(JSON.stringify(sent[0]?.aggs)).not.toContain(".keyword");
	});

	test("does NOT retry on an unrelated shard failure", async () => {
		// A node dropping out is not fixed by changing the field, so the retry must stay off and the
		// normal shard-failure error path must run instead.
		const { handler } = harness([
			{
				...baseHits,
				_shards: {
					failed: 1,
					total: 2,
					successful: 1,
					skipped: 0,
					failures: [
						{ shard: 0, index: "logs-x", reason: { type: "node_not_connected_exception", reason: "node left" } },
					],
				},
			},
		]);

		const caught = await handler(
			{ index: "logs-x", size: 0, aggs: { svc: { terms: { field: "message" } } } },
			{},
		).catch((e: unknown) => e);
		// Surfaces as an error rather than silently retrying.
		expect((caught as Error).message).toContain("node_not_connected_exception");
	});

	test("keeps the ORIGINAL failure when the retry also fails", async () => {
		const { handler, sent } = harness([
			{ ...baseHits, _shards: FIELDDATA_FAILURE },
			{ ...baseHits, _shards: FIELDDATA_FAILURE },
		]);

		const caught = await handler(
			{ index: "logs-x", size: 0, aggs: { svc: { terms: { field: "message" } } } },
			{},
		).catch((e: unknown) => e);

		expect(sent).toHaveLength(2);
		// Reports the real problem, not a second symptom, and never claims a partial result is valid.
		expect((caught as Error).message).toContain("Fielddata is disabled");
	});
});
