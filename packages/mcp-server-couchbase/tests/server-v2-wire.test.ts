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

describe("SIO-1443 follow-up: capella_list_playbooks respects the loadPlaybooks fallback-directory search", () => {
	const priorPlaybooks = config.playbooks;

	afterEach(() => {
		config.playbooks = priorPlaybooks;
	});

	// Regression test for the reviewer finding on the v2 playbooks port: v1's PlaybookRegistry is
	// null under TWO independent conditions -- config.playbooks.enabled === false (already covered
	// by the tool's own gate) OR enabled === true but no directory among baseDirectory/cwd-playbook/
	// __dirname-playbook/packageRoot-playbook has a matching markdown file. Both produce the SAME
	// clean "No resource handler found for URI: playbook://" error in v1. Before this fix, the v2
	// port only checked the first condition, so enabled=true with a missing baseDirectory fell
	// through to listPlaybooksContent's own fs.readdir(), which threw ENOENT and got caught into a
	// 200 success result containing raw filesystem-path text -- a materially different (and leakier)
	// signal than v1's isError: true. Uses a baseDirectory guaranteed not to exist so the assertion
	// holds regardless of whether a real ./playbook directory happens to be present in the checkout.
	test("playbooks enabled but no fallback directory has markdown files: capella_list_playbooks errors instead of returning ENOENT text", async () => {
		config.playbooks = {
			enabled: true,
			baseDirectory: "/tmp/sio-1443-nonexistent-playbook-dir-does-not-exist",
			fileExtension: ".md",
		};

		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "tools/call",
					"Mcp-Name": "capella_list_playbooks",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 6,
					method: "tools/call",
					params: {
						name: "capella_list_playbooks",
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
		expect(body.id).toBe(6);
		// Must be a clean isError: true, matching v1's "No resource handler found for URI"
		// contract -- NOT a 200 success result carrying "Error listing playbooks: ENOENT..." text.
		expect(body.result?.isError).toBe(true);
		expect(body.result?.content?.[0]?.text).toContain("No resource handler found for URI");
		expect(body.result?.content?.[0]?.text).not.toContain("ENOENT");
	});
});

// SIO-1443 Task 9: representative wire-level coverage across the ported v2 surface.
//
// Selection rationale (avoids duplicating existing coverage above): capella_ping already proves
// the no-arg + graceful-no-connection pattern; capella_read_documentation and
// capella_list_playbooks already have dedicated fix-round regression suites (disabled-gate and
// fallback-directory-missing paths). The 4 tools below are chosen instead for genuinely different
// input shapes AND to touch registration groups (core.ts, echo.ts) with no prior wire coverage.
//
// Live-cluster finding (this checkout's .env carries real Capella credentials, unlike the
// "no live cluster" assumption baked into capella_ping's header comment above): a live probe
// during this task showed connectionManager.getConnection() sometimes succeeds against the real
// cluster and sometimes hits an UnambiguousTimeoutError or an "unhealthy" fast-fail, depending on
// network reachability from this sandbox AND on what earlier tests in the SAME process did to the
// module-singleton connectionManager (its initializationPromise is cached process-wide -- see
// connectionManager.ts -- so a full `bun run test` invocation across many files can leave it in a
// different state than running this file alone). Every core.ts tool (capella_get_buckets,
// capella_get_document_by_id, capella_run_sql_plus_plus_query included) calls
// connectionManager.getConnection() UNCONDITIONALLY FIRST, before any of its own guard/validation
// logic -- so capella_run_sql_plus_plus_query's own full-bucket-path guard is not reachable
// deterministically either without a live, healthy connection. That non-determinism means any test
// asserting a SPECIFIC success-or-failure outcome (or a specific error envelope shape) for a
// tool/resource that calls getConnection() would be flaky. Per this file's own stated goal
// ("verify PROTOCOL shape... not database connectivity"), the tools below that DO touch the
// connection are asserted on dispatch/shape only (valid JSON-RPC envelope, a well-formed
// content/isError shape) -- never on which branch the live network took. Each such test also
// carries a generous per-test timeout (the observed connect attempt can approach or exceed bun
// test's 5000ms default) so a slow real network round-trip doesn't itself fail the test.
//   - capella_get_buckets: no-arg tool (proves the no-arg pattern generalizes to a SECOND tool
//     beyond capella_ping); dispatch-shape assertions only, per the flakiness note above.
//   - capella_get_document_by_id: required string params (3 fields) -- proves the Zod inputSchema
//     accepts a well-formed args object before the tool ever reaches
//     connectionManager.getConnection(); dispatch-shape assertions only.
//   - capella_run_sql_plus_plus_query: multi-field schema (scope_name + query) -- proves both
//     schema fields round-trip through dispatch; dispatch-shape assertions only (its
//     full-bucket-path guard is NOT reachable deterministically -- see above).
//   - capella_echo: different registration file (echo.ts, not core.ts); its inputSchema is
//     z.object({}) (no fields declared), so the SDK's Zod-parse step strips any caller-supplied
//     arguments before the handler ever sees them -- deterministic without a database connection.
const LIVE_CONNECTION_TEST_TIMEOUT_MS = 15_000;

describe("SIO-1443 Task 9: representative wire-level coverage across the ported v2 surface", () => {
	test(
		"capella_get_buckets: no-arg tool call dispatches through the chokepoint+logging composition",
		async () => {
			const handler = buildHandler();
			const response = await handler.fetch(
				new Request("http://localhost/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"Mcp-Method": "tools/call",
						"Mcp-Name": "capella_get_buckets",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 9,
						method: "tools/call",
						params: {
							name: "capella_get_buckets",
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
			expect(body.id).toBe(9);
			// Not a protocol-level error either way (a live-network success or a caught DB failure are
			// both legitimate JSON-RPC results at the protocol layer) -- proves the no-arg tool
			// dispatched through the read-only chokepoint + logging wrap, independent of live network
			// reachability from this sandbox (see the file-level comment above).
			expect(body.error).toBeUndefined();
			expect(body.result?.content?.[0]?.type).toBe("text");
			expect(typeof body.result?.isError === "boolean" || body.result?.isError === undefined).toBe(true);
		},
		LIVE_CONNECTION_TEST_TIMEOUT_MS,
	);

	test(
		"capella_get_document_by_id: required string params are accepted by the Zod inputSchema and the tool dispatches",
		async () => {
			const handler = buildHandler();
			const response = await handler.fetch(
				new Request("http://localhost/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"Mcp-Method": "tools/call",
						"Mcp-Name": "capella_get_document_by_id",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 10,
						method: "tools/call",
						params: {
							name: "capella_get_document_by_id",
							arguments: { scope_name: "inventory", collection_name: "b2b", document_id: "sio-1443-task-9-probe" },
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
			expect(body.id).toBe(10);
			// Proves the 3 required string params were accepted by the Zod inputSchema (a malformed-args
			// request would fail differently, at the schema layer, with a top-level JSON-RPC error before
			// ever reaching connectionManager.getConnection()) -- the tool genuinely dispatched. The
			// live-network outcome itself (document found/not-found/connection timeout) is not asserted;
			// see the file-level comment above.
			expect(body.error).toBeUndefined();
			expect(body.result?.content?.[0]?.type).toBe("text");
		},
		LIVE_CONNECTION_TEST_TIMEOUT_MS,
	);

	test(
		"capella_run_sql_plus_plus_query: complex multi-field schema (scope_name + query) dispatches",
		async () => {
			const handler = buildHandler();
			const response = await handler.fetch(
				new Request("http://localhost/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"Mcp-Method": "tools/call",
						"Mcp-Name": "capella_run_sql_plus_plus_query",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 11,
						method: "tools/call",
						params: {
							name: "capella_run_sql_plus_plus_query",
							arguments: {
								scope_name: "inventory",
								query: "SELECT * FROM `b2b` LIMIT 1",
							},
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
			expect(body.id).toBe(11);
			// Proves both schema fields (scope_name + query) were accepted and the tool dispatched --
			// the live-network outcome (query success, no-index error, or connection failure) is not
			// asserted; see the file-level comment above.
			expect(body.error).toBeUndefined();
			expect(body.result?.content?.[0]?.type).toBe("text");
		},
		LIVE_CONNECTION_TEST_TIMEOUT_MS,
	);

	test("capella_echo: different registration group (echo.ts) dispatches; its empty inputSchema strips caller arguments", async () => {
		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "tools/call",
					"Mcp-Name": "capella_echo",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 12,
					method: "tools/call",
					params: {
						name: "capella_echo",
						arguments: { probe: "sio-1443-task-9" },
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
		expect(body.id).toBe(12);
		expect(body.result?.isError).not.toBe(true);
		// capella_echo's inputSchema is z.object({}) -- no fields declared -- so the SDK's Zod-parse
		// step strips the caller's "probe" argument before the handler ever sees it, and the handler
		// echoes back exactly what it received: an empty object. This is correct v2 behavior (not a
		// bug), confirming the tool dispatched and its schema was actually enforced by the SDK.
		expect(body.result?.content?.[0]?.text).toBe(JSON.stringify({}));
	});

	test(
		"resources/read: database-structure (static resource) dispatches through the real handler, not a protocol error",
		async () => {
			const handler = buildHandler();
			const response = await handler.fetch(
				new Request("http://localhost/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"Mcp-Method": "resources/read",
						"Mcp-Name": "database://structure",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 13,
						method: "resources/read",
						params: {
							uri: "database://structure",
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
				result?: { contents?: Array<{ uri: string; mimeType: string; text: string }> };
				error?: unknown;
			};
			expect(body.jsonrpc).toBe("2.0");
			expect(body.id).toBe(13);
			// database-structure's handler catches its own errors and always returns { contents } (a
			// genuine 200 success at the wire level) whether or not the underlying getConnection() call
			// succeeds against the live cluster -- unlike the gated documentation resources below, this
			// is not a throw-on-disabled scenario. The load-bearing assertion is that the real static-URI
			// resource dispatched to its own handler and returned resource content addressed by the
			// requested URI (not a JSON-RPC protocol error) -- the live-network outcome itself is not
			// asserted; see the file-level comment above.
			expect(body.error).toBeUndefined();
			expect(body.result?.contents?.[0]?.uri).toBe("database://structure");
			expect(typeof body.result?.contents?.[0]?.text).toBe("string");
			expect((body.result?.contents?.[0]?.text?.length ?? 0) > 0).toBe(true);
		},
		LIVE_CONNECTION_TEST_TIMEOUT_MS,
	);

	test(
		"resources/read: query-results (dynamic ResourceTemplate) extracts {scope}/{encodedQuery} variables and dispatches",
		async () => {
			const handler = buildHandler();
			// The {scope} and {encodedQuery} template variables are asserted via the response's own uri
			// field (see below), which round-trips the exact request URI regardless of which branch the
			// live network took inside the handler -- deterministic proof of template-variable
			// extraction without depending on cluster reachability from this sandbox.
			const encodedQuery = encodeURIComponent("SELECT META().id FROM `b2b` LIMIT 1");
			const uri = `query://inventory/${encodedQuery}`;
			const response = await handler.fetch(
				new Request("http://localhost/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"Mcp-Method": "resources/read",
						"Mcp-Name": uri,
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 14,
						method: "resources/read",
						params: {
							uri,
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
				result?: { contents?: Array<{ uri: string; mimeType: string; text: string }> };
				error?: unknown;
			};
			expect(body.jsonrpc).toBe("2.0");
			expect(body.id).toBe(14);
			expect(body.error).toBeUndefined();
			// The load-bearing assertion: the response's own uri field round-trips the exact request URI
			// (ResponseBuilder...buildResourceResponse(uri.href)), proving the ResourceTemplate correctly
			// matched and dispatched with {scope}="inventory" and {encodedQuery}=<the encoded SELECT
			// statement> extracted from the URI path segments, not just that SOME handler ran.
			expect(body.result?.contents?.[0]?.uri).toBe(uri);
			expect(typeof body.result?.contents?.[0]?.text).toBe("string");
		},
		LIVE_CONNECTION_TEST_TIMEOUT_MS,
	);

	test("prompts/get: generate_sqlpp_query returns a well-formed prompt message referencing the supplied bucket/scope/collection", async () => {
		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "prompts/get",
					"Mcp-Name": "generate_sqlpp_query",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 15,
					method: "prompts/get",
					params: {
						name: "generate_sqlpp_query",
						arguments: {
							description: "find all hotels in the UK",
							bucket: "travel-sample",
							scope: "inventory",
							collection: "hotel",
							filters: "country = 'United Kingdom'",
							limit: "10",
						},
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
			result?: { messages?: Array<{ role: string; content?: { type?: string; text?: string } }> };
			error?: unknown;
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(15);
		expect(body.error).toBeUndefined();
		const message = body.result?.messages?.[0];
		expect(message?.role).toBe("user");
		expect(message?.content?.type).toBe("text");
		// Not byte-identical parity with v1 (out of scope per the task brief) -- asserts the
		// callback actually consumed the supplied arguments (bucket/scope/collection/description)
		// rather than returning a generic or empty template.
		const text = message?.content?.text ?? "";
		expect(text).toContain("find all hotels in the UK");
		expect(text).toContain("`travel-sample`");
		expect(text).toContain("`inventory`");
		expect(text).toContain("`hotel`");
	});
});

describe("SIO-1443 Critical fix: documentation resources (resources/read) genuinely fail, not 200-success with error text", () => {
	const priorDocumentation = config.documentation;

	afterEach(() => {
		config.documentation = priorDocumentation;
	});

	// Regression test for the task-7 reviewer's Critical finding: the 4 documentation resource
	// handlers in v2/resources.ts (documentation-browser, scope-documentation,
	// collection-documentation, documentation-file) previously `return`ed { contents: [...] } with
	// error-shaped TEXT when config.documentation.enabled was false, which is always a 200 JSON-RPC
	// SUCCESS at the wire level regardless of what the text says.
	//
	// SIO-1443 (reviewer follow-up fix): the original fix made each handler `throw` while still
	// registering all 4 resources unconditionally, which fixed resources/read but left
	// resources/list showing all 4 as available even though reading them always failed -- a
	// discovery-level divergence from v1 (v1 never registers these resources at all when
	// config.documentation.enabled is false; see resources/index.ts:37). The fix now wraps the
	// registration itself in the config check (mirroring v1 exactly), so resources/read for a
	// disabled-config request hits the SDK's own "resource not found" dispatch -- because the
	// resource was never registered -- instead of a custom thrown error. Live-verified (throwaway
	// probe, not committed): the SDK's own not-found response is
	// { error: { code: -32602, message: "Resource not found: <uri>", data: { uri: "<uri>" } } },
	// distinct from the previous custom createError("NOT_FOUND", ...) text and from the -32603
	// internal-error code a thrown handler body would have produced.
	test("docs:// disabled: resources/read returns the SDK's own resource-not-found error, not a 200 success", async () => {
		config.documentation = { enabled: false, baseDirectory: "/tmp/docs", fileExtension: ".md" };

		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "resources/read",
					"Mcp-Name": "docs://",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 7,
					method: "resources/read",
					params: {
						uri: "docs://",
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
			result?: unknown;
			error?: { code?: number; message?: string; data?: { uri?: string } };
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(7);
		// The load-bearing assertion: a genuine top-level JSON-RPC `error`, not a `result` carrying
		// "Error: ..." text -- and specifically the SDK's own "resource was never registered" error
		// (code -32602), not a handler-thrown -32603.
		expect(body.result).toBeUndefined();
		expect(body.error).toBeDefined();
		expect(body.error?.code).toBe(-32602);
		expect(body.error?.message).toContain("Resource not found");
		expect(body.error?.message).toContain("docs://");
	});

	// scope-documentation:// is one of the 3 scheme-less-fixed resources (see resources.ts's header
	// comment on the scheme-less URI finding) -- confirms the conditional-registration fix applies
	// uniformly across all 4 gated resources, not just the one with a "real" scheme.
	test("scope-documentation:// disabled: resources/read returns the SDK's own resource-not-found error", async () => {
		config.documentation = { enabled: false, baseDirectory: "/tmp/docs", fileExtension: ".md" };

		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "resources/read",
					"Mcp-Name": "scope-documentation://",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 8,
					method: "resources/read",
					params: {
						uri: "scope-documentation://",
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
			result?: unknown;
			error?: { code?: number; message?: string; data?: { uri?: string } };
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(8);
		expect(body.result).toBeUndefined();
		expect(body.error).toBeDefined();
		expect(body.error?.code).toBe(-32602);
		expect(body.error?.message).toContain("Resource not found");
		expect(body.error?.message).toContain("scope-documentation://");
	});

	// Direct regression coverage for the actual gap the reviewer flagged: resources/list must omit
	// the 4 documentation resources entirely when documentation is disabled, not just fail their
	// individual reads. Live-verified counts (throwaway probe, not committed): default/disabled
	// config returns exactly 1 resource (database-structure); enabling documentation returns 5
	// (database-structure + the 4 documentation resources) -- matching v1's registerAllResources
	// gating (resources/index.ts:37) 1:1.
	test("resources/list omits the 4 documentation resources when config.documentation.enabled is false", async () => {
		config.documentation = { enabled: false, baseDirectory: "/tmp/docs", fileExtension: ".md" };

		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "resources/list",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 20,
					method: "resources/list",
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
		await handler.close();

		expect(response.status).toBe(200);
		const body = (await parseJsonRpcBody(response)) as {
			jsonrpc: string;
			id: number;
			result?: { resources?: Array<{ uri: string; name: string }> };
			error?: unknown;
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(20);
		expect(body.error).toBeUndefined();
		const uris = (body.result?.resources ?? []).map((r) => r.uri).sort();
		expect(uris).toEqual(["database://structure"]);
		expect(uris).not.toContain("docs://");
		expect(uris).not.toContain("scope-documentation://");
		expect(uris).not.toContain("collection-documentation://");
		expect(uris).not.toContain("documentation-file://");
	});

	// Positive-side counterpart: with documentation enabled, all 4 documentation resources ARE
	// discoverable via resources/list, alongside the always-on database-structure resource.
	test("resources/list includes the 4 documentation resources when config.documentation.enabled is true", async () => {
		config.documentation = { enabled: true, baseDirectory: "/tmp/docs", fileExtension: ".md" };

		const handler = buildHandler();
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "resources/list",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 21,
					method: "resources/list",
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
		await handler.close();

		expect(response.status).toBe(200);
		const body = (await parseJsonRpcBody(response)) as {
			jsonrpc: string;
			id: number;
			result?: { resources?: Array<{ uri: string; name: string }> };
			error?: unknown;
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.id).toBe(21);
		expect(body.error).toBeUndefined();
		const uris = (body.result?.resources ?? []).map((r) => r.uri).sort();
		expect(uris).toEqual(
			[
				"collection-documentation://",
				"database://structure",
				"docs://",
				"documentation-file://",
				"scope-documentation://",
			].sort(),
		);
	});
});
