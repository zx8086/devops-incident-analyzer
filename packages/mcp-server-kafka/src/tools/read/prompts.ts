// src/tools/read/prompts.ts

export const LIST_TOPICS_DESCRIPTION = `List Kafka topics in the cluster. Optionally filter by a regex pattern. Returns topic names. Use this to discover available topics before performing other operations.`;

export const DESCRIBE_TOPIC_DESCRIPTION = `Get detailed information about a specific Kafka topic including partition details, replica configuration, and topic-level settings. Use this to understand topic structure and configuration.`;

export const GET_TOPIC_OFFSETS_DESCRIPTION = `Get current offsets for all partitions of a topic. Optionally specify a timestamp to get offsets at a specific point in time. Useful for understanding data volume and time-based offset lookups.`;

export const CONSUME_MESSAGES_DESCRIPTION = `Read messages from a Kafka topic. Creates an ephemeral consumer that does not affect existing consumer groups. Use this to inspect message content, verify data formats, or debug data flow issues. Returns up to maxMessages within the timeout period.`;

export const LIST_CONSUMER_GROUPS_DESCRIPTION = `List consumer groups in the cluster. Optionally filter by regex pattern or state. Use this to discover consumer groups and their current status.`;

export const DESCRIBE_CONSUMER_GROUP_DESCRIPTION = `Get detailed information about a consumer group including members, assigned partitions, and committed offsets. Use this to debug consumer lag or group coordination issues.`;

export const GET_CLUSTER_INFO_DESCRIPTION = `Get high-level information about the Kafka cluster including broker count, topic count, and provider-specific metadata. Use this as a starting point to understand the cluster.`;
