---
type: Module
title: runners-lzv2/gitlab-runner
description: An earlier runner implementation left in the repository; superseded by k8s-gitlab-runner and not called.
resource: gitlab-k8s-runners-lzv2/modules/gitlab-runner
change_class: gitops-hcl
tags: [aws-lz, gitlab-runner, helm, dead-code]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: gitlab-k8s-runners-lzv2/modules/gitlab-runner
    title: Module source as checked out
  - id: parent
    resource: gitlab-k8s-runners-lzv2
    title: Consuming root — see /repos/gitlab-k8s-runners-lzv2.md
---

# When this applies

A runner change is requested in the v2 platform. Read this before editing this directory.

# Surface

**Edit:** `gitlab-k8s-runners-lzv2/modules/gitlab-runner/` — `iam.tf`, `main.tf`, `variables.tf`, `versions.tf`.

Called from **nothing — `runners.tf` calls `./modules/k8s-gitlab-runner` instead**. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/gitlab-k8s-runners-lzv2.md](/repos/gitlab-k8s-runners-lzv2.md).


# Traps

- **This module is not called.** The live runner module is `modules/k8s-gitlab-runner`. Editing this directory changes nothing that is deployed.
- It has a README, which makes it look current. Prefer the call site over the README.
- Its interface is much smaller than the live module's, so it is not a drop-in replacement.
- Deleting versus adopting it is a platform decision, not an incidental cleanup.

# Fields

Inputs: `concurrent` · `description` · `gitlab_url` · `iam_permissions` · `name` · `namespace` · `node_selector` · `oidc_provider_arn` · `oidc_provider_url` · `resource_tags` · `resources` · `runner_token_secret_name` · `runner_type_config` · `tags` · `team_name` · `tolerations`

Outputs: `helm_release_name` · `helm_release_status` · `iam_role_arn` · `iam_role_name` · `runner_name` · `service_account_name`

# Plan

None. This module is not in any plan.

# Stop

- The task assumes this module is live. Confirm the call site first; there is none.
