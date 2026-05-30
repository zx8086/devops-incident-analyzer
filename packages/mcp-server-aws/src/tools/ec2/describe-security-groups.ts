// src/tools/ec2/describe-security-groups.ts
import { DescribeSecurityGroupsCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeSecurityGroupsSchema = z.object({
	groupIds: z.array(z.string()).optional().describe("Security group IDs"),
	groupNames: z.array(z.string()).optional().describe("Security group names (default VPC only)"),
	maxResults: z.number().int().min(5).max(1000).optional().describe("Max results per page (5-1000). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().min(5).max(1000).optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeSecurityGroupsParams = WithEstate<z.infer<typeof describeSecurityGroupsSchema>>;

export function describeSecurityGroups(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_security_groups",
		listField: "SecurityGroups",
		fn: async (params: DescribeSecurityGroupsParams) => {
			const client = getEc2Client(config, params.estate);
			return client.send(
				new DescribeSecurityGroupsCommand({
					GroupIds: params.groupIds,
					GroupNames: params.groupNames,
					MaxResults: preferSdkParam(params.maxResults, params.limit),
					NextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
