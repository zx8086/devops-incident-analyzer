// src/tools/messaging/stepfunctions/list-state-machines.ts
import { ListStateMachinesCommand } from "@aws-sdk/client-sfn";
import { z } from "zod";
import type { AwsConfig } from "../../../config/schemas.ts";
import { getSfnClient } from "../../../services/client-factory.ts";
import type { WithEstate } from "../../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../../wrap.ts";

export const listStateMachinesSchema = z.object({
	maxResults: z.number().int().optional().describe("Max state machines per page (1-1000). Alias: limit."),
	nextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination aliases (-> maxResults / nextToken; SDK param wins).
	limit: z.number().int().optional().describe("Canonical page-size alias (-> maxResults)."),
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> nextToken). Pass _truncated.cursor here."),
});

export type ListStateMachinesParams = WithEstate<z.infer<typeof listStateMachinesSchema>>;

export function listStateMachines(config: AwsConfig) {
	return wrapListTool({
		name: "aws_stepfunctions_list_state_machines",
		listField: "stateMachines",
		fn: async (params: ListStateMachinesParams) => {
			const client = getSfnClient(config, params.estate);
			return client.send(
				new ListStateMachinesCommand({
					maxResults: preferSdkParam(params.maxResults, params.limit),
					nextToken: preferSdkParam(params.nextToken, params.cursor),
				}),
			);
		},
	});
}
