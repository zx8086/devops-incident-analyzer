// src/tools/messaging/sns/get-topic-attributes.ts
import { GetTopicAttributesCommand } from "@aws-sdk/client-sns";
import { z } from "zod";
import type { AwsConfig } from "../../../config/schemas.ts";
import { getSnsClient } from "../../../services/client-factory.ts";
import { wrapBlobTool } from "../../wrap.ts";

export const getTopicAttributesSchema = z.object({
	TopicArn: z.string().describe("ARN of the SNS topic"),
});

export type GetTopicAttributesParams = z.infer<typeof getTopicAttributesSchema>;

export function getTopicAttributes(config: AwsConfig) {
	return wrapBlobTool({
		name: "aws_sns_get_topic_attributes",
		fn: async (params: GetTopicAttributesParams) => {
			const client = getSnsClient(config);
			return client.send(
				new GetTopicAttributesCommand({
					TopicArn: params.TopicArn,
				}),
			);
		},
	});
}
