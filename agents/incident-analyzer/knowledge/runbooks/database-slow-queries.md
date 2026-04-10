# Couchbase Slow Query Investigation

## Symptoms
- N1QL query latency exceeding SLO (P99 > 500ms for complex, >100ms for indexed)
- Application timeouts when accessing Couchbase
- Capella cluster CPU or memory pressure

## Investigation Steps

### 1. Identify Slow Queries
Use `capella_get_longest_running_queries` to find queries by execution time. Use `capella_get_most_expensive_queries` to find queries consuming the most resources. Use `capella_get_most_frequent_queries` to check if a high-frequency query is degrading performance through volume.

### 2. Check for Primary Index Scans
Use `capella_get_primary_index_queries` to identify queries falling back to primary index (full bucket scan). These are the most common cause of slow queries and indicate missing secondary indexes.

### 3. Analyze Query Plans
Use `capella_suggest_query_optimizations` on the identified slow queries. This returns index recommendations and query rewrites. Use `capella_run_sql_plus_plus_query` with an EXPLAIN prefix to inspect the execution plan directly.

### 4. Audit Index Health
Use `capella_get_system_indexes` to list all indexes with their status and statistics. Use `capella_get_detailed_indexes` for extended metadata. Use `capella_get_indexes_to_drop` to identify unused or redundant indexes consuming resources.

### 5. Check Cluster Resource Pressure
Use `capella_get_system_vitals` for CPU, memory, disk usage, and rebalance status. Use `capella_get_system_nodes` to check per-node resource allocation across KV, Query, Index, and FTS services. Look for imbalanced load across nodes.

### 6. Check for Query Errors
Use `capella_get_fatal_requests` to find failed queries. Use `capella_get_completed_requests` to compare successful query latency distribution with the SLO thresholds.

### 7. Inspect Prepared Statement Cache
Use `capella_get_prepared_statements` to check cached query plans. Use `capella_get_detailed_prepared_statements` to check if plan invalidation or cache misses are causing repeated query planning overhead.

### 8. Cross-Reference with Application Logs
Use `elasticsearch_search` filtered by the application service name accessing Couchbase. Look for connection pool exhaustion, timeout errors, CAS conflict patterns, or retry storms. Use `elasticsearch_count_documents` to quantify error frequency.

### 9. Check API Gateway Impact
Use `query_api_requests` filtered to routes that depend on Couchbase-backed services. Check if slow queries are causing elevated gateway latency or 5xx responses.

## Cross-Datasource Correlation
- Couchbase slow queries + Kong 5xx on dependent routes = user-visible latency impact
- Couchbase slow queries + Elasticsearch timeout errors from app = connection pool exhaustion
- Couchbase slow queries + Kafka consumer lag = async processing bottleneck on DB writes
- Couchbase high CPU + primary index queries = missing index causing full scans

## Escalation Criteria
- Bucket memory resident ratio below 10%: page on-call
- Index build stuck for >30 minutes: escalate to DBA
- Query timeout rate >10%: consider circuit breaker activation (requires human approval)

## All Tools Used Are Read-Only
capella_get_longest_running_queries, capella_get_most_expensive_queries, capella_get_most_frequent_queries, capella_get_primary_index_queries, capella_suggest_query_optimizations, capella_run_sql_plus_plus_query, capella_get_system_indexes, capella_get_detailed_indexes, capella_get_indexes_to_drop, capella_get_system_vitals, capella_get_system_nodes, capella_get_fatal_requests, capella_get_completed_requests, capella_get_prepared_statements, capella_get_detailed_prepared_statements, elasticsearch_search, elasticsearch_count_documents, query_api_requests
