// src/tools/read/tools-extended.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../../config/schemas.ts";
import { ResponseBuilder } from "../../lib/response-builder.ts";
import type { KafkaService } from "../../services/kafka-service.ts";
import { wrapHandler } from "../wrap.ts";
import * as ops from "./operations-extended.ts";
import * as params from "./parameters-extended.ts";
import * as prompts from "./prompts-extended.ts";

export function registerExtendedReadTools(
  server: McpServer,
  service: KafkaService,
  config: AppConfig,
): void {
  server.tool(
    "kafka_get_consumer_group_lag",
    prompts.GET_CONSUMER_GROUP_LAG_DESCRIPTION,
    params.GetConsumerGroupLagParams.shape,
    wrapHandler("kafka_get_consumer_group_lag", config, async (args) => {
      const result = await ops.getConsumerGroupLag(service, args);
      return ResponseBuilder.success(result);
    }),
  );

  server.tool(
    "kafka_describe_cluster",
    prompts.DESCRIBE_CLUSTER_DESCRIPTION,
    params.DescribeClusterParams.shape,
    wrapHandler("kafka_describe_cluster", config, async () => {
      const result = await ops.describeCluster(service);
      return ResponseBuilder.success(result);
    }),
  );

  server.tool(
    "kafka_get_message_by_offset",
    prompts.GET_MESSAGE_BY_OFFSET_DESCRIPTION,
    params.GetMessageByOffsetParams.shape,
    wrapHandler("kafka_get_message_by_offset", config, async (args) => {
      const result = await ops.getMessageByOffset(service, args);
      return ResponseBuilder.success(result);
    }),
  );
}
