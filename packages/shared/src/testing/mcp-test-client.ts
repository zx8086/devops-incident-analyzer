// shared/src/testing/mcp-test-client.ts
// SIO-1957: SDK-neutral MCP test client. Tests used to link a v1 Client to a server instance with
// InMemoryTransport.createLinkedPair(); v1 and v2 in-memory pairs cannot interconnect and v2 has no
// in-memory transport for the 2026-07-28 era. This keeps the v1 Client but routes its streamable
// HTTP transport's fetch straight into a web-standard handler, so no socket is opened. A server
// still on v1 passes v1StatelessHandler(factory); a server ported to v2 passes
// createMcpHandler(factory).fetch, and its tests change only that line.
//
// The handler builds a fresh server per request, as production does, so callers pass a FACTORY.
// Reusing one v1 server instance fails on the second request ("Already connected"), and v2
// rejects it the same way.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BootstrapLogger } from "../bootstrap.ts";
import { v1StatelessHandler } from "../transport/agentcore.ts";

const silentLogger: BootstrapLogger = { info: () => {}, warn: () => {}, error: () => {} };

export type McpFetchHandler = (req: Request) => Promise<Response>;

export async function connectTestClient(handleMcp: McpFetchHandler, name = "mcp-test-client"): Promise<Client> {
	const transport = new StreamableHTTPClientTransport(new URL("http://mcp-test.local/mcp"), {
		fetch: async (url, init) => {
			const req = new Request(url, init);
			// The v1 client opens an optional GET SSE stream after initialize; a stateless server
			// answers 405, which the client tolerates.
			if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
			return handleMcp(req);
		},
	});
	const client = new Client({ name, version: "0.0.0" });
	await client.connect(transport);
	return client;
}

export function connectV1TestClient(serverFactory: () => McpServer, name?: string): Promise<Client> {
	return connectTestClient(v1StatelessHandler(serverFactory, silentLogger), name);
}
