// src/tools/cloudwatch/describe-alarms.ts
import { DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeAlarmsSchema = z.object({
	AlarmNames: z.array(z.string()).optional().describe("List of alarm names to filter (omit to list all)"),
	AlarmNamePrefix: z.string().optional().describe("Filter alarms whose name starts with this prefix"),
	StateValue: z.string().optional().describe("Filter by alarm state: OK | ALARM | INSUFFICIENT_DATA"),
	MaxRecords: z.number().int().optional().describe("Max results per page (1-100)"),
	NextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type DescribeAlarmsParams = z.infer<typeof describeAlarmsSchema>;

export function describeAlarms(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudwatch_describe_alarms",
		listField: "MetricAlarms",
		fn: async (params: DescribeAlarmsParams) => {
			const client = getCloudWatchClient(config);
			return client.send(
				new DescribeAlarmsCommand({
					AlarmNames: params.AlarmNames,
					AlarmNamePrefix: params.AlarmNamePrefix,
					StateValue: params.StateValue as "OK" | "ALARM" | "INSUFFICIENT_DATA" | undefined,
					MaxRecords: params.MaxRecords,
					NextToken: params.NextToken,
				}),
			);
		},
	});
}
