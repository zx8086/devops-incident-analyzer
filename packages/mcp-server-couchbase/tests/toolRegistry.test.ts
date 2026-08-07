// tests/toolRegistry.test.ts
// SIO-1419 (CodeRabbit): the sugar->registerTool conversion silently bypassed the old
// server.tool tracing wrap in registerAll, losing traceToolCall for every registry
// tool. registerAll now wraps server.registerTool; these tests pin that seam so a
// future registration-path change cannot silently drop tracing again.

import { describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Bucket } from "couchbase";
import { registerAll, wrapWithToolTracing } from "../src/lib/toolRegistry";

type AnyFn = (...args: unknown[]) => unknown;

// Any bucket access throws; handlers catch internally and return error-shaped
// results, which is enough to prove the traced wrapper delegates to the real handler.
const throwingBucket = new Proxy(
	{},
	{
		get() {
			throw new Error("stub-bucket: not connected in tests");
		},
	},
) as unknown as Bucket;

function makeRecordingServer() {
	const handlers = new Map<string, AnyFn>();
	const registerTool = (name: string, _config: unknown, handler: AnyFn) => {
		handlers.set(name, handler);
	};
	const server = { registerTool } as unknown as McpServer;
	return { server, handlers, originalRegisterTool: registerTool };
}

describe("registerAll tracing wrap (SIO-1419)", () => {
	test("every registry tool's registered handler passed through wrapWithToolTracing", () => {
		const { server, handlers } = makeRecordingServer();
		registerAll(server, throwingBucket);

		expect(handlers.size).toBeGreaterThan(30);
		for (const [name, handler] of handlers) {
			expect(handler.name).toBe(`traced:${name}`);
		}
	});

	test("registerTool is restored after registerAll (no wrap on later registrations)", () => {
		const { server, handlers } = makeRecordingServer();
		registerAll(server, throwingBucket);

		// registerAll restores a bound copy of the original registerTool; the contract
		// that matters is behavioral: registrations AFTER registerAll are not traced.
		const postRestore = async () => ({ content: [] });
		(server as unknown as { registerTool: AnyFn }).registerTool("post_restore_tool", {}, postRestore);
		expect(handlers.get("post_restore_tool")?.name).not.toStartWith("traced:");
	});

	test("a traced handler delegates to the underlying tool handler", async () => {
		const { server, handlers } = makeRecordingServer();
		registerAll(server, throwingBucket);

		const handler = handlers.get("capella_get_buckets");
		if (!handler) throw new Error("capella_get_buckets was not registered");
		// The stub bucket throws inside the real handler, which catches and returns an
		// error-shaped result -- reaching ANY result proves delegation through the wrap.
		const result = await handler({});
		expect(result).toBeDefined();
	});

	test("wrapWithToolTracing passes through non-function handlers and propagates results", async () => {
		expect(wrapWithToolTracing("x", undefined)).toBeUndefined();

		const wrapped = wrapWithToolTracing("capella_test_tool", async (n: number) => n * 2) as AnyFn;
		expect(typeof wrapped).toBe("function");
		expect(wrapped.name).toBe("traced:capella_test_tool");
		expect(await wrapped(21)).toBe(42);

		const failing = wrapWithToolTracing("capella_failing_tool", async () => {
			throw new Error("boom");
		}) as AnyFn;
		let thrown: unknown;
		try {
			await failing();
		} catch (err) {
			thrown = err;
		}
		expect((thrown as Error).message).toBe("boom");
	});
});
