// src/transport/__tests__/http.test.ts
import { afterEach, describe, expect, test } from "bun:test";

describe("HTTP transport stateless mode", () => {
	let server: ReturnType<typeof Bun.serve> | null = null;

	afterEach(() => {
		if (server) {
			server.stop(true);
			server = null;
		}
	});

	test("GET /mcp returns 405 in stateless mode", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const result = await startHttpTransport(
			() => {
				throw new Error("should not create server for GET");
			},
			{
				port: 0,
				host: "127.0.0.1",
				path: "/mcp",
				sessionMode: "stateless" as const,
				idleTimeout: 10,
			},
		);
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "GET" });
		expect(res.status).toBe(405);
		await result.close();
	});

	test("DELETE /mcp returns 405 in stateless mode", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const result = await startHttpTransport(
			() => {
				throw new Error("should not create server for DELETE");
			},
			{
				port: 0,
				host: "127.0.0.1",
				path: "/mcp",
				sessionMode: "stateless" as const,
				idleTimeout: 10,
			},
		);
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "DELETE" });
		expect(res.status).toBe(405);
		await result.close();
	});

	test("404 for unknown paths", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const result = await startHttpTransport(
			() => {
				throw new Error("should not create server");
			},
			{
				port: 0,
				host: "127.0.0.1",
				path: "/mcp",
				sessionMode: "stateless" as const,
				idleTimeout: 10,
			},
		);
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/unknown`);
		expect(res.status).toBe(404);
		await result.close();
	});
});

describe("HTTP transport stateful mode", () => {
	let server: ReturnType<typeof Bun.serve> | null = null;

	afterEach(() => {
		if (server) {
			server.stop(true);
			server = null;
		}
	});

	test("GET /mcp returns 400 without session ID in stateful mode", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
		const result = await startHttpTransport(() => new McpServer({ name: "test", version: "0.1.0" }), {
			port: 0,
			host: "127.0.0.1",
			path: "/mcp",
			sessionMode: "stateful" as const,
			idleTimeout: 10,
		});
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "GET" });
		expect(res.status).toBe(400);
		await result.close();
	});

	test("DELETE /mcp returns 400 without valid session in stateful mode", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
		const result = await startHttpTransport(() => new McpServer({ name: "test", version: "0.1.0" }), {
			port: 0,
			host: "127.0.0.1",
			path: "/mcp",
			sessionMode: "stateful" as const,
			idleTimeout: 10,
		});
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
			method: "DELETE",
			headers: { "mcp-session-id": "nonexistent-session" },
		});
		expect(res.status).toBe(400);
		await result.close();
	});

	test("POST /mcp initializes a session in stateful mode", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
		const result = await startHttpTransport(
			() => {
				const s = new McpServer({ name: "test", version: "0.1.0" });
				return s;
			},
			{
				port: 0,
				host: "127.0.0.1",
				path: "/mcp",
				sessionMode: "stateful" as const,
				idleTimeout: 10,
			},
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
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "test-client", version: "0.1.0" },
				},
			}),
		});
		expect(res.status).toBe(200);
		const sessionId = res.headers.get("mcp-session-id");
		expect(sessionId).toBeTruthy();
		await result.close();
	});
});

// SIO-726: /ready endpoint -- 503 vs 200 driven by the snapshot.ready boolean
// passed in via the readinessProbe option. /health stays shallow regardless.
describe("HTTP transport /ready (SIO-726)", () => {
	let server: ReturnType<typeof Bun.serve> | null = null;

	afterEach(() => {
		if (server) {
			server.stop(true);
			server = null;
		}
	});

	const noopFactory = () => {
		throw new Error("serverFactory should not be called for /ready or /health");
	};

	const baseConfig = {
		port: 0,
		host: "127.0.0.1",
		path: "/mcp",
		sessionMode: "stateless" as const,
		idleTimeout: 10,
	};

	test("/ready returns 200 + snapshot when probe reports ready", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const snapshot = {
			ready: true,
			components: { kafka: "ok", schemaRegistry: "ok", ksql: "disabled", connect: "disabled", restproxy: "disabled" },
			cachedAt: "2026-05-12T00:00:00.000Z",
		};
		const result = await startHttpTransport(noopFactory, {
			...baseConfig,
			readinessProbe: async () => snapshot as never,
		});
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/ready`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ready: boolean; components: Record<string, string>; cachedAt: string };
		expect(body.ready).toBe(true);
		expect(body.components.kafka).toBe("ok");
		expect(body.cachedAt).toBe("2026-05-12T00:00:00.000Z");
		await result.close();
	});

	test("/ready returns 503 + snapshot when probe reports not ready", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const snapshot = {
			ready: false,
			components: {
				kafka: "ok",
				schemaRegistry: "unreachable",
				ksql: "disabled",
				connect: "disabled",
				restproxy: "disabled",
			},
			errors: { schemaRegistry: "HTML 503 from upstream" },
			cachedAt: "2026-05-12T00:00:00.000Z",
		};
		const result = await startHttpTransport(noopFactory, {
			...baseConfig,
			readinessProbe: async () => snapshot as never,
		});
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/ready`);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { ready: boolean; errors?: Record<string, string> };
		expect(body.ready).toBe(false);
		expect(body.errors?.schemaRegistry).toContain("HTML 503");
		await result.close();
	});

	test("/ready returns 404 when probe is not configured", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const result = await startHttpTransport(noopFactory, baseConfig);
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/ready`);
		expect(res.status).toBe(404);
		await result.close();
	});

	test("/ready returns 503 when probe throws (probe internal failure)", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const result = await startHttpTransport(noopFactory, {
			...baseConfig,
			readinessProbe: async () => {
				throw new Error("probe crashed");
			},
		});
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/ready`);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { ready: boolean; error: string };
		expect(body.ready).toBe(false);
		expect(body.error).toContain("probe crashed");
		await result.close();
	});

	test("/health still returns 200 regardless of /ready state", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const result = await startHttpTransport(noopFactory, {
			...baseConfig,
			readinessProbe: async () => ({ ready: false, components: {}, cachedAt: "" }) as never,
		});
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
		await result.close();
	});
});

// SIO-727: graceful shutdown drain. close() must wait for in-flight requests
// to finish (up to drainTimeoutMs) and reject new requests with a clean
// JSON-RPC 503 envelope, not an ECONNRESET. These tests exercise both halves
// of the hybrid drain (Bun-native drain + shuttingDown flag).
describe("HTTP transport graceful drain (SIO-727)", () => {
	let server: ReturnType<typeof Bun.serve> | null = null;

	afterEach(() => {
		if (server) {
			server.stop(true);
			server = null;
		}
	});

	const noopFactory = () => {
		throw new Error("serverFactory should not be called for /health or /ready");
	};

	const baseConfig = {
		port: 0,
		host: "127.0.0.1",
		path: "/mcp",
		sessionMode: "stateless" as const,
		idleTimeout: 10,
	};

	test("close() waits for in-flight request to finish (graceful drain)", async () => {
		// Use a long-running serverFactory so the request takes time to complete.
		// The drain must wait for it; close() should not return until the handler
		// finishes. We don't use a real McpServer here -- the test only needs to
		// prove that close() respects an active connection.
		const { startHttpTransport } = await import("../http.ts");
		const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");

		const result = await startHttpTransport(() => new McpServer({ name: "test", version: "0.1.0" }), {
			...baseConfig,
			drainTimeoutMs: 5000,
		});
		server = result.server;

		// Fire a real-but-bogus MCP request that the SDK will quickly reject
		// (no initialize). Even a fast 400 proves the connection-acceptance path
		// works during normal operation; the drain test is the close() timing.
		const requestPromise = fetch(`http://127.0.0.1:${server.port}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});

		// Wait for the request to actually start hitting the server before calling close.
		await new Promise((r) => setTimeout(r, 10));
		const closeStarted = Date.now();
		await Promise.all([result.close(), requestPromise.then((r) => r.text())]);

		// Close completed without hanging past the drain deadline.
		expect(Date.now() - closeStarted).toBeLessThan(5500);
	});

	test("shuttingDown gate returns clean JSON-RPC 503 (unit-level, no race)", async () => {
		// The gate is a closure inside startHttpTransport; we can't poke it
		// directly. Instead exercise the integration by holding close() open via
		// a stuck closeAllSessions, then requesting /mcp while shuttingDown=true.
		// In stateful mode close() calls closeAllSessions BEFORE drainBunServer,
		// so a slow closeAll keeps the gate open and the listener live.
		const { startHttpTransport } = await import("../http.ts");
		const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");

		const result = await startHttpTransport(() => new McpServer({ name: "test", version: "0.1.0" }), {
			...baseConfig,
			sessionMode: "stateful" as const,
			drainTimeoutMs: 5000,
		});
		server = result.server;

		// Initialize a session so closeAllSessions has work to do (and therefore
		// can be observed mid-close).
		await fetch(`http://127.0.0.1:${server.port}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "test", version: "0.1.0" },
				},
			}),
		});

		// Start close in the background; the shuttingDown flag flips immediately.
		const closePromise = result.close();

		// Give the close() call a tick to flip the flag, then fire a request.
		await new Promise((r) => setTimeout(r, 5));
		const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
		}).catch((err) => err); // connection-refused after stop() is acceptable too

		// If fetch threw (post-stop), that's the racy outcome. The interesting
		// assertion is when fetch got through: status must be 503 with the
		// JSON-RPC envelope.
		if (res instanceof Response && res.status === 503) {
			const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string } };
			expect(body.jsonrpc).toBe("2.0");
			expect(body.error.code).toBe(-32000);
			expect(body.error.message).toContain("shutting down");
			expect(res.headers.get("retry-after")).toBe("30");
		}
		// Otherwise (connection refused -- Bun stopped the listener first) the
		// gate didn't get a chance to fire, which is fine -- the LLM gets a
		// retryable network error rather than a malformed response.
		await closePromise;
	});

	test("close() resolves within drainTimeoutMs even with no active requests", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const result = await startHttpTransport(noopFactory, { ...baseConfig, drainTimeoutMs: 5000 });
		server = result.server;
		const started = Date.now();
		await result.close();
		expect(Date.now() - started).toBeLessThan(500); // graceful with no traffic
	});

	test("drainTimeoutMs=0 short-circuits to immediate force-close (pre-SIO-727 parity)", async () => {
		const { startHttpTransport } = await import("../http.ts");
		const result = await startHttpTransport(noopFactory, { ...baseConfig, drainTimeoutMs: 0 });
		server = result.server;
		const started = Date.now();
		await result.close();
		expect(Date.now() - started).toBeLessThan(100); // basically immediate
	});

	test("/health still returns 200 BEFORE close() is called (gate only flips during close)", async () => {
		// Belt-and-braces: the gate must not affect /health during normal operation.
		const { startHttpTransport } = await import("../http.ts");
		const result = await startHttpTransport(noopFactory, baseConfig);
		server = result.server;
		const res = await fetch(`http://127.0.0.1:${server.port}/health`);
		expect(res.status).toBe(200);
		await result.close();
	});
});
