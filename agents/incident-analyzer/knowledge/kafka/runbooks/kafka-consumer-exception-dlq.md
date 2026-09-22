---
type: Runbook
title: "Kafka Consumer Exception and DLQ Backlog"
description: "Triage SRMSG00200 / SRMSG00201 consumer failures, dead-letter backlogs and the upstream HTTP faults that cause them."
status: stable
tags: [kafka, consumer, dlq, smallrye, reactive-messaging]
generated:
  by: human:simon
  at: 2026-09-22
triggers:
  metrics:
    - SRMSG00200
    - SRMSG00201
    - consumer exception
    - dead letter
    - DLQ
    - dead-letter queue
    - VariantEventConsumer
    - VariantConsumer
    - consume exception
    - message nacked
    - deadlock
  match: any
tools:
  - kafka_list_dlq_topics
  - kafka_get_consumer_group_lag
  - kafka_describe_consumer_group
  - kafka_consume_messages
  - kafka_get_message_by_offset
  - kafka_get_topic_offsets
  - elasticsearch_search
  - konnect_query_api_requests
  - konnect_list_plugins
  - gitlab_get_file_content
  - gitlab_get_blame
  - gitlab_recent_deploys
  - aws_logs_start_query
  - aws_logs_get_query_results
  - aws_ecs_describe_tasks
  - capella_get_most_expensive_queries
  - capella_explain_sql_plus_plus_query
---
# Kafka Consumer Exception and DLQ Backlog

Triage SRMSG00200 / SRMSG00201 consumer failures, dead-letter backlogs and the
upstream HTTP faults that cause them.

SRMSG00200 is a SmallRye Reactive Messaging wrapper, not a cause. It means the consume
method threw. The work of this runbook is finding what threw, and that is almost never
Kafka. Prior incidents: DEVOPS-1393, DEVOPS-1396, DEVOPS-1397.

## Symptoms
- `SRMSG00200` or `SRMSG00201` in the consumer service log
- Dead-letter topic growing while the source topic drains normally
- Consumer group lag that recovers on its own after a task replacement, then returns
- ECS task replacement loop on the consuming service

## Step 1: size the backlog before reading any code
Use `kafka_list_dlq_topics` to find the dead-letter topics for the affected consumer group.
Use `kafka_get_topic_offsets` on each to get the message count, and
`kafka_get_consumer_group_lag` plus `kafka_describe_consumer_group` on the live group to
separate a stuck consumer from a consumer that is running but rejecting.

Scale changes the diagnosis. In DEVOPS-1393 the DLQ held 113,715 messages, which is a
systematic upstream fault; a handful of messages is a data-shape defect on specific records.

## Step 2: read the dead letter's own headers
Use `kafka_consume_messages` against the DLQ topic, or `kafka_get_message_by_offset` for a
specific offset. SmallRye writes the cause into the message headers -- read
`dead-letter-reason` and `dead-letter-cause` rather than inferring from the service log.
Group the reasons: one dominant reason means one defect, a spread means several.

## Step 3: classify the cause

| Header reason | Family | Go to |
|---|---|---|
| HTTP 404 from a downstream client | Upstream data gap | Step 4 |
| NullPointerException in a mapper or DTO | Message-shape defect | Step 5 |
| Deadlock detected / could not serialize access | Database contention | Step 6 |
| Validation exception | Message-shape defect | Step 5 |

## Step 4: upstream 404 (most common)
A downstream lookup returns 404 for a key that the producer considers valid, and the
consumer has no 404 fallback, so the exception escapes and the message dead-letters.

Use `konnect_query_api_requests` filtered to the downstream route to get the upstream 404
count and error rate -- 1,360 upstream 404s at a 31 percent error rate was the DEVOPS-1393
signature. Use `konnect_list_plugins` on that route and check for a response-caching
plugin: caching a 404 amplifies a transient gap into a sustained one, which is what made
this incident platform-wide rather than per-message.

Use `elasticsearch_search` on the downstream service to confirm whether the key genuinely
does not exist or the lookup itself is failing. Missing reference data is a data-ownership
problem; see the season and reference-data runbook for the lookup side.

This failure is rarely confined to one consumer. Check the other consumers of the same
downstream client before scoping the ticket.

## Step 5: message-shape defect
A field the consumer assumes is present arrives null or malformed.

Use `elasticsearch_search` on the consumer service for the stack trace and take the exact
class and line. Use `gitlab_get_file_content` to read that method and
`gitlab_get_blame` on the line to find when the assumption was introduced -- these defects
are usually years old and only exposed by a new producer or format. Use
`gitlab_recent_deploys` to check whether a recent release changed the producer side.

The fix is a null guard at the call site, not a change to Kafka configuration.

## Step 6: database deadlock
Concurrent consumer threads updating the same row in non-deterministic column order.

Use `aws_logs_start_query` and `aws_logs_get_query_results` against the service log group
for the deadlock detail, and `aws_ecs_describe_tasks` to confirm whether tasks are being
replaced in a loop (the replacement loop is the visible symptom; the deadlock is the cause).

Two aggravating patterns to check for explicitly, both seen in DEVOPS-1397:
- A full wide-column UPDATE where a partial update would do, which widens the lock footprint
- A transactional annotation interacting with a CDI proxy so the exception escapes the
  catch block, meaning no retry ever happens

Use `gitlab_get_file_content` on the consumer to confirm whether any deadlock retry exists.

## Step 7: rule out or confirm a database contribution
If the consumer reads Couchbase on the hot path, use `capella_get_most_expensive_queries`
and `capella_explain_sql_plus_plus_query` on its statements. Non-covering index scans add
latency that widens the window for the deadlock in Step 6 without being the root cause
themselves -- report them as contributing, not primary.

## Cross-Datasource Correlation
- DLQ growth + Kong upstream 404s on one route = upstream data gap, Step 4
- DLQ growth + ECS task replacement loop = deadlock or OOM, Step 6
- The same dead-letter reason across several consumer services = one shared downstream client
- Consumer lag that clears on restart and returns = poison message, not capacity
- A response-caching plugin in front of a 404 turns a transient gap into a sustained outage

## Escalation Criteria
- DLQ above 100,000 messages: the upstream fault is systematic, escalate to the owning team rather than replaying
- The same dead-letter reason across three or more services: raise at platform level, not per service
- Deadlock present with no retry logic in the consumer: application change required, not an operational fix
- Never replay a DLQ before the cause is fixed: replay re-dead-letters and doubles the backlog

## All Tools Used Are Read-Only
kafka_list_dlq_topics, kafka_get_consumer_group_lag, kafka_describe_consumer_group, kafka_consume_messages, kafka_get_message_by_offset, kafka_get_topic_offsets, elasticsearch_search, konnect_query_api_requests, konnect_list_plugins, gitlab_get_file_content, gitlab_get_blame, gitlab_recent_deploys, aws_logs_start_query, aws_logs_get_query_results, aws_ecs_describe_tasks, capella_get_most_expensive_queries, capella_explain_sql_plus_plus_query
