---
type: Module
title: vending-orchestrator/alerting
description: SNS topic and email subscriptions for vending alerts.
resource: aws-lz-vending-orchestrator/modules/alerting
change_class: gitops-hcl
tags: [aws-lz, sns, alerting, vending]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-vending-orchestrator/modules/alerting
    title: Module source as checked out
  - id: parent
    resource: aws-lz-vending-orchestrator
    title: Consuming root — see /repos/aws-lz-vending-orchestrator.md
---

# When this applies

A vending alert recipient changes.

# Surface

**Edit:** `aws-lz-vending-orchestrator/modules/alerting/` — `_data.tf`, `_locals.tf`, `_outputs.tf`, `_variables.tf`, `_versions.tf`, `sns.tf`.

Called from `main.tf` in the vending-orchestrator root, driven by the root's `alert_emails` input. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-vending-orchestrator.md](/repos/aws-lz-vending-orchestrator.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- Email subscriptions are created pending confirmation. `1 to add` does not mean alerts are being delivered.
- Removing an address from `alert_emails` deletes the subscription immediately on apply.
- This topic is separate from the security alerting topic in [/repos/aws-lz-security-tools.md](/repos/aws-lz-security-tools.md). Do not consolidate them without a decision — they have different audiences.

# Fields

Inputs: `alert_emails` · `custom_tags` · `mandatory_tags` · `region`

Outputs: `topic_arn`

# Plan

Recipient add or remove: `1 to add` or `1 to destroy` on the subscription.

# Stop

- A plan proposes destroying the topic itself.
- Consolidation with another alerting topic is being attempted as a tidy-up.
