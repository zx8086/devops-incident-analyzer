// src/tools/messaging/sns/list-topics.ts
import { ListTopicsCommand } from "@aws-sdk/client-sns";
import { z } from "zod";
import type { AwsConfig } from "../../../config/schemas.ts";
import { getSnsClient } from "../../../services/client-factory.ts";
import type { WithEstate } from "../../estate-schema.ts";
import { preferSdkParam, wrapListTool } from "../../wrap.ts";

export const listTopicsSchema = z.object({
	NextToken: z.string().optional().describe("Pagination token from a previous response. Alias: cursor."),
	// SIO-838: canonical pagination alias (map to NextToken below; SDK param wins).
	cursor: z
		.string()
		.optional()
		.describe("Canonical pagination-token alias (-> NextToken). Pass _truncated.cursor here."),
});

export type ListTopicsParams = WithEstate<z.infer<typeof listTopicsSchema>>;

export function listTopics(config: AwsConfig) {
	return wrapListTool({
		name: "aws_sns_list_topics",
		listField: "Topics",
		fn: async (params: ListTopicsParams) => {
			const client = getSnsClient(config, params.estate);
			return client.send(
				new ListTopicsCommand({
					NextToken: preferSdkParam(params.NextToken, params.cursor),
				}),
			);
		},
	});
}
