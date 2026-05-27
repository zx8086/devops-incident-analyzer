// src/tools/health/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeEventsParams, describeEvents, describeEventsSchema } from "./describe-events.ts";

export function registerHealthTools(server: McpServer, config: AwsConfig): void {
	const events = describeEvents(config);
	server.tool(
		"aws_health_describe_events",
		"Describe AWS Health events (service issues, maintenance, account notifications). Always queries us-east-1.",
		withEstate(config, describeEventsSchema.shape),
		async (params) => toMcp(await events(params as DescribeEventsParams)),
	);
}
