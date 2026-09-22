---
type: Module
title: security-tools/alerts-central
description: "The security alerting fan-out: an SNS topic, its policy and the subscriptions that carry security findings to their recipients."
resource: aws-lz-security-tools/modules/alerts-central
change_class: gitops-hcl
tags: [aws-lz, sns, alerting, security]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-security-tools/modules/alerts-central
    title: Module source as checked out
  - id: parent
    resource: aws-lz-security-tools
    title: Consuming root — see /repos/aws-lz-security-tools.md
---

# When this applies

A security alert recipient or the topic policy changes.

# Surface

**Edit:** `aws-lz-security-tools/modules/alerts-central/` — `_data.tf`, `_outputs.tf`, `_variables.tf`, `_versions.tf`, `main.tf`.

Called from `main.tf` in the security-tools root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-security-tools.md](/repos/aws-lz-security-tools.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- Removing a subscription stops delivery immediately on apply. There is no grace period and no queue.
- Email subscriptions require confirmation by the recipient. Terraform creates them as pending; a plan that says `1 to add` does not mean alerts are flowing.
- The topic policy governs which services may publish. Narrowing it silently stops findings from a service that was publishing before.
- The topic ARN is a root output consumed elsewhere; renaming the topic changes the ARN and breaks those consumers.

# Fields

Inputs: `additional_tags` · `application_name` · `environment` · `notification_emails` · `org_id` · `region` · `tags`

Outputs: `topic_arn` · `topic_name`

# Plan

Recipient add: `1 to add`, pending confirmation. Policy edit: `1 in place`. Topic rename: destroy plus add — breaks consumers.

# Stop

- A plan proposes destroying or renaming the topic.
- A subscription would be removed without confirming the recipient no longer needs alerts.
- A policy change would narrow which services may publish.
