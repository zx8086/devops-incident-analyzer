---
type: Module
title: network-core/test-services
description: EC2 instances and a security group used for network path testing; not called by anything.
resource: aws-lz-network-core/modules/test-services
change_class: gitops-hcl
tags: [aws-lz, ec2, testing, dead-code]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: aws-lz-network-core/modules/test-services
    title: Module source as checked out
  - id: parent
    resource: aws-lz-network-core
    title: Consuming root — see /repos/aws-lz-network-core.md
---

# When this applies

A network test host is requested in network-core.

# Surface

**Edit:** `aws-lz-network-core/modules/test-services/` — `main.tf`.

Called from **nothing — no `source` reference to it exists in the repository**. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/aws-lz-network-core.md](/repos/aws-lz-network-core.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **This module is not called from anywhere in the repository.** Only `modules/s3_bucket`, `modules/monitoring`, `modules/aws_dx` and `modules/aws_tgw` are sourced by the root or by `infrastructure/`. Editing this module changes nothing that is deployed.
- It creates real EC2 instances and a security group. If it is ever wired up, it becomes a running cost and an attack surface, not a test fixture.
- Three variables, no outputs, no README — it is a scratch fixture, not a supported module.

# Fields

Inputs: `allowed_cidr_blocks` · `subnet_id` · `vpc_id`

Outputs: none

# Plan

None. This module is not in any plan.

# Stop

- The task assumes this module is live. Confirm the call site first; there is none today.
- Deleting or adopting a dead module is a platform decision, not an incidental cleanup.
