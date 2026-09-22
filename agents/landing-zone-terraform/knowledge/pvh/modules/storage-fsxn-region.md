---
type: Module
title: storage/fsxn-region
description: "Per-region networking for the FSxN estate: the security group and its ingress and egress rules."
resource: aws-lz-storage/modules/fsxn-region
change_class: gitops-hcl
tags: [aws-lz, fsxn, security-group, networking]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-storage/modules/fsxn-region
    title: Module source as checked out
  - id: parent
    resource: aws-lz-storage
    title: Consuming root — see /repos/aws-lz-storage.md
---

# When this applies

The FSxN port set, allowed CIDRs, or per-region network placement changes.

# Surface

**Edit:** `aws-lz-storage/modules/fsxn-region/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `_modules.tf` / `main.tf` in the storage root, iterated over the `config/` tree. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-storage.md](/repos/aws-lz-storage.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- The NFS, SMB, ONTAP management and intercluster port set is wide by necessity. Narrowing it to 'just NFS' breaks replication and management.
- Intercluster rules are what let SnapMirror run between regions. Removing one breaks replication without breaking client access — a partial failure.
- This module has the largest input surface of the storage modules. Adding a rule usually means adding an input, which is a caller-visible change.
- Security-group rule changes apply immediately on apply, with no propagation delay to hide a mistake.

# Fields

Inputs: `ad_cidr_blocks` · `ad_credentials_secret_arn_default` · `data_cidr_blocks` · `extra_ingress_cidrs_per_rule` · `filesystem` · `filesystem_name` · `fsxadmin_secret_name` · `kms_key_id` · `mgmt_cidr_blocks` · `region` · `route_table_ids` · `sg_name` · `snapmirror_cidr_blocks` · `subnet_ids` · `svms` · `tags` · `volumes` · `vpc_id`

Outputs: `filesystem_id` · `intercluster_endpoints` · `management_dns` · `svms` · `volumes`

# Plan

CIDR or port edit: `1 in place` per rule. New region: a full security-group set.

# Stop

- A plan proposes destroying a security group while file systems are attached.
- Intercluster rules would be removed or narrowed.
- The change narrows the port set without confirming which protocol each port serves.
