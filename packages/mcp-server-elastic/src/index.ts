#!/usr/bin/env bun

// src/index.ts
import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { initializeCloudClient } from "./clients/cloudClient.js";
import { clearConfigWarnings, config, getConfigWarnings } from "./config/index.js";
import { createMcpServerInstance, initializeElasticsearchClient } from "./server.js";
import { createTransport } from "./transport/index.js";
import { logger } from "./utils/logger.js";
import { getReadOnlyManager } from "./utils/readOnlyMode.js";
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
					transport: config.server.transportMode,
					port: config.server.port,
				},
				"Starting Elasticsearch MCP Server",
			);

			return initializeElasticsearchClient(config);
		},

		// SIO-674: Build the Elastic Cloud client once per server (lazy auth -- no probe).
		// initializeCloudClient returns null when EC_API_KEY is unset; createMcpServerInstance
		// then registers cluster tools only and the cloud + billing tools never appear.
		createServerFactory: (esClient) => {
			const cloudClient = initializeCloudClient(config);
			return () => createMcpServerInstance(config, esClient, cloudClient);
		},

		// SIO-671: hoisted from per-tool withReadOnlyCheck wrappers. The shared
		// bootstrap installs a single dispatcher-level chokepoint per server.
		// The wrapper defers manager lookup to call time because the singleton
		// is initialized inside initDatasource (after this options literal is
		// evaluated).
		readOnly: {
			manager: {
				checkOperation: (toolName) => getReadOnlyManager().checkOperation(toolName),
				createBlockedResponse: (toolName) => getReadOnlyManager().createBlockedResponse(toolName),
				createWarningResponse: (toolName, originalResponse) =>
					getReadOnlyManager().createWarningResponse(toolName, originalResponse as never),
			},
		},

		createTransport: (serverFactory) =>
			createTransport(
				{
					mode: config.server.transportMode,
					port: config.server.port,
					host: config.server.host ?? "0.0.0.0",
					path: config.server.path ?? "/mcp",
					sessionMode: (config.server.sessionMode ?? "stateless") as "stateless" | "stateful",
					idleTimeout: config.server.idleTimeout ?? 255,
					apiKey: config.server.apiKey,
					allowedOrigins: config.server.allowedOrigins,
				},
				serverFactory,
			),

		onStarted: () => {
			logger.info(
				{
					mode: config.server.readOnlyMode ? "READ-ONLY" : "FULL-ACCESS",
					strictMode: config.server.readOnlyStrictMode,
					transport: config.server.transportMode,
				},
				"Elasticsearch MCP Server ready",
			);
		},
	});
}
