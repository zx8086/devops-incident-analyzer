---
type: Contract
title: network YAML tooling
description: The four loader, expander and aggregator modules that turn workload VPC YAML into subnet plans — all four consumed at ?ref=main by one repository.
resource: https://gitlab.com/pvhcorp/terraform/aws-modules
change_class: human-only
tags: [shared-module, networking, yaml, pinning]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: consumer
    resource: aws-lz-network-workloads/locals.tf
    title: The four module blocks, all at ?ref=main
---

# When this applies

Any workload VPC or subnet change in
[/repos/aws-lz-network-workloads.md](/repos/aws-lz-network-workloads.md).
These four modules are what turn a VPC YAML file into concrete subnet CIDRs.

# Surface

You do not edit these modules. The consuming repo owns the `source` lines in
`locals.tf`.

# Traps

- **All four are pinned to `main`** — `aws-yaml-loader`, `aws-subnet-loader`,
  `aws-subnet-expander`, `aws-vpc-aggregator`. See
  [/shared/unpinned-refs.md](/shared/unpinned-refs.md) for why that matters and
  why fixing it is not a one-line change.
- **They form a pipeline, not four independent modules.** The loader reads YAML,
  the subnet loader reads external subnets, the expander computes CIDRs, the
  aggregator assembles the result. A change in any one of them changes the
  subnet plan for every workload VPC.
- Because the expander computes CIDRs, an upstream change to it can move a
  subnet's CIDR. A moved CIDR is a destroy-and-recreate of the subnet and
  everything in it. This is the concrete risk behind the `main` pins.
- The consuming repo's four `debug_*` outputs exist to inspect this pipeline's
  intermediate results. They are diagnostic, undocumented, and not a stable
  interface — but they are the fastest way to see what the expander produced.
- The repo's JSON schema validates the YAML *input*. Nothing validates the
  expander's *output* except the plan.

# Fields

Read each module's `variables.tf` at `main` — which is to say, at whatever
`main` holds when you read it. That is the problem this concept exists to flag.

# Plan

Unknowable in advance across a module change, because the input to the plan is
computed by code that can move. Always read the plan for subnet replacements in
this repo, even for a change that looks unrelated to subnets.

# Stop

- A plan shows any subnet CIDR change that the YAML edit does not explain.
- A pin is being proposed for one of the four without the other three.
- The expander's behaviour is being reasoned about from documentation rather
  than from the plan output and the `debug_*` outputs.
