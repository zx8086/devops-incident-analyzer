// src/tools/logs/describe-log-groups.ts
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudWatchLogsClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeLogGroupsSchema = z.object({
	logGroupNamePrefix: z.string().optional().describe("Filter log groups whose name starts with this prefix"),
	logGroupNamePattern: z.string().optional().describe("Substring match anywhere in the log group name"),
	limit: z.number().int().min(1).max(50).optional().describe("Max results per page (1-50)"),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: cursor alias (-> nextToken). This tool's SDK page-size param is already named `limit`, so no page-size alias is needed.
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeLogGroupsParams = WithEstate<z.infer<typeof describeLogGroupsSchema>>;

export function describeLogGroups(config: AwsConfig) {
	return wrapListTool({
		name: "aws_logs_describe_log_groups",
		listField: "logGroups",
		fn: async (params: DescribeLogGroupsParams) => {
			const client = getCloudWatchLogsClient(config, params.estate);
			return client.send(
				new DescribeLogGroupsCommand({
					logGroupNamePrefix: params.logGroupNamePrefix,
					logGroupNamePattern: params.logGroupNamePattern,
					limit: params.limit,
					nextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
