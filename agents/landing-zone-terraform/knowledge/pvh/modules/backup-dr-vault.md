---
type: Module
title: backup/dr-vault
description: A logically air-gapped AWS Backup vault for DR copies, with a retention range and an access policy.
resource: aws-lz-backup/modules/dr-vault
change_class: gitops-hcl
tags: [aws-lz, backup, dr, air-gapped]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-backup/modules/dr-vault
    title: Module source as checked out
  - id: parent
    resource: aws-lz-backup
    title: Consuming root — see /repos/aws-lz-backup.md
---

# When this applies

A DR vault is added for a region, its retention range changes, or its access policy changes.

# Surface

**Edit:** `aws-lz-backup/modules/dr-vault/` — `_data.tf`, `_outputs.tf`, `_variables.tf`, `_versions.tf`, `vault.tf`.

Called from `_modules.tf` in the backup root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-backup.md](/repos/aws-lz-backup.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **`min_retention_days` / `max_retention_days` define the allowed range only.** Per-recovery-point retention is set by the source backup plans' `copy_action.lifecycle.delete_after`, and the module says so in its own file comments. A retention-shortening request is almost always a change to the source plan, not to this vault.
- Air-gapped vaults are designed to resist deletion. Do not plan a destroy as a way to change an immutable attribute — verify against the provider whether the attribute forces replacement first.
- The vault holds copies, not primaries. Losing it does not lose production data, but it does lose the DR position.

# Fields

Inputs: `additional_tags` · `application_name` · `central_admin_principal_arns` · `environment` · `organization_id` · `region` · `tags`

Outputs: `dr_vault_arn` · `dr_vault_name` · `region`

# Plan

New region: `1 to add` plus its policy. Retention-range change: verify replacement behaviour before stating a shape.

# Stop

- The plan proposes destroying or replacing an air-gapped vault.
- A retention cut is requested and the correct owner is the source backup plan.
