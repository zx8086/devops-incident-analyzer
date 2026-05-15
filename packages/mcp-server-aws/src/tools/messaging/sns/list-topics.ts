// src/tools/messaging/sns/list-topics.ts
import { ListTopicsCommand } from "@aws-sdk/client-sns";
import { z } from "zod";
import type { AwsConfig } from "../../../config/schemas.ts";
import { getSnsClient } from "../../../services/client-factory.ts";
import { wrapListTool } from "../../wrap.ts";

export const listTopicsSchema = z.object({
	NextToken: z.string().optional().describe("Pagination token from a previous response"),
});

export type ListTopicsParams = z.infer<typeof listTopicsSchema>;

export function listTopics(config: AwsConfig) {
	return wrapListTool({
		name: "aws_sns_list_topics",
		listField: "Topics",
		fn: async (params: ListTopicsParams) => {
			const client = getSnsClient(config);
			return client.send(
				new ListTopicsCommand({
					NextToken: params.NextToken,
				}),
			);
		},
	});
}
