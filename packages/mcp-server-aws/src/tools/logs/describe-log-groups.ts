// src/tools/logs/describe-log-groups.ts
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchLogsClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeLogGroupsSchema = z.object({
	logGroupNamePrefix: z.string().optional().describe("Filter log groups whose name starts with this prefix"),
	logGroupNamePattern: z.string().optional().describe("Substring match anywhere in the log group name"),
	limit: z.number().int().min(1).max(50).optional().describe("Max results per page (1-50)"),
	nextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type DescribeLogGroupsParams = z.infer<typeof describeLogGroupsSchema>;

export function describeLogGroups(config: AwsConfig) {
	return wrapListTool({
		name: "aws_logs_describe_log_groups",
		listField: "logGroups",
		fn: async (params: DescribeLogGroupsParams) => {
			const client = getCloudWatchLogsClient(config);
			return client.send(
				new DescribeLogGroupsCommand({
					logGroupNamePrefix: params.logGroupNamePrefix,
					logGroupNamePattern: params.logGroupNamePattern,
					limit: params.limit,
					nextToken: params.nextToken,
				}),
			);
		},
	});
}
