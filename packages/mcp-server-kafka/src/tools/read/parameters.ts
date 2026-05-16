// src/tools/read/parameters.ts
import { z } from "zod";
import {
	GroupFilterParam,
	GroupIdParam,
	MaxMessagesParam,
	TimeoutParam,
	TopicFilterParam,
	TopicNameParam,
} from "../shared/parameters.ts";

export const ListTopicsParams = z.object({
	filter: TopicFilterParam,
	prefix: z
		.string()
		.min(1)
		.optional()
		.describe("Case-sensitive prefix filter applied before the regex filter (cheap startsWith). Example: 'DLQ_'."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe("Maximum number of topics to return (1-500). Default 100."),
	offset: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Number of topics to skip from the start of the sorted result set (for pagination). Default 0."),
});

export const DescribeTopicParams = z.object({
	topic: TopicNameParam,
});

export const GetTopicOffsetsParams = z.object({
	topic: TopicNameParam,
	timestamp: z.number().optional().describe("Unix timestamp in ms to get offsets at a specific point in time"),
});

export const ConsumeMessagesParams = z.object({
	topic: TopicNameParam,
	maxMessages: MaxMessagesParam,
	timeoutMs: TimeoutParam,
	fromBeginning: z.boolean().optional().describe("Start consuming from the beginning of the topic"),
});

export const ListConsumerGroupsParams = z.object({
	filter: GroupFilterParam,
	states: z.array(z.string()).optional().describe("Filter by consumer group states (e.g., STABLE, EMPTY)"),
});

// SIO-770: args mirror the service's ListDlqTopicsOptions (kafka-service.ts:140)
// rather than renaming, so the MCP tool contract stays aligned with the underlying
// API. DLQ topic detection itself is hardcoded to DLQ_PATTERNS in the service.
export const ListDlqTopicsParams = z.object({
	windowMs: z
		.number()
		.int()
		.min(100)
		.max(60_000)
		.optional()
		.describe(
			"Milliseconds between the two listOffsets samples used to compute recentDelta. Defaults to 30_000 (30s). Lower values run faster but recentDelta becomes noisier.",
		),
	skipDelta: z
		.boolean()
		.optional()
		.describe(
			"When true, take only one sample and return recentDelta:null for every topic. Use for fast probes where current totalMessages is enough and growth rate is not needed.",
		),
});

export const DescribeConsumerGroupParams = z.object({
	groupId: GroupIdParam,
});

export const GetClusterInfoParams = z.object({
	prefix: z
		.string()
		.min(1)
		.optional()
		.describe("Case-sensitive prefix filter for the embedded topic list (cheap startsWith). Example: 'DLQ_'."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe("Maximum number of topics to return in the topic list (1-500). Default 100. Does not affect topicCount."),
	offset: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("Number of topics to skip from the start of the sorted topic list (for pagination). Default 0."),
});
