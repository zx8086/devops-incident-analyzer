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
});
