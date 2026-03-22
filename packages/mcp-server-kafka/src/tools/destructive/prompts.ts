// src/tools/destructive/prompts.ts

export const DELETE_TOPIC_DESCRIPTION = `Permanently delete a Kafka topic and all its data. This action is IRREVERSIBLE. All messages in the topic will be lost. Consumer groups reading from this topic will be affected. DESTRUCTIVE OPERATION: Requires KAFKA_ALLOW_DESTRUCTIVE=true.`;

export const RESET_CONSUMER_GROUP_OFFSETS_DESCRIPTION = `Reset committed offsets for a consumer group on a specific topic. The consumer group MUST be in EMPTY state (no active consumers). Supports resetting to earliest, latest, or a specific timestamp. This affects where the consumer group will start reading from next. DESTRUCTIVE OPERATION: Requires KAFKA_ALLOW_DESTRUCTIVE=true.`;
