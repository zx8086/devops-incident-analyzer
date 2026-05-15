// src/tools/cloudformation/describe-stacks.ts
import { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudFormationClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeStacksSchema = z.object({
	StackName: z.string().optional().describe("Stack name or ID (omit to describe all stacks)"),
	NextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type DescribeStacksParams = z.infer<typeof describeStacksSchema>;

export function describeStacks(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudformation_describe_stacks",
		listField: "Stacks",
		fn: async (params: DescribeStacksParams) => {
			const client = getCloudFormationClient(config);
			return client.send(
				new DescribeStacksCommand({
					StackName: params.StackName,
					NextToken: params.NextToken,
				}),
			);
		},
	});
}
