---
type: Module
title: account-creator/account-mgn
description: A wiring shim for Application Migration Service onboarding — declares inputs and an output but creates no AWS resources.
resource: aws-lz-account-creator/modules/account-mgn
change_class: gitops-hcl
tags: [aws-lz, mgn, migration, shim]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-account-creator/modules/account-mgn
    title: Module source as checked out
  - id: parent
    resource: aws-lz-account-creator
    title: Consuming root — see /repos/aws-lz-account-creator.md
---

# When this applies

MGN onboarding wiring for a vended account changes.

# Surface

**Edit:** `aws-lz-account-creator/modules/account-mgn/` — `_backend.tf`, `_data.tf`, `_outputs.tf`, `_providers.tf`, `_variables.tf`, `mgn-roles.tf`.

Called from the generated per-account root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-account-creator.md](/repos/aws-lz-account-creator.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **This module creates no resources.** It declares variables and one output only. A plan will never show anything from it, and adding resources here changes it from a shim into a provisioner — a design change, not an edit.
- Because it produces no resources, an apparent 'no-op' plan is the correct result, not evidence that the change failed.

# Fields

Inputs: `aws_assume_role_arn` · `custom_tags` · `enable_rehost_mgn` · `factory_aws_account_id` · `permissions_boundary` · `tags`

Outputs: `cmf_roles`

# Plan

No plan impact from this module alone.

# Stop

- A task expects this module to create MGN resources — confirm the design intent first.
