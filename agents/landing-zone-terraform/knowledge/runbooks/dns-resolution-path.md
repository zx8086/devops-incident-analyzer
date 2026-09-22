---
type: Runbook
title: DNS resolution path evidence workflow
description: Read-only workflow for mapping DNS separately from packet routing in a Landing Zone account.
resource: dns-resolution-path
tags: [dns, route53, resolver, network]
status: stable
---

# DNS resolution path evidence workflow

## Scope

Use for hosted zones, records, resolver rules, resolver endpoints, forwarding,
VPC associations, and post-vending DNS baselines.

## Required concepts

Read `repos/aws-lz-post-vending.md`, network-core and workload-network concepts,
affected modules, shared networking contracts, and evidence validation.

## Required live evidence

Inspect desired hosted zones, record sets, resolver rules and associations,
resolver endpoints, forwarding targets, VPC links, post-vending outputs, and
read-only Route 53 or Resolver observations when available.

## Representative examples

Compare at least three accounts with the same resolution pattern and include a
counterexample using a different zone, forwarding path, or association model.

## Stop conditions

Stop if a DNS zone, resolver rule owner, forwarding target, or VPC association
is unverified. A route proves packet reachability intent, not name resolution;
never substitute route-table evidence for DNS evidence.

## Permitted outcomes

Return a cited resolution chain, highlight desired-versus-observed differences,
or create a deterministic DNS diagram projection. Do not change records,
associations, or resolver rules.
