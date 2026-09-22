---
type: Module
title: storage/fsxn-secret
description: A Secrets Manager secret for FSxN credentials, seeded once; rotation is owned out of band.
resource: aws-lz-storage/modules/fsxn-secret
change_class: gitops-hcl
tags: [aws-lz, fsxn, secretsmanager]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-storage/modules/fsxn-secret
    title: Module source as checked out
  - id: parent
    resource: aws-lz-storage
    title: Consuming root — see /repos/aws-lz-storage.md
---

# When this applies

An FSxN credential secret is created, or its metadata changes.

# Surface

**Edit:** `aws-lz-storage/modules/fsxn-secret/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `_modules.tf` / `main.tf` in the storage root, iterated over the `config/` tree. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-storage.md](/repos/aws-lz-storage.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **`secret_string` is under `ignore_changes`, deliberately** — the module comments state that rotation is owned out of band and Terraform must not re-seed.
- A `secret_string` diff in a plan means the `random_password` regenerated. Stop rather than apply.
- This module and `fsxn-ad-secret` are near-identical in shape but serve different credentials. Check the caller before editing either.
- Never surface the secret value anywhere outside Secrets Manager.

# Fields

Inputs: `kms_key_id` · `name` · `password_length` · `recovery_window_in_days` · `region` · `tags`

Outputs: `arn` · `name`

# Plan

New secret: `1 to add` plus one version. Metadata edit: `1 in place`. A `secret_string` diff: stop.

# Stop

- The plan proposes changing `secret_string`.
- It is unclear whether this module or `fsxn-ad-secret` owns the target secret.
