// src/tools/read/tools-extended.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { KafkaService } from "../../services/kafka-service.ts";
import { kafkaToolAnnotations } from "../tool-classification.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations-extended.ts";
import * as params from "./parameters-extended.ts";
import * as prompts from "./prompts-extended.ts";

export function registerExtendedReadTools(server: McpServer, service: KafkaService, config: AppConfig): void {
	server.registerTool(
		"kafka_get_consumer_group_lag",
		{
			description: prompts.GET_CONSUMER_GROUP_LAG_DESCRIPTION,
			inputSchema: params.GetConsumerGroupLagParams.shape,
			annotations: kafkaToolAnnotations("kafka_get_consumer_group_lag"),
		},
		wrapHandler("kafka_get_consumer_group_lag", config, async (args) => {
			const result = await ops.getConsumerGroupLag(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_describe_cluster",
		{
			description: prompts.DESCRIBE_CLUSTER_DESCRIPTION,
			inputSchema: params.DescribeClusterParams.shape,
			annotations: kafkaToolAnnotations("kafka_describe_cluster"),
		},
		wrapHandler("kafka_describe_cluster", config, async () => {
			const result = await ops.describeCluster(service);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_get_message_by_offset",
		{
			description: prompts.GET_MESSAGE_BY_OFFSET_DESCRIPTION,
			inputSchema: params.GetMessageByOffsetParams.shape,
			annotations: kafkaToolAnnotations("kafka_get_message_by_offset"),
		},
		wrapHandler("kafka_get_message_by_offset", config, async (args) => {
			const result = await ops.getMessageByOffset(service, args);
			return ResponseBuilder.success(result);
		}),
	);
}
