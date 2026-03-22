// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NodeSDK } from "@opentelemetry/sdk-node";
import { getConfig } from "./config/index.ts";
import { getLogger, setLogger } from "./logging/container.ts";
import { createLogger } from "./logging/create-logger.ts";
import { createProvider } from "./providers/factory.ts";
import { KafkaClientManager } from "./services/client-manager.ts";
import { KafkaService } from "./services/kafka-service.ts";
import { KsqlService } from "./services/ksql-service.ts";
import { SchemaRegistryService } from "./services/schema-registry-service.ts";
import { initTelemetry, shutdownTelemetry } from "./telemetry/telemetry.ts";
import { registerAllTools, type ToolRegistrationOptions } from "./tools/index.ts";
import { createTransport } from "./transport/factory.ts";

export async function main(): Promise<void> {
	// 1. Load config
	const config = getConfig();

	// 2. Create logger
	const logger = createLogger({
		level: config.logging.level,
		name: config.telemetry.serviceName,
		isDev: config.kafka.provider === "local",
	});
	setLogger(logger);
	logger.info("Starting Kafka MCP Server", {
		provider: config.kafka.provider,
		clientId: config.kafka.clientId,
		transport: config.transport.mode,
	});

	// 3. Init telemetry
	let sdk: NodeSDK | null = null;
	if (config.telemetry.enabled) {
		sdk = initTelemetry(config.telemetry);
		logger.info("Telemetry initialized", { mode: config.telemetry.mode });
	}

	// 4. Create provider
	const provider = createProvider(config);
	logger.info(`Provider created: ${provider.name}`);

	// 5. Create client manager and service
	const clientManager = new KafkaClientManager(provider);
	const kafkaService = new KafkaService(clientManager);

	// 6. Create optional services
	const toolOptions: ToolRegistrationOptions = {};

	if (config.schemaRegistry.enabled) {
		toolOptions.schemaRegistryService = new SchemaRegistryService(config);
		logger.info("Schema Registry enabled", { url: config.schemaRegistry.url });
	}

	if (config.ksql.enabled) {
		toolOptions.ksqlService = new KsqlService(config);
		logger.info("ksqlDB enabled", { endpoint: config.ksql.endpoint });
	}

	// 7. Server factory -- creates a fully configured McpServer instance
	const serverFactory = (): McpServer => {
		const server = new McpServer({
			name: "kafka-mcp-server",
			version: "1.0.0",
		});
		registerAllTools(server, kafkaService, config, toolOptions);
		return server;
	};

	const toolCount = 15 + (config.schemaRegistry.enabled ? 8 : 0) + (config.ksql.enabled ? 7 : 0);
	logger.info(`Tool registration ready (${toolCount} tools per server instance)`);

	// 8. Start transport(s)
	const transport = await createTransport(config, serverFactory);

	// 9. Graceful shutdown
	const shutdown = async (signal: string) => {
		logger.info(`Received ${signal}, shutting down...`);

		try {
			await transport.closeAll();
		} catch (error) {
			logger.error("Error closing transports", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		try {
			await clientManager.close();
			logger.info("Kafka clients closed");
		} catch (error) {
			logger.error("Error closing Kafka clients", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		try {
			await shutdownTelemetry(sdk);
		} catch (error) {
			logger.error("Error shutting down telemetry", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		logger.flush();
		process.exit(0);
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (import.meta.main) {
	main().catch((error) => {
		const logger = getLogger();
		logger.error("Fatal error starting server", {
			error: error instanceof Error ? error.message : String(error),
		});
		logger.flush();
		process.exit(1);
	});
}
