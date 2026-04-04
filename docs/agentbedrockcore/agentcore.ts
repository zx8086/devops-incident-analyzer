// src/transport/agentcore.ts
//
// AgentCore Runtime transport adapter.
//
// AgentCore Runtime expects MCP servers to expose:
//   - GET  /ping        → 200 OK (health check)
//   - POST /mcp         → Stateless streamable-HTTP MCP endpoint
//
// This adapter reuses the existing stateless HTTP handler from http.ts
// but configures it for AgentCore's contract:
//   - Port 8000 (AgentCore default)
//   - Host 0.0.0.0 (required for microVM networking)
//   - Path /mcp (AgentCore default)
//   - Stateless session mode (AgentCore manages sessions externally)

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getLogger } from "../logging/container.ts";

export interface AgentCoreTransportConfig {
	port?: number;
	host?: string;
	path?: string;
}

export interface AgentCoreTransportResult {
	server: ReturnType<typeof Bun.serve>;
	close(): Promise<void>;
}

/**
 * Start the MCP server in AgentCore-compatible mode.
 *
 * AgentCore Runtime creates a fresh microVM per session, so stateless mode
 * is the correct choice. The platform adds Mcp-Session-Id headers automatically.
 */
export async function startAgentCoreTransport(
	serverFactory: () => McpServer,
	config: AgentCoreTransportConfig = {},
): Promise<AgentCoreTransportResult> {
	const logger = getLogger();
	const port = config.port ?? 8000;
	const host = config.host ?? "0.0.0.0";
	const mcpPath = config.path ?? "/mcp";

	// Stateless MCP handler — each POST creates a fresh server+transport pair
	const handleMcpPost = async (req: Request): Promise<Response> => {
		const server = serverFactory();
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // Stateless — AgentCore manages sessions
		});

		await server.connect(transport);

		try {
			return await transport.handleRequest(req);
		} catch (error) {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "AgentCore MCP request error");
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
				{ status: 500 },
			);
		}
	};

	const httpServer = Bun.serve({
		port,
		hostname: host,
		idleTimeout: 120,

		routes: {
			// AgentCore health check — must return 200 for the runtime to consider the server ready
			"/ping": {
				GET: () => Response.json({ status: "ok" }),
			},

			// MCP endpoint — AgentCore proxies /invocations → /mcp
			[mcpPath]: {
				POST: handleMcpPost,
				// AgentCore doesn't use GET/DELETE for stateless MCP, but return proper errors
				GET: () =>
					Response.json(
						{ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null },
						{ status: 405, headers: { Allow: "POST" } },
					),
			},

			// Secondary health check path for compatibility
			"/health": {
				GET: () => Response.json({ status: "ok" }),
			},
		},

		fetch: () => {
			return Response.json({ error: "Not found" }, { status: 404 });
		},

		error: (error) => {
			logger.error({ error: error instanceof Error ? error.message : String(error) }, "AgentCore HTTP server error");
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
				{ status: 500 },
			);
		},
	});

	logger.info(
		{
			url: `http://${host}:${httpServer.port}${mcpPath}`,
			mode: "agentcore",
			ping: `http://${host}:${httpServer.port}/ping`,
		},
		"MCP server started (AgentCore Runtime mode)",
	);

	return {
		server: httpServer,
		async close() {
			httpServer.stop(true);
			logger.info("AgentCore transport closed");
		},
	};
}
