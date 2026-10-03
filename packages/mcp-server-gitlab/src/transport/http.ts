// src/transport/http.ts

import type { IdentityCard, ReadinessSnapshot } from "@devops-agent/shared";
import { withTraceContextMiddleware } from "@devops-agent/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createContextLogger } from "../utils/logger.js";
import { withApiKeyAuth, withOriginValidation } from "./middleware.ts";

const log = createContextLogger("transport");

interface HttpTransportConfig {
	port: number;
	host: string;
	path: string;
	idleTimeout: number;
	apiKey?: string;
	allowedOrigins?: string[];
	// SIO-780: readiness probe wired into GET /ready; single-component
	// getCurrentUser token-validation call. When omitted, /ready returns
	// 404 (stdio/AgentCore have no HTTP surface).
	readinessProbe?: () => Promise<ReadinessSnapshot>;
	// SIO-780: identity card returned by GET /identity
	identityCard?: IdentityCard;
	// SIO-1209: last-observed "embeddings not ready" projects, returned by
	// GET /status/semantic-search. GitLab.com owns embeddings indexing and
	// exposes no live status API, so this is passive/observational (populated
	// from real search failures, not a probe) -- see tools/proxy/index.ts.
	semanticSearchStatus?: () => Array<{ projectId: string; lastNotReadyAt: string }>;
}

type ServerFactory = () => McpServer;

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
			log.error({ error: error instanceof Error ? error.message : String(error) }, "Stateless request error");
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
				{ status: 500 },
			);
		}
	};
}

export async function startHttpTransport(
	serverFactory: ServerFactory,
	config: HttpTransportConfig,
): Promise<HttpTransportResult> {
	const postHandler = createStatelessHandler(serverFactory);
	const getHandler = methodNotAllowed;
	const deleteHandler = methodNotAllowed;

	const securedPost = withTraceContextMiddleware(
		withApiKeyAuth(withOriginValidation(postHandler, config.allowedOrigins), config.apiKey),
	);
	const securedGet = withApiKeyAuth(withOriginValidation(getHandler, config.allowedOrigins), config.apiKey);
	const securedDelete = withApiKeyAuth(withOriginValidation(deleteHandler, config.allowedOrigins), config.apiKey);

	// SIO-780: readiness route. Internal probe exceptions render as 503 so
	// /ready never 500s -- an internal failure inside the probe is itself a
	// readiness failure.
	const readinessHandler = config.readinessProbe
		? async (): Promise<Response> => {
				try {
					const probe = config.readinessProbe;
					if (!probe) {
						return Response.json({ error: "readiness probe not configured" }, { status: 503 });
					}
					const snapshot = await probe();
					return Response.json(snapshot, { status: snapshot.ready ? 200 : 503 });
				} catch (err) {
					log.error({ error: err instanceof Error ? err.message : String(err) }, "Readiness probe threw");
					return Response.json(
						{ ready: false, error: err instanceof Error ? err.message : String(err) },
						{ status: 503 },
					);
				}
			}
		: null;
	const readyHandler = readinessHandler ?? (() => Response.json({ error: "Not found" }, { status: 404 }));

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
			"/identity": {
				GET: () =>
					config.identityCard
						? Response.json(config.identityCard)
						: Response.json({ error: "identity not configured" }, { status: 503 }),
			},
			// SIO-780: readiness route
			"/ready": {
				GET: readyHandler,
			},
			// SIO-1209: passive semantic-search-embeddings status (not a live probe --
			// see semanticSearchStatus doc above).
			"/status/semantic-search": {
				GET: () => Response.json({ notReadyProjects: config.semanticSearchStatus?.() ?? [] }),
			},
		},
		fetch: () => {
			return Response.json({ error: "Not found" }, { status: 404 });
		},
		error: (error) => {
			log.error({ error: error instanceof Error ? error.message : String(error) }, "HTTP server error");
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
				{ status: 500 },
			);
		},
	});

	log.info(
		{ url: `http://${config.host}:${httpServer.port}${config.path}` },
		"MCP server started (HTTP stateless mode)",
	);

	return {
		server: httpServer,
		async close() {
			httpServer.stop(true);
			log.info("HTTP transport closed");
		},
	};
}
