---
type: Module
title: network-core/eip
description: An Elastic IP module carried in network-core but not called by anything.
resource: aws-lz-network-core/modules/eip
change_class: gitops-hcl
tags: [aws-lz, eip, networking, dead-code]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-network-core/modules/eip
    title: Module source as checked out
  - id: parent
    resource: aws-lz-network-core
    title: Consuming root — see /repos/aws-lz-network-core.md
---

# When this applies

An Elastic IP change is requested in network-core.

# Surface

**Edit:** `aws-lz-network-core/modules/eip/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from **nothing — no `source` reference to it exists in the repository**. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-network-core.md](/repos/aws-lz-network-core.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **This module is not called from anywhere in the repository.** Only `modules/s3_bucket`, `modules/monitoring`, `modules/aws_dx` and `modules/aws_tgw` are sourced by the root or by `infrastructure/`. Editing this module changes nothing that is deployed.
- Elastic IPs in the live network path are created by the shared modules the root actually calls, not here. Changing this module will not move a live address.

# Fields

Inputs: `application_name` · `associate_with_private_ip` · `custom_tags` · `domain` · `eip_name` · `environment` · `instance_id` · `mandatory_tags` · `network_interface_id` · `public_ipv4_pool` · `region`

Outputs: `allocation_id` · `association_id` · `eip_id` · `public_ip`

# Plan

None. This module is not in any plan.

# Stop

- The task assumes this module is live. Confirm the call site first; there is none today.
- Deleting or adopting a dead module is a platform decision, not an incidental cleanup.
