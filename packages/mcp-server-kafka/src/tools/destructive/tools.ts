// src/tools/destructive/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { KafkaService } from "../../services/kafka-service.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerDestructiveTools(server: McpServer, service: KafkaService, config: AppConfig): void {
	// SIO-732: gate destructive tools at registration so they don't appear in
	// tools/list when destructive ops are disabled. The wrap-layer check in
	// tools/wrap.ts stays as belt-and-braces against a config-mismatch race.
	// Take `config` as a parameter (previously called getConfig() internally) so
	// tests can drive registration with their own fixture.
	if (!config.kafka.allowDestructive) return;

	server.tool(
		"kafka_delete_topic",
		prompts.DELETE_TOPIC_DESCRIPTION,
		params.DeleteTopicParams.shape,
		wrapHandler("kafka_delete_topic", config, async (args) => {
			const result = await ops.deleteTopic(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_reset_consumer_group_offsets",
		prompts.RESET_CONSUMER_GROUP_OFFSETS_DESCRIPTION,
		params.ResetConsumerGroupOffsetsParams.shape,
		wrapHandler("kafka_reset_consumer_group_offsets", config, async (args) => {
			const result = await ops.resetConsumerGroupOffsets(service, args);
			return ResponseBuilder.success(result);
		}),
	);
}
