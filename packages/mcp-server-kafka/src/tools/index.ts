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

	const toolCount = computeRegisteredToolCount(config, {
		schemaRegistry: Boolean(options?.schemaRegistryService),
		ksql: Boolean(options?.ksqlService),
		connect: Boolean(options?.connectService),
		restProxy: Boolean(options?.restProxyService),
	});
	logger.info({ toolCount }, "All tools registered successfully");
}

// SIO-1193: the ONE copy of the registered-tool-count math -- the two previous
// hand-maintained copies (here and src/index.ts) drifted (coreReads 10 vs 11,
// health-check tools omitted) and the startup log under-reported vs tools/list
// (audit SIO-1186: logged < 61 while the live server registered 61). Per-family
// constants mirror src/tools/*/tools.ts registration and are pinned to the real
// registered sets by tests/tools/full-stack-tools.test.ts (baseline 11 /
// writes-only 52 / full 61).
export function computeRegisteredToolCount(
	config: AppConfig,
	enabled: { schemaRegistry: boolean; ksql: boolean; connect: boolean; restProxy: boolean },
): number {
	const writes = config.kafka.allowWrites;
	const destructive = config.kafka.allowDestructive;
	const coreReads = 11;
	const coreWrites = writes ? 3 : 0;
	const coreDestructive = destructive ? 2 : 0;
	const schemaReads = enabled.schemaRegistry ? 6 : 0;
	const schemaKafkaWrites = enabled.schemaRegistry && writes ? 2 : 0;
	const schemaKafkaDestructive = enabled.schemaRegistry && destructive ? 1 : 0;
	const srWrites = enabled.schemaRegistry && writes ? 3 : 0;
	const srDestructive = enabled.schemaRegistry && destructive ? 4 : 0;
	const ksqlReads = enabled.ksql ? 8 : 0;
	const ksqlWrites = enabled.ksql && writes ? 1 : 0;
	const connectReads = enabled.connect ? 5 : 0;
	const connectWrites = enabled.connect && writes ? 3 : 0;
	const connectDestructive = enabled.connect && destructive ? 2 : 0;
	const restProxyReads = enabled.restProxy ? 4 : 0;
	const restProxyWrites = enabled.restProxy && writes ? 6 : 0;
	return (
		coreReads +
		coreWrites +
		coreDestructive +
		schemaReads +
		schemaKafkaWrites +
		schemaKafkaDestructive +
		srWrites +
		srDestructive +
		ksqlReads +
		ksqlWrites +
		connectReads +
		connectWrites +
		connectDestructive +
		restProxyReads +
		restProxyWrites
	);
}
