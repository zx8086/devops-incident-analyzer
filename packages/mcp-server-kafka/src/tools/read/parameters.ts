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
});

export const DescribeTopicParams = z.object({
  topic: TopicNameParam,
});

export const GetTopicOffsetsParams = z.object({
  topic: TopicNameParam,
  timestamp: z
    .number()
    .optional()
    .describe("Unix timestamp in ms to get offsets at a specific point in time"),
});

export const ConsumeMessagesParams = z.object({
  topic: TopicNameParam,
  maxMessages: MaxMessagesParam,
  timeoutMs: TimeoutParam,
  fromBeginning: z.boolean().optional().describe("Start consuming from the beginning of the topic"),
});

export const ListConsumerGroupsParams = z.object({
  filter: GroupFilterParam,
  states: z
    .array(z.string())
    .optional()
    .describe("Filter by consumer group states (e.g., STABLE, EMPTY)"),
});

export const DescribeConsumerGroupParams = z.object({
  groupId: GroupIdParam,
});

export const GetClusterInfoParams = z.object({});
