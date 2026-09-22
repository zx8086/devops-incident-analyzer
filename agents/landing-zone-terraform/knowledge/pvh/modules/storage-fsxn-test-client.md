---
type: Module
title: storage/fsxn-test-client
description: An optional EC2 client for validating FSxN mounts, with its instance profile, role and security group.
resource: aws-lz-storage/modules/fsxn-test-client
change_class: gitops-hcl
tags: [aws-lz, fsxn, ec2, testing]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-storage/modules/fsxn-test-client
    title: Module source as checked out
  - id: parent
    resource: aws-lz-storage
    title: Consuming root — see /repos/aws-lz-storage.md
---

# When this applies

The FSxN test client is enabled, disabled, resized or re-imaged.

# Surface

**Edit:** `aws-lz-storage/modules/fsxn-test-client/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `_modules.tf` in the storage root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-storage.md](/repos/aws-lz-storage.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **This is a diagnostic aid, not part of the storage service.** Leaving it enabled is a running cost and an extra attack surface in the storage account; that is a decision, not a default.
- `ami` is under `ignore_changes`, so the instance does not silently replace when the source image moves. Removing that would replace a live client on the next AMI refresh.
- Disabling the client destroys the instance. Anything left on its local disk is lost.
- Its security group egress is what lets it reach the FSxN endpoints; narrowing it makes the client useless without an obvious error.

# Fields

Inputs: `iam_role_name` · `instance_name` · `instance_profile_name` · `instance_type` · `region` · `sg_name` · `subnet_id` · `tags` · `vpc_id`

Outputs: `instance_id`

# Plan

Enable: a full add set. Disable: `N to destroy`. Sizing change: verify whether the attribute forces replacement.

# Stop

- The client is being left enabled in production without a stated reason.
- The `ignore_changes` on `ami` would be removed.
