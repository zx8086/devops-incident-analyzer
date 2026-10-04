// src/transport.ts
import {
	type BootstrapTransportResult,
	type IdentityCard,
	isBenignStreamCancel,
	type ReadinessSnapshot,
} from "@devops-agent/shared";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
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
	// SIO-1960: one handler per process, building a fresh server per request. It serves the
	// 2025-era protocol (legacy: "stateless") and 2026-07-28 from the same endpoint.
	// SIO-869: a client that disconnects mid-stream cancels the response reader (benign
	// AbortError); route it to warn and keep genuine transport failures at error.
	const mcpHandler = createMcpHandler(serverFactory, {
		legacy: "stateless",
		onerror: (err: Error) => {
			const detail = { error: err.message };
			if (isBenignStreamCancel(err)) log.warn(detail, "benign stream cancel");
			else log.error(detail, "transport stream error");
		},
	});
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
				try {
					return await mcpHandler.fetch(req);
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
		listen: { mode: "http", port: server.port, url: `http://${host}:${server.port}${path}` },
		async closeAll() {
			await server.stop(true);
			await mcpHandler.close();
		},
	};
}

function startStdio(serverFactory: () => McpServer): BootstrapTransportResult {
	const handle = serveStdio(serverFactory);
	return {
		listen: { mode: "stdio" },
		async closeAll() {
			await handle.close();
		},
	};
}

export function createTransport(
	serverFactory: () => McpServer,
	config: Config,
	deps: TransportDeps,
): Promise<BootstrapTransportResult> {
	if (config.transport.mode === "stdio") return Promise.resolve(startStdio(serverFactory));
	return Promise.resolve(startHttp(serverFactory, config, deps));
}
