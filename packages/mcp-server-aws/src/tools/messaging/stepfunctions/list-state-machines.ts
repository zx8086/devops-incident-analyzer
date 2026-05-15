// src/tools/messaging/stepfunctions/list-state-machines.ts
import { ListStateMachinesCommand } from "@aws-sdk/client-sfn";
import { z } from "zod";
import type { AwsConfig } from "../../../config/schemas.ts";
import { getSfnClient } from "../../../services/client-factory.ts";
import { wrapListTool } from "../../wrap.ts";

export const listStateMachinesSchema = z.object({
	maxResults: z.number().int().optional().describe("Max state machines per page (1-1000)"),
	nextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type ListStateMachinesParams = z.infer<typeof listStateMachinesSchema>;

export function listStateMachines(config: AwsConfig) {
	return wrapListTool({
		name: "aws_stepfunctions_list_state_machines",
		listField: "stateMachines",
		fn: async (params: ListStateMachinesParams) => {
			const client = getSfnClient(config);
			return client.send(
				new ListStateMachinesCommand({
					maxResults: params.maxResults,
					nextToken: params.nextToken,
				}),
			);
		},
	});
}
