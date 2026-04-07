// src/agentcore-entrypoint.ts
import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import type { Client } from "@elastic/elasticsearch";
import { clearConfigWarnings, config, getConfigWarnings } from "./config/index.js";
import { createMcpServerInstance, initializeElasticsearchClient } from "./server.js";
import { createTransport } from "./transport/index.js";
import { logger } from "./utils/logger.js";
import { initializeTracing } from "./utils/tracing.js";

if (import.meta.main) {
	// Override transport config for AgentCore Runtime contract
	const agentCoreTransport = {
		mode: "agentcore" as const,
		port: Number(Bun.env.MCP_PORT) || 8000,
		host: Bun.env.MCP_HOST || "0.0.0.0",
		path: config.server.path ?? "/mcp",
		sessionMode: (config.server.sessionMode ?? "stateless") as "stateless" | "stateful",
		idleTimeout: config.server.idleTimeout ?? 255,
		apiKey: config.server.apiKey,
		allowedOrigins: config.server.allowedOrigins,
	};

	createMcpApplication<Client>({
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
					transport: "agentcore",
				},
				"Starting Elasticsearch MCP Server (AgentCore Runtime mode)",
			);

			return initializeElasticsearchClient(config);
		},

		createServerFactory: (esClient) => () => createMcpServerInstance(config, esClient),

		createTransport: (serverFactory) => createTransport(agentCoreTransport, serverFactory),

		onStarted: () => {
			logger.info(
				{
					mode: config.server.readOnlyMode ? "READ-ONLY" : "FULL-ACCESS",
					strictMode: config.server.readOnlyStrictMode,
					transport: "agentcore",
				},
				"Elasticsearch MCP Server started on AgentCore Runtime",
			);
		},
	});
}
