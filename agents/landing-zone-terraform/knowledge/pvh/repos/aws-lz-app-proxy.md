---
type: Stack
title: aws-lz-app-proxy
description: Entra Application Proxy connector hosts — a thin root that instantiates the shared EC2 module once per region from a locals map.
resource: aws-lz-app-proxy
archetype: flat-hcl-root
change_class: gitops-hcl
tags: [aws-lz, ec2, entra, app-proxy]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: repo
    resource: aws-lz-app-proxy
    title: Repository contents as checked out
---

# When this applies

A connector host is added or removed, a region is brought into scope, instance
sizing changes, or the host prerequisite script changes.

# Surface

**Edit:** `_locals.tf` (the region map that drives everything),
`app_proxy.tf` (the single module call), `templates/connector_prereqs.ps1`.

**Never edit:** `_backend.tf`, `_versions.tf`.

# Traps

- **The root declares no variables and no outputs.** Everything is a `local`.
  An agent looking for a `.tfvars` surface will not find one; region, VPC,
  subnet and sizing all live in `_locals.tf`.
- All resources come from one shared EC2 module call. The repo owns no
  `resource` blocks of its own, so a plan naming `module.ec2_app_proxy.*` is the
  normal shape, and the module's own contract governs what is changeable in
  place versus what forces replacement.
- The region map in `_locals.tf` and the VPC/subnet map are separate. A region
  present in the abbreviation map but absent from the VPC map produces no
  instances there — that is the current state for one approved region, and it is
  intentional, not a bug.
- **`_locals.tf` hard-codes VPC and subnet IDs per region** rather than
  discovering them from data sources or taking them as typed inputs.
  `AGENTS.md` prefers verified platform constants or typed inputs. [^agents-md]
  Treat this as observed and preserved: never copy an id between regions, and
  never infer one — read it from the target VPC.
- Connector agent install and tenant registration are **not** Terraform. They
  need an interactive administrator credential. A request to "deploy the
  connector" that means registration is out of scope for this root.
- Domain join is not configured here.
- Uses the singular-env CI template and S3 native locking with an explicit
  backend `assume_role`; the account and environment come from `TF_VAR_*` in
  `.gitlab-ci.yml`.

# Fields

No root variables or outputs. The locals are: a region-to-abbreviation map and
a per-region object carrying VPC id, subnet ids and instance settings. Module
inputs are the shared EC2 module's contract, not this repo's.

# Plan

Adding a region to the VPC map: `N to add` for that region's instances and
supporting resources. Sizing change: usually `1 to change` per instance, but
confirm the shared module does not force replacement on that attribute.

# Stop

- The plan proposes replacing an instance when the intent was an in-place
  sizing change.
- The request is connector registration, secrets provisioning, or domain join
  rather than infrastructure.
- A new region is requested without a VPC and subnet already available for it.
