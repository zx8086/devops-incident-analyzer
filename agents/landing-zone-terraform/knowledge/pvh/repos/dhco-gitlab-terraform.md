---
type: Stack
title: dhco-gitlab-terraform
description: GitLab-as-code — the groups, projects, SAML links and committed CI files for the whole DHCO estate, including the aws-lz-* projects themselves.
resource: dhco-gitlab-terraform
archetype: gitlab-as-code-root
change_class: gitops-hcl
tags: [gitlab, groups, projects, platform, saml]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: backend
    resource: dhco-gitlab-terraform/_backend.tf
    title: HTTP backend declaration
  - id: versions
    resource: dhco-gitlab-terraform/_versions.tf
    title: Provider and version constraints
---

# When this applies

A GitLab group, project, SAML link or committed repository file changes —
including creating the GitLab project for a new `aws-lz-*` repository, or
changing one's settings, approvals or CI variables.

**This repo sits upstream of every other repo in scope.** The chain is:
this repo creates the GitLab project → [/repos/gitlab-k8s-runners-lzv2.md](/repos/gitlab-k8s-runners-lzv2.md)
creates the runner its pipeline executes on → the `aws-lz-*` root deploys AWS.

# Surface

**Edit:** the per-domain root files — `aws.tf`, `aws-lz-finops.tf`,
`aws-sandbox.tf`, `retail.tf`, `plm.tf`, `observability.tf`, `toolbox.tf`,
`runners-lz2_0.tf`, `datacenter-projects.tf`, `gcp-projects.tf`, `azure.tf`,
`active-dir.tf`, `ansible.tf`, `aprimo.tf`, `base-images.tf`,
`aws_breakglass.tf` — and `modules/personal-aws-sandbox-repository/`.

**Never edit:** `_backend.tf`, `_versions.tf`.

# Traps

- **This is not an AWS repository.** The only provider is `gitlabhq/gitlab`.
  Nothing in `AGENTS.md` about AWS providers, naming/tagging Core modules,
  regions, account boundaries or `TerraformCrossAccountRole` applies
  here. [^versions] Do not carry an `aws-lz-*` habit into it.
- **The state backend is `backend "http"`, not S3** — GitLab-managed Terraform
  state, configured entirely at run time. [^backend] The estate-wide questions
  about DynamoDB versus native S3 locking are irrelevant here, and the state is
  not in `pvh-terraform-state-bucket`.
- **There is no `.gitlab-ci.yml` in this repository.** How it is applied is not
  determinable from the checkout. Establish the run mechanism before claiming
  what a merge will do.
- `gitlab_token` is a root variable. It is a credential input — never echo it,
  and never move it into a committed file.
- **The `gitlab-project` module is pinned at three different tags in one
  repository**, and `gitlab-group` at two. A project created under an older tag
  has a different default settings surface from one created under the newest.
  Copying a `module` block from a neighbouring file therefore also copies its
  module version. Check the tag on the block you are copying.
- `gitlab_repository_file` **commits files into other repositories.** A change
  here rewrites a file inside a downstream project — including, potentially, an
  `aws-lz-*` repo's CI configuration. That is the most far-reaching resource
  type in the estate and it plans as an ordinary in-place update.
- `ignore_changes` appears thirteen times. Before concluding a settings change
  "has no effect", check whether that attribute is ignored.
- `gitlab_group_saml_link` governs access. Removing one revokes group access on
  apply.
- Deleting a `gitlab_project` resource deletes the GitLab project and its
  history. There is no `prevent_destroy` anywhere in this repo.

# Fields

Root inputs: `gitlab_url` · `gitlab_token` · `approvals_before_merge`.
No root outputs.

Per-project configuration lives inline in the per-domain `.tf` files as module
arguments, not in a YAML surface.

# Plan

New project: `1 to add` for the project plus any `gitlab_repository_file` it
seeds. Settings change: `1 in place`. Removing a project block: `1 to destroy`
— destroys the GitLab project.

# Stop

- Any plan proposing to destroy a `gitlab_project`, a `gitlab_group`, or a
  `gitlab_group_saml_link`.
- A `gitlab_repository_file` change would rewrite a file in a downstream repo
  that repo's owners have not agreed to.
- The run mechanism for this repository cannot be established.
- A module block is being copied without checking which tag it pins.
