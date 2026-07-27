---
name: ml-anomaly-investigation
description: Query Elastic ML anomaly-detection records to explain what's behaving unusually, why, and how badly -- triggers on "what's anomalous", "is anything unusual happening", "why is X slow/spiking", and memory/CPU/restart/latency/error-rate drift questions.
---

# Skill: ML Anomaly Investigation

## When to use
The incident narrative or user question asks what's anomalous, whether anything
unusual is happening, why a service is slow/spiking, or references memory/CPU/
restart/latency/error-rate drift from typical behavior. Also trigger on explicit
"ML anomalies" / "Elastic ML" / "what does ML think" phrasing. Use
`elasticsearch_ml_get_anomaly_records` (action `ml_anomaly_records`) -- not
`ml_monitoring`, which answers "is the job healthy", not "what did it detect".

## Parameters and defaults

| Parameter | Default | Notes |
|---|---|---|
| `minScore` | omitted (no filter) | Never default this to a critical-only threshold on an open-ended question. Only set it when the caller names a severity band. |
| `lookback` | `now-24h` | Use a shorter window (`now-1h`) for an acute investigation, wider (`now-7d`) for a trend review -- only on explicit request. |
| `entity` | omitted | A single plain field VALUE (e.g. `checkout-service`), never a composite `field=value; field=value` expression. Matched across by/partition/over field values and every influencer. |
| `jobId` | omitted | Only set when the caller names a specific job or signal domain. |
| `limit` | 25 | Raise for a full audit; lower for "show me the worst". |

## Procedure
1. Derive parameters from the request per the table above. Do not guess a
   `minScore` the caller did not ask for.
2. Call the tool exactly once. It returns per-record `recordScore`, `jobId`,
   `fieldName`, `functionName`, `entity`, `deviationPercent`, `actual`/`typical`,
   plus a `jobsSummary` of per-job counts -- everything needed for one turn.
3. Empty result (`count: 0`) is a valid, final answer at the requested
   parameters. State it plainly ("no anomaly records above <threshold> in
   <window>"), record "wider lookback / no score filter not tried" as an
   un-queried gap, and STOP. Do NOT re-call this tool with a lower score or a
   wider window on your own initiative -- exactly one call per turn, always.
   The gap line is how the broadening option reaches the report; there is no
   one to agree to it mid-turn.
4. Reporting shape: if many jobs fired, lead with `jobsSummary` counts before
   individual records. If investigating one entity/job, lead with its
   highest-scoring record (job, score, field/function, actual vs typical
   deviation) before the rest.
5. Watch for an unexpectedly broad `entity` match (a low-cardinality value like
   a shared namespace can match tens of thousands of records) -- report the
   match count rather than dumping the full list when this happens.

## Numbers discipline
Every `recordScore`/`actual`/`typical`/`deviationPercent` cited must come from
the same record of the same call. Never merge fields from different records or
different calls into one claim, even for the same entity.

## Fallback / related
For job or datafeed HEALTH questions (is the model stale, is the datafeed
lagging, has data stopped arriving) use `ml_monitoring`
(`elasticsearch_ml_get_job_stats` / `elasticsearch_ml_get_datafeed_stats`)
instead -- that answers a different question than this skill.

## Future work (not implemented)
Cross-datasource follow-ups like "check APM service dependencies" or "assess
K8s blast radius" are NOT present in this codebase -- no
`apm-service-dependencies` or `k8s-blast-radius` tool exists. Do not reference
them as available follow-ups; cross-datasource correlation stays the
orchestrator's job, not this skill's.
