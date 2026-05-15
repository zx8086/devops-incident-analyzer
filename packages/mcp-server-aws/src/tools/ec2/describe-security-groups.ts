// src/tools/ec2/describe-security-groups.ts
import { DescribeSecurityGroupsCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeSecurityGroupsSchema = z.object({
	groupIds: z.array(z.string()).optional().describe("Security group IDs"),
	groupNames: z.array(z.string()).optional().describe("Security group names (default VPC only)"),
	maxResults: z.number().int().min(5).max(1000).optional(),
	nextToken: z.string().optional(),
});

export type DescribeSecurityGroupsParams = z.infer<typeof describeSecurityGroupsSchema>;

export function describeSecurityGroups(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_security_groups",
		listField: "SecurityGroups",
		fn: async (params: DescribeSecurityGroupsParams) => {
			const client = getEc2Client(config);
			return client.send(
				new DescribeSecurityGroupsCommand({
					GroupIds: params.groupIds,
					GroupNames: params.groupNames,
					MaxResults: params.maxResults,
					NextToken: params.nextToken,
				}),
			);
		},
	});
}
