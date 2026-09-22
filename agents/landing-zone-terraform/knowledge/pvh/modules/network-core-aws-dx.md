---
type: Module
title: network-core/aws-dx
description: Direct Connect gateway and its CloudWAN attachment, plus the attachment accepter; the physical connection and virtual interfaces are provisioned out of band.
resource: aws-lz-network-core/modules/aws_dx
change_class: gitops-hcl
tags: [aws-lz, direct-connect, cloudwan, networking]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-network-core/modules/aws_dx
    title: Module source as checked out
  - id: parent
    resource: aws-lz-network-core
    title: Consuming root — see /repos/aws-lz-network-core.md
---

# When this applies

A Direct Connect gateway, its CloudWAN attachment, or the attachment acceptance changes.

# Surface

**Edit:** `aws-lz-network-core/modules/aws_dx/` — `data.tf`, `locals.tf`, `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from `security.tf` in the network-core root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-network-core.md](/repos/aws-lz-network-core.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **The physical Direct Connect connection and its virtual interfaces are created by hand in the console and imported into state.** This module manages the gateway and the CloudWAN attachment only. A request to 'provision Direct Connect' is partly out of scope.
- `aws_networkmanager_attachment_accepter` is a separate resource from the attachment. An attachment created without its accepter sits pending and carries no traffic, and both plan clean.
- Its `virtual_interfaces` variable has **no description**. Read the `.tf` to learn its shape before setting it.
- Destroying the gateway drops every virtual interface associated with it, including ones Terraform did not create.
- DX changes affect on-premises connectivity. A plan that looks small can take a site offline.

# Fields

Inputs: `amazon_side_asn` · `core_network_id` · `custom_tags` · `dx_name` · `edge_locations` · `mandatory_tags` · `region` · `virtual_interfaces`

Outputs: `dx_arn` · `dx_id` · `dx_name`

# Plan

Attachment add: `1 to add` plus `1 to add` for the accepter. Gateway change: verify replacement behaviour first.

# Stop

- Any plan proposing to destroy or replace the DX gateway or an attachment.
- An attachment would be created without its accepter.
- The change assumes Terraform will create the physical connection.
