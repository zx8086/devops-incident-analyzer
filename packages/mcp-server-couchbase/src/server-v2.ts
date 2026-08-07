// src/server-v2.ts
//
// SIO-1424: pilot MCP SDK 2.0.0 registration + createMcpHandler(factory, { legacy: 'stateless' })
// on couchbase's capella_ping tool. Deliberately minimal (one tool): the goal is proving the v2
// serving model, chokepoint/logging rebuild, and dual-era wire protocol end to end, NOT porting
// couchbase's full v1 tool surface. Does not share createMcpServerFactory (server.ts) -- v2's
// per-request McpServerFactory model and v1's record-once/replay-many createCachedServerFactory
// are fundamentally different serving shapes (see bootstrap-v2.ts's header comment).
import {
	McpServer,
	type McpServerFactory,
	type RegisteredTool,
	SUPPORTED_PROTOCOL_VERSIONS,
	type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { connectionManager } from "./lib/connectionManager.ts";
import { installReadOnlyChokepointV2, installToolCallLoggingV2, type ToolCallLogger } from "./v2/tool-call-wrappers.ts";
import { registerCoreToolsV2 } from "./v2/tools/core.ts";
import { registerDocumentationToolsV2 } from "./v2/tools/documentation.ts";

const PING_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

// SIO-1424: read-only manager stub proving the chokepoint rebuild composes correctly end to end.
// Not wired to couchbase's real readOnlyQueryMode config -- v1 couchbase never enables
// installReadOnlyChokepoint either (it enforces read-only at the query-parser layer instead, see
// runSqlPlusPlusQuery.ts); this pilot exists to prove the v2 SEAM works, matching the pattern
// other v1 servers (atlassian, elastic) already rely on for real.
const ALWAYS_ALLOW_MANAGER = {
	checkOperation: () => ({ allowed: true }),
	createBlockedResponse: () => ({ content: [{ type: "text", text: "blocked" }], isError: true }),
	createWarningResponse: (_toolName: string, originalResponse: unknown) => originalResponse,
};

// Builds a fresh McpServer per createMcpHandler invocation (one per HTTP request under the
// 'stateless' legacy posture) and applies the read-only-then-logging composition to every
// registered tool via the v2 public per-tool seam (RegisteredTool.update()).
export function buildServerFactory(logger: ToolCallLogger): McpServerFactory {
	return async () => {
		// SIO-1436: the SDK's default SUPPORTED_PROTOCOL_VERSIONS has no 2026-07-28 entry, so
		// without this override the modern-only handlers (e.g. server/discover's _ondiscover) are
		// never registered on this instance -- createMcpHandler's HTTP router still classifies a
		// fully-claimed modern request correctly, but dispatch then hits a genuinely-unregistered
		// method and returns -32601. Root-caused via the installed @modelcontextprotocol/server
		// bundle: dist/mcp-DXXb3Vv3.mjs:733 (Server constructor's conditional registration) and
		// dist/src-CX2iR2pK.mjs:6157 / @modelcontextprotocol/core's auth-CUe6YdwF.mjs:6-12 (the
		// version list itself). See server-v2-wire.test.ts's server/discover test for the wire-level
		// proof.
		const server = new McpServer(
			{ name: "mcp-server-couchbase-v2", version: "0.1.0-pilot" },
			{ supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS, "2026-07-28"] },
		);

		const tools = new Map<string, RegisteredTool>();

		const ping = server.registerTool(
			"capella_ping",
			{
				description: "Checks the server and database connection status (v2 pilot)",
				inputSchema: z.object({}),
				annotations: PING_ANNOTATIONS,
			},
			async () => {
				if (!connectionManager.isConnectionHealthy()) {
					return { content: [{ type: "text", text: "Server is running but not connected to a database." }] };
				}
				try {
					const bucket = await connectionManager.getConnection();
					await bucket.ping();
					return { content: [{ type: "text", text: "Server and database are healthy" }] };
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Server is running but database connection failed. ${error instanceof Error ? error.message : String(error)}`,
							},
						],
					};
				}
			},
		);
		tools.set("capella_ping", ping);

		// SIO-1443: core/database tools (buckets, cluster health, scopes/collections, schema,
		// SQL++ query/explain, single-document CRUD).
		registerCoreToolsV2(server, tools);

		// SIO-1443: documentation tools (create/list/delete/sync/read markdown docs).
		registerDocumentationToolsV2(server, tools);

		// SIO-1424: composition order matches v1's serverFactory closure in bootstrap.ts --
		// read-only INNER (installed first), tool-call logging OUTER (installed second, so a
		// blocked call is still logged).
		installReadOnlyChokepointV2(tools, ALWAYS_ALLOW_MANAGER);
		installToolCallLoggingV2(tools, logger);

		return server;
	};
}
