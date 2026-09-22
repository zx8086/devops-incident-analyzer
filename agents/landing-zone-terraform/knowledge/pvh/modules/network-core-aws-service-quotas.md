---
type: Module
title: network-core/aws-service-quotas
description: A local service-quota module, superseded by the remote shared network-service-quotas module the root calls.
resource: aws-lz-network-core/modules/aws_service_quotas
change_class: gitops-hcl
tags: [aws-lz, service-quotas, networking, dead-code]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-network-core/modules/aws_service_quotas
    title: Module source as checked out
  - id: parent
    resource: aws-lz-network-core
    title: Consuming root — see /repos/aws-lz-network-core.md
---

# When this applies

A service-quota change is requested in network-core.

# Surface

**Edit:** `aws-lz-network-core/modules/aws_service_quotas/` — `main.tf`, `outputs.tf`, `variables.tf`, `versions.tf`.

Called from **nothing — no `source` reference to it exists in the repository**. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-network-core.md](/repos/aws-lz-network-core.md).


# Traps

- **This module is not called from anywhere in the repository.** Only `modules/s3_bucket`, `modules/monitoring`, `modules/aws_dx` and `modules/aws_tgw` are sourced by the root or by `infrastructure/`. Editing this module changes nothing that is deployed.
- **The root calls the remote shared `aws-network-service-quotas` module instead.** Raise quotas there.
- Service quota increases are asynchronous and can be rejected by AWS; a successful apply is a request, not a grant.

# Fields

Inputs: `quota_code` · `quota_name` · `service_code` · `value`

Outputs: `quota_details` · `quota_summary`

# Plan

None. This module is not in any plan.

# Stop

- The task assumes this module is live. Confirm the call site first; there is none today.
- Deleting or adopting a dead module is a platform decision, not an incidental cleanup.
