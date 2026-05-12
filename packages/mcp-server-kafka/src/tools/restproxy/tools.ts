// src/tools/restproxy/tools.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { RestProxyService } from "../../services/restproxy-service.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations.ts";
import * as params from "./parameters.ts";
import * as prompts from "./prompts.ts";

export function registerRestProxyTools(server: McpServer, service: RestProxyService, config: AppConfig): void {
	// 3 metadata reads — always registered when service is present
	server.tool(
		"restproxy_list_topics",
		prompts.RESTPROXY_LIST_TOPICS_DESCRIPTION,
		params.ListTopicsParams.shape,
		wrapHandler("restproxy_list_topics", config, async (args) => {
			const result = await ops.listTopics(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"restproxy_get_topic",
		prompts.RESTPROXY_GET_TOPIC_DESCRIPTION,
		params.GetTopicParams.shape,
		wrapHandler("restproxy_get_topic", config, async (args) => {
			const result = await ops.getTopic(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	server.tool(
		"restproxy_get_partitions",
		prompts.RESTPROXY_GET_PARTITIONS_DESCRIPTION,
		params.GetPartitionsParams.shape,
		wrapHandler("restproxy_get_partitions", config, async (args) => {
			const result = await ops.getPartitions(service, args);
			return ResponseBuilder.success(result);
		}),
	);

	// 6 write tools — gated by allowWrites
	if (config.kafka.allowWrites) {
		server.tool(
			"restproxy_produce",
			prompts.RESTPROXY_PRODUCE_DESCRIPTION,
			params.ProduceParams.shape,
			wrapHandler("restproxy_produce", config, async (args) => {
				const result = await ops.produce(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"restproxy_create_consumer",
			prompts.RESTPROXY_CREATE_CONSUMER_DESCRIPTION,
			params.CreateConsumerParams.shape,
			wrapHandler("restproxy_create_consumer", config, async (args) => {
				const result = await ops.createConsumer(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"restproxy_subscribe",
			prompts.RESTPROXY_SUBSCRIBE_DESCRIPTION,
			params.SubscribeParams.shape,
			wrapHandler("restproxy_subscribe", config, async (args) => {
				const result = await ops.subscribe(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"restproxy_consume",
			prompts.RESTPROXY_CONSUME_DESCRIPTION,
			params.ConsumeParams.shape,
			wrapHandler("restproxy_consume", config, async (args) => {
				const result = await ops.consume(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"restproxy_commit_offsets",
			prompts.RESTPROXY_COMMIT_OFFSETS_DESCRIPTION,
			params.CommitOffsetsParams.shape,
			wrapHandler("restproxy_commit_offsets", config, async (args) => {
				const result = await ops.commitOffsets(service, args);
				return ResponseBuilder.success(result);
			}),
		);

		server.tool(
			"restproxy_delete_consumer",
			prompts.RESTPROXY_DELETE_CONSUMER_DESCRIPTION,
			params.DeleteConsumerParams.shape,
			wrapHandler("restproxy_delete_consumer", config, async (args) => {
				const result = await ops.deleteConsumer(service, args);
				return ResponseBuilder.success(result);
			}),
		);
	}
}
