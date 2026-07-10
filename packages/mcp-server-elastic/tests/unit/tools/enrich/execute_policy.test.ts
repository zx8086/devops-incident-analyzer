// tests/unit/tools/enrich/execute_policy.test.ts
// SIO-1047: characterization coverage for executePolicyHandler's extracted helpers
// (sendExecuteStartNotifications / handleAsyncPolicyResult / handleSyncPolicyResult),
// exercised only through the registered tool handler.

import { describe, expect, test } from "bun:test";
import type { Client } from "@elastic/elasticsearch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { registerEnrichExecutePolicyTool } from "../../../../src/tools/enrich/execute_policy.js";
import { getToolFromServer } from "../../../utils/elasticsearch-client.js";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;

function makeHandler(executePolicyImpl: (args: Record<string, unknown>) => Promise<Record<string, unknown>>): {
	handler: Handler;
} {
	const stub = {
		enrich: {
			executePolicy: executePolicyImpl,
		},
	} as unknown as Client;

	const server = new McpServer({ name: "test", version: "1.0.0" });
	registerEnrichExecutePolicyTool(server, stub);
	const tool = getToolFromServer(server, "elasticsearch_enrich_execute_policy");
	if (!tool) throw new Error("tool not registered");
	return { handler: tool.handler as Handler };
}

describe("elasticsearch_enrich_execute_policy (SIO-1047 handler-helper extraction)", () => {
	test("asynchronous mode (waitForCompletion: false, task returned) hits handleAsyncPolicyResult", async () => {
		const { handler } = makeHandler(async () => ({ task: "task-id-123" }));
		const out = await handler({ name: "my-policy", waitForCompletion: false });
		const text = out.content[0]?.text ?? "";
		expect(JSON.parse(text)).toEqual({ task: "task-id-123" });
	});

	test("synchronous mode (waitForCompletion: true) hits handleSyncPolicyResult and returns raw result", async () => {
		const { handler } = makeHandler(async () => ({ status: { phase: "COMPLETE" } }));
		const out = await handler({ name: "my-policy", waitForCompletion: true });
		const text = out.content[0]?.text ?? "";
		expect(JSON.parse(text)).toEqual({ status: { phase: "COMPLETE" } });
	});

	test("default mode (waitForCompletion omitted, no task in result) falls through to sync-result branch", async () => {
		const { handler } = makeHandler(async () => ({ acknowledged: true }));
		const out = await handler({ name: "my-policy" });
		const text = out.content[0]?.text ?? "";
		expect(JSON.parse(text)).toEqual({ acknowledged: true });
	});

	test("waitForCompletion: false but no task in result also falls through to sync-result branch", async () => {
		const { handler } = makeHandler(async () => ({}));
		const out = await handler({ name: "my-policy", waitForCompletion: false });
		const text = out.content[0]?.text ?? "";
		expect(JSON.parse(text)).toEqual({});
	});

	test("forwards name/masterTimeout/waitForCompletion to esClient.enrich.executePolicy", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const { handler } = makeHandler(async (args) => {
			calls.push(args);
			return { task: "t1" };
		});
		await handler({ name: "my-policy", masterTimeout: "30s", waitForCompletion: false });
		expect(calls).toEqual([{ name: "my-policy", master_timeout: "30s", wait_for_completion: false }]);
	});

	test("validation failure (empty name) throws a McpError with the ZodError clone-group branch", async () => {
		const { handler } = makeHandler(async () => ({}));
		let threw: unknown;
		try {
			await handler({ name: "" });
		} catch (err) {
			threw = err;
		}
		expect(threw).toBeInstanceOf(McpError);
		expect((threw as McpError).message).toContain("[elasticsearch_enrich_execute_policy]");
		expect((threw as McpError).message).toContain("Validation failed");
	});

	test("ES not_found error maps to the policy_not_found branch", async () => {
		const { handler } = makeHandler(async () => {
			throw new Error("resource_not_found_exception: no such policy");
		});
		let threw: unknown;
		try {
			await handler({ name: "missing-policy" });
		} catch (err) {
			threw = err;
		}
		expect(threw).toBeInstanceOf(McpError);
		expect((threw as McpError).message).toContain("Enrich policy not found: missing-policy");
	});
});
