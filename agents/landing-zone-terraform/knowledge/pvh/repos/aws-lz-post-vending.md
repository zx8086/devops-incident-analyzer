---
type: Stack
title: aws-lz-post-vending
description: Post-vending DNS and network baseline applied to freshly vended accounts — one YAML per workload, root .tf generated per application-environment and never committed.
resource: aws-lz-post-vending
archetype: generated-root
change_class: gitops-config
tags: [aws-lz, post-vending, vpc, dns, route53]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: gitignore
    resource: aws-lz-post-vending/.gitignore
    title: Which root files are tracked
---

# When this applies

A vended account needs its DNS and network baseline; an existing workload gains
an environment or a region; the baseline itself changes.

# Surface

**Edit:** `workloads/<application>.yml` — one file per application, keyed by
environment. `modules/post-vending/` for baseline behaviour. `scripts/` for
generation logic.

**Never edit:** root `*.tf` other than `_backend.tf`, `_providers.tf` and
`_variables.tf`. Every other root `.tf` is generated one-per
application-environment and is not committed. [^gitignore] Editing generated HCL
is lost on the next generation run.

# Traps

- **Five provider aliases exist** — four regional plus one for the network
  account. A resource must be given the right one; peering and DNS association
  cross accounts.
- The generated per-workload roots mean **the repo you check out is not the
  configuration that runs**. Reading root `.tf` to understand behaviour will
  find almost nothing; read `modules/post-vending/` and the template.
- **This repo runs with state locking disabled** (`use_lockfile = false`).
  `AGENTS.md` names vending repos with locking disabled as a known gap that must
  never be copied. [^agents-md] Observed and preserved; not precedent.
- It and `aws-lz-account-creator` are the only repos still on an older shared CI
  template ref.
- **No `.pre-commit-config.yaml` exists here.** Nothing enforces formatting,
  credential scanning or docs generation.
- **`modules/post-vending` sources the shared workload-DNS module from a feature
  branch**, not a released tag. `AGENTS.md` forbids a branch ref. [^agents-md]
  Every apply here tracks whatever that branch currently holds. Pinning it to a
  release is a real change needing a verified equivalent tag — see
  [/shared/aws-route53-workload.md](/shared/aws-route53-workload.md).
- `modules/post-vending` creates VPC peering connections **and** their
  accepters. Peering is inherently two-sided; a plan that shows only one side is
  incomplete.
- A workload YAML carries the full mandatory tag set per application. The
  `DataClassification` and `BusinessCriticality` vocabularies are an unresolved
  platform decision — reuse the values sibling files already use. [^agents-md]

# Fields

`workloads/<app>.yml`: `application_name` · `common.tags.{ApplicationName,
Approver, BusinessCriticality, BusinessUnit, DataClassification, BlueprintID,
Owner, ManagedBy, CostCenter, map-migrated}` ·
`environments.<env>.{account_id, vpc_id, region}`.

Root inputs: `account_id` · `region` · `datasync_network_account_id`.

# Plan

New environment entry in a workload YAML: a full add set for that
application-environment, including both sides of any peering. Baseline change in
`modules/post-vending`: fans out across every generated root — scope the MR.

# Stop

- A plan proposes destroying a VPC, subnet, route table or peering connection.
- A peering change shows only one side.
- The change requires editing a generated root `.tf`.
- A new tag vocabulary value is needed that no sibling workload file uses.
