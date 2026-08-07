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
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { config } from "../src/config/index.ts";
import { registerPingHandlers } from "../src/lib/pingHandler.ts";
import { buildServerFactory } from "../src/server-v2.ts";

// v1's real capella_ping, called through a live v1 Client/InMemoryTransport pair -- NOT a
// hardcoded literal, so wording drift in pingHandler.ts (the actual source of truth) fails this
// test instead of silently passing. Mirrors the existing v1 test pattern in
// src/__tests__/docs-resolution.test.ts.
async function callV1PingHandler(): Promise<string | undefined> {
	const server = new McpServer({ name: "couchbase-v1-ping-probe", version: "0.0.0" });
	registerPingHandlers(server);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "couchbase-v1-ping-probe-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	const result = (await client.callTool({ name: "capella_ping", arguments: {} })) as {
		content?: Array<{ text?: string }>;
	};
	await client.close();
	return result.content?.[0]?.text;
}

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

	// SIO-1436: resolved. SIO-1424's original -32601 repro sent a bare
	// {jsonrpc, id, method: "server/discover", params: {}} with no envelope claim -- that
	// classifies as LEGACY at the HTTP routing layer (classifyRequestBody, installed
	// @modelcontextprotocol/server bundle dist/src-CX2iR2pK.mjs:5101-5140; confirmed by the public
	// isLegacyRequest doc comment at dist/index.mjs:1152-1155), so it never reached the modern
	// dispatch path where _ondiscover lives. A second, independent gate also had to be closed:
	// McpServer only self-registers server/discover when its _supportedProtocolVersions includes a
	// modern (2026-07-28+) entry (dist/mcp-DXXb3Vv3.mjs:733), which the SDK's default
	// SUPPORTED_PROTOCOL_VERSIONS does not -- fixed in server-v2.ts's McpServer construction. This
	// test now sends the same full _meta envelope trio the passing tools/call test above uses, plus
	// Mcp-Method: server/discover (server/discover carries no params.name/uri, so it is NOT in
	// MCP_NAME_HEADER_SOURCE and needs no Mcp-Name header -- dist/src-CX2iR2pK.mjs:4990-4993).
	test("server/discover: modern probe returns a DiscoverResult", async () => {
		const handler = buildHandler();
		try {
			const response = await handler.fetch(
				new Request("http://localhost/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"Mcp-Method": "server/discover",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 3,
						method: "server/discover",
						params: {
							_meta: {
								"io.modelcontextprotocol/protocolVersion": "2026-07-28",
								"io.modelcontextprotocol/clientCapabilities": {},
								"io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" },
							},
						},
					}),
				}),
			);

			expect(response.status).toBe(200);
			const body = (await parseJsonRpcBody(response)) as {
				jsonrpc: string;
				id: number;
				error?: unknown;
				result?: unknown;
			};
			expect(body.jsonrpc).toBe("2.0");
			expect(body.id).toBe(3);
			expect(body.error).toBeUndefined();
			expect(body.result).toBeDefined();
		} finally {
			await handler.close();
		}
	});

	test("v1 text-equivalence: v2's not-connected text matches v1's REAL pingHandler.ts response (not a hardcoded literal)", async () => {
		// Live-cluster equivalence isn't feasible in CI (no Couchbase available), so this compares
		// v2's response against v1's ACTUAL registerPingHandlers output, called live through a v1
		// Client/InMemoryTransport pair (callV1PingHandler above) -- not a copy-pasted literal. A
		// future wording change in pingHandler.ts now fails this test instead of silently passing.
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
		const v2Text = body.result?.content?.[0]?.text;
		const v1Text = await callV1PingHandler();

		expect(v1Text).toBeDefined();
		expect(v2Text).toBe(v1Text);
	});
});

describe("SIO-1443 follow-up: capella_read_documentation respects config.documentation.enabled", () => {
	const priorDocumentation = config.documentation;

	afterEach(() => {
		config.documentation = priorDocumentation;
	});

	// Regression test for the reviewer finding on the v2 documentation port: resolveDocsUri() had
	// no gate on config.documentation.enabled, so under the DEFAULT config (disabled) the tool
	// silently succeeded with placeholder content where v1 errors ("No resource handler found for
	// URI", via registerAllResources only constructing a DocumentationHandler when
	// config.documentation.enabled -- see resources/index.ts). Asserts the v2 tool now fails
	// (isError: true) instead of returning a success result, matching v1's behavioral contract for
	// the default/common configuration.
	test("documentation disabled (the default): capella_read_documentation errors instead of returning placeholder content", async () => {
		config.documentation = { enabled: false, baseDirectory: "/tmp/docs", fileExtension: ".md" };

		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "tools/call",
					"Mcp-Name": "capella_read_documentation",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 5,
					method: "tools/call",
					params: {
						name: "capella_read_documentation",
						arguments: { scope_name: "inventory", collection_name: "products", file_name: "overview" },
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
		expect(body.id).toBe(5);
		// An uncaught throw from a registerTool handler surfaces as a JSON-RPC result with
		// isError: true (not a top-level JSON-RPC error and not a plain-text success result) --
		// this is what "the tool must fail" means at the protocol layer.
		expect(body.result?.isError).toBe(true);
		expect(body.result?.content?.[0]?.text).toContain("No resource handler found for URI");
	});
});
