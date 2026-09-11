// tests/unit/tools/scroll_search.test.ts

import { describe, expect, test } from "bun:test";
import { type Client, errors } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { registerScrollSearchTool } from "../../../src/tools/search/scroll_search.js";
import { getToolFromServer } from "../../utils/elasticsearch-client.js";

const { ResponseError } = errors;

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
type ScrollBatch = { documents: unknown[]; clear: () => Promise<void> };

const ErrorEnvelopeSchema = z.object({
	_error: z.object({
		kind: z.string(),
		category: z.string(),
		message: z.string(),
		advice: z.string().optional(),
	}),
});

// McpError folds the envelope (its second constructor arg) into `.message` behind a
// `MCP error -32602: ` prefix, so scan to the first brace before parsing.
function parseErrorEnvelope(err: McpError): z.infer<typeof ErrorEnvelopeSchema> {
	const jsonStart = err.message.indexOf("{");
	if (jsonStart === -1) throw new Error(`expected a JSON envelope in the error message, got: ${err.message}`);
	return ErrorEnvelopeSchema.parse(JSON.parse(err.message.slice(jsonStart)));
}

// Builds a real SDK ResponseError so the structural path (meta.body.error.type) is
// exercised rather than a hand-shaped stub that could drift from the SDK.
function esResponseError(type: string, statusCode: number): InstanceType<typeof ResponseError> {
	return new ResponseError({
		statusCode,
		body: { error: { type, reason: `${type}: simulated` } },
		headers: {},
		warnings: null,
		meta: {} as never,
	} as never);
}

interface HarnessOptions {
	batches?: unknown[][];
	throws?: unknown;
}

function makeHandler(options: HarnessOptions = {}): {
	handler: Handler;
	calls: { params?: Record<string, unknown>; options?: Record<string, unknown>; clears: number };
} {
	const calls: { params?: Record<string, unknown>; options?: Record<string, unknown>; clears: number } = { clears: 0 };

	const stub = {
		helpers: {
			scrollSearch: (params: Record<string, unknown>, opts?: Record<string, unknown>) => {
				calls.params = params;
				calls.options = opts;
				if (options.throws) throw options.throws;
				const batches = options.batches ?? [[{ id: 1 }]];
				return (async function* (): AsyncGenerator<ScrollBatch> {
					for (const documents of batches) {
						yield {
							documents,
							clear: async () => {
								calls.clears += 1;
							},
						};
					}
				})();
			},
		},
	} as unknown as Client;

	const server = new McpServer({ name: "test", version: "1.0.0" });
	registerScrollSearchTool(server, stub);
	const tool = getToolFromServer(server, "elasticsearch_scroll_search");
	if (!tool) throw new Error("tool not registered");
	return { handler: tool.handler as Handler, calls };
}

describe("scroll_search request shape (SIO-1690)", () => {
	test("forwards index, query and scroll as top-level fields, plus an opaqueId", async () => {
		const { handler, calls } = makeHandler();

		await handler({
			index: "logs-apm.app.prices_api_v2_service-default",
			query: { range: { "@timestamp": { gte: "now-24h" } } },
			scroll: "2m",
		});

		expect(calls.params?.index).toBe("logs-apm.app.prices_api_v2_service-default");
		expect(calls.params?.query).toEqual({ range: { "@timestamp": { gte: "now-24h" } } });
		expect(calls.params?.scroll).toBe("2m");
		expect(calls.options?.opaqueId).toBe("elasticsearch_scroll_search");
	});

	test("forwards restTotalHitsAsInt as rest_total_hits_as_int when supplied", async () => {
		const { handler, calls } = makeHandler();

		await handler({
			index: "logs-*",
			query: { match_all: {} },
			restTotalHitsAsInt: true,
		});

		expect(calls.params?.rest_total_hits_as_int).toBe(true);
	});

	test("omits rest_total_hits_as_int when not provided (back-compat)", async () => {
		const { handler, calls } = makeHandler();

		await handler({ index: "logs-*", query: { match_all: {} } });

		expect(calls.params).toBeDefined();
		expect(calls.params?.rest_total_hits_as_int).toBeUndefined();
	});

	test("stops at maxDocuments and clears the scroll context", async () => {
		const { handler, calls } = makeHandler({
			batches: [
				[{ id: 1 }, { id: 2 }, { id: 3 }],
				[{ id: 4 }, { id: 5 }],
			],
		});

		const result = await handler({
			index: "logs-*",
			query: { match_all: {} },
			maxDocuments: 2,
		});

		expect(result.content[0]?.text).toBe("Retrieved 2 documents");
		expect(calls.clears).toBe(1);
	});
});

describe("scroll_search error classification (SIO-1690)", () => {
	test("a malformed query DSL returns a structured bad-query envelope with advice", async () => {
		// The live failure: `parsing_exception: unknown query [query]`, which ES raises when the
		// DSL nests a `query` key where a clause name belongs.
		const { handler } = makeHandler({ throws: esResponseError("parsing_exception", 400) });

		try {
			await handler({ index: "logs-*", query: { bool: { query: {} } } });
			throw new Error("expected handler to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			const envelope = parseErrorEnvelope(err as McpError);
			expect(envelope._error.kind).toBe("bad-query");
			expect(envelope._error.category).toBe("bad-query");
			expect(envelope._error.message).toContain("parsing_exception");
			expect(envelope._error.advice).toContain("BARE clause");
		}
	});

	test("a missing index is classified not-found, not bad-query", async () => {
		const { handler } = makeHandler({ throws: esResponseError("index_not_found_exception", 404) });

		try {
			await handler({ index: "no-such-index", query: { match_all: {} } });
			throw new Error("expected handler to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			const envelope = parseErrorEnvelope(err as McpError);
			expect(envelope._error.kind).toBe("not-found");
			expect(envelope._error.advice).toBeUndefined();
		}
	});

	test("an unclassifiable error is never stamped with a degrading category", async () => {
		const { handler } = makeHandler({ throws: new Error("boom") });

		try {
			await handler({ index: "logs-*", query: { match_all: {} } });
			throw new Error("expected handler to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).message).toContain("[elasticsearch_scroll_search] boom");
			expect((err as McpError).message).not.toContain('"_error"');
		}
	});

	test("schema validation still fails before any ES call", async () => {
		const { handler, calls } = makeHandler();

		try {
			await handler({ index: "", query: { match_all: {} } });
			throw new Error("expected handler to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(McpError);
			expect((err as McpError).message).toContain("Validation failed");
			expect(calls.params).toBeUndefined();
		}
	});
});
