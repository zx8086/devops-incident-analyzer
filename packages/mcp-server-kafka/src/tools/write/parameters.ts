// src/tools/write/parameters.ts
import { z } from "zod";
import { TopicNameParam } from "../shared/parameters.ts";

export const ProduceMessageParams = z.object({
  topic: TopicNameParam,
  messages: z
    .array(
      z.object({
        key: z.string().optional().describe("Message key (optional)"),
        value: z.string().describe("Message value (required)"),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Message headers as key-value pairs"),
        partition: z.number().int().min(0).optional().describe("Target partition number"),
      }),
    )
    .min(1)
    .max(50)
    .describe("Array of messages to produce (1-50)"),
  acks: z
    .number()
    .int()
    .min(-1)
    .max(1)
    .optional()
    .describe("Acknowledgment level: -1 (all), 0 (none), 1 (leader)"),
});

export const CreateTopicParams = z.object({
  name: z.string().min(1).describe("Topic name to create"),
  partitions: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Number of partitions (default: 1)"),
  replicas: z.number().int().min(1).max(10).optional().describe("Number of replicas (default: 1)"),
  configs: z
    .record(z.string(), z.string())
    .optional()
    .describe("Topic configuration entries (e.g., retention.ms, cleanup.policy)"),
});

export const AlterTopicConfigParams = z.object({
  topic: TopicNameParam,
  configs: z
    .record(z.string(), z.string())
    .describe("Configuration entries to update (e.g., retention.ms: '86400000')"),
});
