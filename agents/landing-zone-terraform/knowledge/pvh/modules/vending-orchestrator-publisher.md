---
type: Module
title: vending-orchestrator/publisher
description: The publisher Lambda that emits vending results, with its IAM role, log group and the cross-account invoke permission.
resource: aws-lz-vending-orchestrator/modules/publisher
change_class: gitops-hcl
tags: [aws-lz, lambda, vending, cross-account]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-vending-orchestrator/modules/publisher
    title: Module source as checked out
  - id: parent
    resource: aws-lz-vending-orchestrator
    title: Consuming root — see /repos/aws-lz-vending-orchestrator.md
---

# When this applies

Publisher behaviour, its permissions, or the cross-account invoke grant changes.

# Surface

**Edit:** `aws-lz-vending-orchestrator/modules/publisher/` — `_data.tf`, `_locals.tf`, `_outputs.tf`, `_variables.tf`, `_versions.tf`, `iam.tf`, `lambda.tf`.

Called from `main.tf` in the vending-orchestrator root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-vending-orchestrator.md](/repos/aws-lz-vending-orchestrator.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **`aws_lambda_permission` is what lets the account-creator flow invoke this function across accounts.** Narrowing or removing it breaks vending from [/repos/aws-lz-account-creator.md](/repos/aws-lz-account-creator.md) with no error in this repo.
- The principal in that permission must match the caller's actual role. A mismatch produces an access-denied at invoke time, not at apply.
- The publisher writes vending results; a failure here leaves accounts created but unreported, which looks like a vending failure but is not.
- Log-group retention affects the only record of what was published.

# Fields

Inputs: `accounts_table_arn` · `accounts_table_name` · `custom_tags` · `log_retention_days` · `mandatory_tags` · `network_table_arn` · `network_table_name` · `org_id` · `region`

Outputs: `execution_role_arn` · `function_arn` · `function_name`

# Plan

Code change: `1 in place` plus a new version. Permission change: `1 in place` with cross-account impact.

# Stop

- The invoke permission would be narrowed or removed.
- The caller principal cannot be confirmed against the account-creator flow.
