// shared/src/transport/agentcore.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { BootstrapLogger } from "../bootstrap.ts";
import { drainBunServer } from "./drain-helper.ts";

// SIO-727: default drain deadline. 25s leaves 5s headroom under k8s/AgentCore's
// typical 30s terminationGracePeriodSeconds.
const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;

export interface AgentCoreTransportConfig {
	port?: number;
	host?: string;
	path?: string;
	// SIO-727: max time to wait for in-flight MCP requests to finish on close()
	// before force-closing. 0 = immediate force-close. Default 25s.
	drainTimeoutMs?: number;
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
	const drainTimeoutMs = config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

	// SIO-727: shared shuttingDown flag. close() flips it before drain so /mcp
	// requests that race in during the brief stop() propagation window get a
	// clean JSON-RPC 503 envelope. /ping and /health stay live throughout drain
	// because they ARE AgentCore's health surface -- the framework needs them
	// up to see the container is still alive while draining.
	let shuttingDown = false;

	const handleMcpPost = async (req: Request): Promise<Response> => {
		if (shuttingDown) {
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Server is shutting down" }, id: null },
				{ status: 503, headers: { "Retry-After": "30" } },
			);
		}

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
			// SIO-727: flip the gate BEFORE draining so /mcp requests racing in
			// during stop() propagation get the clean 503 envelope. /ping and
			// /health are not gated -- they must stay 200 throughout drain so
			// the AgentCore framework keeps the container "alive" during cleanup.
			shuttingDown = true;
			await drainBunServer(httpServer, drainTimeoutMs, logger);
			logger.info("AgentCore transport closed");
		},
	};
}
