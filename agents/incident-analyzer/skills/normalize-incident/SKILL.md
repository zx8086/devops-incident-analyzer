# Skill: Normalize Incident

## Purpose
Transform a raw incident report (PagerDuty alert, Slack message, user query)
into a structured incident object with standardized fields for downstream analysis.

## Procedure
1. Parse the incoming alert or query to extract key signals
2. Identify affected services by name, namespace, or deployment
3. Determine the incident time window (explicit or inferred from "last 30 minutes")
4. Classify severity: critical (outage), high (degraded), medium (anomaly), low (informational)
5. Map affected services to datasources (which MCP servers to query)
6. Extract any specific metrics mentioned (error rate, latency, lag count)

## Output Format
```
Incident:
  id: <generated UUID>
  severity: critical | high | medium | low
  time_window: { from: ISO8601, to: ISO8601 }
  affected_services: [{ name, namespace?, deployment? }]
  datasources_to_query: [elastic | kafka | couchbase | konnect]
  extracted_metrics: [{ metric_name, value?, threshold? }]
  raw_input: <original text>
```

## Edge Cases
- No explicit time window: default to last 1 hour
- No service name: query all datasources for anomalies
- Multiple services: create separate datasource queries per service
- Follow-up query: inherit time window and services from previous turn
