// src/transport/http.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createContextLogger } from "../utils/logger.ts";

const log = createContextLogger("transport-http");

export interface HttpTransportOptions {
	port: number;
	host: string;
	path: string;
}

export interface HttpTransportResult {
	port: number;
	url: string;
	close: () => Promise<void>;
}

export async function startHttpTransport(
	serverFactory: () => McpServer,
	options: HttpTransportOptions,
): Promise<HttpTransportResult> {
	const server = Bun.serve({
		port: options.port,
		hostname: options.host,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			if (url.pathname === "/ping") return new Response("pong", { status: 200 });
			if (url.pathname === "/health")
				return new Response(JSON.stringify({ status: "ok" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			if (url.pathname !== options.path) return new Response("not found", { status: 404 });
			if (req.method !== "POST") {
				return Response.json(
					{ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null },
					{ status: 405, headers: { Allow: "POST" } },
				);
			}

			const mcpServer = serverFactory();
			const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			try {
				await mcpServer.connect(transport);
				return await transport.handleRequest(req);
			} catch (error) {
				log.error({ error: error instanceof Error ? error.message : String(error) }, "MCP request handler error");
				return Response.json(
					{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
					{ status: 500 },
				);
			}
		},
	});

	const port = server.port ?? options.port;
	const url = `http://${options.host}:${port}${options.path}`;
	log.info({ port, host: options.host, path: options.path }, "HTTP transport ready");
	return {
		port,
		url,
		close: async () => {
			await server.stop(true);
		},
	};
}
