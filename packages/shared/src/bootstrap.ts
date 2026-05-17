// shared/src/bootstrap.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pino from "pino";
import { installReadOnlyChokepoint, type ReadOnlyMiddlewareConfig } from "./read-only-chokepoint.ts";
import { initTelemetry, shutdownTelemetry, type TelemetryConfig } from "./telemetry/telemetry.ts";

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

export interface BootstrapTransportResult {
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
	createTransport: (serverFactory: (() => McpServer) | undefined, datasource: T) => Promise<BootstrapTransportResult>;
	cleanupDatasource?: (datasource: T) => Promise<void>;
	onStarted?: (datasource: T) => void;
	// SIO-671: opt-in dispatcher-level read-only enforcement. When supplied,
	// every McpServer produced by createServerFactory has its tools/call
	// handler wrapped to consult the manager before delegating.
	readOnly?: ReadOnlyMiddlewareConfig;
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
		const serverFactory: (() => McpServer) | undefined =
			innerFactory && readOnlyConfig
				? () => {
						const server = innerFactory();
						installReadOnlyChokepoint(server, readOnlyConfig.manager);
						return server;
					}
				: innerFactory;

		// Step 5: Start transport (serverFactory may be undefined in proxy mode)
		const transport = await options.createTransport(serverFactory, datasource);

		// Step 6: Build structured shutdown function with re-entrancy guard
		let isShuttingDown = false;

		const shutdown = async () => {
			if (isShuttingDown) return;
			isShuttingDown = true;

			logger.info(`Shutting down ${name}...`);

			try {
				await transport.closeAll();
			} catch (error) {
				logger.error("Error closing transport", {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			if (options.cleanupDatasource) {
				try {
					await options.cleanupDatasource(datasource);
				} catch (error) {
					logger.error("Error cleaning up datasource", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			try {
				await shutdownTelemetry(otelSdk);
			} catch (error) {
				logger.error("Error shutting down telemetry", {
					error: error instanceof Error ? error.message : String(error),
				});
			}

			if (logger.flush) {
				logger.flush();
			}

			logger.info(`${name} shutdown completed`);
			process.exit(0);
		};

		// Step 7: Register process-level signal handlers
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
			logger.error(`Unhandled rejection in ${name}`, {
				reason: reason instanceof Error ? reason.message : String(reason),
				stack: reason instanceof Error ? reason.stack : undefined,
			});
			if (logger.flush) logger.flush();
			process.exit(1);
		});

		// Step 8: Notify startup complete
		if (options.onStarted) {
			options.onStarted(datasource);
		}
		logger.info(`${name} started successfully`);

		return { datasource, transport, shutdown };
	} catch (error) {
		logger.error(`Fatal error starting ${name}`, {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		if (logger.flush) logger.flush();
		process.exit(1);
	}
}
