---
type: Stack
title: aws-lz-network-workloads
description: Workload VPCs — one YAML per VPC per environment, schema-validated, expanded into subnets and endpoints and attached to CloudWAN, with a generated per-VPC child pipeline.
resource: aws-lz-network-workloads
archetype: yaml-driven-root
change_class: gitops-config
tags: [aws-lz, networking, vpc, cloudwan, yaml, child-pipeline]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: schema
    resource: aws-lz-network-workloads/schema/workload-vpc.schema.json
    title: Workload VPC JSON schema
  - id: ci
    resource: aws-lz-network-workloads/.gitlab-ci.yml
    title: Bespoke pipeline with generated child jobs
---

# When this applies

A workload VPC is created, resized, given subnets or endpoints, attached to a
CloudWAN segment, or retired.

# Surface

**Edit:** `environments/<env>/vpcs/<vpc>.yaml` — one file per VPC. This is the
only surface most changes need.

**Never edit:** `backend.tf`, `versions.tf`, `moved.tf`. Root `.tf` files are
generic; a change there affects every VPC.

**Ignore:** `terragrunt/` contains a migration marker and a leftover config;
this repo is not Terragrunt-driven today.

# Traps

- **The YAML is schema-validated in pre-commit, and the schema is the
  contract.** `schema/workload-vpc.schema.json` plus the
  `validate-workload-yaml-semantic` and `validate-yaml-schema` hooks reject
  malformed files before Terraform sees them. [^schema] Run pre-commit; a hand
  edit that skips it fails later and less clearly.
- **The AWS provider is pinned to an exact version**, not a range — the only
  repo in the estate that does. Do not relax it to `~>` as a tidy-up.
- **`moved.tf` carries a substantial set of `moved` blocks** from a past
  refactor. They are load-bearing: removing one turns a rename back into a
  destroy-and-recreate of a live VPC resource. Never delete a `moved` block to
  clean up.
- **The CI pipeline is bespoke and generates a child pipeline** from the changed
  set (`scripts/ci/generate_child_pipeline.py`). [^ci] The plan you see is
  per-VPC and scoped to what changed; a VPC absent from the child pipeline was
  not in the changed set, which is the intended behaviour, not a missed plan.
- Four `debug_*` outputs exist with no descriptions. They are diagnostic; do not
  treat their shape as a stable interface.
- **Four shared modules are sourced at `?ref=main`, live, in `locals.tf`** —
  the YAML loader, subnet loader, subnet expander and VPC aggregator. `AGENTS.md`
  forbids `main`, a branch or an untagged commit as a module ref. [^agents-md]
  Every plan in this repo can therefore pick up an unrelated upstream change with
  no diff to review, and two runs a day apart are not reproducible. The
  `aws-lz-networking` module beside them *is* pinned to a released tag — read the
  `source` line of the specific module you are touching. See
  [/shared/index.md](/shared/index.md) for the estate-wide ref inventory.
- **The `_locals.tf` `try(...)` pattern means a mistyped optional key silently
  takes a default** rather than failing. Diff a new VPC file against a sibling.
- `vpc_filter` and `exclude_vpc_files` inputs let a run be scoped to a subset.
  A plan that shows fewer VPCs than expected may be scoped, not broken.
- IPAM pools are read from `aws-lz-network-core`'s remote state. A pool that
  does not exist there cannot be referenced here.
- Uses DynamoDB locking with a backend `assume_role` into the shared-services
  account.

# Fields

`environments/<env>/vpcs/<name>.yaml`: `vpcs[].{name, segment, region,
availability_zones, ipam_pool_name, ipam_netmask_length, cloudwan_attachment,
enable_public_access, enable_native_ipam, vpc_endpoints, subnets, tags}`.

Root inputs: `account_id` · `environment` · `region` · `application_name` ·
`vpc_filter` · `exclude_vpc_files` · `flow_logs_destination` ·
`flow_logs_role_arn` · `mandatory_tags` · `custom_tags`.

Key root outputs: `vpc_ids` · `vpc_cidr_blocks` · `subnet_ids` ·
`route_table_ids` · `cloudwan_attachment_ids` · `vpc_endpoints_summary` ·
`workload_vpcs` · `validation_status` · `aggregation_validation`.

# Plan

New VPC file: a full add set for that VPC in the child pipeline. Subnet or
endpoint edit: adds or changes within one VPC. Deleting a VPC file: `N to
destroy` for a live VPC — destructive, requires owner sign-off.

# Stop

- A `moved` block would be removed or edited.
- A plan proposes destroying a VPC, subnet or CloudWAN attachment when the
  intent was an edit.
- The YAML fails schema validation and the fix is not obvious from the schema.
- A referenced IPAM pool does not exist in `/repos/aws-lz-network-core.md`.
