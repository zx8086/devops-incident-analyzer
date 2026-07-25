// src/tools/ec2/describe-subnets.ts
import { DescribeSubnetsCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

// EC2 Filter is [{ Name, Values[] }]. Kept permissive so the agent can filter by
// vpc-id, subnet-id, cidr, availability-zone, etc.
const filterSchema = z.object({
	Name: z.string(),
	Values: z.array(z.string()),
});

export const describeSubnetsSchema = z.object({
	subnetIds: z
		.array(z.string())
		.optional()
		.describe("Optional list of subnet IDs (subnet-...) to filter (omit to list all)"),
	filters: z
		.array(filterSchema)
		.optional()
		.describe(
			'EC2 filters, e.g. [{ Name: "vpc-id", Values: ["vpc-1"] }] or [{ Name: "cidr", Values: ["10.0.1.0/24"] }]',
		),
	maxResults: z.number().int().min(5).max(1000).optional().describe("Max results per page (5-1000). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().min(5).max(1000).optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeSubnetsParams = WithEstate<z.infer<typeof describeSubnetsSchema>>;

export function describeSubnets(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_subnets",
		listField: "Subnets",
		fn: async (params: DescribeSubnetsParams) => {
			const client = getEc2Client(config, params.estate);
			return client.send(
				new DescribeSubnetsCommand({
					SubnetIds: params.subnetIds,
					Filters: params.filters,
					MaxResults: preferSdkParam(params.maxResults, params.limit),
					NextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
