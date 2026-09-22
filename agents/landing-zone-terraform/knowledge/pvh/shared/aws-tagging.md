---
type: Contract
title: aws-tagging
description: The PVH mandatory-tag Core module — one typed object input, consumed by 16 repos at a single tag; the estate's only shared module with no version skew.
resource: https://gitlab.com/pvhcorp/terraform/aws-modules/aws-tagging
change_class: human-only
tags: [shared-module, tagging, core]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: variables
    resource: https://gitlab.com/pvhcorp/terraform/aws-modules/aws-tagging/-/blob/main/variables.tf
    title: aws-tagging variables.tf at HEAD
    author: team:ccoe-platform
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
---

# When this applies

Any change that tags a resource, or that adds or changes a mandatory tag value.

# Surface

You do not edit this module. Consuming repos own the `ref` and the
`mandatory_tags` object they pass.

# Traps

- **Every consumer is on the same tag.** Sixteen repos, one version, no skew.
  This is the counter-example that shows skew is not inevitable — and it means
  a bump here would be an estate-wide event, not a per-repo choice.
- **`mandatory_tags` is a strict typed object.** Ten required keys plus one
  optional. A missing key is a plan-time type error; an extra key is rejected.
  Additional tags go through the consuming repo's own `additional_tags` or
  `custom_tags` input and are merged after, not into this object.
- **`DataClassification` and `BusinessCriticality` are typed as plain strings
  here, so the module does not constrain their values.** Their vocabularies are
  an unresolved platform decision. [^agents-md] Passing validation proves
  nothing about whether a value is approved — reuse what sibling config already
  uses.
- `ManagedBy` in current account data is a person or team contact, not the
  literal string `Terraform`. [^agents-md] Do not normalise it.
- The merge order matters: `AGENTS.md` specifies module tags first, then
  additional tags, then the per-resource `Name`/`Purpose`/`Service`
  overrides. [^agents-md] Reordering silently changes which value wins.
- Several repos in the estate do not instantiate this module at all and
  assemble tags locally — see
  [/repos/aws-lz-citrix.md](/repos/aws-lz-citrix.md). Those are observed and
  preserved, not precedent.

# Fields

Input: `mandatory_tags`, an object of `ApplicationName`, `Approver`,
`BlueprintID`, `BusinessCriticality`, `BusinessUnit`, `CostCenter`,
`DataClassification`, `Environment`, `ManagedBy`, `Owner`, and optional
`ServiceNow`. [^variables]

Output: the resource tag map consumers merge into `tags`.

# Plan

Changing a tag value plans as an in-place update on every resource carrying it —
a large but safe diff. Adding a key to the object is a module change, not a
consumer change.

# Stop

- A tag key would be added or removed — that is a change to this shared module
  and an estate-wide event.
- A `DataClassification` or `BusinessCriticality` value is being introduced or
  normalised without a current accepted source.
- The merge order in a consuming repo would change.
