# Kafka Consumer Lag Investigation

## Symptoms
- Consumer group lag exceeding threshold (>10,000 messages)
- Processing latency increasing
- Downstream services showing stale data

## Investigation Steps

### 1. Identify Lagging Consumer Groups
Use `kafka_list_consumer_groups` to enumerate all groups. Use `kafka_get_consumer_group_lag` on each to identify which groups have growing lag. Sort by total lag to prioritize investigation.

### 2. Inspect Consumer Group State
Use `kafka_describe_consumer_group` to check group state (Stable, Rebalancing, Dead, Empty), member count, and partition assignments. A group in Rebalancing state may indicate consumer crashes or slow heartbeats. An Empty group means all consumers disconnected.

### 3. Check Partition-Level Lag Distribution
Use `kafka_get_consumer_group_lag` to get per-partition lag. If lag is concentrated on specific partitions, suspect a hot partition (skewed key distribution). If uniform across all partitions, suspect a throughput bottleneck or slow consumer processing.

### 4. Analyze Topic Configuration
Use `kafka_describe_topic` to check partition count, replication factor, and retention settings. Low partition count relative to consumer count means some consumers are idle. Check `kafka_get_topic_offsets` to compare latest vs committed offsets.

### 5. Sample Recent Messages
Use `kafka_consume_messages` with a small limit on the lagging partition to inspect message content. Look for unusually large messages, malformed payloads, or patterns that might cause processing failures.

### 6. Check for Dead Letter Topic Activity
Use `kafka_list_topics` to find DLQ topics (typically suffixed with `.dlq` or `.dead-letter`). Use `kafka_get_topic_offsets` to check message count. Use `kafka_consume_messages` to sample recent DLQ entries for poison message patterns.

### 7. Cross-Reference with Application Logs
Use `elasticsearch_search` filtered by the consumer application's service name. Look for deserialization errors, external dependency timeouts, or out-of-memory patterns. Use `elasticsearch_count_documents` to quantify error frequency.

### 8. Check Downstream Data Staleness
If the consumer writes to Couchbase, use `capella_get_completed_requests` and `capella_get_fatal_requests` to check if the consumer's write operations are succeeding or failing.

## Cross-Datasource Correlation
- Kafka lag + Couchbase fatal requests = consumer failing on database writes
- Kafka lag + Elasticsearch errors from consumer app = processing failures
- Kafka lag + Kong Konnect 5xx on dependent routes = user-visible impact
- Kafka lag uniform + 0 errors = throughput bottleneck, needs scaling

## Escalation Criteria
- Lag >100,000 and growing: page on-call
- Consumer group state is Empty or Dead: immediate escalation
- Lag causing user-visible staleness: notify product team

## Recovery Actions (Require Human Approval)
- Reset consumer offset to latest (data loss trade-off)
- Scale consumer instances
- Temporarily increase partition count

## All Tools Used Are Read-Only
kafka_list_consumer_groups, kafka_get_consumer_group_lag, kafka_describe_consumer_group, kafka_describe_topic, kafka_get_topic_offsets, kafka_consume_messages, kafka_list_topics, elasticsearch_search, elasticsearch_count_documents, capella_get_completed_requests, capella_get_fatal_requests
