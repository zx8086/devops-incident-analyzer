# Couchbase Slow Query Investigation

## Symptoms
- N1QL query latency exceeding SLO (P99 > 500ms)
- Application timeouts when accessing Couchbase
- Capella cluster CPU or memory alerts

## Investigation Steps

### 1. Identify Slow Queries
Use Couchbase system catalog to find queries exceeding latency thresholds. Sort by execution time and frequency to prioritize investigation.

### 2. Analyze Query Execution Plans
Run EXPLAIN on the slowest queries. Look for full bucket scans (PrimaryScan), missing indexes, or inefficient key lookups.

### 3. Check Index Health
Verify all expected indexes exist and are online. Check for indexes in building state or with high mutation queue. Stale indexes produce slow reads.

### 4. Review Bucket Memory Quotas
Check resident ratio for the affected bucket. If resident ratio drops below 20%, queries hit disk more frequently, increasing latency.

### 5. Check for Hot Keys or Vbucket Imbalance
Identify if specific documents or vbuckets are receiving disproportionate traffic. Hot keys can saturate a single node.

### 6. Cross-Reference with Application Logs
Search Elasticsearch for connection pool exhaustion, timeout errors, or CAS conflict patterns from the application layer.

## Escalation Criteria
- Bucket memory resident ratio below 10%: page on-call
- Index build stuck for >30 minutes: escalate to DBA
- Query timeout rate >10%: consider circuit breaker activation (requires human approval)

## Safe Read-Only Checks
All investigation queries use system catalogs and EXPLAIN -- no data mutation.
