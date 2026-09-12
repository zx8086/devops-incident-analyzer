---
name: scope-cloudwatch-logs
description: Query CloudWatch Logs Insights without manufacturing a false negative -- resolve the log group deterministically from the task definition rather than guessing, use relative time windows, read MalformedQueryException ([0,N]) as a window outside retention rather than expired logs, and discover field names before filtering or computing percentiles.
---

# Skill: Scope CloudWatch Logs

## Purpose
Every common Logs Insights mistake produces the same output -- zero rows -- and
zero rows reads as "no logs" when it usually means the group, the window, or
the field name was wrong. This skill separates a real absence from a badly
aimed query.

## Procedure
1. Resolve the log group deterministically BEFORE querying. For ECS the
   authoritative source is the task definition's `awslogs-group`. Otherwise
   prefer groups with recent ingestion. Never guess a group name and then draw
   a conclusion from an empty result.
2. Use a RELATIVE time window. Absolute timestamps drift out of retention and
   are the usual cause of the error in step 4.
3. Discover the field names for that specific group before any filter or
   percentile query -- field names differ per group, and a guessed field
   returns zero rows that falsely read as "no logs". Start with
   `fields @timestamp, @message | limit 20` and read what is actually there.
4. Interpret errors precisely:
   - `MalformedQueryException ([0,N])` means the WINDOW is outside retention,
     NOT that logs expired. Re-anchor the window relatively and retry.
   - "Unexpected symbol" is a query-string error, not a window problem.
     Simplify to `fields @timestamp, @message | limit 20` WITHOUT touching the
     window, then rebuild the query.
5. Only after a query that ran against a confirmed group, a live window, and
   real field names does an empty result mean anything. State which of the
   three it establishes.

## Rules
- A zero-row result from an unconfirmed group, window, or field is not a
  finding. Say what could not be confirmed.
- Application logs are DUAL-SHIPPED in these estates: ECS and Fargate service
  logs land in CloudWatch AND, via BindPlane, in Elasticsearch. Absence,
  truncation, or inaccessibility in CloudWatch is a routing or permission
  detail, NOT evidence the logs do not exist. Report "not available from
  CloudWatch in this account; application logs also ship to Elasticsearch" --
  never a bare "logs not retrieved" gap, and never claim the Elasticsearch copy
  was checked from here.
- A group with zero recent ingestion may belong to a workload that ships
  telemetry elsewhere, or that is scheduled to zero overnight. Check the
  schedule before reporting an outage.
- `/aws/events/` prefixes and CloudTrail-fed groups carry the monitor's OWN API
  calls. Activity there is echo, not workload.
- A group outside the readable name scope is a scoping fact; report it as such
  rather than as missing logs.
- When the question is an aggregate over a large result rather than the rows
  themselves, prefer the ctx_* tools if present: index the output and derive
  the count or grouping there. Their absence changes nothing about this
  procedure.
- Evidence names the log group and the window, for example "per Logs Insights
  over /ecs/<service>, last 3h", not "per a log query".
