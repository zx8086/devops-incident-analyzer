---
type: Module
title: backup/central-vault
description: A standard AWS Backup vault plus its access policy, created once per region in the backup account.
resource: aws-lz-backup/modules/central-vault
change_class: gitops-hcl
tags: [aws-lz, backup, vault]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-backup/modules/central-vault
    title: Module source as checked out
  - id: parent
    resource: aws-lz-backup
    title: Consuming root — see /repos/aws-lz-backup.md
---

# When this applies

A central backup vault is added for a region, or its access policy changes.

# Surface

**Edit:** `aws-lz-backup/modules/central-vault/` — `_data.tf`, `_outputs.tf`, `_variables.tf`, `_versions.tf`, `vault.tf`.

Called from `_modules.tf` in the backup root, iterated over `var.regions`. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-backup.md](/repos/aws-lz-backup.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- A backup vault cannot be deleted while it holds recovery points. A plan showing a destroy will fail at apply rather than silently delete — but the failed apply leaves the run half-done.
- The vault access policy governs which principals may copy into the vault. Narrowing it can silently stop cross-account copy jobs; the failure appears in Backup job history, not in Terraform.
- Removing a region from `var.regions` in the root removes this vault. Check for recovery points first.

# Fields

Inputs: `additional_tags` · `application_name` · `central_admin_principal_arns` · `environment` · `kms_key_arn` · `region` · `tags`

Outputs: `central_vault_arn` · `central_vault_name` · `region`

# Plan

New region: `1 to add` for the vault plus `1 to add` for its policy. Policy edit: `1 in place`.

# Stop

- The plan proposes destroying a vault.
- A policy change would narrow copy access without confirming which source plans depend on it.
