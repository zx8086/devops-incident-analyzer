---
type: Contract
title: aws-lz-networking
description: The shared VPC and subnet construction module behind both network repos, consumed at two different tags that are four releases apart.
resource: https://gitlab.com/pvhcorp/terraform/aws-modules/aws-lz-networking
change_class: human-only
tags: [shared-module, networking, vpc, version-skew]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: consumers
    resource: aws-lz-network-core/infrastructure/networking/main.tf, aws-lz-network-workloads/main.tf
    title: Module blocks in the two consuming repositories
---

# When this applies

A VPC or subnet change in
[/repos/aws-lz-network-core.md](/repos/aws-lz-network-core.md) or
[/repos/aws-lz-network-workloads.md](/repos/aws-lz-network-workloads.md).

# Surface

You do not edit this module. The consuming repos own the `ref` and the arguments
they pass.

# Traps

- **The two network repos are four releases apart** — `network-core` is pinned
  to `v1.0.8` inside `infrastructure/networking`, `network-workloads` to
  `v1.0.12`. They build the network from the same module at different versions.
  A subnet-layout behaviour observed in one repo does not necessarily hold in
  the other.
- `network-workloads` also carries a commented-out `feature/refactoring` ref
  beside the live one. It is not live; read the uncommented `source` line.
- Bringing `network-core` forward changes how core VPCs and subnets are
  constructed. Subnet CIDR or key changes are destroy-and-recreate for the
  subnet and everything attached to it.
- Because `network-workloads` has a substantial `moved.tf`, a module bump there
  can interact with existing `moved` blocks. Verify the state addresses the new
  version produces before planning.

# Fields

The input surface belongs to the module at the tag you are pinned to. Read
`variables.tf` at that tag.

# Plan

A bump in either repo is a networking change, not a version change. Expect to
read the plan for subnet and route-table replacements.

# Stop

- A bump is requested to align the two repos rather than to obtain specific
  behaviour.
- The plan shows any subnet, route-table or attachment replacement.
- The interaction with `network-workloads`' `moved` blocks has not been checked.
