// src/tools/messaging/eventbridge/list-rules.ts
import { ListRulesCommand } from "@aws-sdk/client-eventbridge";
import { z } from "zod";
import type { AwsConfig } from "../../../config/schemas.ts";
import { getEventBridgeClient } from "../../../services/client-factory.ts";
import { wrapListTool } from "../../wrap.ts";

export const listRulesSchema = z.object({
	EventBusName: z.string().optional().describe("Event bus name or ARN (omit for default event bus)"),
	NamePrefix: z.string().optional().describe("Filter rules whose name starts with this prefix"),
});

export type ListRulesParams = z.infer<typeof listRulesSchema>;

export function listRules(config: AwsConfig) {
	return wrapListTool({
		name: "aws_eventbridge_list_rules",
		listField: "Rules",
		fn: async (params: ListRulesParams) => {
			const client = getEventBridgeClient(config);
			return client.send(
				new ListRulesCommand({
					EventBusName: params.EventBusName,
					NamePrefix: params.NamePrefix,
				}),
			);
		},
	});
}
