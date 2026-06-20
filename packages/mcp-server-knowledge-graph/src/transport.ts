// src/transport.ts
import {
	createServer as createNodeHttp,
	type IncomingMessage as NodeIncomingMessage,
	type ServerResponse as NodeServerResponse,
} from "node:http";
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

interface TransportDeps {
	readinessProbe?: () => Promise<ReadinessSnapshot>;
	identityCard?: IdentityCard;
}

// The route handler, runtime-agnostic (Web Request -> Web Response). Stateless streamable-HTTP
// transport plus the three probe routes the agent's health checker hits (/health, /identity,
// /ready). A fresh McpServer is created per request, matching the other servers' stateless pattern.
function buildRouteHandler(serverFactory: () => McpServer, config: Config, deps: TransportDeps) {
	const { path } = config.transport;
	return async (req: Request): Promise<Response> => {
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
				const detail = { error: err instanceof Error ? err.message : String(err) };
				if (isBenignStreamCancel(err)) log.warn(detail, "benign stream cancel");
				else log.error(detail, "transport stream error");
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
	};
}

// SIO-986: this server is mounted IN-PROCESS in the web app's Vite SSR runtime, where the Bun global
// does not exist -- Bun.serve threw "Bun is not defined". Serve via Bun.serve when running under Bun
// (the standalone-process fast path, unchanged), else via node:http with a Web Request<->Node req/res
// adapter (works under Vite SSR and Node). The route handler above is shared verbatim, so behaviour
// is identical across runtimes. The node:http path is spike-verified end-to-end under a Bun-less node.
function startHttp(
	serverFactory: () => McpServer,
	config: Config,
	deps: TransportDeps,
): Promise<BootstrapTransportResult> {
	const { port, host, path } = config.transport;
	const handler = buildRouteHandler(serverFactory, config, deps);
	const bun = (globalThis as { Bun?: { serve: (opts: unknown) => BunHttpServer } }).Bun;

	if (bun) {
		const server = bun.serve({ port, hostname: host, idleTimeout: 120, fetch: handler });
		log.info({ port, host, path, runtime: "bun" }, "Knowledge Graph MCP HTTP transport listening");
		return Promise.resolve({
			listen: { mode: "http", port: server.port, url: `http://${host}:${server.port}${path}` },
			async closeAll() {
				await server.stop(true);
			},
		});
	}

	return startNodeHttp(handler, config);
}

interface BunHttpServer {
	port: number;
	stop(closeActiveConnections?: boolean): Promise<void>;
}

// node:http server hosting the Web-standard route handler. Used in-process under Vite SSR / Node,
// where Bun.serve is unavailable. (SIO-986; spike-verified under a Bun-less node runtime.) Returns a
// Promise that REJECTS on a bind failure: server.listen reports EADDRINUSE via an async 'error' event,
// detached from the call -- without this an unhandled 'error' event would crash the process, defeating
// the caller's best-effort handling. Bind the 'error' listener BEFORE listen() so the event is caught.
function startNodeHttp(
	handler: (req: Request) => Promise<Response>,
	config: Config,
): Promise<BootstrapTransportResult> {
	const { port, host, path } = config.transport;
	const server = createNodeHttp((req, res) => {
		nodeReqToWebRequest(req)
			.then(handler)
			.then((webRes) => writeWebResponseToNode(res, webRes))
			.catch((error) => {
				log.error({ error: error instanceof Error ? error.message : String(error) }, "node:http request failed");
				if (!res.headersSent) res.writeHead(500);
				res.end();
			});
	});
	return new Promise<BootstrapTransportResult>((resolve, reject) => {
		server.once("error", reject); // EADDRINUSE etc. arrive here, async, after listen()
		server.listen(Number(port), host, () => {
			server.removeListener("error", reject);
			// Keep a permanent listener so a later runtime error logs instead of crashing the process.
			server.on("error", (err) => log.error({ error: err.message }, "node:http server error"));
			const a = server.address();
			const actualPort = typeof a === "object" && a ? a.port : Number(port);
			log.info({ port: actualPort, host, path, runtime: "node" }, "Knowledge Graph MCP HTTP transport listening");
			resolve({
				listen: { mode: "http", port: actualPort, url: `http://${host}:${actualPort}${path}` },
				closeAll() {
					return new Promise<void>((res2, rej2) => server.close((err) => (err ? rej2(err) : res2())));
				},
			});
		});
	});
}

// Web Request <- Node IncomingMessage: collect the body and build a whatwg Request.
function nodeReqToWebRequest(req: NodeIncomingMessage): Promise<Request> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("error", reject);
		req.on("end", () => {
			const url = `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
			const headers = new Headers();
			for (const [k, v] of Object.entries(req.headers)) {
				if (typeof v === "string") headers.set(k, v);
				else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
			}
			const method = req.method ?? "GET";
			const hasBody = method !== "GET" && method !== "HEAD" && chunks.length > 0;
			resolve(new Request(url, { method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }));
		});
	});
}

// Web Response -> Node ServerResponse, streaming the body so SSE responses flush incrementally.
async function writeWebResponseToNode(res: NodeServerResponse, webRes: Response): Promise<void> {
	res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
	if (!webRes.body) {
		res.end();
		return;
	}
	const reader = webRes.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(Buffer.from(value));
		}
	} finally {
		res.end();
	}
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
	deps: TransportDeps,
): Promise<BootstrapTransportResult> {
	if (config.transport.mode === "stdio") return startStdio(serverFactory);
	return startHttp(serverFactory, config, deps);
}
