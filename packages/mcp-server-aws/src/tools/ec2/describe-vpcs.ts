// src/tools/ec2/describe-vpcs.ts
import { DescribeVpcsCommand } from "@aws-sdk/client-ec2";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getEc2Client } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeVpcsSchema = z.object({
	vpcIds: z.array(z.string()).optional().describe("Optional list of VPC IDs to filter (omit to list all)"),
	maxResults: z.number().int().min(5).max(1000).optional().describe("Max results per page (5-1000). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (map to maxResults/nextToken below; SDK param wins).
	limit: z.number().int().min(5).max(1000).optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type DescribeVpcsParams = WithEstate<z.infer<typeof describeVpcsSchema>>;

export function describeVpcs(config: AwsConfig) {
	return wrapListTool({
		name: "aws_ec2_describe_vpcs",
		listField: "Vpcs",
		fn: async (params: DescribeVpcsParams) => {
			const client = getEc2Client(config, params.estate);
			return client.send(
				new DescribeVpcsCommand({
					VpcIds: params.vpcIds,
					MaxResults: preferSdkParam(params.maxResults, params.limit),
					NextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
