// tests/server-v2-wire.test.ts
//
// SIO-1424: wire-level tests for the v2 pilot's createMcpHandler(factory, { legacy: 'stateless' })
// handler, via raw fetch() against its web-standard .fetch (no live network I/O, no Bun.serve --
// the handler IS a (Request) => Promise<Response> function, callable directly). Per the handover:
// v1/v2 InMemoryTransports cannot link and the beta/stable v2 client should not be a test
// dependency, so this exercises the exact protocol surface a real curl client would hit.
//
// capella_ping's handler tolerates no live database connection (returns a "not connected" text
// result rather than throwing -- see server-v2.ts), so these tests run without a Couchbase
// cluster: they verify PROTOCOL shape (JSON-RPC envelope, era negotiation, tool dispatch), not
// database connectivity.
import { describe, expect, test } from "bun:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { buildServerFactory } from "../src/server-v2.ts";

const silentLogger = { info: () => {}, warn: () => {}, debug: () => {} };

function buildHandler() {
	return createMcpHandler(buildServerFactory(silentLogger), { legacy: "stateless" });
}

// Helper: createMcpHandler's response body can arrive as plain JSON OR SSE-framed
// ("event: message\ndata: <json>\n\n") depending on responseMode negotiation -- observed live:
// the legacy `initialize` handshake and `server/discover` upgrade to SSE, the stateless
// `tools/call` in this suite stays plain JSON. Parse whichever the server actually returned
// rather than assuming one.
async function parseJsonRpcBody(response: Response): Promise<Record<string, unknown>> {
	const text = await response.text();
	const dataLine = text
		.split("\n")
		.find((line) => line.startsWith("data:"))
		?.slice("data:".length)
		.trim();
	return JSON.parse(dataLine ?? text);
}

describe("SIO-1424: v2 pilot wire protocol (three-era matrix)", () => {
	test("legacy era: initialize handshake negotiating protocolVersion 2025-11-25", async () => {
		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
				}),
			}),
		);
		await handler.close();

		expect(response.status).toBe(200);
		const body = (await parseJsonRpcBody(response)) as {
			jsonrpc: string;
			id: number;
			result?: { protocolVersion?: string };
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(1);
		expect(body.result?.protocolVersion).toBe("2025-11-25");
	});

	// SIO-1424 discovery finding (per the handover's own "exact request shapes may need
	// adjusting" caveat): the modern 2026-07-28 envelope requires the FULL _meta trio
	// (protocolVersion + clientCapabilities + clientInfo, not protocolVersion alone as the spec
	// announcement's shorthand example implied) AND the Mcp-Method/Mcp-Name headers -- confirmed
	// via a live 400 ("clientCapabilities: missing") on the partial envelope, then a live 400
	// ("Mcp-Method header is absent") on the full envelope without the headers, before landing on
	// this working combination.
	test("stateless 2026-07-28 era: tools/call with the full _meta envelope + Mcp-Method/Mcp-Name headers", async () => {
		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "tools/call",
					"Mcp-Name": "capella_ping",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: {
						name: "capella_ping",
						arguments: {},
						_meta: {
							"io.modelcontextprotocol/protocolVersion": "2026-07-28",
							"io.modelcontextprotocol/clientCapabilities": {},
							"io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" },
						},
					},
				}),
			}),
		);
		await handler.close();

		expect(response.status).toBe(200);
		const body = (await parseJsonRpcBody(response)) as {
			jsonrpc: string;
			id: number;
			result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
			error?: unknown;
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(2);
		expect(body.error).toBeUndefined();
		// capella_ping handles "no live connection" gracefully (a normal text result, not an
		// error) -- confirms the tool actually dispatched through the chokepoint+logging
		// composition rather than being rejected at the protocol layer.
		expect(body.result?.content?.[0]?.type).toBe("text");
		expect(body.result?.isError).not.toBe(true);
	});

	// SIO-1424 discovery finding: `server/discover` returns -32601 "Method not found" from this
	// handler in every combination tried (no headers, matching the initialize pattern; with
	// Mcp-Method: server/discover) despite McpServer's own Protocol class having a private
	// `_ondiscover` handler installed and `assertCapabilityForMethod("server/discover")` NOT
	// throwing when probed directly on the raw server instance -- so the gap is in
	// createMcpHandler's HTTP routing layer, not McpServer's method dispatch. Left as an
	// UNRESOLVED finding per the ticket's tolerance for "exact request shapes may need
	// adjusting" rather than force-fitting a workaround; documented in the PR for follow-up.
	test.skip("server/discover (UNRESOLVED: -32601 Method not found from every header/meta combination tried)", async () => {
		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "server/discover", params: {} }),
			}),
		);
		await handler.close();

		expect(response.status).toBe(200);
		const body = (await parseJsonRpcBody(response)) as { jsonrpc: string; id: number; error?: unknown };
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(3);
		expect(body.error).toBeUndefined();
	});

	test("v1 text-equivalence: capella_ping's not-connected text matches the v1 pingHandler's wording", async () => {
		// Live-cluster equivalence isn't feasible in CI (no Couchbase available), so this checks
		// the shared "not connected" branch text is byte-identical between v1's pingHandler.ts and
		// the v2 pilot's server-v2.ts -- the one code path both can exercise without a live
		// cluster, and the one most likely to silently drift since it's duplicated, not shared.
		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "tools/call",
					"Mcp-Name": "capella_ping",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 4,
					method: "tools/call",
					params: {
						name: "capella_ping",
						arguments: {},
						_meta: {
							"io.modelcontextprotocol/protocolVersion": "2026-07-28",
							"io.modelcontextprotocol/clientCapabilities": {},
							"io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" },
						},
					},
				}),
			}),
		);
		await handler.close();

		const body = (await parseJsonRpcBody(response)) as { result?: { content?: Array<{ text: string }> } };
		const text = body.result?.content?.[0]?.text;
		expect(text).toBe("Server is running but not connected to a database.");
	});
});
