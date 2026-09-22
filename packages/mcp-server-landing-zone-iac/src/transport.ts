import {
	type BootstrapTransportResult,
	type IdentityCard,
	isBenignStreamCancel,
	type ReadinessSnapshot,
} from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
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

			const mcp = serverFactory();
			const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			transport.onerror = (error: unknown) => {
				const detail = { error: error instanceof Error ? error.message : String(error) };
				if (isBenignStreamCancel(error)) log.warn(detail, "benign stream cancel");
				else log.error(detail, "transport stream error");
			};
			await mcp.connect(transport);
			try {
				return await transport.handleRequest(request);
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
		},
	};
}

async function startStdio(serverFactory: () => McpServer): Promise<BootstrapTransportResult> {
	const mcp = serverFactory();
	const transport = new StdioServerTransport();
	await mcp.connect(transport);
	return {
		listen: { mode: "stdio" },
		async closeAll() {
			await transport.close();
		},
	};
}

export function createTransport(
	serverFactory: () => McpServer,
	config: Config,
	dependencies: TransportDependencies,
): Promise<BootstrapTransportResult> {
	if (config.transport.mode === "stdio") return startStdio(serverFactory);
	return Promise.resolve(startHttp(serverFactory, config, dependencies));
}
