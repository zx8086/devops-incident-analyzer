// src/tools/messaging/eventbridge/describe-rule.ts
import { DescribeRuleCommand } from "@aws-sdk/client-eventbridge";
import { z } from "zod";
import type { AwsConfig } from "../../../config/schemas.ts";
import { getEventBridgeClient } from "../../../services/client-factory.ts";
import { wrapBlobTool } from "../../wrap.ts";

export const describeRuleSchema = z.object({
	Name: z.string().describe("EventBridge rule name"),
	EventBusName: z.string().optional().describe("Event bus name or ARN (omit for default event bus)"),
});

export type DescribeRuleParams = z.infer<typeof describeRuleSchema>;

export function describeRule(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_eventbridge_describe_rule",
		fn: async (params: DescribeRuleParams) => {
			const client = getEventBridgeClient(config);
			return client.send(
				new DescribeRuleCommand({
					Name: params.Name,
					EventBusName: params.EventBusName,
				}),
			);
		},
	});
}
