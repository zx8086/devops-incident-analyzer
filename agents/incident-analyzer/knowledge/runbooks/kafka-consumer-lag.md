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

### 2a. ksqlDB Cluster-State Check (collapse N findings into 1)
If 3 or more EMPTY (or Dead) groups share the `_confluent-ksql-default_query_*` prefix, do not investigate them individually. Call `ksql_get_server_info` and `ksql_list_queries` once. A non-`RUNNING` or unreachable response is a single system-level finding ("ksqlDB cluster down/degraded") that supersedes per-query reporting. Only fall back to per-query investigation if the ksqlDB server itself is healthy and only a subset of queries are stopped.

### 3. Check Partition-Level Lag Distribution
Use `kafka_get_consumer_group_lag` to get per-partition lag. If lag is concentrated on specific partitions, suspect a hot partition (skewed key distribution). If uniform across all partitions, suspect a throughput bottleneck or slow consumer processing.

### 4. Analyze Topic Configuration
Use `kafka_describe_topic` to check partition count, replication factor, and retention settings. Low partition count relative to consumer count means some consumers are idle. Check `kafka_get_topic_offsets` to compare latest vs committed offsets.

### 5. Sample Recent Messages
Use `kafka_consume_messages` with a small limit on the lagging partition to inspect message content. Look for unusually large messages, malformed payloads, or patterns that might cause processing failures.

### 6. Check for Dead Letter Topic Activity
Use `kafka_list_topics` to find DLQ topics (typically suffixed with `.dlq` or `.dead-letter`). Use `kafka_get_topic_offsets` to check message count. Use `kafka_consume_messages` to sample recent DLQ entries for poison message patterns.

### 7. Cross-Reference with Application Logs (MANDATORY when any group is Empty/Dead)
Use `elasticsearch_search` and `elasticsearch_count_documents` filtered by the consumer application's service name over a 24h window. Look for deserialization errors, external dependency timeouts, out-of-memory patterns, rebalance failures, and authorization exceptions.

**This step is mandatory whenever 1 or more consumer groups are in `Empty` or `Dead` state.** Do not emit a final report whose gaps section says "Elasticsearch not queried" when Empty/Dead groups are present. If Elastic is genuinely unreachable, state the failure mode explicitly (e.g., "Elastic deployment `eu-cld` returned 503"), not a vague gap.

**Inferring service names from consumer group IDs.** Translate group IDs to the underlying service before querying Elastic:
- `Apache_Kafka_Consumer_<config-name>-<uuid>` -> the `<config-name>` segment usually maps to the Spring `spring.application.name` or k8s deployment label. Strip the trailing UUID.
- `_confluent-ksql-default_query_<id>` -> ksqlDB query identifier; do not search per-query Elastic logs (see Step 2a). Search ksqlDB server logs by service name `ksqldb-server` or `ksql-server`.
- `connect-<connector-name>` -> Kafka Connect connector. Search for the Kafka Connect worker logs (typically `kafka-connect` deployment) AND any sink/source-specific service.
- `<service-name>-<env>` and `<service-name>` -> use the service name verbatim.
- `__amazon_msk_canary_*` -> ignore (MSK internal canary, not an application).

If a group ID matches none of the patterns above, report it as "service unknown" and skip the Elastic query rather than guessing. Do not fabricate service names.

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

## Known Configuration Gaps (don't re-flag as findings)
- If `kafka_describe_cluster` returns incomplete broker metadata or any tool surfaces an `AccessDenied` / `kafka:DescribeClusterV2 not authorized` error against an MSK cluster, link to [`msk-iam-permissions.md`](./msk-iam-permissions.md) instead of treating it as a cluster-health finding. The fix is an IAM policy update on the MCP server's role, not a Kafka cluster issue.

## Cluster Service Mapping
When the runbook says "infer the service name and query Elastic / GitLab", use these per-cluster defaults to skip discovery:

| Kafka cluster | Elastic deployment (`deployment` arg) | GitLab group (project paths) |
|---------------|---------------------------------------|------------------------------|
| `c72-shared-services-msk` (eu-central-1) | `eu-b2b` | `b2b-technologies` (use `b2b-technologies%2F<service>` as URL-encoded `project_id` if no numeric ID is known) |

Other clusters not yet mapped here -- ask the operator before guessing.

## Recovery Actions (Require Human Approval)
- Reset consumer offset to latest (data loss trade-off)
- Scale consumer instances
- Temporarily increase partition count

## All Tools Used Are Read-Only
kafka_list_consumer_groups, kafka_get_consumer_group_lag, kafka_describe_consumer_group, kafka_describe_topic, kafka_get_topic_offsets, kafka_consume_messages, kafka_list_topics, ksql_get_server_info, ksql_list_queries, elasticsearch_search, elasticsearch_count_documents, capella_get_completed_requests, capella_get_fatal_requests
