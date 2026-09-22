---
type: Stack
title: aws-lz-backup
description: Central and logically air-gapped DR backup vaults plus Veeam S3 targets with object lock, deployed per region from local modules.
resource: aws-lz-backup
archetype: flat-hcl-root
change_class: gitops-hcl
tags: [aws-lz, backup, s3, object-lock, veeam]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: repo
    resource: aws-lz-backup
    title: Repository contents as checked out
  - id: dr-vault-src
    resource: aws-lz-backup/modules/dr-vault/vault.tf
    title: DR vault module — retention model documented in file comments
---

# When this applies

A backup vault, vault access policy, DR vault or Veeam bucket changes; a region
is added to the backup footprint; retention or object-lock settings change.

# Surface

**Edit:** `_modules.tf` (the three module calls), `_locals.tf`, `_variables.tf`,
`main.tf`, and `modules/central-vault/`, `modules/dr-vault/`,
`modules/veeam_s3_bucket/`.

**Never edit:** `_backend.tf`, `.terraform.lock.hcl`.

# Traps

- **A retention request usually does not belong in this repo.** The air-gapped
  vault's `min_retention_days` / `max_retention_days` define the *allowed range*
  only; per-recovery-point retention is set by the source backup plans'
  `copy_action.lifecycle.delete_after`. The module says so in its own file
  comments. [^dr-vault-src] Changing the vault range to shorten retention is
  the wrong lever and risks a replace on a vault that holds recovery points.
- Object lock on the Veeam buckets (`aws_s3_bucket_object_lock_configuration`)
  cannot be removed once versioning plus lock are established. Treat any plan
  touching it as destructive even when Terraform reports it as an update.
- `modules/veeam_s3_bucket` creates an **IAM user and access key** and writes
  the credentials to SSM parameters. That is a long-lived credential by design.
  Do not "improve" it into a role without a platform decision, and never surface
  the key material in an MR description or a log.
- This repo uses **DynamoDB state locking** and its backend declares **no
  `assume_role`**, unlike the S3-lockfile repos. Locking mechanism is an
  unresolved platform decision; preserve what is there. [^agents-md]
- Its `required_version` is an upper-bounded range, not the `~> 1.11` default
  in `AGENTS.md`. Preserve it.
- Two different pinned versions of the shared naming module appear across the
  root and the local modules. Aligning them is a deliberate change with a plan
  impact, not a tidy-up.
- The root README is an **empty file**. There is no prose to fall back on; this
  concept and the code are the only sources.

# Fields

Root inputs: `account_id` · `environment` · `application_name` · `regions` ·
`organization_id` · `central_admin_principal_arns` · `bucket_name` ·
`access_logging` · `object_lock_default_retention` · `veeam_user_name` ·
`ssm_prefix` · `mandatory_tags` · `custom_tags`.

Root outputs: `central_vaults` · `dr_vaults` · `veeam_bucket_names` ·
`veeam_bucket_arns` · `veeam_ssm_access_key_id_parameters` ·
`veeam_ssm_secret_access_key_parameters`.

# Plan

Adding a region to `regions`: adds a central vault, a DR vault and a Veeam
bucket set for that region. Vault policy edit: `1 in place`. A change to the
air-gapped vault's retention range: verify against the provider whether the
attribute forces replacement before opening the MR.

# Stop

- Any plan showing destroy or replace on a backup vault, an air-gapped vault, or
  an object-locked bucket.
- A change that would remove or weaken object lock or bucket versioning.
- A request to rotate or regenerate the Veeam access key through Terraform
  without a stated cutover plan for the consumer.
- A retention cut is requested and the correct owner is a source backup plan
  rather than the vault range.
