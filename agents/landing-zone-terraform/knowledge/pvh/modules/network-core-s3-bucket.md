---
type: Module
title: network-core/s3-bucket
description: A local S3 bucket module with versioning, encryption, public-access block and lifecycle configuration, used for CloudWAN-related storage.
resource: aws-lz-network-core/modules/s3_bucket
change_class: gitops-hcl
tags: [aws-lz, s3, networking]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-network-core/modules/s3_bucket
    title: Module source as checked out
  - id: parent
    resource: aws-lz-network-core
    title: Consuming root — see /repos/aws-lz-network-core.md
---

# When this applies

A network-core bucket's lifecycle, encryption or access configuration changes.

# Surface

**Edit:** `aws-lz-network-core/modules/s3_bucket/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `cloudwan_core.tf` in the network-core root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-network-core.md](/repos/aws-lz-network-core.md).


# Traps

- This is a local re-implementation of bucket hardening rather than the shared `aws-s3` module used elsewhere in the estate. Consolidating it is a migration, not a tidy-up.
- The public-access block is the guardrail. `AGENTS.md` forbids creating public S3 access without a documented approved exception.
- A lifecycle rule change can begin expiring objects on the next evaluation, hours after the apply.
- Bucket names are global. A rename is a destroy-and-recreate that loses the contents.

# Fields

Inputs: `application_name` · `bucket_name` · `custom_tags` · `description` · `enable_versioning` · `environment` · `kms_key_id` · `lifecycle_rules` · `mandatory_tags` · `purpose` · `region`

Outputs: `bucket_arn` · `bucket_domain_name` · `bucket_id` · `bucket_regional_domain_name`

# Plan

Lifecycle or encryption edit: `1 in place`. New bucket: a full add set. Rename: destroy plus add.

# Stop

- A plan proposes destroying a bucket or removing the public-access block.
- A lifecycle change would shorten retention on data with an owner who has not signed off.
