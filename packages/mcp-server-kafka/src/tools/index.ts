// src/tools/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config/schemas.ts";
import type { KafkaService } from "../services/kafka-service.ts";
import type { KsqlService } from "../services/ksql-service.ts";
import type { SchemaRegistryService } from "../services/schema-registry-service.ts";
import { registerDestructiveTools } from "./destructive/tools.ts";
import { registerKsqlTools } from "./ksql/tools.ts";
import { registerReadTools } from "./read/tools.ts";
import { registerExtendedReadTools } from "./read/tools-extended.ts";
import { registerSchemaTools } from "./schema/tools.ts";
import { registerWriteTools } from "./write/tools.ts";

export interface ToolRegistrationOptions {
	schemaRegistryService?: SchemaRegistryService;
	ksqlService?: KsqlService;
}

export function registerAllTools(
	server: McpServer,
	service: KafkaService,
	config: AppConfig,
	options?: ToolRegistrationOptions,
): void {
	registerReadTools(server, service, config);
	registerExtendedReadTools(server, service, config);
	registerWriteTools(server, service);
	registerDestructiveTools(server, service);

	if (options?.schemaRegistryService) {
		registerSchemaTools(server, options.schemaRegistryService);
	}

	if (options?.ksqlService) {
		registerKsqlTools(server, options.ksqlService);
	}
}
