// src/tools/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config/schemas.ts";
import type { ConnectService } from "../services/connect-service.ts";
import type { KafkaService } from "../services/kafka-service.ts";
import type { KsqlService } from "../services/ksql-service.ts";
import type { RestProxyService } from "../services/restproxy-service.ts";
import type { SchemaRegistryService } from "../services/schema-registry-service.ts";
import { logger } from "../utils/logger.ts";
import { registerConnectTools } from "./connect/tools.ts";
import { registerDestructiveTools } from "./destructive/tools.ts";
import { registerKsqlTools } from "./ksql/tools.ts";
import { registerReadTools } from "./read/tools.ts";
import { registerExtendedReadTools } from "./read/tools-extended.ts";
import { registerRestProxyTools } from "./restproxy/tools.ts";
import { registerSchemaTools } from "./schema/tools.ts";
import { registerWriteTools } from "./write/tools.ts";

export interface ToolRegistrationOptions {
	schemaRegistryService?: SchemaRegistryService;
	ksqlService?: KsqlService;
	connectService?: ConnectService;
	restProxyService?: RestProxyService;
}

export function registerAllTools(
	server: McpServer,
	service: KafkaService,
	config: AppConfig,
	options?: ToolRegistrationOptions,
): void {
	logger.debug("Registering read tools");
	registerReadTools(server, service, config);
	logger.debug("Registering extended read tools");
	registerExtendedReadTools(server, service, config);
	logger.debug("Registering write tools");
	registerWriteTools(server, service, config);
	logger.debug("Registering destructive tools");
	registerDestructiveTools(server, service, config);

	if (options?.schemaRegistryService) {
		logger.debug("Registering schema registry tools");
		registerSchemaTools(server, options.schemaRegistryService, config);
	}

	if (options?.ksqlService) {
		logger.debug("Registering ksqlDB tools");
		registerKsqlTools(server, options.ksqlService, config);
	}

	if (options?.connectService) {
		logger.debug("Registering Kafka Connect tools");
		registerConnectTools(server, options.connectService, config);
	}

	if (options?.restProxyService) {
		logger.debug("Registering REST Proxy tools");
		registerRestProxyTools(server, options.restProxyService, config);
	}

	// SIO-732: core writes/destructive + 1 ksql + 3 kafka_* schema tools are gated
	// at registration; mirror that in the reported count so the log line matches
	// what's actually visible in tools/list.
	const coreReads = 10;
	const coreWrites = config.kafka.allowWrites ? 3 : 0;
	const coreDestructive = config.kafka.allowDestructive ? 2 : 0;
	const schemaReads = options?.schemaRegistryService ? 5 : 0;
	const schemaKafkaWrites = options?.schemaRegistryService && config.kafka.allowWrites ? 2 : 0;
	const schemaKafkaDestructive = options?.schemaRegistryService && config.kafka.allowDestructive ? 1 : 0;
	const ksqlReads = options?.ksqlService ? 6 : 0;
	const ksqlWrites = options?.ksqlService && config.kafka.allowWrites ? 1 : 0;
	const connectReads = options?.connectService ? 4 : 0;
	const connectWrites = options?.connectService && config.kafka.allowWrites ? 3 : 0;
	const connectDestructive = options?.connectService && config.kafka.allowDestructive ? 2 : 0;
	const srWrites = options?.schemaRegistryService && config.kafka.allowWrites ? 3 : 0;
	const srDestructive = options?.schemaRegistryService && config.kafka.allowDestructive ? 4 : 0;
	const restProxyReads = options?.restProxyService ? 3 : 0;
	const restProxyWrites = options?.restProxyService && config.kafka.allowWrites ? 6 : 0;
	const toolCount =
		coreReads +
		coreWrites +
		coreDestructive +
		schemaReads +
		schemaKafkaWrites +
		schemaKafkaDestructive +
		ksqlReads +
		ksqlWrites +
		connectReads +
		connectWrites +
		connectDestructive +
		srWrites +
		srDestructive +
		restProxyReads +
		restProxyWrites;
	logger.info({ toolCount }, "All tools registered successfully");
}
