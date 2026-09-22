---
type: Module
title: network-core/ipam
description: A local IPAM module — scope, pools and pool CIDRs — superseded by the remote shared IPAM module the root actually calls.
resource: aws-lz-network-core/modules/ipam
change_class: gitops-hcl
tags: [aws-lz, ipam, networking, dead-code]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-network-core/modules/ipam
    title: Module source as checked out
  - id: parent
    resource: aws-lz-network-core
    title: Consuming root — see /repos/aws-lz-network-core.md
---

# When this applies

An IPAM change is requested in network-core.

# Surface

**Edit:** `aws-lz-network-core/modules/ipam/` — `data.tf`, `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from **nothing — no `source` reference to it exists in the repository**. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-network-core.md](/repos/aws-lz-network-core.md).


# Traps

- **This module is not called from anywhere in the repository.** Only `modules/s3_bucket`, `modules/monitoring`, `modules/aws_dx` and `modules/aws_tgw` are sourced by the root or by `infrastructure/`. Editing this module changes nothing that is deployed.
- **The root calls the remote shared `aws-ipam` module instead**, pinned in its `module` block. That is where a live IPAM change belongs.
- This module has a README, which makes it look current. It is not called. Prefer the call site over the README.
- IPAM pool CIDR changes can strand allocations — that hazard applies to the remote module, not this one.

# Fields

Inputs: `application_name` · `create_custom_scope` · `custom_tags` · `enable_auto_import` · `environment` · `ipam_description` · `ipam_name` · `locale` · `mandatory_tags` · `operating_regions` · `pools_config_file` · `region` · `scope_description` · `scope_name`

Outputs: `alias_pool_ids` · `all_pool_ids` · `child_pool_ids` · `ipam_arn` · `ipam_id` · `ipam_scope_id` · `pool_hierarchy` · `pools_by_level` · `pools_configuration` · `root_pool_ids`

# Plan

None. This module is not in any plan.

# Stop

- The task assumes this module is live. Confirm the call site first; there is none today.
- Deleting or adopting a dead module is a platform decision, not an incidental cleanup.
