---
type: Module
title: storage/fsxn-filesystem
description: One FSx for NetApp ONTAP file system per cluster directory in the config tree.
resource: aws-lz-storage/modules/fsxn-filesystem
change_class: gitops-hcl
tags: [aws-lz, fsxn, ontap, storage]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-storage/modules/fsxn-filesystem
    title: Module source as checked out
  - id: parent
    resource: aws-lz-storage
    title: Consuming root — see /repos/aws-lz-storage.md
---

# When this applies

A file system's capacity, throughput, backup retention or endpoint range changes, or a new cluster is added.

# Surface

**Edit:** `aws-lz-storage/modules/fsxn-filesystem/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `_modules.tf` / `main.tf` in the storage root, iterated over the `config/` tree. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-storage.md](/repos/aws-lz-storage.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **`fsx_admin_password` is under `ignore_changes`.** The password is owned outside Terraform after creation; changing it in config has no effect and produces no plan diff.
- Storage capacity can generally grow but not shrink. A reduction is a replace, and a replaced file system loses every volume on it.
- `endpoint_ip_address_range` is fixed at creation. Changing it replaces the file system.
- Deployment type (single- versus multi-AZ) is fixed at creation.
- The cluster's identity is its directory path in `config/`, not a field. Renaming the directory destroys and recreates the file system.

# Fields

Inputs: `automatic_backup_retention_days` · `daily_automatic_backup_start_time` · `deployment_type` · `endpoint_ip_address_range` · `fsxadmin_secret_arn` · `kms_key_id` · `name` · `region` · `route_table_ids` · `security_group_ids` · `storage_capacity_gib` · `subnet_ids` · `tags` · `throughput_capacity_mbps` · `weekly_maintenance_start_time`

Outputs: `arn` · `id` · `intercluster_endpoints` · `management_dns` · `management_ip_addresses` · `preferred_subnet_id`

# Plan

Capacity or throughput increase: `1 in place`. Capacity decrease, endpoint-range or deployment-type change: replace — stop.

# Stop

- Any plan proposing to destroy or replace a file system.
- A capacity reduction is requested.
- A config directory would be renamed.
