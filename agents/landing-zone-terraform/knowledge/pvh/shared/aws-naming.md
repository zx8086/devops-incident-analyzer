---
type: Contract
title: aws-naming
description: The PVH resource-naming Core module — three inputs, roughly ninety per-service name objects; consumed by 16 repos at eleven different pinned tags.
resource: https://gitlab.com/pvhcorp/terraform/aws-modules/aws-naming
change_class: human-only
tags: [shared-module, naming, core, version-skew]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: variables
    resource: https://gitlab.com/pvhcorp/terraform/aws-modules/aws-naming/-/blob/main/variables.tf
    title: aws-naming variables.tf at HEAD
    author: team:ccoe-platform
  - id: outputs
    resource: https://gitlab.com/pvhcorp/terraform/aws-modules/aws-naming/-/blob/main/outputs.tf
    title: aws-naming outputs.tf at HEAD
    author: team:ccoe-platform
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
---

# When this applies

Any change that creates a resource, renames one, adds a region, or bumps this
module's `ref` in a consuming repo. This is the highest-skew shared contract in
the estate — read it before touching a `module "aws_naming"` block anywhere.

# Surface

You do not edit this module. It lives in
`pvhcorp/terraform/aws-modules/aws-naming` and is owned by the CCoE Platform
Team. The only thing a consuming repo owns is the `ref` in its `module` block
and the three arguments it passes.

# Traps

- **The estate consumes eleven different tags of this one module.** Ordered:
  `v1.0.1`, `v1.0.4`, `v1.0.5`, `v1.0.11`, `v1.0.13`, `v1.0.15`, `v1.0.16`,
  `v1.0.18`, `v1.0.19`, `v1.0.20`, `v1.0.22`, `v1.0.23`. `v1.0.15` is the
  plurality. Two repos pin more than one tag internally:
  [/repos/aws-lz-network-core.md](/repos/aws-lz-network-core.md) uses four, and
  [/repos/aws-lz-backup.md](/repos/aws-lz-backup.md)'s root and child modules
  disagree.
- **This module decides resource names and `Name` tag values.** Skew is
  therefore not cosmetic: two resources of the same type built under different
  tags can carry different names, and a name change in Terraform is a
  destroy-and-recreate for most resource types.
- **A bump can silently change a name.** Read the diff of `locals.tf` between
  the current and target tag before bumping, not just the release notes. Then
  plan and read the plan for replacements. `AGENTS.md` requires the smallest
  coherent change and forbids normalising historical differences
  opportunistically. [^agents-md]
- **An older tag has fewer outputs.** The contract at HEAD exposes roughly
  ninety per-service outputs. [^outputs] A repo pinned to an early tag cannot
  reference a service output added later — the failure is "unsupported
  attribute" at plan, which reads like a typo rather than a version problem.
- **The region validation at HEAD accepts five regions**, including one beyond
  the four `AGENTS.md` names as approved. [^variables] The module is therefore
  more permissive than the standard. Do not treat passing validation as evidence
  a region is approved.
- The `application_name` validation constrains length. A name outside the bound
  fails at plan with a message that points at the wiki, not at your input.
- The `environment` validation carries the estate's environment code set. A new
  code has to land here first; adding one to a repo alone will not pass.

# Fields

Inputs: `region` · `environment` · `application_name`. [^variables]

Outputs: one object per AWS service — `s3`, `kms`, `ec2`, `iam_role`,
`iam_policy`, `dynamodb`, `vpc`, `subnet`, `route53_zone`, `secrets_manager`,
`imagebuilder_*`, and many more — plus `region_code` and `account`. Consumers
read `.name` or `.name_prefix` off the service object. [^outputs] The exact set
depends on the tag you are pinned to; read `outputs.tf` at that tag.

There is a separate global variant instantiated as `module.aws_naming_global`
for global resources, which use the `gl` code.

# Plan

Bumping the `ref` alone produces no plan until a name changes — and when one
does, it usually appears as a replacement, not an update. Never treat a naming
bump as a no-op change.

# Stop

- A bump is requested as a tidy-up rather than to obtain a specific new output.
- The plan after a bump shows any replacement.
- A repo would be moved off a tag that another of its own modules still pins.
- A name is being hard-coded to avoid a version problem — `AGENTS.md` forbids
  reconstructing naming logic locally. [^agents-md]
