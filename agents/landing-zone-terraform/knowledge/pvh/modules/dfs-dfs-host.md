---
type: Module
title: dfs/dfs-host
description: Security group, intra-cluster rules and the conditional AD join-secret read policy for DFS namespace hosts; the instances themselves come from the shared EC2 module.
resource: aws-lz-dfs/modules/dfs-host
change_class: gitops-hcl
tags: [aws-lz, dfs, ec2, security-group, active-directory]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-dfs/modules/dfs-host
    title: Module source as checked out
  - id: parent
    resource: aws-lz-dfs
    title: Consuming root — see /repos/aws-lz-dfs.md
---

# When this applies

DFS host networking, allowed CIDRs, or the AD join-secret grant changes.

# Surface

**Edit:** `aws-lz-dfs/modules/dfs-host/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `main.tf` in the DFS root, iterated over the config tree. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-dfs.md](/repos/aws-lz-dfs.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **This module contains no EC2 resource.** Instances come from the shared EC2 module pinned inside it. Grepping the directory for `aws_instance` finds nothing; that is expected.
- **The join-secret IAM policy is created only when `bootstrap_enabled` is true and at least one secret ARN is present.** Turning the gate off removes the policy but does not un-join a host that is already in the domain.
- Ingress rules are split between a self-referencing intra-cluster rule and CIDR-based rules. Removing the self rule breaks DFS replication between hosts without breaking client access — a partial failure that is easy to miss.
- The DFS/SMB/AD port set is wide. Narrowing it to 'just SMB' breaks domain operations.

# Fields

Inputs: `active_directory` · `allowed_cidr_blocks` · `bootstrap_enabled` · `custom_tags` · `data_volumes` · `ec2_name` · `instance_count` · `instance_type` · `kms_key_arn` · `mandatory_tags` · `namespaces` · `os_type` · `permissions_boundary` · `region` · `root_volume_size` · `subnet_ids` · `vpc_id`

Outputs: `ami_id` · `iam_role_name` · `instance_availability_zones` · `instance_ids` · `instance_private_ips` · `intra_security_group_id` · `security_group_id`

# Plan

CIDR or namespace edit: `1 in place` per rule. Turning on bootstrap: adds the IAM policy and changes user data, which may replace instances.

# Stop

- A plan proposes destroying the security group while hosts are attached.
- The self-referencing intra-cluster rule would be removed.
- `bootstrap_enabled` is being turned off on already-joined hosts.
