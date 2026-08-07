// shared/src/bootstrap-v2.ts
//
// SIO-1424: pilot v2 bootstrap on the MCP SDK's 2.0.0 package family (@modelcontextprotocol/
// server|core|node), built on the SIO-1423 bootstrap-lifecycle.ts extraction. NOT exported from
// index.ts -- couchbase's server-v2.ts imports this by path, matching bootstrap-lifecycle.ts's own
// convention (see F1 handover: "not exported from index.ts... F2 imports by path").
//
// v2's serving model is fundamentally different from v1's: createMcpHandler(factory, options)
// returns a { fetch, close, notify, bus } object -- there is no "start a listening transport, run
// until a signal" imperative flow the way v1's createTransport callback provides. createMcpHandler
// itself owns per-request server construction (one McpServer per HTTP request via the caller's
// McpServerFactory). createMcpApplicationV2 therefore wraps createMcpHandler's construction and a
// caller-supplied Bun.serve() (or equivalent) listener, not a v1-style transport factory.
import {
	type BootstrapLogger,
	handleStartupFailure,
	initTelemetry,
	installProcessErrorHandlers,
	installShutdownSignalHandlers,
	type McpRole,
	openMetricsRecorder,
	shutdownTelemetry,
	type TelemetryConfig,
} from "./bootstrap-lifecycle.ts";
import { buildIdentityCard, type IdentityCard } from "./transport/identity.ts";

export interface McpApplicationV2Options<T> {
	name: string;
	logger: BootstrapLogger;
	initTracing: () => void;
	telemetry: TelemetryConfig;
	initDatasource: () => Promise<T>;
	// SIO-1424: builds the v2 McpHttpHandler (the createMcpHandler(...) call site) once startup
	// data is ready. Distinct from v1's createServerFactory: v2 constructs one server PER REQUEST
	// via its own McpServerFactory, closed over inside this callback -- there is no equivalent to
	// v1's single long-lived serverFactory() the caller passes to createTransport.
	createHandler: (
		datasource: T,
		identityCard: IdentityCard,
	) => {
		fetch: (request: Request) => Promise<Response>;
		close: () => Promise<void>;
	};
	// SIO-1424: caller starts its own HTTP listener (Bun.serve() in the couchbase pilot) wrapping
	// the fetch handler createHandler returned. Returns listen info for the uniform startup line,
	// matching v1's BootstrapTransportResult.listen shape.
	listen: (fetch: (request: Request) => Promise<Response>) => { port: number; url: string; stop: () => Promise<void> };
	cleanupDatasource?: (datasource: T) => Promise<void>;
	onStarted?: (datasource: T) => void;
	role: McpRole;
	version: string;
	identityFingerprint: (datasource: T) => string;
	embedded?: boolean;
}

export interface McpApplicationV2<T> {
	datasource: T;
	port: number;
	url: string;
	shutdown: () => Promise<void>;
}

export async function createMcpApplicationV2<T>(options: McpApplicationV2Options<T>): Promise<McpApplicationV2<T>> {
	const { logger, name } = options;

	installProcessErrorHandlers({ name, logger, embedded: options.embedded });

	let toolMetrics: Awaited<ReturnType<typeof openMetricsRecorder>>;

	try {
		options.initTracing();
		const otelSdk = initTelemetry(options.telemetry);

		logger.info(`Initializing datasource for ${name}`);
		const datasource = await options.initDatasource();

		toolMetrics = await openMetricsRecorder({ mode: "server", name, logger });

		const identityCard = buildIdentityCard({
			role: options.role,
			version: options.version,
			mode: "http",
			upstreamFingerprint: options.identityFingerprint(datasource),
		});
		logger.info("Identity card built (v2)", {
			instanceId: identityCard.instanceId,
			role: identityCard.role,
			upstreamFingerprint: identityCard.upstreamFingerprint,
		});

		const handler = options.createHandler(datasource, identityCard);
		const server = options.listen(handler.fetch);

		logger.info(`${name} (v2) listening on ${server.url}`, { port: server.port, mode: "http" });

		let isShuttingDown = false;
		const shutdown = async () => {
			if (isShuttingDown) return;
			isShuttingDown = true;

			logger.info(`Shutting down ${name} (v2)...`);

			try {
				await handler.close();
			} catch (error) {
				logger.warn("Error closing v2 handler", {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			try {
				await server.stop();
			} catch (error) {
				logger.warn("Error stopping v2 listener", {
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

			toolMetrics?.close();

			try {
				await shutdownTelemetry(otelSdk);
			} catch (error) {
				logger.warn("Error shutting down telemetry", {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			if (logger.flush) logger.flush();
			logger.info(`${name} (v2) shutdown completed`);
			process.exit(0);
		};

		installShutdownSignalHandlers({ embedded: options.embedded, shutdown: () => shutdown() });

		if (options.onStarted) options.onStarted(datasource);
		logger.info(`${name} (v2) started successfully`);

		return { datasource, port: server.port, url: server.url, shutdown };
	} catch (error) {
		toolMetrics?.close();
		handleStartupFailure({ error, name, logger, embedded: options.embedded });
	}
}
