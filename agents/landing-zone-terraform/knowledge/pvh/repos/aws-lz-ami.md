---
type: Stack
title: aws-lz-ami
description: EC2 Image Builder golden-AMI factory for Windows 2022/2025, AL2023 and SQL Server, with multi-region distribution, per-region KMS keys and SSM AMI pointers.
resource: aws-lz-ami
archetype: flat-hcl-root
change_class: gitops-hcl
tags: [aws-lz, imagebuilder, ami, kms, ssm]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: repo
    resource: aws-lz-ami
    title: Repository contents as checked out
---

# When this applies

A golden image recipe, component, distribution target or retention rule
changes; a new OS pipeline is added; or an agent installer in the installers
bucket is updated.

# Surface

**Edit:** `imagebuilder_*.tf` (one file per OS pipeline plus `_infra` and
`_shared_linux`), `image_config/**/*.yaml` (the Image Builder component
documents), `component_versions.json`, `lambda/` and `lambda_ami_tagging.tf`,
`s3_installers.tf`, `ssm_ami_latest.tf`.

**Never edit:** `_backend.tf`.

# Traps

- **Component and recipe versions are driven by `component_versions.json`, not
  by the HCL.** Image Builder components and recipes are immutable once
  published: changing a component body without bumping its version in that JSON
  produces an apply error, not a new version. Bump the version in the JSON in
  the same change.
- The root reads that file with `jsondecode`. A malformed edit fails at plan,
  not at apply — that is the cheap failure, and it is the only one this repo
  gives you for free.
- **Distribution is cross-account and asymmetric.** `distribution_accounts`
  grants launch permission; the SQL Server CEV path additionally copies an
  *owned* AMI into consumer accounts, and a consumer account must already hold
  the Image Builder distribution cross-account role. Adding a consumer without
  that role fails at apply.
- The SQL Server consumer input is a **map of account to regions**, not a list
  of accounts. The repo's generated README section still documents the earlier
  list-shaped variable under its old name; `_variables.tf` and
  `imagebuilder_sqlserver.tf` are authoritative.
- A validation block rejects a consumer region that is not also in
  `distribution_regions`. Add the region to both or the plan fails.
- Cross-region KMS: one key per distribution region. Adding a region adds a key
  and its alias — irreversible PVH-owned resources under `AGENTS.md`. [^agents-md]
- This repo pins the AWS provider with `>=`, and Image Builder resources move
  fast between provider minors. A plan showing unexpected diffs on
  `aws_imagebuilder_*` after a provider refresh is a provider-version effect,
  not drift.
- `.terraform.lock.hcl` is **not tracked here**. Do not add one incidentally.

# Fields

Root inputs: `account_id` · `region` · `distribution_accounts` ·
`distribution_regions` · `sqlserver_cev_consumers` · `s3_logs_suffix`.
Root outputs: `installers_bucket_name` · `logs_bucket_name`.

Component YAML lives under `image_config/shared-components/` and the per-OS
directories; the recipe references it by name and version.

# Plan

Component body edit with a version bump: `1 to add` (new component version)
plus `1 to change` on each recipe that references it. Adding a distribution
region: adds a KMS key, alias and distribution entry per pipeline. Retention or
lifecycle edit on the buckets: `1 in place`.

# Stop

- A plan proposes destroying an `aws_kms_key` or `aws_kms_alias`.
- A component change carries no matching version bump in
  `component_versions.json`.
- A new CEV consumer account is requested without confirmation that the
  distribution cross-account role exists there.
- The change requires a Windows Update component — blocked on firewall egress,
  not on Terraform.
