// src/tools/restproxy/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { RestProxyService } from "../../services/restproxy-service.ts";
import { kafkaToolAnnotations } from "../tool-classification.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerRestProxyTools(server: McpServer, service: RestProxyService, config: AppConfig): void {
	// SIO-742: no-parameter reachability probe -- always registered.
	server.registerTool(
		"restproxy_health_check",
		{
			description: prompts.RESTPROXY_HEALTH_CHECK_DESCRIPTION,
			inputSchema: params.HealthCheckParams.shape,
			annotations: kafkaToolAnnotations("restproxy_health_check"),
		},
		wrapHandler("restproxy_health_check", config, async () => {
			const result = await ops.healthCheck(service, config);
			return ResponseBuilder.success(result);
		}),
	);

	// 3 metadata reads — always registered when service is present
	server.registerTool(
		"restproxy_list_topics",
		{
			description: prompts.RESTPROXY_LIST_TOPICS_DESCRIPTION,
			inputSchema: params.ListTopicsParams.shape,
			annotations: kafkaToolAnnotations("restproxy_list_topics"),
		},
		wrapHandler("restproxy_list_topics", config, async (args) => {
			const result = await ops.listTopics(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"restproxy_get_topic",
		{
			description: prompts.RESTPROXY_GET_TOPIC_DESCRIPTION,
			inputSchema: params.GetTopicParams.shape,
			annotations: kafkaToolAnnotations("restproxy_get_topic"),
		},
		wrapHandler("restproxy_get_topic", config, async (args) => {
			const result = await ops.getTopic(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.registerTool(
		"restproxy_get_partitions",
		{
			description: prompts.RESTPROXY_GET_PARTITIONS_DESCRIPTION,
			inputSchema: params.GetPartitionsParams.shape,
			annotations: kafkaToolAnnotations("restproxy_get_partitions"),
		},
		wrapHandler("restproxy_get_partitions", config, async (args) => {
			const result = await ops.getPartitions(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	// 6 write tools — gated by allowWrites
	if (config.kafka.allowWrites) {
		server.registerTool(
			"restproxy_produce",
			{
				description: prompts.RESTPROXY_PRODUCE_DESCRIPTION,
				inputSchema: params.ProduceParams.shape,
				annotations: kafkaToolAnnotations("restproxy_produce"),
			},
			wrapHandler("restproxy_produce", config, async (args) => {
				const result = await ops.produce(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"restproxy_create_consumer",
			{
				description: prompts.RESTPROXY_CREATE_CONSUMER_DESCRIPTION,
				inputSchema: params.CreateConsumerParams.shape,
				annotations: kafkaToolAnnotations("restproxy_create_consumer"),
			},
			wrapHandler("restproxy_create_consumer", config, async (args) => {
				const result = await ops.createConsumer(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"restproxy_subscribe",
			{
				description: prompts.RESTPROXY_SUBSCRIBE_DESCRIPTION,
				inputSchema: params.SubscribeParams.shape,
				annotations: kafkaToolAnnotations("restproxy_subscribe"),
			},
			wrapHandler("restproxy_subscribe", config, async (args) => {
				const result = await ops.subscribe(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"restproxy_consume",
			{
				description: prompts.RESTPROXY_CONSUME_DESCRIPTION,
				inputSchema: params.ConsumeParams.shape,
				annotations: kafkaToolAnnotations("restproxy_consume"),
			},
			wrapHandler("restproxy_consume", config, async (args) => {
				const result = await ops.consume(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"restproxy_commit_offsets",
			{
				description: prompts.RESTPROXY_COMMIT_OFFSETS_DESCRIPTION,
				inputSchema: params.CommitOffsetsParams.shape,
				annotations: kafkaToolAnnotations("restproxy_commit_offsets"),
			},
			wrapHandler("restproxy_commit_offsets", config, async (args) => {
				const result = await ops.commitOffsets(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.registerTool(
			"restproxy_delete_consumer",
			{
				description: prompts.RESTPROXY_DELETE_CONSUMER_DESCRIPTION,
				inputSchema: params.DeleteConsumerParams.shape,
				annotations: kafkaToolAnnotations("restproxy_delete_consumer"),
			},
			wrapHandler("restproxy_delete_consumer", config, async (args) => {
				const result = await ops.deleteConsumer(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}
}
