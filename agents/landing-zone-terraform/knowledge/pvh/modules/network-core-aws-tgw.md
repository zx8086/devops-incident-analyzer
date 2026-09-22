---
type: Module
title: network-core/aws-tgw
description: Transit Gateways with their route tables, policy tables, static routes and the CloudWAN peering that attaches them to the core network.
resource: aws-lz-network-core/modules/aws_tgw
change_class: gitops-hcl
tags: [aws-lz, tgw, cloudwan, networking, peering]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-network-core/modules/aws_tgw
    title: Module source as checked out
  - id: parent
    resource: aws-lz-network-core
    title: Consuming root — see /repos/aws-lz-network-core.md
---

# When this applies

A Transit Gateway, its route or policy tables, a static route, or its CloudWAN peering changes.

# Surface

**Edit:** `aws-lz-network-core/modules/aws_tgw/` — `main.tf`, `outputs.tf`, `variables.tf`.

Called from `cloudwan_final.tf` / the root's `transit_gateways` module block. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-network-core.md](/repos/aws-lz-network-core.md).


# Traps

- `aws_networkmanager_transit_gateway_peering` plus `aws_networkmanager_transit_gateway_route_table_attachment` are two halves of one attachment. Changing one without the other leaves a half-attached gateway that plans clean.
- A TGW policy table association is what makes routes propagate. Removing an association silently blackholes traffic; the plan reports one small resource.
- Static routes in `aws_ec2_transit_gateway_route` override propagated routes. Adding one can shadow a working path.
- Replacing a Transit Gateway detaches every VPC attached to it. Attachments are owned by other repos.
- This module has a README, unlike most local modules in the estate — read it, then verify against the `.tf`.

# Fields

Inputs: `application_name` · `asn` · `cloudwan_peering` · `custom_tags` · `environment` · `mandatory_tags` · `region` · `route_tables` · `tgw_name`

Outputs: `transit_gateway_arn` · `transit_gateway_id` · `transit_gateway_owner_id`

# Plan

Route add: `1 to add`. Policy-table association change: `1 in place` with routing impact. TGW replacement: estate-wide outage — stop.

# Stop

- Any plan proposing to destroy or replace a Transit Gateway or a peering.
- A policy-table association would be removed.
- A static route would shadow an existing propagated path without a stated reason.
