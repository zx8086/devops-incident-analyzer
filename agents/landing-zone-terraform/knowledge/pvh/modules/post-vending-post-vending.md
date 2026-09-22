---
type: Module
title: post-vending/post-vending
description: "The per-workload network baseline: VPC, subnets, route tables, endpoints and both sides of the VPC peering to the network account."
resource: aws-lz-post-vending/modules/post-vending
change_class: gitops-hcl
tags: [aws-lz, vpc, subnet, peering, route53, post-vending]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-post-vending/modules/post-vending
    title: Module source as checked out
  - id: parent
    resource: aws-lz-post-vending
    title: Consuming root — see /repos/aws-lz-post-vending.md
---

# When this applies

A vended account needs its network baseline, or the baseline itself changes.

# Surface

**Edit:** `aws-lz-post-vending/modules/post-vending/` — `_data.tf`, `_locals.tf`, `_outputs.tf`, `_variables.tf`, `datasync.tf`, `main.tf`, `versions.tf`.

Called from each generated per-application-environment root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-post-vending.md](/repos/aws-lz-post-vending.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **Peering is created here as both the connection and the accepter.** A plan that shows only one side is incomplete — check which provider alias each resource uses.
- The root configures five provider aliases (four regional plus network). A resource given the wrong alias lands in the wrong account or region, and the plan will look plausible.
- This module fans out across every generated root. A change here plans against every vended workload — scope the MR.
- Subnet CIDRs come from the workload YAML. Changing one destroys and recreates the subnet and everything attached to it.
- The baseline creates a security group. Widening it applies to every vended account at once.

# Fields

Inputs: `account_id` · `application_name` · `custom_tags` · `datasync_activation_key` · `datasync_network_account_id` · `datasync_placeholder_cidr` · `enable_datasync` · `environment` · `force_destroy` · `isolated_phz` · `parent_zone_name_override` · `region` · `root_domain` · `tags` · `vpc_id`

Outputs: `datasync_control_endpoint_id` · `datasync_peering_connection_id` · `datasync_placeholder_vpc_id` · `vpc_cidr` · `vpc_id`

# Plan

New workload environment: a full add set including both peering sides. Baseline change: `N to change` across every generated root.

# Stop

- The plan proposes destroying a VPC, subnet, route table or peering connection.
- Only one side of a peering appears in the plan.
- A subnet CIDR would change on a live workload.
