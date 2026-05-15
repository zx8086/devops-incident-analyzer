// src/tools/cloudformation/describe-stack-events.ts
import { DescribeStackEventsCommand } from "@aws-sdk/client-cloudformation";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudFormationClient } from "../../services/client-factory.ts";
import { wrapListTool } from "../wrap.ts";

export const describeStackEventsSchema = z.object({
	StackName: z.string().describe("Stack name or ID"),
	NextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type DescribeStackEventsParams = z.infer<typeof describeStackEventsSchema>;

export function describeStackEvents(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudformation_describe_stack_events",
		listField: "StackEvents",
		fn: async (params: DescribeStackEventsParams) => {
			const client = getCloudFormationClient(config);
			return client.send(
				new DescribeStackEventsCommand({
					StackName: params.StackName,
					NextToken: params.NextToken,
				}),
			);
		},
	});
}
