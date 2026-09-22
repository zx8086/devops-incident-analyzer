---
type: Module
title: vending-orchestrator/orchestrator
description: The vending orchestrator Lambda with its SQS event source mapping, IAM role and policy, log group and CloudWatch alarm.
resource: aws-lz-vending-orchestrator/modules/orchestrator
change_class: gitops-hcl
tags: [aws-lz, lambda, sqs, orchestration, vending]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-vending-orchestrator/modules/orchestrator
    title: Module source as checked out
  - id: parent
    resource: aws-lz-vending-orchestrator
    title: Consuming root — see /repos/aws-lz-vending-orchestrator.md
---

# When this applies

Orchestrator behaviour, its queue wiring, its permissions, or its alarm thresholds change.

# Surface

**Edit:** `aws-lz-vending-orchestrator/modules/orchestrator/` — `_data.tf`, `_locals.tf`, `_outputs.tf`, `_variables.tf`, `_versions.tf`, `alarms.tf`, `event_source.tf`, `iam.tf`.

Called from `main.tf` in the vending-orchestrator root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-vending-orchestrator.md](/repos/aws-lz-vending-orchestrator.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **`aws_lambda_event_source_mapping` settings are throughput and failure behaviour, not configuration.** Batch size and concurrency changes alter how vending fails under load; a partial batch failure setting decides whether one bad event blocks a queue.
- The SQS queue is created here. Deleting and recreating it drops any in-flight vending events.
- The Lambda's IAM role policy grants access to the state-store tables. Narrowing it produces runtime failures the plan cannot see.
- The CloudWatch alarm is the only signal that vending has stalled. Removing or loosening it removes the detection, not the problem.
- Log-group retention changes are cheap but affect incident forensics.

# Fields

Inputs: `accounts_stream_arn` · `accounts_table_arn` · `accounts_table_name` · `custom_tags` · `events_table_arn` · `events_table_name` · `gitlab_token_ssm_param` · `log_retention_days` · `mandatory_tags` · `network_stream_arn` · `network_table_arn` · `network_table_name` · `region` · `routing_rules` · `sns_topic_arn`

Outputs: `dlq_arn` · `execution_role_arn` · `function_arn` · `function_name`

# Plan

Code or environment change: `1 in place` plus a new version. Event-source setting: `1 in place` with behavioural impact. Queue replacement: destructive.

# Stop

- A plan proposes replacing the SQS queue.
- An IAM policy would be narrowed without tracing which table or action the Lambda needs.
- The stall alarm would be removed or loosened.
