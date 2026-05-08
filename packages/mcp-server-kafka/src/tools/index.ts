// src/tools/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config/schemas.ts";
import type { ConnectService } from "../services/connect-service.ts";
import type { KafkaService } from "../services/kafka-service.ts";
import type { KsqlService } from "../services/ksql-service.ts";
import type { SchemaRegistryService } from "../services/schema-registry-service.ts";
import { logger } from "../utils/logger.ts";
import { registerConnectTools } from "./connect/tools.ts";
import { registerDestructiveTools } from "./destructive/tools.ts";
import { registerKsqlTools } from "./ksql/tools.ts";
import { registerReadTools } from "./read/tools.ts";
import { registerExtendedReadTools } from "./read/tools-extended.ts";
import { registerSchemaTools } from "./schema/tools.ts";
import { registerWriteTools } from "./write/tools.ts";

export interface ToolRegistrationOptions {
	schemaRegistryService?: SchemaRegistryService;
	ksqlService?: KsqlService;
	connectService?: ConnectService;
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
	registerWriteTools(server, service);
	logger.debug("Registering destructive tools");
	registerDestructiveTools(server, service);

	if (options?.schemaRegistryService) {
		logger.debug("Registering schema registry tools");
		registerSchemaTools(server, options.schemaRegistryService);
	}

	if (options?.ksqlService) {
		logger.debug("Registering ksqlDB tools");
		registerKsqlTools(server, options.ksqlService);
	}

	if (options?.connectService) {
		logger.debug("Registering Kafka Connect tools");
		registerConnectTools(server, options.connectService, config);
	}

	const connectWrites = options?.connectService && config.kafka.allowWrites ? 3 : 0;
	const connectDestructive = options?.connectService && config.kafka.allowDestructive ? 2 : 0;
	const toolCount =
		15 +
		(options?.schemaRegistryService ? 8 : 0) +
		(options?.ksqlService ? 7 : 0) +
		(options?.connectService ? 4 : 0) +
		connectWrites +
		connectDestructive;
	logger.info({ toolCount }, "All tools registered successfully");
}
