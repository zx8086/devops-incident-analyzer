---
type: Module
title: storage/fsxn-svm
description: One ONTAP storage virtual machine per SVM file under a cluster directory.
resource: aws-lz-storage/modules/fsxn-svm
change_class: gitops-hcl
tags: [aws-lz, fsxn, ontap, svm, active-directory]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-storage/modules/fsxn-svm
    title: Module source as checked out
  - id: parent
    resource: aws-lz-storage
    title: Consuming root — see /repos/aws-lz-storage.md
---

# When this applies

An SVM is added, or its Active Directory configuration changes.

# Surface

**Edit:** `aws-lz-storage/modules/fsxn-svm/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `_modules.tf` / `main.tf` in the storage root, iterated over the `config/` tree. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-storage.md](/repos/aws-lz-storage.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **The SVM password is deliberately NOT under `ignore_changes`, and the module says so in a comment.** FSxN requires the full AD configuration — password included — to be resent whenever any AD field changes; ignoring it stripped the password and broke the update. Do not 'fix' this by adding it to `ignore_changes`.
- An SVM cannot be deleted while it holds volumes. A destroy plan will fail at apply and leave the run half-done.
- Joining an SVM to AD is not idempotent in the way Terraform assumes: a partial failure can leave the SVM created but unjoined.
- SVM identity is the file name under `svms/`. Renaming the file destroys and recreates the SVM.

# Fields

Inputs: `ad` · `file_system_id` · `name` · `ontap_name_prefix` · `region` · `root_volume_security_style` · `tags`

Outputs: `arn` · `endpoints` · `id` · `name` · `uuid`

# Plan

New SVM: `1 to add`. AD field change: `1 in place`, resending the whole AD block. SVM removal: destroy — blocked while volumes exist.

# Stop

- Any plan proposing to destroy an SVM.
- A change would add the password to `ignore_changes`.
- An AD field change is requested without the credential available to resend.
