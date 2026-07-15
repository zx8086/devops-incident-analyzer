// src/tools/ec2/describe-flow-logs.ts
import { DescribeFlowLogsCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

// SIO-1120: before claiming "no packet-level evidence" for a connectivity failure, check
// whether VPC flow logging is even enabled on the VPC/subnet/ENI. This describes the flow-log
// CONFIG (destination, status, resource id); the log CONTENT lives in the /vpc/flow-logs/*
// log group and is read via aws_logs_* once a flow log is confirmed present. NOTE: the SDK
// request field is the SINGULAR `Filter` (not `Filters`).
const filterSchema = z.object({
	Name: z.string(),
	Values: z.array(z.string()),
});

export const describeFlowLogsSchema = z.object({
	flowLogIds: z
		.array(z.string())
		.optional()
		.describe("Optional list of flow log IDs (fl-...) to filter (omit to list all)"),
	filters: z
		.array(filterSchema)
		.optional()
		.describe('EC2 filters, e.g. [{ Name: "resource-id", Values: ["vpc-123"] }] or deliver-log-status'),
	maxResults: z.number().int().min(5).max(1000).optional().describe("Max results per page (5-1000). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().min(5).max(1000).optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeFlowLogsParams = WithEstate<z.infer<typeof describeFlowLogsSchema>>;

export function describeFlowLogs(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_flow_logs",
		listField: "FlowLogs",
		fn: async (params: DescribeFlowLogsParams) => {
			const client = getEc2Client(config, params.estate);
			return client.send(
				new DescribeFlowLogsCommand({
					FlowLogIds: params.flowLogIds,
					Filter: params.filters,
					MaxResults: preferSdkParam(params.maxResults, params.limit),
					NextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
