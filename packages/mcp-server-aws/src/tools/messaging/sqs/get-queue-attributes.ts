// src/tools/messaging/sqs/get-queue-attributes.ts
import { GetQueueAttributesCommand, type QueueAttributeName } from "@aws-sdk/client-sqs";
import { z } from "zod";
import type { AwsConfig } from "../../../config/schemas.ts";
import { getSqsClient } from "../../../services/client-factory.ts";
import { wrapBlobTool } from "../../wrap.ts";

export const getQueueAttributesSchema = z.object({
	QueueUrl: z.string().describe("URL of the SQS queue"),
	AttributeNames: z
		.array(z.string())
		.optional()
		.describe("List of attribute names to retrieve (e.g. All, ApproximateNumberOfMessages)"),
});

export type GetQueueAttributesParams = z.infer<typeof getQueueAttributesSchema>;

export function getQueueAttributes(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_sqs_get_queue_attributes",
		fn: async (params: GetQueueAttributesParams) => {
			const client = getSqsClient(config);
			return client.send(
				new GetQueueAttributesCommand({
					QueueUrl: params.QueueUrl,
					AttributeNames: params.AttributeNames as QueueAttributeName[] | undefined,
				}),
			);
		},
	});
}
