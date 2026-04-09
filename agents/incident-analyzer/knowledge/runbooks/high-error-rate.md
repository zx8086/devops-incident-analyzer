# High Error Rate Investigation

## Symptoms
- Elevated 5xx responses on API gateway (Kong Konnect)
- Error rate exceeding SLO threshold (>1% of requests)
- Backend service health checks failing

## Investigation Steps

### 1. Check API Gateway Error Distribution
Query Kong Konnect for status code breakdown by route and service over the last 30 minutes. Look for patterns: is the error rate uniform or concentrated on specific routes?

### 2. Identify Affected Backend Services
Cross-reference erroring routes with upstream service targets. Check if errors correlate with a specific deployment or instance.

### 3. Check Elasticsearch for Application Logs
Search for ERROR and FATAL log entries in the same time window. Filter by the affected service names. Look for stack traces, connection refused, or timeout patterns.

### 4. Verify Database Connectivity
If backend errors suggest database issues, check Couchbase Capella cluster health. Look for query timeouts, bucket memory pressure, or rebalancing operations.

### 5. Check Kafka for Async Processing Failures
If the erroring service produces or consumes Kafka messages, check consumer lag and dead letter topics. Stalled consumers can cause cascading timeouts.

## Escalation Criteria
- Error rate >5% sustained for 10+ minutes: page on-call
- Error rate >25%: escalate to incident commander
- Single service >50% error rate: consider emergency rollback (requires human approval)

## Safe Read-Only Checks
All investigation steps above are read-only. No write operations needed during investigation phase.
