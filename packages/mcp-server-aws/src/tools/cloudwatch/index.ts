// src/tools/cloudwatch/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { withEstate } from "../estate-schema.ts";
import { toMcp } from "../wrap.ts";
import { type DescribeAlarmsParams, describeAlarms, describeAlarmsSchema } from "./describe-alarms.ts";
import { type GetMetricDataParams, getMetricData, getMetricDataSchema } from "./get-metric-data.ts";
import {
	type MetricsInsightsQueryParams,
	metricsInsightsQuery,
	metricsInsightsQuerySchema,
} from "./metrics-insights-query.ts";

export function registerCloudWatchTools(server: McpServer, config: AwsConfig): void {
	const metricData = getMetricData(config);
	server.tool(
		"aws_cloudwatch_get_metric_data",
		"Retrieve CloudWatch metric data for one or more KNOWN metrics over a time range using MetricDataQueries. For top-N / unknown-dimension discovery use aws_cloudwatch_metrics_insights_query instead.",
		withEstate(config, getMetricDataSchema.shape),
		async (params) => toMcp(await metricData(params as GetMetricDataParams)),
	);

	const insights = metricsInsightsQuery(config);
	server.tool(
		"aws_cloudwatch_metrics_insights_query",
		"Run a CloudWatch Metrics Insights SQL query (SELECT ... FROM SCHEMA(...) GROUP BY ... ORDER BY ... LIMIT n) to rank the top-N noisiest resources across a whole namespace WITHOUT knowing instance/function/queue ids up front. One SQL query per call; 14-day max lookback.",
		withEstate(config, metricsInsightsQuerySchema.shape),
		async (params) => toMcp(await insights(params as MetricsInsightsQueryParams)),
	);

	const alarms = describeAlarms(config);
	server.tool(
		"aws_cloudwatch_describe_alarms",
		"List or describe CloudWatch metric alarms with current state, threshold, and comparison operator.",
		withEstate(config, describeAlarmsSchema.shape),
		async (params) => toMcp(await alarms(params as DescribeAlarmsParams)),
	);
}
