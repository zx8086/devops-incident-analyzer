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
    const result = await startHttpTransport(
      () => new McpServer({ name: "test", version: "0.1.0" }),
      {
        port: 0,
        host: "127.0.0.1",
        path: "/mcp",
        sessionMode: "stateful" as const,
        idleTimeout: 10,
      },
    );
    server = result.server;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "GET" });
    expect(res.status).toBe(400);
    await result.close();
  });

  test("DELETE /mcp returns 400 without valid session in stateful mode", async () => {
    const { startHttpTransport } = await import("../http.ts");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const result = await startHttpTransport(
      () => new McpServer({ name: "test", version: "0.1.0" }),
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
