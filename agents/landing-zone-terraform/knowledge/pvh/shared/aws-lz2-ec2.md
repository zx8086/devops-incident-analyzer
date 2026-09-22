---
type: Contract
title: aws-lz2-ec2
description: The shared EC2 building block for Landing Zone v2 hosts — used by four repos at two different tags, and the sole source of resources in the thinnest of them.
resource: https://gitlab.com/pvhcorp/terraform/aws-modules/aws-lz2-ec2
change_class: human-only
tags: [shared-module, ec2, version-skew]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: consumers
    resource: aws-lz-app-proxy, aws-lz-citrix, aws-lz-dc, aws-lz-dfs
    title: Module blocks in the four consuming repositories
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
---

# When this applies

Any EC2 host change in [/repos/aws-lz-app-proxy.md](/repos/aws-lz-app-proxy.md),
[/repos/aws-lz-citrix.md](/repos/aws-lz-citrix.md),
[/repos/aws-lz-dc.md](/repos/aws-lz-dc.md), or the host layer of
[/repos/aws-lz-dfs.md](/repos/aws-lz-dfs.md).

# Surface

You do not edit this module. Consuming repos own the `ref` and the arguments
they pass.

# Traps

- **Two tags are in use: `v1.0.15` in three repos, `v1.0.12` in one.** The
  outlier is `aws-lz-dc`, which runs the domain controllers. Bringing it forward
  is an EC2-affecting change on the estate's AD hosts, not a version tidy-up.
- **`aws-lz-citrix` calls this module three times** — Cloud Connector,
  StoreFront and FAS — all on the same tag. Bumping one call and not the others
  produces a silent inconsistency the plan will not flag.
- **In `aws-lz-app-proxy` and `aws-lz-dc` this module is the only source of
  resources.** Those roots declare no `resource` blocks at all, so every plan
  entry reads `module.<name>.*`. That is the normal shape, not an indirection to
  unwrap.
- Whether a given attribute change is in-place or forces replacement is the
  module's contract, not the consuming repo's. **Read the module's own source at
  the pinned tag before stating an expected plan shape** for a sizing, volume or
  image change.
- The module owns the default security group, IAM role and SSM baseline for a
  host. A consuming repo adding its own security group alongside is layering,
  not overriding.

# Fields

The input surface belongs to the module at the tag you are pinned to. Read
`variables.tf` at that tag; do not infer it from a sibling repo's `module` block,
which may be on a different tag.

# Plan

Instance count change: adds or destroys hosts. Sizing or volume change: verify
against the module whether the attribute forces replacement — this is the single
most common source of an unexpected replace in the consuming repos.

# Stop

- The expected plan shape for a sizing or image change cannot be established
  from the module source at the pinned tag.
- One of `aws-lz-citrix`'s three calls would be bumped without the others.
- `aws-lz-dc` would be brought forward a tag as part of an unrelated change.
