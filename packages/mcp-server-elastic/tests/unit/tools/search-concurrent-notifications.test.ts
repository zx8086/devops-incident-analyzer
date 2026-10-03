// tests/unit/tools/search-concurrent-notifications.test.ts

import { describe, expect, test } from "bun:test";
import type { Client, estypes } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchTool } from "../../../src/tools/core/search.js";
import { getToolFromServer } from "../../utils/elasticsearch-client.js";

type Extra = { sendNotification: (n: unknown) => Promise<void>; signal: AbortSignal; requestId: string };
type Handler = (args: { index: string }, extra: Extra) => Promise<{ content: Array<{ type: string; text: string }> }>;

const emptyResponse = {
	took: 1,
	timed_out: false,
	_shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
	hits: { total: { value: 0, relation: "eq" }, max_score: null, hits: [] },
} as unknown as estypes.SearchResponse;

function extraFor(requestId: string, sink: unknown[]): Extra {
	return {
		sendNotification: async (n: unknown) => {
			sink.push(n);
		},
		signal: new AbortController().signal,
		requestId,
	};
}

// SIO-1953: the search tool used to park the request's `extra` on a process-global singleton.
// With two calls in flight, the second call's context replaced the first, so the first call's
// progress went out on the second call's stream, and whichever finished first nulled the
// context for the other. Progress is now log-only, so neither call can reach the other's stream.
describe("elasticsearch_search under concurrent calls", () => {
	test("two overlapping calls never send notifications on each other's stream", async () => {
		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let calls = 0;
		const client = {
			indices: { getMapping: async () => ({}) },
			search: async () => {
				calls++;
				if (calls === 1) await firstGate;
				return emptyResponse;
			},
		} as unknown as Client;

		const server = new McpServer({ name: "test", version: "1.0.0" });
		registerSearchTool(server, client);
		const tool = getToolFromServer(server, "elasticsearch_search");
		if (!tool) throw new Error("tool not registered");
		const handler = tool.handler as Handler;

		const sentA: unknown[] = [];
		const sentB: unknown[] = [];
		const callA = handler({ index: "logs-a" }, extraFor("a", sentA));
		// let A reach its blocked search before B starts
		await new Promise((r) => setTimeout(r, 10));
		const resultB = await handler({ index: "logs-b" }, extraFor("b", sentB));
		releaseFirst();
		const resultA = await callA;

		expect(resultA.content.length).toBeGreaterThan(0);
		expect(resultB.content.length).toBeGreaterThan(0);
		expect(sentA).toEqual([]);
		expect(sentB).toEqual([]);
	});
});
