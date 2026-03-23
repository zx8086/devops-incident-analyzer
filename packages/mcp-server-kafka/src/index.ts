// src/index.ts

import { createMcpApplication } from "@devops-agent/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "./config/index.ts";
import { setLogger } from "./logging/container.ts";
import { createLogger } from "./logging/create-logger.ts";
import { createProvider } from "./providers/factory.ts";
import { KafkaClientManager } from "./services/client-manager.ts";
import { KafkaService } from "./services/kafka-service.ts";
import { KsqlService } from "./services/ksql-service.ts";
import { SchemaRegistryService } from "./services/schema-registry-service.ts";
import { initializeTracing } from "./telemetry/tracing.ts";
import { registerAllTools, type ToolRegistrationOptions } from "./tools/index.ts";
import { createTransport } from "./transport/factory.ts";

interface KafkaDatasource {
	kafkaService: KafkaService;
	clientManager: KafkaClientManager;
	toolOptions: ToolRegistrationOptions;
}

if (import.meta.main) {
	const config = getConfig();

	const logger = createLogger({
		level: config.logging.level,
		name: config.telemetry.serviceName,
		isDev: config.kafka.provider === "local",
	});
	setLogger(logger);

	createMcpApplication<KafkaDatasource>({
		name: "kafka-mcp-server",
		logger,

		initTracing: () => initializeTracing(),
		telemetry: config.telemetry,

		initDatasource: async () => {
			logger.info("Starting Kafka MCP Server", {
				provider: config.kafka.provider,
				clientId: config.kafka.clientId,
				transport: config.transport.mode,
			});

			const provider = createProvider(config);
			logger.info(`Provider created: ${provider.name}`);

			const clientManager = new KafkaClientManager(provider);
			const kafkaService = new KafkaService(clientManager);
			const toolOptions: ToolRegistrationOptions = {};

			if (config.schemaRegistry.enabled) {
				toolOptions.schemaRegistryService = new SchemaRegistryService(config);
				logger.info("Schema Registry enabled", { url: config.schemaRegistry.url });
			}

			if (config.ksql.enabled) {
				toolOptions.ksqlService = new KsqlService(config);
				logger.info("ksqlDB enabled", { endpoint: config.ksql.endpoint });
			}

			return { kafkaService, clientManager, toolOptions };
		},

		createServerFactory: (ds) => () => {
			const server = new McpServer({ name: "kafka-mcp-server", version: "1.0.0" });
			registerAllTools(server, ds.kafkaService, config, ds.toolOptions);
			return server;
		},

		createTransport: (serverFactory) => createTransport(config, serverFactory),

		cleanupDatasource: async (ds) => {
			await ds.clientManager.close();
			logger.info("Kafka clients closed");
		},

		onStarted: () => {
			const toolCount = 15 + (config.schemaRegistry.enabled ? 8 : 0) + (config.ksql.enabled ? 7 : 0);
			logger.info(`Kafka MCP Server started (${toolCount} tools per server instance)`, {
				provider: config.kafka.provider,
				transport: config.transport.mode,
			});
		},
	});
}
