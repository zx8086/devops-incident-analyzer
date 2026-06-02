// src/transport.ts
import type { BootstrapTransportResult, IdentityCard, ReadinessSnapshot } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Config } from "./config.ts";
import { createContextLogger } from "./logger.ts";

const log = createContextLogger("transport");

interface TransportDeps {
	readinessProbe?: () => Promise<ReadinessSnapshot>;
	identityCard?: IdentityCard;
}

// Stateless streamable-HTTP transport plus the three probe routes the agent's
// health checker hits (/health, /identity, /ready). A fresh McpServer is created
// per request, matching the stateless pattern used by the other servers.
function startHttp(serverFactory: () => McpServer, config: Config, deps: TransportDeps): BootstrapTransportResult {
	const { port, host, path } = config.transport;
	const server = Bun.serve({
		port,
		hostname: host,
		idleTimeout: 120,
		async fetch(req): Promise<Response> {
			const url = new URL(req.url);

			if (req.method === "GET" && url.pathname === "/health") {
				return Response.json({ status: "ok" });
			}
			if (req.method === "GET" && url.pathname === "/identity") {
				return deps.identityCard
					? Response.json(deps.identityCard)
					: new Response("identity unavailable", { status: 404 });
			}
			if (req.method === "GET" && url.pathname === "/ready") {
				if (!deps.readinessProbe) return new Response("readiness unavailable", { status: 404 });
				const snapshot = await deps.readinessProbe();
				return Response.json(snapshot, { status: snapshot.ready ? 200 : 503 });
			}
			if (url.pathname === path) {
				const mcp = serverFactory();
				const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
				// SIO-869: a client that disconnects mid-stream cancels the response reader
				// (benign AbortError). Log it here rather than letting it bubble to the global
				// unhandledRejection handler, which would otherwise exit the whole server.
				transport.onerror = (err: unknown) => {
					log.warn({ error: err instanceof Error ? err.message : String(err) }, "transport stream error");
				};
				await mcp.connect(transport);
				try {
					return await transport.handleRequest(req);
				} catch (error) {
					log.error({ error: error instanceof Error ? error.message : String(error) }, "MCP request failed");
					return Response.json(
						{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
						{ status: 500 },
					);
				}
			}
			return new Response("Not found", { status: 404 });
		},
	});
	log.info({ port, host, path }, "Elastic IaC MCP HTTP transport listening");
	return {
		async closeAll() {
			await server.stop(true);
		},
	};
}

async function startStdio(serverFactory: () => McpServer): Promise<BootstrapTransportResult> {
	const mcp = serverFactory();
	const transport = new StdioServerTransport();
	await mcp.connect(transport);
	return {
		async closeAll() {
			await transport.close();
		},
	};
}

export function createTransport(
	serverFactory: () => McpServer,
	config: Config,
	deps: TransportDeps,
): Promise<BootstrapTransportResult> {
	if (config.transport.mode === "stdio") return startStdio(serverFactory);
	return Promise.resolve(startHttp(serverFactory, config, deps));
}
