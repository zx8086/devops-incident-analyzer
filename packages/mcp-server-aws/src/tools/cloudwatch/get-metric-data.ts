// src/tools/cloudwatch/get-metric-data.ts
import { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchClient } from "../../services/client-factory.ts";
import { wrapBlobTool } from "../wrap.ts";

export const getMetricDataSchema = z.object({
	MetricDataQueries: z
		.array(z.record(z.string(), z.unknown()))
		.describe("Array of metric data query objects (MetricStat or Expression-based)"),
	StartTime: z.string().describe("ISO 8601 start time for the metric data range"),
	EndTime: z.string().describe("ISO 8601 end time for the metric data range"),
});

export type GetMetricDataParams = z.infer<typeof getMetricDataSchema>;

export function getMetricData(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_cloudwatch_get_metric_data",
		fn: async (params: GetMetricDataParams) => {
			const client = getCloudWatchClient(config);
			return client.send(
				new GetMetricDataCommand({
					// biome-ignore lint/suspicious/noExplicitAny: SIO-758 - SDK MetricDataQuery shape is complex; pass through from validated unknown
					MetricDataQueries: params.MetricDataQueries as any,
					StartTime: new Date(params.StartTime),
					EndTime: new Date(params.EndTime),
				}),
			);
		},
	});
}
