---
type: Contract
title: unpinned module refs
description: The seven shared-module sources across the estate that resolve to a branch or a bare commit instead of a released tag, and what each one costs.
resource: AGENTS.md
change_class: human-only
tags: [shared-module, pinning, risk, agents-md]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions — pin every remote shared module to an exact released semantic version tag
    author: team:ccoe-platform
---

# When this applies

Before changing anything in a repo listed below, and before proposing to "pin
these properly" anywhere. `AGENTS.md` states the rule: pin every remote shared
module to an exact released semantic version tag, and never use `main`, `HEAD`,
a branch name, or an untagged commit. [^agents-md] Seven live sources break it.

# Surface

Each entry is one `source` line in the consuming repository. You change it by
editing that line — but see Stop first: none of these is a safe incidental fix.

# Traps

- **`aws-lz-network-workloads/locals.tf` — four modules at `?ref=main`:**
  `aws-yaml-loader`, `aws-subnet-loader`, `aws-subnet-expander`,
  `aws-vpc-aggregator`. These four do the subnet maths for every workload VPC.
  Two runs a day apart are not reproducible, and an upstream change lands with
  no diff to review in the consuming MR.
- **`aws-lz-infra-ss-components` — `aws-s3` at `?ref=main`.** The same module is
  pinned to a released tag in `aws-lz-citrix`, so a released tag exists; this
  consumer simply is not on one.
- **`aws-lz-network-core/infrastructure/security` — `aws-route-table` at a bare
  40-character commit SHA.** More reproducible than `main`, still not a tag, and
  it gives no signal about which release the behaviour corresponds to.
- **`aws-lz-post-vending/modules/post-vending` —
  `aws-route53_workload` at `?ref=feature/post-vending-version`.** A feature
  branch. The same module is pinned at `v1.0.0` in `aws-lz-network-core`, so the
  branch exists because the release did not carry what post-vending needed.
  Pinning it requires a release that does.
- **The common failure mode is the same in all seven:** the fix looks like a
  one-line edit and is actually an upgrade. Resolving `main` to a tag can move
  the module backwards or forwards by an unknown amount, and the plan is the
  first place you find out.
- Renovate governs dependency bumps elsewhere in the organisation. Nothing
  bumps these, because a branch ref never appears out of date.

# Fields

Not applicable — this concept inventories sources, not a module interface.

# Plan

Unknowable before planning, in every case. A ref change produces whatever diff
the version delta produces. State that explicitly rather than predicting a
shape.

# Stop

- The pin is being proposed as a cleanup, a tidy-up, or part of an unrelated
  change. Each one is its own change with its own plan.
- No released tag has been identified that matches current deployed behaviour.
- For the post-vending feature branch: no release exists that carries the
  behaviour the branch was cut for.
- More than one of the seven would be changed in a single merge request.
