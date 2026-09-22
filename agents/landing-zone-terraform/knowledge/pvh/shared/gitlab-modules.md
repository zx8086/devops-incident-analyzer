---
type: Contract
title: gitlab-modules
description: The gitlab-group and gitlab-project modules that create every GitLab group and project in the estate — pinned at five different tags inside one repository.
resource: https://gitlab.com/pvhcorp/terraform/gitlab-modules
change_class: human-only
tags: [shared-module, gitlab, version-skew]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: consumer
    resource: dhco-gitlab-terraform
    title: The only consuming repository
---

# When this applies

Creating or changing a GitLab group or project in
[/repos/dhco-gitlab-terraform.md](/repos/dhco-gitlab-terraform.md) — including
the GitLab project behind any `aws-lz-*` repository.

# Surface

You do not edit these modules. `dhco-gitlab-terraform` owns the `ref` on each
`module` block and the arguments it passes.

# Traps

- **`gitlab-project` is pinned at three tags in one repository — `v5.2.5`,
  `v5.4.0` and `v6.1.0` — and `gitlab-group` at two, `v2.0.5` and `v2.2.1`.**
  A major-version gap between `v5` and `v6` sits inside a single state.
- **Copying a `module` block from a neighbouring file copies its tag.** That is
  how a new project silently inherits an old default settings surface. Check the
  `ref` on the block you copy, and decide the version deliberately.
- A `v5`-to-`v6` bump on an existing project is a major-version change to a live
  GitLab project's settings. It is not a version tidy-up.
- These modules configure branch protection, approvals and CI settings. A
  settings change is a change to how a downstream team's merge requests behave —
  including the `aws-lz-*` repositories' own review gates.
- There is no `prevent_destroy` in the consuming repo. Removing a `module` block
  destroys the GitLab project and its history.

# Fields

Read `variables.tf` at the tag on the specific block you are changing. The
inputs differ across the major-version boundary.

# Plan

Settings change: `1 in place`. New project: `1 to add` plus any seeded files.
Tag bump on an existing project: read the plan for settings the new default
surface changes.

# Stop

- Any plan proposing to destroy a project or group.
- A tag bump crosses the major-version boundary on a live project.
- A block is being copied without a deliberate decision about its `ref`.
- A settings change would alter review gates on a repository whose owners have
  not agreed.
