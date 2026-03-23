#!/usr/bin/env bun

// src/index.ts
import { clearConfigWarnings, config, getConfigWarnings } from "./config.js";
import { createMcpServerInstance, initializeElasticsearchClient } from "./server.js";
import { initTelemetry, shutdownTelemetry, type TelemetryConfig } from "./telemetry/telemetry.js";
import { createTransport } from "./transport/index.js";
import { logger } from "./utils/logger.js";
import { initializeTracing } from "./utils/tracing.js";

async function main() {
	try {
		// Initialize LangSmith tracing first
		initializeTracing();

		// Initialize OTEL telemetry
		const telemetryConfig: TelemetryConfig = {
			enabled: process.env.TELEMETRY_MODE !== undefined,
			serviceName: process.env.OTEL_SERVICE_NAME || "elastic-mcp-server",
			mode: (process.env.TELEMETRY_MODE as "console" | "otlp" | "both") || "console",
			otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318",
		};
		const otelSdk = initTelemetry(telemetryConfig);

		// Log any configuration warnings now that logger is available
		const configWarnings = getConfigWarnings();
		if (configWarnings.length > 0) {
			for (const warning of configWarnings) {
				logger.warn(warning);
			}
			clearConfigWarnings();
		}

		// Configuration is already loaded and validated in config.ts
		logger.info("Starting Elasticsearch MCP server with validated configuration", {
			url: config.elasticsearch.url,
			hasApiKey: !!config.elasticsearch.apiKey,
			hasUsername: !!config.elasticsearch.username,
			hasPassword: !!config.elasticsearch.password,
			hasCaCert: !!config.elasticsearch.caCert,
			readOnlyMode: config.server.readOnlyMode,
			readOnlyStrictMode: config.server.readOnlyStrictMode,
			maxQueryTimeout: config.server.maxQueryTimeout,
			maxResultsPerQuery: config.server.maxResultsPerQuery,
			transportMode: config.server.transportMode,
			port: config.server.port,
		});

		// Initialize ES client once at startup (async)
		const esClient = await initializeElasticsearchClient(config);

		// Sync factory for per-request McpServer creation
		const serverFactory = () => createMcpServerInstance(config, esClient);

		const transportConfig = {
			transport: {
				mode: config.server.transportMode,
				port: config.server.port,
				host: config.server.host ?? "0.0.0.0",
				path: config.server.path ?? "/mcp",
				sessionMode: (config.server.sessionMode ?? "stateless") as "stateless" | "stateful",
				idleTimeout: config.server.idleTimeout ?? 255,
				apiKey: config.server.apiKey,
				allowedOrigins: config.server.allowedOrigins,
			},
		};

		const transport = await createTransport(transportConfig, serverFactory);

		// Graceful shutdown
		const shutdown = async () => {
			logger.info("Shutting down server gracefully...");
			try {
				await transport.closeAll();
				await shutdownTelemetry(otelSdk);
				logger.info("Server shutdown completed");
			} catch (error) {
				logger.error("Error during shutdown:", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		process.on("uncaughtException", (error) => {
			logger.error("Uncaught exception - shutting down:", {
				error: error.message,
				stack: error.stack,
				name: error.name,
			});
			shutdown();
		});

		process.on("unhandledRejection", (reason) => {
			logger.error("Unhandled promise rejection - shutting down:", {
				reason: reason instanceof Error ? reason.message : String(reason),
				stack: reason instanceof Error ? reason.stack : undefined,
			});
			shutdown();
		});

		logger.info("Elasticsearch MCP Server started successfully", {
			mode: config.server.readOnlyMode ? "READ-ONLY" : "FULL-ACCESS",
			strictMode: config.server.readOnlyStrictMode,
			transport: config.server.transportMode,
		});
	} catch (error) {
		logger.error("Fatal error during startup:", {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		process.exit(1);
	}
}

// Start the server
main().catch((error) => {
	logger.error("Failed to start server:", {
		error: error instanceof Error ? error.message : String(error),
		stack: error instanceof Error ? error.stack : undefined,
	});
	process.exit(1);
});
