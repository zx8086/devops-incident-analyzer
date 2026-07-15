// src/tools/ec2/describe-transit-gateways.ts
import { DescribeTransitGatewaysCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

// SIO-1120: in shared-services / hub-and-spoke estates the egress path to another VPC (MSK,
// on-prem) is often a transit gateway rather than a NAT gateway. Confirm the TGW exists and is
// State=available when a route table points a destination CIDR at a tgw-... target.
const filterSchema = z.object({
	Name: z.string(),
	Values: z.array(z.string()),
});

export const describeTransitGatewaysSchema = z.object({
	transitGatewayIds: z
		.array(z.string())
		.optional()
		.describe("Optional list of transit gateway IDs (tgw-...) to filter (omit to list all)"),
	filters: z
		.array(filterSchema)
		.optional()
		.describe('EC2 filters, e.g. [{ Name: "state", Values: ["available"] }] or owner-id'),
	maxResults: z.number().int().min(5).max(1000).optional().describe("Max results per page (5-1000). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().min(5).max(1000).optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeTransitGatewaysParams = WithEstate<z.infer<typeof describeTransitGatewaysSchema>>;

export function describeTransitGateways(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_transit_gateways",
		listField: "TransitGateways",
		fn: async (params: DescribeTransitGatewaysParams) => {
			const client = getEc2Client(config, params.estate);
			return client.send(
				new DescribeTransitGatewaysCommand({
					TransitGatewayIds: params.transitGatewayIds,
					Filters: params.filters,
					MaxResults: preferSdkParam(params.maxResults, params.limit),
					NextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
