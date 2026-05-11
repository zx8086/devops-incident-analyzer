// src/tools/write/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { KafkaService } from "../../services/kafka-service.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerWriteTools(server: McpServer, service: KafkaService, config: AppConfig): void {
	// SIO-732: gate write tools at registration so they don't appear in tools/list
	// when writes are disabled. The wrap-layer check in tools/wrap.ts stays as
	// belt-and-braces against a config-mismatch race. Take `config` as a parameter
	// (previously called getConfig() internally) so tests can drive registration
	// with their own fixture.
	if (!config.kafka.allowWrites) return;

	server.tool(
		"kafka_produce_message",
		prompts.PRODUCE_MESSAGE_DESCRIPTION,
		params.ProduceMessageParams.shape,
		wrapHandler("kafka_produce_message", config, async (args) => {
			const result = await ops.produceMessage(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_create_topic",
		prompts.CREATE_TOPIC_DESCRIPTION,
		params.CreateTopicParams.shape,
		wrapHandler("kafka_create_topic", config, async (args) => {
			const result = await ops.createTopic(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_alter_topic_config",
		prompts.ALTER_TOPIC_CONFIG_DESCRIPTION,
		params.AlterTopicConfigParams.shape,
		wrapHandler("kafka_alter_topic_config", config, async (args) => {
			const result = await ops.alterTopicConfig(service, args);
			return ResponseBuilder.success(result);
		}),
	);
}
