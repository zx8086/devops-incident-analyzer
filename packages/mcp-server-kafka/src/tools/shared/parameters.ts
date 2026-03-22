// src/tools/shared/parameters.ts
import { z } from "zod";

export const TopicNameParam = z.string().min(1).describe("Kafka topic name");

export const GroupIdParam = z.string().min(1).describe("Consumer group ID");

export const TopicFilterParam = z
  .string()
  .optional()
  .describe("Regex pattern to filter topic names");

export const GroupFilterParam = z
  .string()
  .optional()
  .describe("Regex pattern to filter consumer group names");

export const TimeoutParam = z
  .number()
  .int()
  .min(1000)
  .max(60000)
  .optional()
  .describe("Timeout in milliseconds (1000-60000)");

export const MaxMessagesParam = z
  .number()
  .int()
  .min(1)
  .max(500)
  .optional()
  .describe("Maximum number of messages to return (1-500)");
