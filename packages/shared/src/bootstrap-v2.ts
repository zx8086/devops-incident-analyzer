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

	// SIO-1424 (CodeRabbit): tracked outside the try, in acquisition order, so a startup failure
	// AFTER one of these resources opens can release exactly what was acquired (reverse order) --
	// not just the metrics recorder. A partially-started listener/handler/datasource otherwise
	// leaks silently, which matters most in embedded mode where the process outlives the failure.
	let toolMetrics: Awaited<ReturnType<typeof openMetricsRecorder>>;
	let otelSdk: ReturnType<typeof initTelemetry> | undefined;
	let datasource: T | undefined;
	let handler: ReturnType<McpApplicationV2Options<T>["createHandler"]> | undefined;
	let server: ReturnType<McpApplicationV2Options<T>["listen"]> | undefined;

	try {
		options.initTracing();
		otelSdk = initTelemetry(options.telemetry);

		logger.info(`Initializing datasource for ${name}`);
		datasource = await options.initDatasource();

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

		handler = options.createHandler(datasource, identityCard);
		server = options.listen(handler.fetch);

		logger.info(`${name} (v2) listening on ${server.url}`, { port: server.port, mode: "http" });

		// Non-null past this point: every step above either assigned these or threw, so a
		// reference here only runs after all of them succeeded.
		const readyDatasource = datasource;
		const readyHandler = handler;
		const readyServer = server;
		const readyOtelSdk = otelSdk;

		// SIO-1424 (CodeRabbit): a second concurrent shutdown() call must wait for the FIRST call's
		// cleanup to actually finish, not resolve immediately -- store the in-flight promise and
		// return it to every caller instead of a bare early return.
		let shutdownPromise: Promise<void> | undefined;
		const shutdown = (): Promise<void> => {
			if (shutdownPromise) return shutdownPromise;
			shutdownPromise = (async () => {
				logger.info(`Shutting down ${name} (v2)...`);

				try {
					await readyHandler.close();
				} catch (error) {
					logger.warn("Error closing v2 handler", {
						error: error instanceof Error ? error.message : String(error),
					});
				}

				try {
					await readyServer.stop();
				} catch (error) {
					logger.warn("Error stopping v2 listener", {
						error: error instanceof Error ? error.message : String(error),
					});
				}

				if (options.cleanupDatasource) {
					try {
						await options.cleanupDatasource(readyDatasource);
					} catch (error) {
						logger.warn("Error cleaning up datasource", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}

				toolMetrics?.close();

				try {
					await shutdownTelemetry(readyOtelSdk);
				} catch (error) {
					logger.warn("Error shutting down telemetry", {
						error: error instanceof Error ? error.message : String(error),
					});
				}

				if (logger.flush) logger.flush();
				logger.info(`${name} (v2) shutdown completed`);
				// SIO-986 parity: an embedded server's host process owns its own lifecycle --
				// exiting here would take the whole host down. Standalone processes still exit.
				if (!options.embedded) process.exit(0);
			})();
			return shutdownPromise;
		};

		installShutdownSignalHandlers({ embedded: options.embedded, shutdown: () => shutdown() });

		if (options.onStarted) options.onStarted(readyDatasource);
		logger.info(`${name} (v2) started successfully`);

		return { datasource: readyDatasource, port: readyServer.port, url: readyServer.url, shutdown };
	} catch (error) {
		// SIO-1424 (CodeRabbit): release exactly what was acquired before the failure, in reverse
		// order -- a partial startup (e.g. listen() throws after createHandler() succeeded) must
		// not leak the handler/listener/datasource, especially in embedded mode where the process
		// outlives the failed start.
		if (server) {
			try {
				await server.stop();
			} catch {
				// best-effort during failure cleanup
			}
		}
		if (handler) {
			try {
				await handler.close();
			} catch {
				// best-effort during failure cleanup
			}
		}
		if (datasource !== undefined && options.cleanupDatasource) {
			try {
				await options.cleanupDatasource(datasource);
			} catch {
				// best-effort during failure cleanup
			}
		}
		toolMetrics?.close();
		if (otelSdk) {
			try {
				await shutdownTelemetry(otelSdk);
			} catch {
				// best-effort during failure cleanup
			}
		}
		handleStartupFailure({ error, name, logger, embedded: options.embedded });
	}
}
