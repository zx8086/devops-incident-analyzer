#!/usr/bin/env bun

// src/index.ts
import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { clearConfigWarnings, config, getConfigWarnings } from "./config.js";
import { createMcpServerInstance, initializeElasticsearchClient } from "./server.js";
import { createTransport } from "./transport/index.js";
import { logger } from "./utils/logger.js";
import { initializeTracing } from "./utils/tracing.js";

if (import.meta.main) {
	createMcpApplication({
		name: "elastic-mcp-server",
		logger: createBootstrapAdapter(logger),

		initTracing: () => initializeTracing(),
		telemetry: buildTelemetryConfig("elastic-mcp-server"),

		initDatasource: async () => {
			const configWarnings = getConfigWarnings();
			if (configWarnings.length > 0) {
				for (const warning of configWarnings) {
					logger.warn(warning);
				}
				clearConfigWarnings();
			}

			logger.info(
				{
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
				},
				"Starting Elasticsearch MCP server with validated configuration",
			);

			return initializeElasticsearchClient(config);
		},

		createServerFactory: (esClient) => () => createMcpServerInstance(config, esClient),

		createTransport: (serverFactory) => {
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
			return createTransport(transportConfig, serverFactory);
		},

		onStarted: () => {
			logger.info(
				{
					mode: config.server.readOnlyMode ? "READ-ONLY" : "FULL-ACCESS",
					strictMode: config.server.readOnlyStrictMode,
					transport: config.server.transportMode,
				},
				"Elasticsearch MCP Server started successfully",
			);
		},
	});
}
