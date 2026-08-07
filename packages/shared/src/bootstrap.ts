// shared/src/bootstrap.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pino from "pino";
import {
	type BootstrapLogger,
	buildIdentityCard,
	handleStartupFailure,
	type IdentityCard,
	initTelemetry,
	installProcessErrorHandlers,
	installShutdownSignalHandlers,
	isBenignStreamCancel,
	type McpRole,
	openMetricsRecorder,
	shutdownTelemetry,
	type TelemetryConfig,
} from "./bootstrap-lifecycle.ts";
import { installReadOnlyChokepoint, type ReadOnlyMiddlewareConfig } from "./read-only-chokepoint.ts";
import { installToolCallLogging } from "./tool-call-logging.ts";

export type { BootstrapLogger, TelemetryConfig };
export { isBenignStreamCancel };

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

	// Process-level error handlers install BEFORE any startup await -- a background
	// rejection during initDatasource/createTransport would otherwise hit the runtime
	// default (crash) in the window before registration. SIO-986: skip in embedded
	// mode; these are process-GLOBAL and the host app owns them there.
	installProcessErrorHandlers({ name, logger, embedded: options.embedded });

	// SIO-1400 (CodeRabbit): declared outside the try so a startup failure after the
	// recorder opened can close it -- matters in embedded mode, where the process
	// (and its SQLite handle) outlives the failed start.
	let toolMetrics: Awaited<ReturnType<typeof openMetricsRecorder>>;

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
		// SIO-1400: opt-in SQLite usage counters (MCP_TOOL_METRICS_DB_PATH unset = off).
		// Created ONCE per process and shared by every server instance -- the factory
		// below can run per-connection (cached-server-factory), so the recorder must
		// not live inside it. Proxy mode counts in the agentcore proxy itself.
		toolMetrics = await openMetricsRecorder({ mode, name, logger });
		// const capture: the factory closure below outlives this scope, and TS cannot
		// narrow the outer `let` (declared before the try for the error path).
		const metricsSink = toolMetrics;
		// SIO-974: every server gets tools/call lifecycle logging; read-only enforcement is
		// still opt-in. Install order matters: read-only INNER, logging OUTER, so a blocked
		// call (read-only handler short-circuits) is still logged by the outer wrap.
		const serverFactory: (() => McpServer) | undefined = innerFactory
			? () => {
					const server = innerFactory();
					if (readOnlyConfig) installReadOnlyChokepoint(server, readOnlyConfig.manager);
					installToolCallLogging(
						server,
						logger,
						undefined,
						metricsSink ? (outcome) => metricsSink.record(outcome.tool, outcome.ok, outcome.failureClass) : undefined,
					);
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

			// SIO-1400: best-effort -- per-call upserts are already committed (WAL).
			toolMetrics?.close();

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

		// Step 7: Register signal handlers (need `shutdown`, so they cannot install earlier).
		// The uncaughtException/unhandledRejection handlers are registered at function entry,
		// before any startup await. SIO-986: skip in embedded mode -- process-GLOBAL; an
		// in-process server would hijack the host app's SIGINT/SIGTERM. The host owns these.
		installShutdownSignalHandlers({ embedded: options.embedded, shutdown: () => shutdown() });

		// Step 8: Notify startup complete
		if (options.onStarted) {
			options.onStarted(datasource);
		}
		logger.info(`${name} started successfully`);

		return { datasource, transport, shutdown };
	} catch (error) {
		// SIO-1400: a startup failure never reaches the shutdown handle, so close the
		// recorder here (no-op if it never opened; close() is soft-failing).
		toolMetrics?.close();
		handleStartupFailure({ error, name, logger, embedded: options.embedded });
	}
}
