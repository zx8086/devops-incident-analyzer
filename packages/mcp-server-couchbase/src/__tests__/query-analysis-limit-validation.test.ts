// src/__tests__/query-analysis-limit-validation.test.ts
// SIO-1430: the five queryAnalysis limit schemas accepted fractional/zero/negative
// values that Couchbase LIMIT rejects at query time (e.g. LIMIT 1.5). They are now
// z.number().int().positive().optional(); these tests drive the REAL registered
// tools through tools/call and assert the SDK's -32602 argument validation rejects
// invalid limits before any handler (or bucket) is touched. An intentional
// LLM-visible surface change -- the snapshot fixture was regenerated in this PR.

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Bucket } from "couchbase";
import { createMcpServerFactory } from "../server.ts";

// Validation failures must never reach the handler; a throwing bucket proves it.
const throwingBucket = new Proxy(
	{},
	{
		get() {
			throw new Error("bucket should not be touched when argument validation fails");
		},
	},
) as unknown as Bucket;

const LIMIT_TOOLS = [
	"capella_get_completed_requests",
	"capella_get_fatal_requests",
	"capella_get_largest_result_size_queries",
	"capella_get_longest_running_queries",
	"capella_get_most_frequent_queries",
] as const;

// SIO-1410: SDK 1.30 changed the zod-error prose; match both forms.
const VALIDATION_TEXT_RE = /Input validation error|Invalid arguments/i;

async function callTool(name: string, args: Record<string, unknown>) {
	const factory = createMcpServerFactory({ bucket: throwingBucket, playbooks: null });
	const server = factory();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "limit-validation-test", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const result = (await client.callTool({ name, arguments: args })) as {
		isError?: boolean;
		content?: Array<{ type: string; text?: string }>;
	};
	await client.close();
	return { result, text: (result.content ?? []).map((c) => c.text ?? "").join("\n") };
}

describe("SIO-1430: queryAnalysis limit must be a positive integer", () => {
	for (const tool of LIMIT_TOOLS) {
		test(`${tool} rejects fractional, zero, and negative limits at validation`, async () => {
			for (const limit of [1.5, 0, -3]) {
				const { result, text } = await callTool(tool, { limit });
				expect(result.isError).toBe(true);
				expect(text).toMatch(VALIDATION_TEXT_RE);
			}
		});
	}

	test("a valid positive integer limit passes validation and reaches the handler", async () => {
		const { text } = await callTool("capella_get_completed_requests", { limit: 5 });
		// The throwing bucket makes the HANDLER fail -- but that failure is not a
		// validation rejection, proving limit: 5 got through the schema.
		expect(text).not.toMatch(VALIDATION_TEXT_RE);
	});
});
