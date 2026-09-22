---
type: Stack
title: aws-lz-network-core
description: Core network — CloudWAN, IPAM, Transit Gateways, Direct Connect, Route 53 core and profiles, driven by per-environment WAN YAML and composed from local sub-roots.
resource: aws-lz-network-core
archetype: yaml-driven-root
change_class: gitops-config
tags: [aws-lz, networking, cloudwan, ipam, tgw, route53, direct-connect]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: ci
    resource: aws-lz-network-core/.gitlab-ci.yml
    title: Bespoke pipeline and workflow rules
---

# When this applies

A CloudWAN segment, attachment policy, edge location or ASN range changes; an
IPAM pool changes; a TGW or Direct Connect attachment changes; a Route 53 core
zone or profile changes.

# Surface

**Edit:** `environments/<env>/WAN/*.yaml` and `environments/<env>/WAN/dns/*.yaml`
— this is the intended change surface and the reason the root is generic.
`modules/*` and `infrastructure/*` for behaviour changes.

**Never edit:** `backend.tf`, `versions.tf`. The root `.tf` files are loaders
and wiring; a change there affects every environment at once.

**Ignore:** `ATTACHMENT_ACCEPTER_UPDATE_SUMMARY.md`,
`DOCUMENTATION_UPDATE_SUMMARY.md`, `TESTING_FILES_STRUCTURE.txt` and
`prod-migration-data.json` are records of past work, not instructions.

# Traps

- **This repo does not follow the estate's underscore file convention.** It uses
  `backend.tf`, `variables.tf`, `outputs.tf`, `locals.tf`, `providers.tf`,
  `versions.tf`. `AGENTS.md` describes the underscore layout. [^agents-md] Match
  the files that exist here; do not rename them.
- **The CI pipeline is bespoke** — no shared template include. Workflow rules
  select environment by trigger: a tag means production, `main` means staging.
  A branch push is neither. [^ci]
- **The production and staging workflow rules both set the same
  `PROJECT_RUNNER_TAG`.** The production rule does not select a production
  runner. Confirm with the platform team before relying on runner isolation for
  a production apply; do not silently "fix" it as part of unrelated work.
- Root-level copies of both shared CI templates (`.terraform-run-aws.yml`,
  `.terraform-aws-singular-env.yml`) sit in the repo but are not included by
  `.gitlab-ci.yml`. They are inert; editing them changes nothing.
- **Four regional provider aliases** are configured. Every resource must be
  given one explicitly. A resource without an alias lands in the default
  provider's region.
- `infrastructure/config`, `infrastructure/networking` and
  `infrastructure/security` are consumed as **local modules**, not as separate
  roots. Their outputs feed the root's outputs. Eight of the root's outputs and
  one module variable have no description.
- **Seven of the eleven local modules are not called from anywhere.** Only
  `modules/s3_bucket`, `modules/monitoring`, `modules/aws_dx` and
  `modules/aws_tgw` are sourced. `aws_igw`, `internet_gateway`, `eip`,
  `nat-gateway`, `test-services`, `ipam` and `aws_service_quotas` are dead code:
  `aws_igw` and `internet_gateway` are near-duplicates of each other, and IPAM
  and service quotas are served by *remote* shared modules instead. Editing one
  of the seven changes nothing. Confirm the call site before touching any local
  module here.
- **`infrastructure/security` pins a shared route-table module to a bare commit
  SHA**, not a released tag. `AGENTS.md` forbids an untagged commit as a module
  ref. [^agents-md] It is one of seven non-tag refs across the estate — see
  [/shared/index.md](/shared/index.md). Do not resolve it to a tag as a side
  effect: verify which release matches deployed behaviour first.
- **This repo pins the shared naming module at four different tags at once** —
  the root, `infrastructure/security` and the local modules disagree. Naming
  drives resource names and `Name` tags, so two resources built by different
  tags can be named inconsistently. Aligning them is a naming migration with
  replacements, not a tidy-up. See [/shared/aws-naming.md](/shared/aws-naming.md).
- YAML is read in roughly two dozen `yamldecode` calls. A schema mistake often
  surfaces as a confusing type error deep in a module, not as a clear message.
- Direct Connect connections are provisioned by hand and imported into state.
  `modules/aws_dx` manages the gateway and attachment, not the physical
  connection.
- Uses DynamoDB locking, with a backend `assume_role` into the shared-services
  account while the provider assumes a role in the target account.
- Native Terraform tests exist (`tests/*.tftest.hcl`) and a `terraform-test`
  pre-commit hook runs them. Run them; do not substitute another toolchain.

# Fields

`environments/<env>/WAN/cloudwan.yaml`: `asn_ranges[].{from,to}` ·
`inside_cidr_blocks` · `region` · `flow_logs_destination` ·
`segments[].{name,actions}` · `nfgs[].{name,type,location,description}` ·
`segment_actions[].{segment,mode,action,share_with}` ·
`attachment_policies[].{rule_number,segment,tag_value}` ·
`edge_locations[].{location,asn,inside_cidr_blocks}`.

Sibling files under the same directory carry Direct Connect, DNS profile and
Route 53 core configuration.

Root inputs: `account_id` · `environment` · `region` · `custom_tags` ·
`flow_logs_destination` · `flow_logs_role_arn`.

# Plan

A segment or attachment-policy edit rewrites the CloudWAN core policy — expect
`1 in place` on the policy document with a large embedded diff; read the policy
delta, not just the count. Adding an edge location: `1 in place` on the policy
plus new attachments. IPAM pool change: verify no allocation is displaced.

# Stop

- A plan proposes destroying a CloudWAN attachment, a TGW, an IPAM pool or a
  Route 53 zone.
- An IPAM pool CIDR change would strand an existing allocation.
- A change targets a local module without a confirmed call site.
- A production apply is expected to run on an isolated production runner.
