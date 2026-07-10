// src/tools/ec2/describe-vpc-endpoints.ts
import { DescribeVpcEndpointsCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

// SIO-1057: EC2 Filter is [{ Name, Values[] }]. Kept permissive so the agent can filter by
// vpc-id, service-name, vpc-endpoint-state, etc. without an exhaustive Name enum here.
const filterSchema = z.object({
	Name: z.string(),
	Values: z.array(z.string()),
});

export const describeVpcEndpointsSchema = z.object({
	vpcEndpointIds: z
		.array(z.string())
		.optional()
		.describe("Optional list of VPC endpoint IDs (vpce-...) to filter (omit to list all)"),
	filters: z.array(filterSchema).optional().describe('EC2 filters, e.g. [{ Name: "vpc-id", Values: ["vpc-123"] }]'),
	maxResults: z.number().int().min(5).max(1000).optional().describe("Max results per page (5-1000). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().min(5).max(1000).optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeVpcEndpointsParams = WithEstate<z.infer<typeof describeVpcEndpointsSchema>>;

export function describeVpcEndpoints(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_vpc_endpoints",
		listField: "VpcEndpoints",
		fn: async (params: DescribeVpcEndpointsParams) => {
			const client = getEc2Client(config, params.estate);
			return client.send(
				new DescribeVpcEndpointsCommand({
					VpcEndpointIds: params.vpcEndpointIds,
					Filters: params.filters,
					MaxResults: preferSdkParam(params.maxResults, params.limit),
					NextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
