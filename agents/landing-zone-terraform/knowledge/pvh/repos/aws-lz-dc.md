---
type: Stack
title: aws-lz-dc
description: Active Directory domain controller hosts across four regions — a single locals-driven module call with static ENIs, persistent data volumes and SSM-held admin passwords.
resource: aws-lz-dc
archetype: flat-hcl-root
change_class: gitops-hcl
tags: [aws-lz, ec2, active-directory, ssm]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: dc-src
    resource: aws-lz-dc/dc_pvhcorp.tf
    title: DC instance construction and count
---

# When this applies

A domain controller is added or removed, a region changes, volume sizing
changes, or security-group rules for AD traffic are introduced.

# Surface

**Edit:** `dc_pvhcorp.tf` (instance count, per-region construction, the module
call), `_locals.tf`.

**Never edit:** `_backend.tf`, `_versions.tf`, `_providers.tf`.

# Traps

- **Scale is a single local, not a variable.** `pvhcorp_dc_count` in
  `dc_pvhcorp.tf` drives instance names and AZ distribution for every
  region. [^dc-src] Changing it renames and redistributes; it is not an
  append-only knob.
- Instances are keyed with `for_each` over a map built from that count. A count
  decrease removes the highest-indexed keys, which are real domain controllers.
  Demote a DC in AD before Terraform destroys it.
- The root declares **no variables and no outputs**. There is no `.tfvars`
  surface; account and environment come from `TF_VAR_*` in `.gitlab-ci.yml`.
- Each instance has a standalone ENI so its private IP is stable. Replacing an
  instance without preserving its ENI changes the IP that AD clients and DNS
  point at.
- The persistent data volume carries destroy protection. A plan proposing to
  destroy it is never routine.
- The admin password is generated and stored in SSM Parameter Store. It is not
  an input and must not be moved into HCL or CI variables.
- AD domain join and the AD-specific security-group ingress rules are **not
  configured here**. A request to "join the DCs to the domain" is out of scope
  for this root as it stands.
- This repo uses the singular-env CI template with S3 native locking and an
  explicit backend `assume_role`, and pins the shared EC2 module to an older tag
  than `aws-lz-citrix` and `aws-lz-app-proxy` do. That is observed state;
  bumping it is a deliberate change. [^agents-md]

# Fields

No root variables or outputs. `_locals.tf` holds the region-to-abbreviation map
and per-region VPC and subnet placement; `dc_pvhcorp.tf` holds the count and the
derived instance map.

# Plan

Count increase: `N to add` per region. Count decrease: `N to destroy` —
destructive. Volume or sizing change: verify whether the shared EC2 module
forces replacement before stating the expected shape.

# Stop

- The plan proposes destroying an instance, its ENI, or its data volume.
- A count change is requested without confirmation that AD-side demotion has
  happened or is planned.
- The request is domain join or AD firewall rules, which this root does not
  currently own.
