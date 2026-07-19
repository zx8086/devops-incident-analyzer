// src/tools/read/prompts.ts

// SIO-785 follow-up (2026-05-18): removed the "DLQ_" prefix example because
// the LLM took it as a recommendation and used this tool for DLQ queries
// instead of kafka_list_dlq_topics, leaving typed DLQ findings empty and the
// UI card invisible. Last sentence redirects DLQ intent to the right tool.
export const LIST_TOPICS_DESCRIPTION = `[READ] List Kafka topics in the cluster with pagination. Use 'prefix' to narrow by case-sensitive name prefix, 'filter' for regex matching, 'limit' (default 100, max 500), and 'offset' for paging. Returns { topics, total, truncated, hint? }. When 'truncated' is true, narrow with 'prefix' or page with 'offset'. For dead-letter queue inspection use 'kafka_list_dlq_topics' instead — it returns sizes and recent-delta in one call.`;

export const DESCRIBE_TOPIC_DESCRIPTION = `[READ] Get detailed information about a specific Kafka topic including partition details, replica configuration, and topic-level settings. Use this to understand topic structure and configuration.`;

export const GET_TOPIC_OFFSETS_DESCRIPTION = `[READ] Get current offsets for all partitions of a topic. Optionally specify a timestamp to get offsets at a specific point in time. Useful for understanding data volume and time-based offset lookups.`;

export const CONSUME_MESSAGES_DESCRIPTION = `[READ] Read messages from a Kafka topic. Creates an ephemeral consumer that does not affect existing consumer groups. IMPORTANT: by default the consumer starts at the LATEST offset and only sees messages produced during the timeout window -- existing backlog is invisible. Pass fromBeginning:true to read historical messages, or use kafka_get_message_by_offset for a specific offset. An empty result returns { messages: [], mode, note } explaining the likely cause. Messages whose value is not valid UTF-8 text (Avro/Protobuf) are flagged valueLooksBinary:true.`;

export const LIST_CONSUMER_GROUPS_DESCRIPTION = `[READ] List consumer groups in the cluster. Optionally filter by regex pattern or state. Use this to discover consumer groups and their current status.`;

// SIO-770: drives the kafka-dlq-growth correlation rule. recentDelta > 0 across
// any topic indicates live failure inflow (not historical noise).
// SIO-1159: description updated to the SIO-1150 reality (10s delta window,
// auto-skip above 15 topics) and the diagnostics wrapper shape.
export const LIST_DLQ_TOPICS_DESCRIPTION = `[READ] List dead-letter queue topics (matched by naming conventions -dlq, dlt-*, *-dead-letter, dead-letter-*, *.dlq, DLQ_*) with totalMessages and recentDelta. Returns { topics, matched, sampleFailed, sampleFailedTopics?, note? }: matched counts DLQ-named topics; sampleFailed counts those omitted because offset sampling failed (they still exist -- their names are in sampleFailedTopics; probe each with kafka_describe_topic). By default samples offsets twice ~10s apart so recentDelta = secondSample - firstSample reveals live inflow vs. historical accumulation; above 15 matched topics the delta window is auto-skipped (recentDelta:null). Pass skipDelta:true for a fast single-sample probe. Use to detect DLQs growing right now, which often indicates a stalled consumer or repeated processing failures.`;

export const DESCRIBE_CONSUMER_GROUP_DESCRIPTION = `[READ] Get detailed information about a consumer group including members, assigned partitions, and committed offsets. Use this to debug consumer lag or group coordination issues.`;

export const GET_CLUSTER_INFO_DESCRIPTION = `[READ] Get high-level information about the Kafka cluster including broker count, topic count, and provider-specific metadata. The embedded topic list paginates — use 'prefix' (case-sensitive startsWith, e.g. "DLQ_"), 'limit' (default 100, max 500), and 'offset'. Response includes topicCount (full aggregate), topics, total, truncated, and hint? when paging is incomplete. Use this as a starting point to understand the cluster.`;
