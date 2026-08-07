// src/tools/cloudwatch/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AwsConfig } from "../../config/schemas.ts";
import { AWS_READ_ONLY_ANNOTATIONS } from "../annotations.ts";
import { withEstate } from "../estate-schema.ts";
import { describeAlarmsOutputSchema } from "../output-schemas.ts";
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
	server.registerTool(
		"aws_cloudwatch_get_metric_data",
		{
			description:
				"Retrieve CloudWatch metric data for one or more KNOWN metrics over a time range using MetricDataQueries. For top-N / unknown-dimension discovery use aws_cloudwatch_metrics_insights_query instead.",
			inputSchema: withEstate(config, getMetricDataSchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await metricData(params as GetMetricDataParams)),
	);

	const insights = metricsInsightsQuery(config);
	server.registerTool(
		"aws_cloudwatch_metrics_insights_query",
		{
			description:
				"Run a CloudWatch Metrics Insights SQL query (SELECT ... FROM SCHEMA(...) GROUP BY ... ORDER BY ... LIMIT n) to rank the top-N noisiest resources across a whole namespace WITHOUT knowing instance/function/queue ids up front. One SQL query per call; 14-day max lookback.",
			inputSchema: withEstate(config, metricsInsightsQuerySchema.shape),
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => toMcp(await insights(params as MetricsInsightsQueryParams)),
	);

	const alarms = describeAlarms(config);
	server.registerTool(
		"aws_cloudwatch_describe_alarms",
		{
			description: "List or describe CloudWatch metric alarms with current state, threshold, and comparison operator.",
			inputSchema: withEstate(config, describeAlarmsSchema.shape),
			outputSchema: describeAlarmsOutputSchema,
			annotations: AWS_READ_ONLY_ANNOTATIONS,
		},
		async (params) => {
			const result = await alarms(params as DescribeAlarmsParams);
			// wrapListTool's return type has no index signature (raw AWS SDK response shape);
			// structuredContent is validated against describeAlarmsOutputSchema at the SDK
			// boundary, so this is a type-level widening of an already-plain-object value, not
			// an unchecked cast.
			return { ...toMcp(result), structuredContent: result as Record<string, unknown> };
		},
	);
}
