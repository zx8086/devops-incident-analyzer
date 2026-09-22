---
type: Stack
title: gitlab-k8s-runners-terraform
description: The legacy v1 GitLab runner estate — 58 flat root files, one per runner group, pinned to AWS provider 4.x and superseded by gitlab-k8s-runners-lzv2.
resource: gitlab-k8s-runners-terraform
archetype: k8s-platform-root
change_class: gitops-hcl
tags: [gitlab-runners, kubernetes, helm, legacy, platform]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: versions
    resource: gitlab-k8s-runners-terraform/_versions.tf
    title: Exact Terraform and AWS provider pins
---

# When this applies

A runner group in the legacy estate changes, or a team is being migrated from
here to [/repos/gitlab-k8s-runners-lzv2.md](/repos/gitlab-k8s-runners-lzv2.md).

Read this concept before assuming a runner change belongs here: the v2 platform
is the successor, and new runners belong there.

# Surface

**Edit:** the per-group root files — one `.tf` per runner group
(`abi-runners.tf`, `b2b-runners.tf`, `b2c-ecom-runners.tf`, `docker-runners.tf`,
`ds-runners.tf`, `account-vending.tf`, `controltower.tf`, `backup.tf`,
`edp.tf`, and so on), plus `_local.tf` and `_variables.tf`.

**Never edit:** `_versions.tf`, `.terraform.lock.hcl`.

There is no `modules/` directory: every group is a call to the shared
`k8s-gitlab-runner` module.

# Traps

- **The AWS provider is pinned to an exact 4.x version and Terraform to an exact
  1.10.x patch.** [^versions] The entire rest of the estate is on AWS provider
  6.x. Nothing about provider-6 behaviour — Enhanced Region Support, v6 resource
  arguments, v6 attribute names — applies here. Do not port a snippet from an
  `aws-lz-*` repo into this repo, and do not "align" the provider: that is a
  major-version migration across 58 root files.
- **It uses different shared CI templates again** — the GitLab merge-request and
  tag scripts, not either Terraform template `AGENTS.md` names. [^agents-md]
  Its workspace name follows neither estate scheme.
- **One file is pinned to a newer runner-module tag than the other 57.** Of the
  116 `k8s-gitlab-runner` module calls in this repo, 115 sit on one tag and a
  single file sits one patch ahead. That is either a deliberate exception or an
  abandoned upgrade — establish which before you either copy it or align it.
  Copying a `module` block between files also copies its `ref`; check the block
  you copy.
- 58 flat root files in a single state. A change to one group plans the whole
  state; an unrelated drift elsewhere appears in your plan and is not yours.
  Read the plan for your group's addresses only, and say so in the MR.
- The backend declares no `assume_role`; state access depends on the CI
  identity.
- Because this is the legacy estate, **the right answer to many requests here is
  a migration to v2, not a change**. Establish which platform the team is meant
  to be on before editing.
- The Kubernetes and Helm resources here are live CI capacity. Destroying a
  runner stops that team's pipelines immediately.

# Fields

Root inputs: `aws_account_id` · `aws_account_ids` · `ecr_name` · `ecr_url` ·
`ecr_tag_tf` · `eks_version` · `eks_image_regex` · `kubelet_extra_args` ·
`elastic_fleet_url`. No root outputs.

Per-group configuration is inline module arguments in each group's `.tf` file.

# Plan

Runner-group edit: `1 in place` on a Helm release, within a plan that covers all
58 files. New group: a full add set. Removing a group: destroys that team's CI
capacity.

# Stop

- A plan proposes destroying a runner group that a team is still using.
- The provider or Terraform version would be changed.
- The request is for a *new* runner — that belongs in
  [/repos/gitlab-k8s-runners-lzv2.md](/repos/gitlab-k8s-runners-lzv2.md), not
  here.
- A snippet is being ported in from a provider-6 repository.
