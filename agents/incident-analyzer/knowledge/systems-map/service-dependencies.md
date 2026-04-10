# Service Dependency Map

## Overview
The monitored infrastructure consists of 4 primary data planes connected through service dependencies. Each plane is observed through a dedicated MCP server.

## Dependency Graph

```
User Traffic
    |
    v
[Kong Konnect API Gateway] -- (routes, rate limits, auth plugins)
    |
    +---> [Backend Services] -- (application layer)
    |         |
    |         +---> [Couchbase Capella] -- (document store, N1QL queries)
    |         |
    |         +---> [Kafka Cluster] -- (async messaging, event streaming)
    |                   |
    |                   +---> [Downstream Consumers] -- (batch processing, analytics)
    |
    +---> [Elasticsearch] -- (log aggregation, observability, search)
```

## Data Flow Patterns

### Synchronous Path
1. Request arrives at Kong Konnect gateway
2. Gateway applies rate limiting, authentication, and routing
3. Request forwarded to backend service
4. Backend queries Couchbase for data
5. Response returned through gateway

### Asynchronous Path
1. Backend service produces message to Kafka topic
2. Consumer groups process messages independently
3. Consumers may query Couchbase or Elasticsearch as part of processing
4. Results stored or forwarded to downstream systems

### Observability Path
1. All services emit structured logs
2. Logs aggregated in Elasticsearch
3. Kong Konnect logs API request metrics separately
4. Couchbase exposes system vitals and slow query logs

## Failure Correlation Patterns

| Symptom | Primary Source | Check Also |
|---------|---------------|------------|
| 5xx errors on API | Kong Konnect | Backend logs in Elastic, Couchbase latency |
| Stale data in responses | Kafka consumer lag | Couchbase query timeouts |
| Slow API responses | Couchbase slow queries | Kafka backpressure, Kong rate limits |
| Missing logs | Elasticsearch cluster health | Backend service health |
