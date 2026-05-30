// src/tools/cloudformation/describe-stacks.ts
import { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudFormationClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeStacksSchema = z.object({
	StackName: z.string().optional().describe("Stack name or ID (omit to describe all stacks)"),
	NextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination alias (map to NextToken below; SDK param wins).
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> NextToken). Pass _truncated.cursor here."),
});

export type DescribeStacksParams = WithEstate<z.infer<typeof describeStacksSchema>>;

export function describeStacks(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudformation_describe_stacks",
		listField: "Stacks",
		fn: async (params: DescribeStacksParams) => {
			const client = getCloudFormationClient(config, params.estate);
			return client.send(
				new DescribeStacksCommand({
					StackName: params.StackName,
					NextToken: preferSdkParam(params.NextToken, params.cursor),
				}),
			);
		},
	});
}
