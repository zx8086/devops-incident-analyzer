// src/tools/register.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../config/schemas.ts";
import { registerCloudFormationTools } from "./cloudformation/index.ts";
import { registerCloudWatchTools } from "./cloudwatch/index.ts";
import { registerConfigTools } from "./config/index.ts";
import { registerDynamoDbTools } from "./dynamodb/index.ts";
import { registerEc2Tools } from "./ec2/index.ts";
import { registerEcsTools } from "./ecs/index.ts";
import { registerElastiCacheTools } from "./elasticache/index.ts";
import { registerHealthTools } from "./health/index.ts";
import { registerLambdaTools } from "./lambda/index.ts";
import { registerLogsTools } from "./logs/index.ts";
import { registerMessagingTools } from "./messaging/index.ts";
import { registerRdsTools } from "./rds/index.ts";
import { registerS3Tools } from "./s3/index.ts";
import { registerTagsTools } from "./tags/index.ts";
import { registerXrayTools } from "./xray/index.ts";

export function registerAllTools(server: McpServer, config: AwsConfig): void {
	registerCloudFormationTools(server, config);
	registerCloudWatchTools(server, config);
	registerConfigTools(server, config);
	registerDynamoDbTools(server, config);
	registerEc2Tools(server, config);
	registerEcsTools(server, config);
	registerElastiCacheTools(server, config);
	registerHealthTools(server, config);
	registerLambdaTools(server, config);
	registerLogsTools(server, config);
	registerMessagingTools(server, config);
	registerRdsTools(server, config);
	registerS3Tools(server, config);
	registerTagsTools(server, config);
	registerXrayTools(server, config);
}
