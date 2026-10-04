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

interface TransportDependencies {
	readinessProbe?: () => Promise<ReadinessSnapshot>;
	identityCard?: IdentityCard;
}

function startHttp(
	serverFactory: () => McpServer,
	config: Config,
	dependencies: TransportDependencies,
): BootstrapTransportResult {
	const { port, host, path } = config.transport;
	// SIO-1958: one handler per process. It builds a fresh server per request and serves both the
	// 2025-era protocol (legacy: "stateless") and 2026-07-28 from the same endpoint.
	const mcpHandler = createMcpHandler(serverFactory, {
		legacy: "stateless",
		onerror: (error: Error) => {
			const detail = { error: error.message };
			if (isBenignStreamCancel(error)) log.warn(detail, "benign stream cancel");
			else log.error(detail, "transport stream error");
		},
	});
	const server = Bun.serve({
		port,
		hostname: host,
		idleTimeout: 120,
		async fetch(request): Promise<Response> {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/health") return Response.json({ status: "ok" });
			if (request.method === "GET" && url.pathname === "/identity") {
				return dependencies.identityCard
					? Response.json(dependencies.identityCard)
					: new Response("identity unavailable", { status: 404 });
			}
			if (request.method === "GET" && url.pathname === "/ready") {
				if (!dependencies.readinessProbe) return new Response("readiness unavailable", { status: 404 });
				const snapshot = await dependencies.readinessProbe();
				return Response.json(snapshot, { status: snapshot.ready ? 200 : 503 });
			}
			if (url.pathname !== path) return new Response("Not found", { status: 404 });

			try {
				return await mcpHandler.fetch(request);
			} catch (error) {
				log.error({ error: error instanceof Error ? error.message : String(error) }, "MCP request failed");
				return Response.json(
					{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
					{ status: 500 },
				);
			}
		},
	});
	log.info({ port, host, path }, "Landing Zone IaC MCP HTTP transport listening");
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
	dependencies: TransportDependencies,
): Promise<BootstrapTransportResult> {
	if (config.transport.mode === "stdio") return Promise.resolve(startStdio(serverFactory));
	return Promise.resolve(startHttp(serverFactory, config, dependencies));
}
