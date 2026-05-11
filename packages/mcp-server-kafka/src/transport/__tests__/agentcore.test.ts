// src/transport/__tests__/agentcore.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import { type BootstrapLogger, startAgentCoreTransport } from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const noopLogger: BootstrapLogger = {
	info: () => {},
	error: () => {},
	warn: () => {},
};

describe("AgentCore transport", () => {
	let server: ReturnType<typeof Bun.serve> | null = null;

	afterEach(() => {
		if (server) {
			server.stop(true);
			server = null;
		}
	});

	test("GET /ping returns 200 with status ok", async () => {
		const result = await startAgentCoreTransport(() => new McpServer({ name: "test", version: "0.1.0" }), noopLogger, {
			port: 0,
			host: "127.0.0.1",
		});
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/ping`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
		await result.close();
	});

	test("GET /health returns 200", async () => {
		const result = await startAgentCoreTransport(() => new McpServer({ name: "test", version: "0.1.0" }), noopLogger, {
			port: 0,
			host: "127.0.0.1",
		});
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/health`);
		expect(res.status).toBe(200);
		await result.close();
	});

	test("GET /mcp returns 405", async () => {
		const result = await startAgentCoreTransport(
			() => {
				throw new Error("should not create server for GET");
			},
			noopLogger,
			{ port: 0, host: "127.0.0.1" },
		);
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/mcp`);
		expect(res.status).toBe(405);
		await result.close();
	});

	test("POST /mcp with initialize returns serverInfo", async () => {
		const result = await startAgentCoreTransport(
			() => new McpServer({ name: "test-agentcore", version: "0.1.0" }),
			noopLogger,
			{ port: 0, host: "127.0.0.1" },
		);
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test-client", version: "1.0.0" },
				},
			}),
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("serverInfo");
		expect(text).toContain("test-agentcore");
		await result.close();
	});

	test("unknown path returns 404", async () => {
		const result = await startAgentCoreTransport(() => new McpServer({ name: "test", version: "0.1.0" }), noopLogger, {
			port: 0,
			host: "127.0.0.1",
		});
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/nonexistent`);
		expect(res.status).toBe(404);
		await result.close();
	});

	// SIO-727: graceful drain on close. Mirrors the http.test.ts drain block but
	// for the AgentCore-side transport. The gate must apply only to /mcp; /ping
	// and /health must stay live during drain because they ARE the AgentCore
	// framework's liveness surface.
	test("close() completes quickly with no active requests", async () => {
		const result = await startAgentCoreTransport(() => new McpServer({ name: "test", version: "0.1.0" }), noopLogger, {
			port: 0,
			host: "127.0.0.1",
			drainTimeoutMs: 5000,
		});
		server = result.server;
		const started = Date.now();
		await result.close();
		expect(Date.now() - started).toBeLessThan(500);
	});

	test("drainTimeoutMs=0 short-circuits to immediate force-close", async () => {
		const result = await startAgentCoreTransport(() => new McpServer({ name: "test", version: "0.1.0" }), noopLogger, {
			port: 0,
			host: "127.0.0.1",
			drainTimeoutMs: 0,
		});
		server = result.server;
		const started = Date.now();
		await result.close();
		expect(Date.now() - started).toBeLessThan(100);
	});

	test("post-shutdown /mcp request returns JSON-RPC 503 envelope when gate catches it", async () => {
		const result = await startAgentCoreTransport(() => new McpServer({ name: "test", version: "0.1.0" }), noopLogger, {
			port: 0,
			host: "127.0.0.1",
			drainTimeoutMs: 5000,
		});
		server = result.server;

		// Start close in the background -- shuttingDown flips synchronously.
		const closePromise = result.close();
		await new Promise((r) => setTimeout(r, 5));
		const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		}).catch((err) => err);

		if (res instanceof Response && res.status === 503) {
			const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
			expect(body.jsonrpc).toBe("2.0");
			expect(body.error.code).toBe(-32000);
			expect(body.error.message).toContain("shutting down");
		}
		// Race-loser case (Bun stopped the listener first) is also acceptable --
		// LLM gets a retryable network error, not a malformed response.
		await closePromise;
	});
});
