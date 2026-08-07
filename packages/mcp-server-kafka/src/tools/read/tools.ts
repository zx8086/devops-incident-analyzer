// src/tools/read/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { KafkaService } from "../../services/kafka-service.ts";
import { kafkaToolAnnotations } from "../tool-classification.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerReadTools(server: McpServer, service: KafkaService, config: AppConfig): void {
	server.registerTool(
		"kafka_list_topics",
		{
			description: prompts.LIST_TOPICS_DESCRIPTION,
			inputSchema: params.ListTopicsParams.shape,
			annotations: kafkaToolAnnotations("kafka_list_topics"),
		},
		wrapHandler("kafka_list_topics", config, async (args) => {
			const result = await ops.listTopics(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_describe_topic",
		{
			description: prompts.DESCRIBE_TOPIC_DESCRIPTION,
			inputSchema: params.DescribeTopicParams.shape,
			annotations: kafkaToolAnnotations("kafka_describe_topic"),
		},
		wrapHandler("kafka_describe_topic", config, async (args) => {
			const result = await ops.describeTopic(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_get_topic_offsets",
		{
			description: prompts.GET_TOPIC_OFFSETS_DESCRIPTION,
			inputSchema: params.GetTopicOffsetsParams.shape,
			annotations: kafkaToolAnnotations("kafka_get_topic_offsets"),
		},
		wrapHandler("kafka_get_topic_offsets", config, async (args) => {
			const result = await ops.getTopicOffsets(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_consume_messages",
		{
			description: prompts.CONSUME_MESSAGES_DESCRIPTION,
			inputSchema: params.ConsumeMessagesParams.shape,
			annotations: kafkaToolAnnotations("kafka_consume_messages"),
		},
		wrapHandler("kafka_consume_messages", config, async (args) => {
			const result = await ops.consumeMessages(service, config, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_list_consumer_groups",
		{
			description: prompts.LIST_CONSUMER_GROUPS_DESCRIPTION,
			inputSchema: params.ListConsumerGroupsParams.shape,
			annotations: kafkaToolAnnotations("kafka_list_consumer_groups"),
		},
		wrapHandler("kafka_list_consumer_groups", config, async (args) => {
			const result = await ops.listConsumerGroups(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	// SIO-770: feeds kafkaFindings.dlqTopics[] for the kafka-dlq-growth correlation rule.
	server.registerTool(
		"kafka_list_dlq_topics",
		{
			description: prompts.LIST_DLQ_TOPICS_DESCRIPTION,
			inputSchema: params.ListDlqTopicsParams.shape,
			annotations: kafkaToolAnnotations("kafka_list_dlq_topics"),
		},
		wrapHandler("kafka_list_dlq_topics", config, async (args) => {
			const result = await ops.listDlqTopics(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_describe_consumer_group",
		{
			description: prompts.DESCRIBE_CONSUMER_GROUP_DESCRIPTION,
			inputSchema: params.DescribeConsumerGroupParams.shape,
			annotations: kafkaToolAnnotations("kafka_describe_consumer_group"),
		},
		wrapHandler("kafka_describe_consumer_group", config, async (args) => {
			const result = await ops.describeConsumerGroup(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"kafka_get_cluster_info",
		{
			description: prompts.GET_CLUSTER_INFO_DESCRIPTION,
			inputSchema: params.GetClusterInfoParams.shape,
			annotations: kafkaToolAnnotations("kafka_get_cluster_info"),
		},
		wrapHandler("kafka_get_cluster_info", config, async (args) => {
			const result = await ops.getClusterInfo(service, args);
			return ResponseBuilder.success(result);
		}),
	);
}
