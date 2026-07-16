// shared/src/bootstrap.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pino from "pino";
import { OAuthRequiresInteractiveAuthError } from "./oauth/errors.ts";
import { installReadOnlyChokepoint, type ReadOnlyMiddlewareConfig } from "./read-only-chokepoint.ts";
import { initTelemetry, shutdownTelemetry, type TelemetryConfig } from "./telemetry/telemetry.ts";
import { installToolCallLogging } from "./tool-call-logging.ts";
import { buildIdentityCard, type IdentityCard, type McpRole } from "./transport/identity.ts";

export type { TelemetryConfig };

export interface BootstrapLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	flush?(): void;
}

// Bridges Pino's (mergeObj, message) arg order to BootstrapLogger's (message, meta?) interface
export function createBootstrapAdapter(pinoLogger: pino.Logger): BootstrapLogger {
	return {
		info: (msg, meta) => (meta ? pinoLogger.info(meta, msg) : pinoLogger.info(msg)),
		error: (msg, meta) => (meta ? pinoLogger.error(meta, msg) : pinoLogger.error(msg)),
		warn: (msg, meta) => (meta ? pinoLogger.warn(meta, msg) : pinoLogger.warn(msg)),
		flush: () => pinoLogger.flush?.(),
	};
}

// Per-server transport surface for the uniform "listening on" boot line.
// http/agentcore populate port (+ url); stdio leaves port undefined so the
// boot log says "stdio transport, no port" instead of inventing a bogus port.
export interface TransportListenInfo {
	mode: string;
	port?: number;
	url?: string;
}

export interface BootstrapTransportResult {
	listen?: TransportListenInfo;
	closeAll(): Promise<void>;
}

// SIO-869: an SSE client that disconnects mid-stream (e.g. the agent pausing at a
// plan-review gate) cancels the response stream reader, surfacing a benign AbortError.
// It must not escalate to process.exit() and take the whole MCP server down.
export function isBenignStreamCancel(reason: unknown): boolean {
	return (
		reason instanceof Error &&
		reason.name === "AbortError" &&
		/releaseLock|stream reader (?:was )?cancelled/i.test(reason.message)
	);
}

export interface McpApplicationOptions<T> {
	name: string;
	logger: BootstrapLogger;
	initTracing: () => void;
	telemetry: TelemetryConfig;
	initDatasource: () => Promise<T>;
	mode?: "server" | "proxy";
	createServerFactory?: (datasource: T) => () => McpServer;
	createTransport: (
		serverFactory: (() => McpServer) | undefined,
		datasource: T,
		identityCard: IdentityCard,
	) => Promise<BootstrapTransportResult>;
	cleanupDatasource?: (datasource: T) => Promise<void>;
	onStarted?: (datasource: T) => void;
	// SIO-671: opt-in dispatcher-level read-only enforcement. When supplied,
	// every McpServer produced by createServerFactory has its tools/call
	// handler wrapped to consult the manager before delegating.
	readOnly?: ReadOnlyMiddlewareConfig;
	// SIO-780 Phase A
	role: McpRole;
	version: string;
	identityFingerprint: (datasource: T) => string;
	// SIO-986: embedded (in-process) mode. A standalone MCP process IS its server, so a fatal start
	// error or a stray signal/exception should process.exit(). But the knowledge-graph server is
	// mounted IN-PROCESS in the web app -- there, process.exit() / process-global SIGINT|SIGTERM|
	// uncaughtException|unhandledRejection handlers would take the WHOLE app down. When embedded:
	//   - a startup failure RETHROWS (the host's try/catch handles it) instead of process.exit(1);
	//   - the process-global signal/exception handlers are NOT installed (the host app owns those).
	// Default (false) preserves the standalone behaviour for every other server unchanged.
	embedded?: boolean;
}

export interface McpApplication<T> {
	datasource: T;
	transport: BootstrapTransportResult;
	shutdown: () => Promise<void>;
}

export async function createMcpApplication<T>(options: McpApplicationOptions<T>): Promise<McpApplication<T>> {
	const { logger, name } = options;

	try {
		// Step 1: LangSmith tracing (must be first -- sets env vars before anything reads them)
		options.initTracing();

		// Step 2: OTEL telemetry
		const otelSdk = initTelemetry(options.telemetry);

		// Step 3: Datasource initialization
		logger.info(`Initializing datasource for ${name}`);
		const datasource = await options.initDatasource();

		// Step 4: Create server factory (skipped in proxy mode)
		const mode = options.mode ?? "server";
		if (mode !== "proxy" && !options.createServerFactory) {
			throw new Error("createServerFactory is required when mode != 'proxy'");
		}
		const innerFactory =
			mode === "proxy" || !options.createServerFactory ? undefined : options.createServerFactory(datasource);
		const readOnlyConfig = options.readOnly;
		// SIO-974: every server gets tools/call lifecycle logging; read-only enforcement is
		// still opt-in. Install order matters: read-only INNER, logging OUTER, so a blocked
		// call (read-only handler short-circuits) is still logged by the outer wrap.
		const serverFactory: (() => McpServer) | undefined = innerFactory
			? () => {
					const server = innerFactory();
					if (readOnlyConfig) installReadOnlyChokepoint(server, readOnlyConfig.manager);
					installToolCallLogging(server, logger);
					return server;
				}
			: innerFactory;

		// Step 4b: Build IdentityCard for /identity route consumers (Phase A: SIO-780)
		const identityCard = buildIdentityCard({
			role: options.role,
			version: options.version,
			mode: mode === "proxy" ? "agentcore-proxy" : "http",
			upstreamFingerprint: options.identityFingerprint(datasource),
		});
		logger.info("Identity card built", {
			instanceId: identityCard.instanceId,
			role: identityCard.role,
			upstreamFingerprint: identityCard.upstreamFingerprint,
		});

		// Step 5: Start transport (serverFactory may be undefined in proxy mode)
		const transport = await options.createTransport(serverFactory, datasource, identityCard);

		// Step 5b: Uniform startup line so every server states its listening port
		// (or stdio) on launch, regardless of which transport mode it selected.
		const listen = transport.listen;
		if (listen?.port !== undefined) {
			logger.info(`${name} listening on ${listen.url ?? `port ${listen.port}`}`, {
				port: listen.port,
				mode: listen.mode,
			});
		} else {
			logger.info(`${name} ready (${listen?.mode ?? "stdio"} transport, no port)`, {
				mode: listen?.mode ?? "stdio",
			});
		}

		// Step 6: Build structured shutdown function with re-entrancy guard
		let isShuttingDown = false;

		const shutdown = async () => {
			if (isShuttingDown) return;
			isShuttingDown = true;

			logger.info(`Shutting down ${name}...`);

			try {
				await transport.closeAll();
			} catch (error) {
				logger.warn("Error closing transport", {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			if (options.cleanupDatasource) {
				try {
					await options.cleanupDatasource(datasource);
				} catch (error) {
					logger.warn("Error cleaning up datasource", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			try {
				await shutdownTelemetry(otelSdk);
			} catch (error) {
				logger.warn("Error shutting down telemetry", {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			if (logger.flush) {
				logger.flush();
			}

			logger.info(`${name} shutdown completed`);
			process.exit(0);
		};

		// Step 7: Register process-level signal handlers. SIO-986: skip in embedded mode -- these are
		// process-GLOBAL, so an in-process server would hijack the host app's SIGINT/SIGTERM and call
		// process.exit() on any uncaught exception/rejection anywhere in the app. The host owns these.
		if (!options.embedded) {
			process.on("SIGINT", () => shutdown());
			process.on("SIGTERM", () => shutdown());

			process.on("uncaughtException", (error) => {
				logger.error(`Uncaught exception in ${name}`, {
					error: error.message,
					stack: error.stack,
					name: error.name,
				});
				if (logger.flush) logger.flush();
				process.exit(1);
			});

			process.on("unhandledRejection", (reason) => {
				if (isBenignStreamCancel(reason)) {
					logger.warn(`Ignoring benign stream-cancel in ${name}`, {
						reason: reason instanceof Error ? reason.message : String(reason),
					});
					return;
				}
				logger.error(`Unhandled rejection in ${name}`, {
					reason: reason instanceof Error ? reason.message : String(reason),
					stack: reason instanceof Error ? reason.stack : undefined,
				});
				if (logger.flush) logger.flush();
				process.exit(1);
			});
		}

		// Step 8: Notify startup complete
		if (options.onStarted) {
			options.onStarted(datasource);
		}
		logger.info(`${name} started successfully`);

		return { datasource, transport, shutdown };
	} catch (error) {
		// An un-authorized OAuth server (no valid seeded tokens under headless /
		// non-interactive stdout) surfaces a typed error. The deep SDK auth stack
		// (auth.js -> streamableHttp.js) is noise -- the fix is a one-time
		// interactive seed -- so render one actionable line, then exit non-zero.
		if (error instanceof OAuthRequiresInteractiveAuthError) {
			logger.error(
				`Cannot start ${name}: ${error.namespace} OAuth is not authorized (no valid seeded tokens under ` +
					`MCP_OAUTH_HEADLESS / non-interactive stdout). Run \`bun run oauth:seed:${error.namespace}\` once ` +
					"interactively to seed tokens (add `-- --force` to re-seed expired tokens), then restart.",
				{ namespace: error.namespace },
			);
			if (logger.flush) logger.flush();
			process.exit(1);
		}
		// SIO-986: embedded servers must NOT take the host app down. Rethrow so the host's try/catch
		// (.catch) handles it gracefully; only a standalone process exits.
		// SIO-987: and do NOT log a level:50 "Fatal" line in embedded mode -- a start failure there is
		// expected/recoverable (the host logs its own actionable WARN), so a scary Fatal is misleading
		// noise. A standalone process logs Fatal + exits, unchanged.
		if (options.embedded) {
			if (logger.flush) logger.flush();
			throw error;
		}
		logger.error(`Fatal error starting ${name}`, {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		if (logger.flush) logger.flush();
		process.exit(1);
	}
}
