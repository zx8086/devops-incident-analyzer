// src/tools/read/prompts.ts

export const LIST_TOPICS_DESCRIPTION = `[READ] List Kafka topics in the cluster with pagination. Use 'prefix' to narrow by case-sensitive name prefix (e.g. "DLQ_"), 'filter' for regex matching, 'limit' (default 100, max 500), and 'offset' for paging. Returns { topics, total, truncated, hint? }. When 'truncated' is true, narrow with 'prefix' or page with 'offset'.`;

export const DESCRIBE_TOPIC_DESCRIPTION = `[READ] Get detailed information about a specific Kafka topic including partition details, replica configuration, and topic-level settings. Use this to understand topic structure and configuration.`;

export const GET_TOPIC_OFFSETS_DESCRIPTION = `[READ] Get current offsets for all partitions of a topic. Optionally specify a timestamp to get offsets at a specific point in time. Useful for understanding data volume and time-based offset lookups.`;

export const CONSUME_MESSAGES_DESCRIPTION = `[READ] Read messages from a Kafka topic. Creates an ephemeral consumer that does not affect existing consumer groups. Use this to inspect message content, verify data formats, or debug data flow issues. Returns up to maxMessages within the timeout period.`;

export const LIST_CONSUMER_GROUPS_DESCRIPTION = `[READ] List consumer groups in the cluster. Optionally filter by regex pattern or state. Use this to discover consumer groups and their current status.`;

// SIO-770: drives the kafka-dlq-growth correlation rule. recentDelta > 0 across
// any topic indicates live failure inflow (not historical noise).
export const LIST_DLQ_TOPICS_DESCRIPTION = `[READ] List dead-letter queue topics (matched by suffix/prefix conventions like -dlq, dlt-, .DLQ) with totalMessages and recentDelta. By default, samples offsets twice ~30s apart so recentDelta = secondSample - firstSample reveals live message inflow vs. historical accumulation. Pass skipDelta:true for a fast single-sample probe (recentDelta:null). Use to detect DLQs growing right now, which often indicates a stalled consumer or repeated processing failures.`;

export const DESCRIBE_CONSUMER_GROUP_DESCRIPTION = `[READ] Get detailed information about a consumer group including members, assigned partitions, and committed offsets. Use this to debug consumer lag or group coordination issues.`;

export const GET_CLUSTER_INFO_DESCRIPTION = `[READ] Get high-level information about the Kafka cluster including broker count, topic count, and provider-specific metadata. The embedded topic list paginates — use 'prefix' (case-sensitive startsWith, e.g. "DLQ_"), 'limit' (default 100, max 500), and 'offset'. Response includes topicCount (full aggregate), topics, total, truncated, and hint? when paging is incomplete. Use this as a starting point to understand the cluster.`;
