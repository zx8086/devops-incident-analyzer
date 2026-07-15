// src/tools/ec2/describe-route-tables.ts
import { DescribeRouteTablesCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

// SIO-1120: route tables answer "does this private subnet egress via a NAT gateway, a
// transit gateway, or a VPC/gateway endpoint?" -- the network-path question the localcore
// incident could not resolve. Filter by association.subnet-id or vpc-id.
const filterSchema = z.object({
	Name: z.string(),
	Values: z.array(z.string()),
});

export const describeRouteTablesSchema = z.object({
	routeTableIds: z
		.array(z.string())
		.optional()
		.describe("Optional list of route table IDs (rtb-...) to filter (omit to list all)"),
	filters: z
		.array(filterSchema)
		.optional()
		.describe('EC2 filters, e.g. [{ Name: "association.subnet-id", Values: ["subnet-123"] }] or vpc-id'),
	maxResults: z.number().int().min(5).max(100).optional().describe("Max results per page (5-100). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().min(5).max(100).optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeRouteTablesParams = WithEstate<z.infer<typeof describeRouteTablesSchema>>;

export function describeRouteTables(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_route_tables",
		listField: "RouteTables",
		fn: async (params: DescribeRouteTablesParams) => {
			const client = getEc2Client(config, params.estate);
			return client.send(
				new DescribeRouteTablesCommand({
					RouteTableIds: params.routeTableIds,
					Filters: params.filters,
					MaxResults: preferSdkParam(params.maxResults, params.limit),
					NextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
