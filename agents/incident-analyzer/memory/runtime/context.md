# Live Context

Durable operating context for the incident-analyzer agent. This file persists
across sessions and is injected into the orchestrator prompt at session start.
Unlike the LangGraph checkpointer (per-thread, transient), this is long-lived,
human-readable, and git-tracked. Keep it concise; it is read on every session.

## Estate

Four primary data planes, each observed through a dedicated MCP server, plus
GitLab, Atlassian, and AWS:

- Kong Konnect API gateway (ingress: routes, rate limits, auth plugins)
- Backend services (application layer)
- Couchbase Capella (document store, N1QL)
- Kafka cluster (async messaging, event streaming)
- Elasticsearch (log aggregation, observability, search)

## Standing constraints

- Read-only analysis by default. Mutations require human-in-the-loop approval.
- Default time window when unspecified: last 1 hour. Default environment: production.

## Failure correlation shortcuts

| Symptom | Primary source | Check also |
|---------|---------------|------------|
| 5xx errors on API | Kong Konnect | Backend logs in Elastic, Couchbase latency |
| Stale data in responses | Kafka consumer lag | Couchbase query timeouts |
| Slow API responses | Couchbase slow queries | Kafka backpressure, Kong rate limits |
| Missing logs | Elasticsearch cluster health | Backend service health |

See `knowledge/systems-map/service-dependencies.md` for the full dependency graph
and `memory/wiki/index.md` for compiled domain knowledge.
