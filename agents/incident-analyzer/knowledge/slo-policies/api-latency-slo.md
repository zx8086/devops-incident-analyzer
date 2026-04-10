# API Latency SLO Definitions

## Service Tiers

### Tier 1: User-Facing APIs (via Kong Konnect)
- **P50 latency**: < 100ms
- **P99 latency**: < 500ms
- **Error rate**: < 0.1%
- **Availability**: 99.95%
- **Error budget**: 21.9 minutes/month

### Tier 2: Internal Service APIs
- **P50 latency**: < 200ms
- **P99 latency**: < 1000ms
- **Error rate**: < 0.5%
- **Availability**: 99.9%
- **Error budget**: 43.8 minutes/month

### Tier 3: Batch/Async Processing (Kafka Consumers)
- **Processing lag**: < 30 seconds (P99)
- **Message failure rate**: < 0.01%
- **Consumer group availability**: 99.9%

## Database SLOs (Couchbase Capella)

### Query Performance
- **Simple key lookups**: < 5ms P99
- **N1QL queries (indexed)**: < 100ms P99
- **N1QL queries (complex joins)**: < 500ms P99

### Cluster Health
- **Bucket resident ratio**: > 20%
- **Rebalance duration**: < 15 minutes
- **Node failover detection**: < 30 seconds

## Breach Escalation Procedures

### Warning (>50% error budget consumed)
- Notify engineering channel
- Begin investigation using read-only diagnostics
- No immediate action required

### Critical (>80% error budget consumed)
- Page on-call engineer
- Full incident investigation across all data sources
- Prepare rollback plan (requires human approval)

### Exhausted (100% error budget consumed)
- Incident declared
- All non-essential deployments frozen
- Root cause analysis initiated
- Create tracking ticket for post-mortem
