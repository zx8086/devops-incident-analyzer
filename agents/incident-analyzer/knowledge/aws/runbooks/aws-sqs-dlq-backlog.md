---
type: Runbook
title: "AWS SQS Dead-Letter Queue Investigation"
description: "Diagnose messages arriving in a dead-letter queue: which consumer failed them and why."
status: stable
tags: [aws, sqs, messaging, lambda]
generated:
  by: human:simon
  at: 2026-09-16
triggers:
  metrics:
    - dead letter
    - dead-letter
    - DLQ
    - redrive
    - ApproximateNumberOfMessages
    - ApproximateAgeOfOldestMessage
    - queue depth
  services:
    - sqs
    - lambda
  match: any
tools:
  - aws_sqs_list_queues
  - aws_sqs_get_queue_attributes
  - aws_lambda_list_functions
  - aws_lambda_get_function_configuration
  - aws_cloudwatch_get_metric_data
  - aws_logs_start_query
  - aws_logs_get_query_results
---

# Dead-letter queue depth

Raised by the monitor's `queues` check when a queue that another queue
redrives into is holding messages.

## What the finding already establishes

A message reaches a DLQ only after its source queue's consumer received it
`maxReceiveCount` times and failed to delete it each time. So by the time this
finding exists:

- the failure has already happened and is **in the past**
- the messages are **not being retried** any more
- the problem is in the **consumer of the source queue**, never in the DLQ

The DLQ is where the evidence landed, not where the fault is. The finding
names the source queues in `evidence.redrivenFrom` precisely so the
investigation starts at the consumer rather than at the queue that raised it.

Depth on a DLQ is always worth reporting; depth on a source queue is not, and
is deliberately not checked. A queue holding messages is a queue working.

## Order of investigation

### 1. Establish whether this is new, ongoing, or a residue

Three states look identical in a single depth reading and mean different
things:

- **A finished incident.** Messages failed during a past outage and nobody
  drained the DLQ afterward. The depth is a leftover, not an active problem.
- **An ongoing failure.** Messages are still arriving now.
- **A single poison message.** One malformed payload the consumer cannot
  handle, arriving once and staying.

Distinguish them with the DLQ's `NumberOfMessagesSent` metric over the last
24 hours via `aws_cloudwatch_get_metric_data`, rather than the depth: a flat
line with a non-zero depth is a residue, a rising line is ongoing. Confirm the
current depth and redrive wiring with `aws_sqs_get_queue_attributes`, and use
`aws_sqs_list_queues` if the finding's source queue names need resolving to
full URLs. Say which one it is; proposing a consumer
fix for a two-week-old residue wastes everyone's time.

### 2. Identify the consumer of the SOURCE queue

`evidence.redrivenFrom` names the source queues. Find what reads them:

- **Lambda**: an event source mapping on the source queue. Find the candidate
  functions with `aws_lambda_list_functions`, then read
  `aws_lambda_get_function_configuration` for the timeout and the reserved
  concurrency: a function throttled to zero fails every receive and fills a
  DLQ fast with nothing in its own logs to show for it.
- **ECS/EC2 workers**: a long-poll consumer. Confirm it is running at all
  before reading its logs. A scaled-to-zero consumer is the commonest cause of
  a DLQ filling with no application errors anywhere.

### 3. Read the consumer's errors in the window the messages arrived

Query the consumer's logs with `aws_logs_start_query` and
`aws_logs_get_query_results` over the window the DLQ metric shows messages
arriving, not a fixed recent window. If the failure stopped two days ago the
recent logs are clean and will mislead.

Lambda specifically: an invocation that times out leaves no application error,
only a `Task timed out` line, and it still counts toward `maxReceiveCount`.
Check `Duration` against the configured timeout and the queue's
`VisibilityTimeout` before concluding the code is at fault. A visibility
timeout shorter than the function timeout causes duplicate delivery and
eventual DLQ arrival even when every invocation eventually succeeds.

### 4. Read one message only if you must, and know that you cannot

The spoke's role denies `sqs:ReceiveMessage` deliberately: message bodies are
data-plane content and may carry personal data. Diagnose from the consumer's
logs and metrics, and if the payload genuinely is the only way forward, say so
in the diagnosis and escalate to a human with the access. Do not report the
absence of message content as a failed check.

## Reporting

Name the source queue, the consumer, and what the consumer was doing when the
messages failed. State whether the failure is ongoing or finished. Redriving
the DLQ back is a write and is always a human decision; propose it, never
imply it has been done.

## All Tools Used Are Read-Only
aws_sqs_list_queues, aws_sqs_get_queue_attributes, aws_lambda_list_functions, aws_lambda_get_function_configuration, aws_cloudwatch_get_metric_data, aws_logs_start_query, aws_logs_get_query_results

---

Source: event-source-mapping and concurrency failure modes adapted from the
AWS Agent Toolkit `aws-serverless` skill (github.com/aws/agent-toolkit-for-aws,
Apache-2.0, Copyright Amazon.com, Inc. or its affiliates).
