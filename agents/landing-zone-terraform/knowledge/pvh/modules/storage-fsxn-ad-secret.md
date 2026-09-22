---
type: Module
title: storage/fsxn-ad-secret
description: A Secrets Manager secret holding the AD join credential for FSxN, seeded once with a generated password.
resource: aws-lz-storage/modules/fsxn-ad-secret
change_class: gitops-hcl
tags: [aws-lz, fsxn, secretsmanager, active-directory]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-storage/modules/fsxn-ad-secret
    title: Module source as checked out
  - id: parent
    resource: aws-lz-storage
    title: Consuming root — see /repos/aws-lz-storage.md
---

# When this applies

The AD join secret for FSxN is created, or its metadata changes.

# Surface

**Edit:** `aws-lz-storage/modules/fsxn-ad-secret/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `_modules.tf` / `main.tf` in the storage root, iterated over the `config/` tree. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-storage.md](/repos/aws-lz-storage.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **`secret_string` is under `ignore_changes`, deliberately** — the module comments say the value must not be re-seeded on subsequent applies. The real credential is set out of band after creation.
- A plan proposing to change `secret_string` means something regenerated the `random_password`. Do not apply it: you overwrite the working credential.
- This module and `fsxn-secret` both create a Secrets Manager secret with a generated password. Establish which one owns the secret you are changing before editing either.
- The secret ARN is consumed by other repos — [/repos/aws-lz-dfs.md](/repos/aws-lz-dfs.md) reads AD join secrets by ARN. Recreating the secret changes the ARN.
- Never surface the secret value in an MR description, a log, or a plan output.

# Fields

Inputs: `kms_key_id` · `name` · `password_length` · `recovery_window_in_days` · `region` · `tags` · `username`

Outputs: `arn` · `name`

# Plan

New secret: `1 to add` plus one version. Metadata edit: `1 in place`. A `secret_string` diff: stop.

# Stop

- The plan proposes changing `secret_string`.
- The secret would be recreated, changing an ARN other repos hold.
- It is unclear whether this module or `fsxn-secret` owns the target secret.
