// src/tools/ec2/describe-nat-gateways.ts
import { DescribeNatGatewaysCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

// SIO-1120: NAT gateways are the egress path a private-subnet Fargate task uses to reach an
// internet/PrivateLink bootstrap endpoint. Confirm State=available and correlate the ~350s
// disconnection cycle with a NAT idle-timeout hypothesis. NOTE: the SDK request field is the
// SINGULAR `Filter` (not `Filters`).
const filterSchema = z.object({
	Name: z.string(),
	Values: z.array(z.string()),
});

export const describeNatGatewaysSchema = z.object({
	natGatewayIds: z
		.array(z.string())
		.optional()
		.describe("Optional list of NAT gateway IDs (nat-...) to filter (omit to list all)"),
	filters: z
		.array(filterSchema)
		.optional()
		.describe('EC2 filters, e.g. [{ Name: "vpc-id", Values: ["vpc-123"] }] or subnet-id / state'),
	maxResults: z.number().int().min(5).max(1000).optional().describe("Max results per page (5-1000). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().min(5).max(1000).optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeNatGatewaysParams = WithEstate<z.infer<typeof describeNatGatewaysSchema>>;

export function describeNatGateways(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_nat_gateways",
		listField: "NatGateways",
		fn: async (params: DescribeNatGatewaysParams) => {
			const client = getEc2Client(config, params.estate);
			return client.send(
				new DescribeNatGatewaysCommand({
					NatGatewayIds: params.natGatewayIds,
					Filter: params.filters,
					MaxResults: preferSdkParam(params.maxResults, params.limit),
					NextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
