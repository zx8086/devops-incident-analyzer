---
type: Module
title: backup/veeam-s3-bucket
description: An object-locked, versioned S3 bucket for Veeam backups, with a dedicated IAM user whose access key is written to SSM.
resource: aws-lz-backup/modules/veeam_s3_bucket
change_class: gitops-hcl
tags: [aws-lz, backup, s3, object-lock, veeam, iam]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-backup/modules/veeam_s3_bucket
    title: Module source as checked out
  - id: parent
    resource: aws-lz-backup
    title: Consuming root — see /repos/aws-lz-backup.md
---

# When this applies

A Veeam backup target is added for a region, object-lock retention changes, or the Veeam credential is rotated.

# Surface

**Edit:** `aws-lz-backup/modules/veeam_s3_bucket/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `_modules.tf` in the backup root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-backup.md](/repos/aws-lz-backup.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **Object lock cannot be turned off once versioning plus lock are established.** A plan that appears to update `aws_s3_bucket_object_lock_configuration` may be attempting something AWS will reject at apply.
- The bucket carries `prevent_destroy`.
- **`aws_iam_access_key` is a long-lived static credential by design** — Veeam is an appliance that cannot assume a role. The key and secret are written to SSM parameters. Never surface either value in an MR description, a log, or a plan output.
- Rotating the key through Terraform invalidates the Veeam configuration at the same instant the new key is created. Rotation needs a Veeam-side cutover plan.
- Access logging is conditional on the root's `access_logging` input; enabling it adds a target bucket dependency.

# Fields

Inputs: `access_logging` · `bucket_name` · `iam_policy_name` · `kms_key_arn` · `object_lock_default_retention` · `region` · `ssm_prefix` · `tags` · `veeam_user_name`

Outputs: `bucket_arn` · `bucket_name` · `iam_user_name` · `ssm_access_key_id_parameter` · `ssm_secret_access_key_parameter`

# Plan

New region: a full bucket set plus the IAM user, policy, key and two SSM parameters. Retention edit: `1 in place`.

# Stop

- The plan proposes destroying the bucket or removing object lock or versioning.
- A key rotation is requested without a stated Veeam cutover.
- Credential values would appear anywhere outside SSM.
