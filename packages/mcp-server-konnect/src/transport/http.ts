// src/transport/http.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { withTraceContextMiddleware } from "@devops-agent/shared";
import { mcpLogger } from "../utils/mcp-logger.js";
import { withApiKeyAuth, withOriginValidation } from "./middleware.ts";

interface HttpTransportConfig {
	port: number;
	host: string;
	path: string;
	sessionMode: "stateless" | "stateful";
	idleTimeout: number;
	apiKey?: string;
	allowedOrigins?: string[];
}

type ServerFactory = () => McpServer;

interface SessionEntry {
	transport: WebStandardStreamableHTTPServerTransport;
	server: McpServer;
}

export interface HttpTransportResult {
	server: ReturnType<typeof Bun.serve>;
	close(): Promise<void>;
}

function methodNotAllowed(): Response {
	return Response.json(
		{ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null },
		{ status: 405, headers: { Allow: "POST" } },
	);
}

function badRequest(message: string): Response {
	return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status: 400 });
}

function createStatelessHandler(serverFactory: ServerFactory) {
	return async (req: Request): Promise<Response> => {
		const server = serverFactory();
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});

		await server.connect(transport);

		try {
			return await transport.handleRequest(req);
		} catch (error) {
			mcpLogger.error("transport", "Stateless request error", {
				error: error instanceof Error ? error.message : String(error),
			});
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
				{ status: 500 },
			);
		}
	};
}

function createStatefulHandlers(serverFactory: ServerFactory) {
	const sessions = new Map<string, SessionEntry>();

	async function handlePost(req: Request): Promise<Response> {
		const sessionId = req.headers.get("mcp-session-id");

		// Existing session: delegate to its transport
		const existingSession = sessionId ? sessions.get(sessionId) : undefined;
		if (existingSession) {
			return existingSession.transport.handleRequest(req);
		}

		// New session: create transport and server
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
			onsessioninitialized: (id) => {
				mcpLogger.info("transport", "Session initialized", { sessionId: id });
			},
		});

		const server = serverFactory();
		await server.connect(transport);

		transport.onclose = () => {
			if (transport.sessionId) {
				sessions.delete(transport.sessionId);
				mcpLogger.info("transport", "Session closed", { sessionId: transport.sessionId });
			}
		};

		const response = await transport.handleRequest(req);

		if (transport.sessionId) {
			sessions.set(transport.sessionId, { transport, server });
		}

		return response;
	}

	async function handleGet(req: Request): Promise<Response> {
		const sessionId = req.headers.get("mcp-session-id");
		const session = sessionId ? sessions.get(sessionId) : undefined;
		if (!session) {
			return badRequest("Bad request: no valid session");
		}
		return session.transport.handleRequest(req);
	}

	async function handleDelete(req: Request): Promise<Response> {
		const sessionId = req.headers.get("mcp-session-id");
		const session = sessionId ? sessions.get(sessionId) : undefined;
		if (!session || !sessionId) {
			return badRequest("Bad request: no valid session");
		}
		await session.transport.close();
		await session.server.close();
		sessions.delete(sessionId);
		return new Response(null, { status: 200 });
	}

	async function closeAll(): Promise<void> {
		const count = sessions.size;
		for (const [id, session] of sessions) {
			try {
				await session.transport.close();
				await session.server.close();
			} catch {
				// Best effort cleanup
			}
			sessions.delete(id);
		}
		if (count > 0) {
			mcpLogger.info("transport", "All sessions closed", { count });
		}
	}

	return { handlePost, handleGet, handleDelete, closeAll };
}

export async function startHttpTransport(
	serverFactory: ServerFactory,
	config: HttpTransportConfig,
): Promise<HttpTransportResult> {
	const isStateful = config.sessionMode === "stateful";

	let postHandler: (req: Request) => Promise<Response>;
	let getHandler: (req: Request) => Promise<Response> | Response;
	let deleteHandler: (req: Request) => Promise<Response> | Response;
	let closeAllSessions: (() => Promise<void>) | undefined;

	if (isStateful) {
		const handlers = createStatefulHandlers(serverFactory);
		postHandler = handlers.handlePost;
		getHandler = handlers.handleGet;
		deleteHandler = handlers.handleDelete;
		closeAllSessions = handlers.closeAll;
	} else {
		postHandler = createStatelessHandler(serverFactory);
		getHandler = methodNotAllowed;
		deleteHandler = methodNotAllowed;
	}

	// Apply security middleware
	const securedPost = withTraceContextMiddleware(
		withApiKeyAuth(withOriginValidation(postHandler, config.allowedOrigins), config.apiKey),
	);
	const securedGet = withApiKeyAuth(withOriginValidation(getHandler, config.allowedOrigins), config.apiKey);
	const securedDelete = withApiKeyAuth(withOriginValidation(deleteHandler, config.allowedOrigins), config.apiKey);

	const httpServer = Bun.serve({
		port: config.port,
		hostname: config.host,
		idleTimeout: config.idleTimeout,

		routes: {
			[config.path]: {
				POST: securedPost,
				GET: securedGet,
				DELETE: securedDelete,
			},
			"/health": {
				GET: () => Response.json({ status: "ok" }),
			},
		},

		fetch: () => {
			return Response.json({ error: "Not found" }, { status: 404 });
		},

		error: (error) => {
			mcpLogger.error("transport", "HTTP server error", {
				error: error instanceof Error ? error.message : String(error),
			});
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
				{ status: 500 },
			);
		},
	});

	mcpLogger.info("transport", `MCP server started (HTTP ${config.sessionMode} mode)`, {
		url: `http://${config.host}:${httpServer.port}${config.path}`,
		sessionMode: config.sessionMode,
	});

	return {
		server: httpServer,
		async close() {
			if (closeAllSessions) {
				await closeAllSessions();
			}
			httpServer.stop(true);
			mcpLogger.info("transport", "HTTP transport closed");
		},
	};
}
