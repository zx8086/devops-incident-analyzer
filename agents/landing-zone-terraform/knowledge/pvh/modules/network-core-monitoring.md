---
type: Module
title: network-core/monitoring
description: CloudWatch dashboards, metric alarms and an SNS topic with subscriptions for network monitoring; wired for the non-production test path.
resource: aws-lz-network-core/modules/monitoring
change_class: gitops-hcl
tags: [aws-lz, cloudwatch, alarms, sns, networking]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-network-core/modules/monitoring
    title: Module source as checked out
  - id: parent
    resource: aws-lz-network-core
    title: Consuming root — see /repos/aws-lz-network-core.md
---

# When this applies

A network dashboard, alarm threshold, or alert recipient changes.

# Surface

**Edit:** `aws-lz-network-core/modules/monitoring/` — `data.tf`, `locals.tf`, `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `monitoring.tf` in the network-core root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-network-core.md](/repos/aws-lz-network-core.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- The root's module block for this is named for the non-production test path. Confirm which environment it actually runs in before changing thresholds.
- An alarm is the detection, not the protection. Loosening a threshold to stop noise removes the signal.
- Email subscriptions are created pending confirmation; `1 to add` does not mean alerts are delivered.
- Dashboard bodies are JSON strings. A malformed edit fails at apply, not at plan.
- This module shares its directory name with no other, but its concept name is prefixed to stay unique in this bundle.

# Fields

Inputs: `alert_emails` · `cloudtrail_write_rule_exclude_principal_arns` · `cloudtrail_write_rule_state` · `cp_asg_name` · `cp_load_balancer` · `cp_target_group` · `custom_tags` · `dx_connections` · `mandatory_tags` · `region`

Outputs: `sns_topic_arn`

# Plan

Threshold or dashboard edit: `1 in place`. Recipient add: `1 to add`, pending confirmation.

# Stop

- An alarm would be removed rather than re-scoped.
- The target environment for this module cannot be confirmed.
