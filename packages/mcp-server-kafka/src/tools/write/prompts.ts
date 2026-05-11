// src/tools/write/prompts.ts

export const PRODUCE_MESSAGE_DESCRIPTION = `[WRITE] Produce messages to a Kafka topic. Supports sending 1-50 messages with optional keys, headers, and partition targeting. Use this to publish test data, replay events, or inject messages for debugging. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true.`;

export const CREATE_TOPIC_DESCRIPTION = `[WRITE] Create a new Kafka topic with specified partitions, replicas, and configuration. Use this to set up new data streams or test topics. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true.`;

export const ALTER_TOPIC_CONFIG_DESCRIPTION = `[WRITE] Modify configuration of an existing Kafka topic (e.g., retention.ms, cleanup.policy). Changes take effect immediately. Use this to tune topic behavior. WRITE OPERATION: Requires KAFKA_ALLOW_WRITES=true.`;
