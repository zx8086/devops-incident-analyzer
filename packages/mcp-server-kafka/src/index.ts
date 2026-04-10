// src/index.ts

import { buildTelemetryConfig, createBootstrapAdapter, createMcpApplication } from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pkg from "../package.json" with { type: "json" };
import { getConfig } from "./config/index.ts";
import { createProvider } from "./providers/factory.ts";
import { KafkaClientManager } from "./services/client-manager.ts";
import { KafkaService } from "./services/kafka-service.ts";
import { KsqlService } from "./services/ksql-service.ts";
import { SchemaRegistryService } from "./services/schema-registry-service.ts";
import { registerAllTools, type ToolRegistrationOptions } from "./tools/index.ts";
import { createTransport } from "./transport/factory.ts";
import { logger } from "./utils/logger.ts";
import { initializeTracing } from "./utils/tracing.ts";

interface KafkaDatasource {
	kafkaService: KafkaService;
	clientManager: KafkaClientManager;
	toolOptions: ToolRegistrationOptions;
}

if (import.meta.main) {
	// If AGENTCORE_RUNTIME_ARN is set, the Kafka MCP server runs remotely on AWS.
	// Start only the local SigV4 proxy so the agent can reach it -- no local server needed.
	if (process.env.AGENTCORE_RUNTIME_ARN) {
		const { startAgentCoreProxy } = await import("@devops-agent/shared");
		logger.info(
			{
				arn: process.env.AGENTCORE_RUNTIME_ARN,
				transport: "agentcore-proxy",
			},
			"Starting Kafka MCP Server",
		);
		const proxy = await startAgentCoreProxy();
		logger.info(
			{
				transport: "agentcore-proxy",
				port: proxy.port,
				url: proxy.url,
			},
			"Kafka MCP Server ready",
		);
		logger.info("kafka-mcp-server started successfully");

		let isShuttingDown = false;
		const shutdown = async () => {
			if (isShuttingDown) return;
			isShuttingDown = true;
			logger.info("Shutting down kafka-mcp-server...");
			await proxy.close();
			logger.info("kafka-mcp-server shutdown completed");
			process.exit(0);
		};
		process.on("SIGINT", () => shutdown());
		process.on("SIGTERM", () => shutdown());
	} else {
		// Local mode: start the Kafka MCP server locally.
		const config = getConfig();
		logger.level = config.logging.level;

		createMcpApplication<KafkaDatasource>({
			name: "kafka-mcp-server",
			logger: createBootstrapAdapter(logger),

			initTracing: () => initializeTracing(),
			telemetry: buildTelemetryConfig("kafka-mcp-server"),

			initDatasource: async () => {
				logger.info(
					{
						provider: config.kafka.provider,
						clientId: config.kafka.clientId,
						transport: config.transport.mode,
					},
					"Starting Kafka MCP Server",
				);

				const provider = createProvider(config);
				logger.info(`Provider created: ${provider.name}`);

				const clientManager = new KafkaClientManager(provider);
				const kafkaService = new KafkaService(clientManager);
				const toolOptions: ToolRegistrationOptions = {};

				if (config.schemaRegistry.enabled) {
					toolOptions.schemaRegistryService = new SchemaRegistryService(config);
					logger.info({ url: config.schemaRegistry.url }, "Schema Registry enabled");
				}

				if (config.ksql.enabled) {
					toolOptions.ksqlService = new KsqlService(config);
					logger.info({ endpoint: config.ksql.endpoint }, "ksqlDB enabled");
				}

				return { kafkaService, clientManager, toolOptions };
			},

			createServerFactory: (ds) => () => {
				const server = new McpServer({ name: pkg.name, version: pkg.version });
				registerAllTools(server, ds.kafkaService, config, ds.toolOptions);
				return server;
			},

			createTransport: (serverFactory) => createTransport(config.transport, serverFactory),

			cleanupDatasource: async (ds) => {
				await ds.clientManager.close();
				logger.info("Kafka clients closed");
			},

			onStarted: () => {
				const toolCount = 15 + (config.schemaRegistry.enabled ? 8 : 0) + (config.ksql.enabled ? 7 : 0);
				logger.info(
					{
						provider: config.kafka.provider,
						transport: config.transport.mode,
						toolCount,
					},
					"Kafka MCP Server ready",
				);
			},
		});
	}
}
