---
type: Runbook
title: Core and workload network onboarding evidence workflow
description: Read-only workflow for separating workload VPC onboarding from shared core-network changes.
resource: aws-lz-network-core
tags: [network, vpc, cloud-wan, ipam]
status: stable
---

# Core and workload network onboarding evidence workflow

## Scope

Use for VPCs, subnets, IPAM, Cloud WAN, transit gateways, Direct Connect,
routes, endpoints, and shared network prerequisites.

## Required concepts

Read `repos/aws-lz-network-workloads.md`, `repos/aws-lz-network-core.md`, the
applicable child modules, shared networking contracts, and evidence validation.

## Required live evidence

Inspect the target environment YAML, schema, generator, tests, available IPAM
pools and segments, remote branch, open merge requests, and published upstream
state contracts.

## Representative examples

Compare three to five active VPC configurations, including the nearest workload
class and a configuration whose segment or routing intent differs.

## Stop conditions

Stop if the account is not ready, a requested pool or segment is absent, CIDR
allocation is not authoritative, or an ordinary workload request would require
an unapproved shared-core change.

## Permitted outcomes

Explain dependencies, review a workload-VPC proposal, or identify a separately
gated core prerequisite. Do not reserve address space, apply Terraform, or
change shared routing.
