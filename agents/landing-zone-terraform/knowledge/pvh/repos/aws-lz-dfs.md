---
type: Stack
title: aws-lz-dfs
description: DFS namespace hosts driven by per-environment, per-region YAML, with gated domain-join bootstrap and an AD join-secret read policy created only when bootstrapping.
resource: aws-lz-dfs
archetype: yaml-driven-root
change_class: gitops-config
tags: [aws-lz, dfs, ec2, active-directory, yaml]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: dfs-host
    resource: aws-lz-dfs/modules/dfs-host/main.tf
    title: dfs-host module — bootstrap gating documented in file comments
---

# When this applies

A DFS host is added, resized or given new volumes; a namespace changes; the
allowed CIDR set changes; or an environment/region is brought into scope.

# Surface

**Edit:** `config/<env>/<region>/dfs.yaml` — this is the intended change
surface. Add a new `config/<env>/<region>/` directory to bring a region into
scope. `modules/dfs-host/` for behaviour changes.

**Never edit:** `_backend.tf`, `_versions.tf`. Root `main.tf` and `_locals.tf`
are generic loaders; changing them changes every environment at once.

# Traps

- **`bootstrap_enabled` is a gate, not a flag.** When false, the module creates
  no AD join-secret read policy at all. [^dfs-host] Turning it on adds IAM
  resources and rewrites user data; turning it off after a host is joined does
  not un-join anything, it only removes the policy.
- The root reads config with `fileset` + `yamldecode`. A YAML file in an
  unexpected path is silently picked up or silently missed depending on the
  glob — check `_locals.tf` for the exact pattern before adding a directory.
- Absent optional keys are defaulted with `try(...)` in `_locals.tf`. A typo'd
  key name therefore does **not** fail the plan; it silently takes the default.
  Diff a new YAML file against a sibling before opening the MR.
- `modules/dfs-host` owns only the security group, its rules and the IAM policy.
  The instances come from the shared EC2 module pinned inside that module. The
  module directory contains no EC2 resource, which is why grepping it for
  `aws_instance` finds nothing.
- EBS encryption is consumed, not created here — the key is provided.
- Uses DynamoDB state locking with **no backend `assume_role`**, and the
  `templates/.terraform-run-aws.yml` CI template with per-environment
  `TF_VAR_*`. Locking mechanism is an unresolved platform decision; preserve
  it. [^agents-md]
- Only one environment/region config directory exists today. The second one is
  a new deployment, not a copy-edit.

# Fields

`config/<env>/<region>/dfs.yaml`: `instance_count` · `instance_type` ·
`root_volume_size` · `data_volumes[].{device_name, volume_size, drive_letter,
label}` · `bootstrap_enabled` · `active_directory.{domain_name, ou_path,
join_user_secret_arn, join_password_secret_arn}` · `namespaces` ·
`allowed_cidr_blocks`.

Root inputs: `account_id` · `environment` · `account_naming_prefix` ·
`permissions_boundary` · `mandatory_tags` · `custom_tags`.

Root outputs: `dfs_instance_ids` · `dfs_instance_private_ips` ·
`dfs_instance_availability_zones` · `dfs_security_group_ids` ·
`dfs_vpc_ids` · `dfs_iam_role_names`.

# Plan

`instance_count` increase: `N to add`. New `config/<env>/<region>/` directory:
a full host set for that region. Flipping `bootstrap_enabled` to true: adds the
IAM policy and changes user data, which replaces instances — confirm before
stating the shape. CIDR or namespace edit: `1 in place` per affected host.

# Stop

- A plan proposes destroying or replacing a DFS host when the intent was a
  config edit.
- `bootstrap_enabled` is being turned off on hosts that are already
  domain-joined.
- The YAML references a join-secret ARN that does not exist in the target
  account.
