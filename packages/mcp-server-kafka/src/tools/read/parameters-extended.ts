// src/tools/read/parameters-extended.ts
import { z } from "zod";
import { GroupIdParam, TopicNameParam } from "../shared/parameters.ts";

export const GetConsumerGroupLagParams = z.object({
  groupId: GroupIdParam.describe("Consumer group ID to calculate lag for"),
});

export const DescribeClusterParams = z.object({});

export const GetMessageByOffsetParams = z.object({
  topic: TopicNameParam,
  partition: z.number().int().min(0).describe("Partition number"),
  offset: z.number().int().min(0).describe("Message offset to retrieve"),
});
