---
type: Contract
title: k8s-gitlab-runner
description: The shared GitLab runner module — consumed from the registry by the legacy estate and forked locally by the v2 platform, so the two run different code.
resource: https://gitlab.com/pvhcorp/terraform/aws-modules/k8s-gitlab-runner
change_class: human-only
tags: [shared-module, gitlab-runner, kubernetes, fork]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: consumers
    resource: gitlab-k8s-runners-terraform, gitlab-k8s-runners-lzv2/runners.tf
    title: Module blocks in the two runner platforms
---

# When this applies

Any GitLab runner change on either platform, and any attempt to fix a runner
behaviour "everywhere".

# Surface

The legacy platform consumes this module from the registry and owns only its
`ref`. The v2 platform has a **local fork** at
`gitlab-k8s-runners-lzv2/modules/k8s-gitlab-runner` — see
[/modules/runners-lzv2-k8s-gitlab-runner.md](/modules/runners-lzv2-k8s-gitlab-runner.md).

# Traps

- **The two platforms do not share this module's code.** The v2 platform's
  `runners.tf` sources the local path with the registry source commented out
  beside it. A fix applied upstream reaches the legacy estate and not v2; a fix
  applied in the v2 fork reaches v2 and not the legacy estate. Any request to
  "fix runners" needs both platforms named explicitly.
- **In the legacy repo, 115 module calls sit on one tag and exactly one file
  sits one patch ahead.** That single outlier is either a deliberate exception
  or an abandoned upgrade — establish which before copying it or aligning it.
- Copying a `module` block between files in the legacy repo copies its `ref` too.
- The module performs the GitLab-side runner registration. Replacing that
  resource issues a new token and invalidates the old one immediately.
- It also creates the IAM role a team's CI assumes. Its inputs are therefore a
  privilege surface, not just configuration.

# Fields

Read `variables.tf` at the tag or fork you are actually using. The registry
module and the v2 fork have diverged, so a variable present in one may be absent
in the other.

# Plan

Registration or Helm-values change: `1 in place` on the release, restarting
runner pods. Replacement of the registration resource: new token, immediate
invalidation of the old.

# Stop

- A change is intended to apply to both platforms — it will not.
- The legacy repo's single out-of-line file would be aligned without
  establishing why it is ahead.
- A runner would be replaced while jobs are running on it.
