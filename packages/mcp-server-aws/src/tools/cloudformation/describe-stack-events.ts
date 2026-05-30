// src/tools/cloudformation/describe-stack-events.ts
import { DescribeStackEventsCommand } from "@aws-sdk/client-cloudformation";
import { z } from "zod";
import type { AwsConfig } from "../../config/schemas.ts";
import { getCloudFormationClient } from "../../services/client-factory.ts";
import type { WithEstate } from "../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../wrap.ts";

export const describeStackEventsSchema = z.object({
	StackName: z.string().describe("Stack name or ID"),
	NextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination alias (map to NextToken below; SDK param wins).
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> NextToken). Pass _truncated.cursor here."),
});

export type DescribeStackEventsParams = WithEstate<z.infer<typeof describeStackEventsSchema>>;

export function describeStackEvents(config: AwsConfig) {
	return wrapListTool({
		name: "aws_cloudformation_describe_stack_events",
		listField: "StackEvents",
		fn: async (params: DescribeStackEventsParams) => {
			const client = getCloudFormationClient(config, params.estate);
			return client.send(
				new DescribeStackEventsCommand({
					StackName: params.StackName,
					NextToken: preferSdkParam(params.NextToken, params.cursor),
				}),
			);
		},
	});
}
