---
type: Runbook
title: Account network map evidence workflow
description: Read-only workflow for mapping an account, VPCs, subnets, route tables, egress, endpoints, and core attachments.
resource: account-network-map
tags: [network, topology, account, vpc]
status: stable
---

# Account network map evidence workflow

## Scope

Use to explain or visualize an account network from desired Terraform state and
optional read-only AWS observations.

## Required concepts

Read the account, workload-network, core-network, and post-vending repository
concepts, affected modules, shared network contracts, and evidence validation.

## Required live evidence

Collect account YAML, VPC and subnet YAML, route-table associations, routes,
NAT or egress resources, endpoints, Cloud WAN or TGW attachments, and published
state. When AWS access is available, compare identifiers and status without
changing resources.

## Representative examples

Compare three to five accounts with the same network pattern and include one
whose subnet classification or route path differs.

## Stop conditions

Stop if account identity, environment, region, VPC ownership, subnet mapping,
or upstream attachment is ambiguous. Do not infer subnet purpose from its name
alone when routes or schema provide stronger evidence.

## Permitted outcomes

Return a cited text map, desired-versus-observed differences, or a deterministic
diagram projection. Do not claim runtime reachability from Terraform alone.
