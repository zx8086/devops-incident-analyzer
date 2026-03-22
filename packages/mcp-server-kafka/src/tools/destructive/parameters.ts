// src/tools/destructive/parameters.ts
import { z } from "zod";
import { GroupIdParam, TopicNameParam } from "../shared/parameters.ts";

export const DeleteTopicParams = z.object({
	topic: TopicNameParam.describe("Name of the topic to delete. This action is irreversible."),
});

export const ResetConsumerGroupOffsetsParams = z.object({
	groupId: GroupIdParam.describe("Consumer group ID. The group MUST be in EMPTY state (no active consumers)."),
	topic: TopicNameParam.describe("Topic to reset offsets for"),
	strategy: z
		.enum(["earliest", "latest", "timestamp"])
		.describe("Reset strategy: earliest (beginning), latest (end), or timestamp (specific point in time)"),
	timestamp: z.number().optional().describe("Unix timestamp in ms (required when strategy is 'timestamp')"),
});
