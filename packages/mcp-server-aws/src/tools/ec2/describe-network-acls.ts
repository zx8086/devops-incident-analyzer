// src/tools/ec2/describe-network-acls.ts
import { DescribeNetworkAclsCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

// SIO-1120: NACLs are the subnet-level allow/deny that a security-group check misses. When
// egress "looks open" at the SG but traffic still fails, an inbound/outbound NACL deny on the
// ephemeral port range is the usual culprit. Filter by association.subnet-id or vpc-id.
const filterSchema = z.object({
	Name: z.string(),
	Values: z.array(z.string()),
});

export const describeNetworkAclsSchema = z.object({
	networkAclIds: z
		.array(z.string())
		.optional()
		.describe("Optional list of network ACL IDs (acl-...) to filter (omit to list all)"),
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

export type DescribeNetworkAclsParams = WithEstate<z.infer<typeof describeNetworkAclsSchema>>;

export function describeNetworkAcls(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_network_acls",
		listField: "NetworkAcls",
		fn: async (params: DescribeNetworkAclsParams) => {
			const client = getEc2Client(config, params.estate);
			return client.send(
				new DescribeNetworkAclsCommand({
					NetworkAclIds: params.networkAclIds,
					Filters: params.filters,
					MaxResults: preferSdkParam(params.maxResults, params.limit),
					NextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
