// shared/src/transport/agentcore.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { BootstrapLogger } from "../bootstrap.ts";

export interface AgentCoreTransportConfig {
	port?: number;
	host?: string;
	path?: string;
}

export interface AgentCoreTransportResult {
	server: ReturnType<typeof Bun.serve>;
	close(): Promise<void>;
}

// AgentCore Runtime expects:
//   GET  /ping  -> 200 OK (health check)
//   POST /mcp   -> Stateless streamable-HTTP MCP endpoint
// Port 8000, host 0.0.0.0, stateless mode (AgentCore manages sessions in microVMs)
export async function startAgentCoreTransport(
	serverFactory: () => McpServer,
	logger: BootstrapLogger,
	config: AgentCoreTransportConfig = {},
): Promise<AgentCoreTransportResult> {
	const port = config.port ?? 8000;
	const host = config.host ?? "0.0.0.0";
	const mcpPath = config.path ?? "/mcp";

	const handleMcpPost = async (req: Request): Promise<Response> => {
		const server = serverFactory();
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});

		await server.connect(transport);

		try {
			return await transport.handleRequest(req);
		} catch (error) {
			logger.error("AgentCore MCP request error", {
				error: error instanceof Error ? error.message : String(error),
			});
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
			"/ping": {
				GET: () => Response.json({ status: "ok" }),
			},

			[mcpPath]: {
				POST: handleMcpPost,
				GET: () =>
					Response.json(
						{ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null },
						{ status: 405, headers: { Allow: "POST" } },
					),
			},

			"/health": {
				GET: () => Response.json({ status: "ok" }),
			},
		},

		fetch: () => {
			return Response.json({ error: "Not found" }, { status: 404 });
		},

		error: (error) => {
			logger.error("AgentCore HTTP server error", {
				error: error instanceof Error ? error.message : String(error),
			});
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
				{ status: 500 },
			);
		},
	});

	logger.info("MCP server started (AgentCore Runtime mode)", {
		url: `http://${host}:${httpServer.port}${mcpPath}`,
		mode: "agentcore",
		ping: `http://${host}:${httpServer.port}/ping`,
	});

	return {
		server: httpServer,
		async close() {
			httpServer.stop(true);
			logger.info("AgentCore transport closed");
		},
	};
}
