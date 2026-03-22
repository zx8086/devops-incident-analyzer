// src/tools/read/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { KafkaService } from "../../services/kafka-service.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerReadTools(server: McpServer, service: KafkaService, config: AppConfig): void {
	server.tool(
		"kafka_list_topics",
		prompts.LIST_TOPICS_DESCRIPTION,
		params.ListTopicsParams.shape,
		wrapHandler("kafka_list_topics", config, async (args) => {
			const result = await ops.listTopics(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_describe_topic",
		prompts.DESCRIBE_TOPIC_DESCRIPTION,
		params.DescribeTopicParams.shape,
		wrapHandler("kafka_describe_topic", config, async (args) => {
			const result = await ops.describeTopic(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_get_topic_offsets",
		prompts.GET_TOPIC_OFFSETS_DESCRIPTION,
		params.GetTopicOffsetsParams.shape,
		wrapHandler("kafka_get_topic_offsets", config, async (args) => {
			const result = await ops.getTopicOffsets(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_consume_messages",
		prompts.CONSUME_MESSAGES_DESCRIPTION,
		params.ConsumeMessagesParams.shape,
		wrapHandler("kafka_consume_messages", config, async (args) => {
			const result = await ops.consumeMessages(service, config, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_list_consumer_groups",
		prompts.LIST_CONSUMER_GROUPS_DESCRIPTION,
		params.ListConsumerGroupsParams.shape,
		wrapHandler("kafka_list_consumer_groups", config, async (args) => {
			const result = await ops.listConsumerGroups(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_describe_consumer_group",
		prompts.DESCRIBE_CONSUMER_GROUP_DESCRIPTION,
		params.DescribeConsumerGroupParams.shape,
		wrapHandler("kafka_describe_consumer_group", config, async (args) => {
			const result = await ops.describeConsumerGroup(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"kafka_get_cluster_info",
		prompts.GET_CLUSTER_INFO_DESCRIPTION,
		params.GetClusterInfoParams.shape,
		wrapHandler("kafka_get_cluster_info", config, async () => {
			const result = await ops.getClusterInfo(service);
			return ResponseBuilder.success(result);
		}),
	);
}
