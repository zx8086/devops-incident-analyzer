// src/tools/messaging/sqs/list-queues.ts
import { ListQueuesCommand } from "@aws-sdk/client-sqs";
import { z } from "zod";
import type { AwsConfig } from "../../../config/schemas.ts";
import { getSqsClient } from "../../../services/client-factory.ts";
import type { WithEstate } from "../../estate-schema.ts";
import { wrapListTool } from "../../wrap.ts";

export const listQueuesSchema = z.object({
	QueueNamePrefix: z.string().optional().describe("Filter queues whose name starts with this prefix"),
});

export type ListQueuesParams = WithEstate<z.infer<typeof listQueuesSchema>>;

export function listQueues(config: AwsConfig) {
	return wrapListTool({
		name: "aws_sqs_list_queues",
		listField: "QueueUrls",
		fn: async (params: ListQueuesParams) => {
			const client = getSqsClient(config, params.estate);
			return client.send(
				new ListQueuesCommand({
					QueueNamePrefix: params.QueueNamePrefix,
				}),
			);
		},
	});
}
