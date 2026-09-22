---
type: Module
title: network-core/internet-gateway
description: The second internet gateway implementation in network-core; like its near-duplicate, it is not called.
resource: aws-lz-network-core/modules/internet_gateway
change_class: gitops-hcl
tags: [aws-lz, igw, networking, dead-code]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-network-core/modules/internet_gateway
    title: Module source as checked out
  - id: parent
    resource: aws-lz-network-core
    title: Consuming root — see /repos/aws-lz-network-core.md
---

# When this applies

An internet gateway change is requested in network-core. Read this before editing.

# Surface

**Edit:** `aws-lz-network-core/modules/internet_gateway/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from **nothing — no `source` reference to it exists in the repository**. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-network-core.md](/repos/aws-lz-network-core.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **This module is not called from anywhere in the repository.** Only `modules/s3_bucket`, `modules/monitoring`, `modules/aws_dx` and `modules/aws_tgw` are sourced by the root or by `infrastructure/`. Editing this module changes nothing that is deployed.
- `modules/aws_igw` is a near-duplicate of this module. Neither is referenced.
- It exposes one fewer output than the duplicate, so the two are not interchangeable without a caller change.

# Fields

Inputs: `application_name` · `custom_tags` · `environment` · `igw_name` · `mandatory_tags` · `region` · `vpc_id`

Outputs: `igw_arn` · `igw_id` · `vpc_id`

# Plan

None. This module is not in any plan.

# Stop

- The task assumes this module is live. Confirm the call site first; there is none today.
- Deleting or adopting a dead module is a platform decision, not an incidental cleanup.
