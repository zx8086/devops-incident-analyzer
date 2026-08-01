---
name: normalize-incident
description: Transform a raw incident report (PagerDuty alert, Slack message, or user query) into a structured incident object with severity, time window, affected services, and the datasources to query. Use at the start of every investigation, before any datasource is queried, to turn free-text input into the pipeline's canonical Incident shape.
---

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

## Severity -> Response Mapping
Severity (step 4) drives downstream pipeline behavior, not just labeling:
- critical (outage): full fan-out to every relevant datasource; escalation is
  expected in the mitigation stage regardless of confidence.
- high (degraded): full fan-out; standard confidence gating applies.
- medium (anomaly): fan out only to explicitly implicated datasources;
  monitor-first posture in the mitigation stage.
- low (informational): narrowest query set; informational report, no
  escalation unless findings reveal higher actual severity.

Reclassify upward, never downward, mid-investigation: when findings reveal
wider impact than initially classified, treat the incident at the higher
severity from that point on and note the reclassification in the report.

## Output Format
```yaml
Incident:
  id: <generated UUID>
  severity: critical | high | medium | low
  time_window: { from: ISO8601, to: ISO8601 }
  affected_services: [{ name, namespace?, deployment? }]
  datasources_to_query: [elastic | kafka | couchbase | konnect | gitlab | atlassian | aws]
  extracted_metrics: [{ metric_name, value?, threshold? }]
  raw_input: <original text>
```

## Edge Cases
- No explicit time window: default to last 24 hours
- No service name: query all datasources for anomalies
- Multiple services: create separate datasource queries per service
- Follow-up query: inherit time window and services from previous turn
