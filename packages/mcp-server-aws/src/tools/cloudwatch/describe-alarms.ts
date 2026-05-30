// src/tools/cloudwatch/describe-alarms.ts
import { DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeAlarmsSchema = z.object({
	AlarmNames: z.array(z.string()).optional().describe("List of alarm names to filter (omit to list all)"),
	AlarmNamePrefix: z.string().optional().describe("Filter alarms whose name starts with this prefix"),
	StateValue: z.string().optional().describe("Filter by alarm state: OK | ALARM | INSUFFICIENT_DATA"),
	MaxRecords: z.number().int().optional().describe("Max results per page (1-100). Alias: limit."),
	NextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to MaxRecords/NextToken below; SDK param wins).
	limit: z.number().int().optional().describe("Canonical page-size alias (-> MaxRecords)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> NextToken). Pass _truncated.cursor here."),
});

export type DescribeAlarmsParams = WithEstate<z.infer<typeof describeAlarmsSchema>>;

export function describeAlarms(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudwatch_describe_alarms",
		listField: "MetricAlarms",
		fn: async (params: DescribeAlarmsParams) => {
			const client = getCloudWatchClient(config, params.estate);
			return client.send(
				new DescribeAlarmsCommand({
					AlarmNames: params.AlarmNames,
					AlarmNamePrefix: params.AlarmNamePrefix,
					StateValue: params.StateValue as "OK" | "ALARM" | "INSUFFICIENT_DATA" | undefined,
					MaxRecords: preferSdkParam(params.MaxRecords, params.limit),
					NextToken: preferSdkParam(params.NextToken, params.cursor),
				}),
			);
		},
		// SIO-833: project EVERY alarm to the fields the findings extractor reads
		// (packages/agent/src/correlation/extractors/aws.ts). When the full MetricAlarms list
		// is byte-truncated, this keeps the AWSFindingsCard count complete (fixes the 28/50 gap).
		// Scalar-only projection stays a few KB even for hundreds of alarms.
		summarize: (response) =>
			(response.MetricAlarms ?? []).map((a) => ({
				AlarmName: a.AlarmName,
				StateValue: a.StateValue,
				StateReason: a.StateReason,
				MetricName: a.MetricName,
				Namespace: a.Namespace,
				StateUpdatedTimestamp: a.StateUpdatedTimestamp,
			})),
	});
}
