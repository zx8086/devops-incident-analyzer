---
sources:
  - knowledge/systems-map/service-dependencies.md
updated: 2026-05-30T23:59:00.000Z
---

# Service Topology

User traffic enters through the Kong Konnect API gateway (routes, rate limits,
auth plugins), which forwards to backend services. Backends read and write
Couchbase Capella (document store, N1QL) and produce events to Kafka, which
downstream consumers process independently. All services emit structured logs to
Elasticsearch; Konnect logs API request metrics separately.

## Paths

- Synchronous: Konnect -> backend -> Couchbase -> response.
- Asynchronous: backend -> Kafka topic -> consumer groups (may read Couchbase or
  Elasticsearch as part of processing).
- Observability: services -> Elasticsearch; Konnect request metrics; Couchbase
  system vitals and slow-query logs.

## Failure correlation shortcuts

- 5xx on API: start at Konnect, then backend logs in Elasticsearch and Couchbase latency.
- Stale data in responses: Kafka consumer lag, then Couchbase query timeouts.
- Slow API responses: Couchbase slow queries, then Kafka backpressure and Konnect rate limits.
- Missing logs: Elasticsearch cluster health, then backend service health.

For raw detail see the source systems-map. Related runbooks live under
`knowledge/runbooks/`.
