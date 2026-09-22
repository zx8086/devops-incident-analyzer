---
type: Module
title: security-tools/guardduty-central
description: GuardDuty for the organisation — detector, features, IP and threat-intel sets and a findings bucket. Present in the repo but not currently called.
resource: aws-lz-security-tools/modules/guardduty-central
change_class: gitops-hcl
tags: [aws-lz, guardduty, security, disabled]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-security-tools/modules/guardduty-central
    title: Module source as checked out
  - id: parent
    resource: aws-lz-security-tools
    title: Consuming root — see /repos/aws-lz-security-tools.md
---

# When this applies

A GuardDuty change is requested. Read this before assuming the module is live.

# Surface

**Edit:** `aws-lz-security-tools/modules/guardduty-central/` — `_data.tf`, `_outputs.tf`, `_variables.tf`, `_versions.tf`, `main.tf`.

Called from **nothing — the module block in the security-tools root `main.tf` is commented out**. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-security-tools.md](/repos/aws-lz-security-tools.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **This module is not called.** GuardDuty is not managed by `aws-lz-security-tools` today. A GuardDuty change is therefore either an activation or belongs to another owner; it is not an edit.
- Its `prevent_destroy` lifecycle blocks are themselves commented out inside the module, which is consistent with a module that has never been applied from here.
- Activating it would create a detector, organisation configuration, admin-account registration, KMS key and a findings bucket in one go — a full add set needing a platform decision, not an incremental change.
- If GuardDuty is already enabled in the account by another mechanism, activating this module will conflict with the existing detector rather than adopt it. Import, do not create.

# Fields

Inputs: `additional_tags` · `application_name` · `environment` · `features` · `finding_publishing_frequency` · `ip_allow_lists` · `region` · `security_account_id` · `tags` · `threat_intel_sets`

Outputs: `detector_arn` · `detector_id` · `findings_s3_bucket_arn` · `organization_admin_enabled`

# Plan

None today. If activated: a full add set, plus a likely conflict with any detector already enabled out of band.

# Stop

- Always, unless the task is an explicit, approved activation with a stated import plan for any existing detector.
