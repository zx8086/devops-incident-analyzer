---
type: Stack
title: aws-lz-vending-orchestrator
description: Event-driven account-vending orchestration — a DynamoDB state store, SQS-fed orchestrator and publisher Lambdas, and SNS alerting, routed by one rules YAML.
resource: aws-lz-vending-orchestrator
archetype: orchestration-root
change_class: gitops-hcl
tags: [aws-lz, vending, lambda, sqs, dynamodb, sns]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: repo
    resource: aws-lz-vending-orchestrator
    title: Repository contents as checked out
---

# When this applies

The vending routing rules change; the orchestrator or publisher Lambda changes;
the state-store table or its indexes change; alerting recipients change.

# Surface

**Edit:** `config/routing-rules.yaml`, `main.tf` (module composition),
`_locals.tf`, `_variables.tf`, and `modules/orchestrator/`,
`modules/publisher/`, `modules/state-store/`, `modules/alerting/`.

**Never edit:** `_backend.tf`.

# Traps

- **This root is a management-plane exception.** It always runs in one account
  and assumes a fixed deployment role rather than deriving the target from
  `var.account_id`. `AGENTS.md` allows this for vending and orchestration roots
  and says explicitly that it is not a reusable default. [^agents-md] Do not
  copy the pattern into a workload root.
- **Pre-commit is disabled by filename.** The config is committed as
  `.pre-commit-config.yaml.disable`, so no hook runs: no formatting, credential
  scanning, TFLint or docs generation. Run the checks by hand and do not assume
  CI catches them.
- **`modules/state-store` owns three DynamoDB tables, not one** — accounts,
  network and an events dedup table — each exposing a name, an ARN and, for two
  of them, a stream ARN. The stream ARNs are consumed downstream: disabling or
  re-creating a stream silently breaks whatever reads it. Changing a table's key
  schema replaces the table and loses the vending state it holds.
- The orchestrator Lambda is fed by SQS through
  `aws_lambda_event_source_mapping`. Changing batch or concurrency settings
  changes vending throughput and failure behaviour, not just configuration.
- The publisher Lambda is invoked cross-account by the account-creator flow via
  `aws_lambda_permission`. Narrowing that permission breaks vending from
  `/repos/aws-lz-account-creator.md` silently.
- A GitLab token is read from an SSM parameter (`gitlab_token_ssm_param`). It is
  a credential path, not a credential; never resolve or echo its value.
- `config/routing-rules.yaml` is read with `yamldecode`. Rules are ordered and
  matched — inserting a rule changes which branch later events take.
- Uses DynamoDB state locking, with the backend and provider both assuming the
  same fixed deployment role.
- Four local modules, none with a README.

# Fields

`config/routing-rules.yaml`: `rules[].{name, description, when, action,
target}`.

Root inputs: `environment` · `region` · `org_id` · `alert_emails` ·
`gitlab_token_ssm_param`.

Root outputs: `state_store` · `orchestrator` · `publisher` · `alerting` —
grouped objects, not flat values.

# Plan

Routing-rule edit: `1 in place` on the Lambda configuration or environment that
consumes it. Lambda code change: `1 in place` plus a new version. Alert
recipient add: `1 to add`. Any DynamoDB key-schema change: expect a replace and
stop.

# Stop

- A plan proposes replacing any of the three DynamoDB state-store tables, or
  changing a stream configuration.
- A change would narrow the publisher's `aws_lambda_permission`.
- A routing-rule insertion changes match order without a stated effect on
  existing flows.
- Pre-commit is being re-enabled as a side effect of an unrelated change.
