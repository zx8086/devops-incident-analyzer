// src/tools/ec2/describe-vpc-peering-connections.ts
import { DescribeVpcPeeringConnectionsCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

// SIO-1120: when a task's SGs return empty or its target lives in another account/VPC, a VPC
// peering connection is the cross-VPC path. Confirm Status.Code=active and that the peer VPC's
// CIDR matches the route table's destination. Filter by requester-vpc-info.vpc-id /
// accepter-vpc-info.vpc-id / status-code.
const filterSchema = z.object({
	Name: z.string(),
	Values: z.array(z.string()),
});

export const describeVpcPeeringConnectionsSchema = z.object({
	vpcPeeringConnectionIds: z
		.array(z.string())
		.optional()
		.describe("Optional list of VPC peering connection IDs (pcx-...) to filter (omit to list all)"),
	filters: z
		.array(filterSchema)
		.optional()
		.describe('EC2 filters, e.g. [{ Name: "status-code", Values: ["active"] }] or requester-vpc-info.vpc-id'),
	maxResults: z.number().int().min(5).max(1000).optional().describe("Max results per page (5-1000). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().min(5).max(1000).optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeVpcPeeringConnectionsParams = WithEstate<z.infer<typeof describeVpcPeeringConnectionsSchema>>;

export function describeVpcPeeringConnections(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_vpc_peering_connections",
		listField: "VpcPeeringConnections",
		fn: async (params: DescribeVpcPeeringConnectionsParams) => {
			const client = getEc2Client(config, params.estate);
			return client.send(
				new DescribeVpcPeeringConnectionsCommand({
					VpcPeeringConnectionIds: params.vpcPeeringConnectionIds,
					Filters: params.filters,
					MaxResults: preferSdkParam(params.maxResults, params.limit),
					NextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
