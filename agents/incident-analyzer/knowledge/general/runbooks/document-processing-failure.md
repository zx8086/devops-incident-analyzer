---
type: Runbook
title: "Import and Document Generation Failure"
description: "Triage Excel import and document generation failures caused by unguarded parsing assumptions about file shape and optional fields."
status: stable
tags: [import, export, document-generation, parsing, data-quality]
generated:
  by: human:simon
  at: 2026-09-22
triggers:
  metrics:
    - document generation
    - excel import
    - import failure
    - ArrayIndexOutOfBoundsException
    - NullPointerException
    - NPE
    - deserialization failure
    - RESTEASY-JACKSON000100
    - export failure
    - sheet not found
  match: any
tools:
  - elasticsearch_search
  - elasticsearch_count_documents
  - elasticsearch_esql_query
  - gitlab_get_file_content
  - gitlab_get_blame
  - gitlab_list_commits
  - gitlab_recent_deploys
  - gitlab_search
  - kafka_list_dlq_topics
  - kafka_consume_messages
  - aws_logs_start_query
  - aws_logs_get_query_results
  - aws_sqs_get_queue_attributes
  - aws_ecs_describe_tasks
  - capella_get_document_by_id
  - capella_run_sql_plus_plus_query
---
# Import and Document Generation Failure

Triage Excel import and document generation failures caused by unguarded parsing
assumptions about file shape and optional fields.

Every incident in this family is an application defect, not an infrastructure fault. The
parser assumes the input conforms to the template the service itself generates, and an
externally edited or differently exported file exposes a missing guard. Prior incidents:
DEVOPS-1392, DEVOPS-1399, DEVOPS-1410, DEVOPS-1417.

Do not spend the investigation on infrastructure. Confirm it is healthy in Step 1 and move
on.

## Symptoms
- `ArrayIndexOutOfBoundsException` during export or sheet construction
- `NullPointerException` on an optional metadata field or a missing worksheet
- Deserialization failure on an inbound payload
- Failures that cluster on specific customers, season codes or file sources

## Step 1: confirm infrastructure is healthy, then stop looking at it
Use `aws_ecs_describe_tasks` for the service's task health and
`aws_sqs_get_queue_attributes` for queue depth and age of the oldest message. Healthy tasks
plus a backlog that only contains failed records means the fault is per-message. In every
prior incident in this family ECS, SQS and Couchbase were healthy; recording that fact
early keeps the report from wandering.

## Step 2: get the exact class, method and line
Use `elasticsearch_search` on the service for the stack trace, and
`aws_logs_start_query` with `aws_logs_get_query_results` against the log group when the
APM trace is truncated. Take the literal method name and line number -- this family is
diagnosed at that precision, not at the service level.

Use `elasticsearch_count_documents` for the 30-day occurrence count per distinct exception,
because these incidents almost always contain more than one defect and the reported one is
rarely the dominant one.

## Step 3: separate the reported defect from the dominant defect
Count occurrences per exception signature before reading any code. In DEVOPS-1399 the
reported exception was an index-out-of-bounds on a split, but the majority of the dead
letters came from a different, unguarded null return. Fixing only the reported one would
have closed the ticket with most of the failures still live.

Use `kafka_list_dlq_topics` and `kafka_consume_messages` to read the dead-letter reasons and
group them, which gives the same split from the message side.

## Step 4: read the code at the failing line
Use `gitlab_get_file_content` for the method and `gitlab_get_blame` on the line to date the
assumption. Use `gitlab_list_commits` on the file for the surrounding history and
`gitlab_recent_deploys` to check whether a release exposed it rather than introduced it.

The recurring defect shapes in this corpus:

| Shape | What the code assumes | What arrives |
|---|---|---|
| Split then index | The delimiter is always present, so the array has at least two elements | A trailing-delimiter value, which Java's default split trims to length one |
| Optional metadata | A document property set by the generating tool is always present | A file produced or edited externally, where it is absent |
| Named worksheet | A workbook always contains the expected sheet | A different export format that omits it |
| Nested getter chain | An intermediate object is never null | A customer or season combination where it is |

These are years old in most cases. The commit that introduced the assumption is usually not
the commit that caused the incident; use `gitlab_search` to find the same unguarded pattern
elsewhere in the service before closing.

## Step 5: characterise which inputs trigger it
Use `capella_run_sql_plus_plus_query` or `capella_get_document_by_id` to fetch the offending
record and inspect the field that broke the parser. Establish whether the trigger correlates
with a customer, a season code or a file source -- a new export format arriving from an
upstream system is a different conversation with a different team than a one-off malformed
upload.

## Step 6: quantify before recommending
Use `elasticsearch_esql_query` to aggregate failures by customer and by defect over the
window. A defect affecting two customers is a guard; a defect affecting an entire format is
a contract change with the producing system.

## Cross-Datasource Correlation
- Healthy ECS and SQS + per-message failures = application defect, always
- Several distinct exception signatures in one incident = several defects, count them before fixing
- Failures clustered on one customer or season = data-shape trigger, not load
- A new upstream export format in the same window = contract change, escalate to the producer
- Dead-letter reasons that disagree with the reported exception = the reported one is not the dominant one

## Escalation Criteria
- More than one defect found: file them separately with their own counts, do not bundle
- The trigger is a new upstream format: escalate to the producing team, a parser guard alone accepts bad data silently
- The same unguarded pattern found elsewhere in the service: raise proactively rather than waiting for the next incident
- Never recommend a broad catch as the fix; it converts a visible failure into silent data loss

## All Tools Used Are Read-Only
elasticsearch_search, elasticsearch_count_documents, elasticsearch_esql_query, gitlab_get_file_content, gitlab_get_blame, gitlab_list_commits, gitlab_recent_deploys, gitlab_search, kafka_list_dlq_topics, kafka_consume_messages, aws_logs_start_query, aws_logs_get_query_results, aws_sqs_get_queue_attributes, aws_ecs_describe_tasks, capella_get_document_by_id, capella_run_sql_plus_plus_query
