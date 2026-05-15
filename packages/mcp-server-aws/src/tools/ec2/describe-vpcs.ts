// src/tools/ec2/describe-vpcs.ts
import { DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeVpcsSchema = z.object({
	vpcIds: z.array(z.string()).optional().describe("Optional list of VPC IDs to filter (omit to list all)"),
	maxResults: z.number().int().min(5).max(1000).optional().describe("Max results per page"),
	nextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type DescribeVpcsParams = z.infer<typeof describeVpcsSchema>;

export function describeVpcs(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_vpcs",
		listField: "Vpcs",
		fn: async (params: DescribeVpcsParams) => {
			const client = getEc2Client(config);
			return client.send(
				new DescribeVpcsCommand({
					VpcIds: params.vpcIds,
					MaxResults: params.maxResults,
					NextToken: params.nextToken,
				}),
			);
		},
	});
}
