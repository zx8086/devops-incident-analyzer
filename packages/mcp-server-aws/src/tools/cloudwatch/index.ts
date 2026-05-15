// src/tools/cloudwatch/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { toMcp } from "../wrap.ts";
import { describeAlarms, describeAlarmsSchema } from "./describe-alarms.ts";
import { getMetricData, getMetricDataSchema } from "./get-metric-data.ts";

export function registerCloudWatchTools(server: McpServer, config: AwsConfig): void {
	const metricData = getMetricData(config);
	server.tool(
		"aws_cloudwatch_get_metric_data",
		"Retrieve CloudWatch metric data for one or more metrics over a time range using MetricDataQueries.",
		getMetricDataSchema.shape,
		async (params) => toMcp(await metricData(params)),
	);

	const alarms = describeAlarms(config);
	server.tool(
		"aws_cloudwatch_describe_alarms",
		"List or describe CloudWatch metric alarms with current state, threshold, and comparison operator.",
		describeAlarmsSchema.shape,
		async (params) => toMcp(await alarms(params)),
	);
}
