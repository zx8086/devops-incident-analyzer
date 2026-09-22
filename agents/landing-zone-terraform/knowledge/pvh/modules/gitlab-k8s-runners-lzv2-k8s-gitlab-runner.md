---
type: Module
title: runners-lzv2/k8s-gitlab-runner
description: The live runner module for the v2 platform — a local fork of the shared module, creating the namespace, IAM role, GitLab runner registration and Helm release per team.
resource: gitlab-k8s-runners-lzv2/modules/k8s-gitlab-runner
change_class: gitops-hcl
tags: [aws-lz, gitlab-runner, helm, kubernetes, iam, fork]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: gitlab-k8s-runners-lzv2/modules/k8s-gitlab-runner
    title: Module source as checked out
  - id: parent
    resource: gitlab-k8s-runners-lzv2
    title: Consuming root — see /repos/gitlab-k8s-runners-lzv2.md
---

# When this applies

A team runner's registration, permissions, Helm values or namespace changes.

# Surface

**Edit:** `gitlab-k8s-runners-lzv2/modules/k8s-gitlab-runner/` — `data.tf`, `iam.tf`, `locals.tf`, `main.tf`, `output.tf`, `registration-flow.tf`, `runner.tf`, `variables.tf`.

Called from `runners.tf`, iterated over the team YAML. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/gitlab-k8s-runners-lzv2.md](/repos/gitlab-k8s-runners-lzv2.md).


# Traps

- **This is a local fork.** `runners.tf` sources it by path; the shared pinned module is commented out beside the call. Upstream fixes to `pvhcorp/terraform/aws-modules/k8s-gitlab-runner` do not reach this repo, and changes made here do not reach the legacy estate.
- It has 56 inputs — the largest interface of any local module in scope. Adding one is a caller-visible change that the team YAML and its schema must both learn about.
- `gitlab_user_runner` performs the GitLab-side registration. Destroying and recreating it issues a new runner token; the old one stops working the moment the resource is replaced.
- The IAM role and its policy are what let a team's CI reach AWS. Widening them is a privilege change that plans as an ordinary policy update.
- `helm_release` replacement interrupts jobs running on that runner. There is no drain step in the plan.
- `kubernetes_namespace_v1` deletion cascades to everything in the namespace.

# Fields

Inputs: `additional_k8s_service_policy_arn` · `aws_accounts` · `aws_iam_role_names` · `builds_cpu_limit` · `builds_cpu_limit_overwrite_max_allowed` · `builds_cpu_requests` · `builds_cpu_requests_overwrite_max_allowed` · `builds_memory_limit` · `builds_memory_limit_overwrite_max_allowed` · `builds_memory_requests` · `builds_memory_requests_overwrite_max_allowed` · `cache_bucket_name` · `chart_repository` · `chart_version` · `concurrent` · `docker` · `docker_service_image` · `eks_cluster_oidc_issuer` · `gitlab_parent_id` · `gitlab_url` · `helper_image_arch` · `helpers_cpu_limit` · `helpers_cpu_limit_overwrite_max_allowed` · `helpers_cpu_requests` · `helpers_cpu_requests_overwrite_max_allowed` · `helpers_memory_limit` · `helpers_memory_limit_overwrite_max_allowed` · `helpers_memory_requests` · `helpers_memory_requests_overwrite_max_allowed` · `iam_permissions` · `job_image` · `job_node_selector` · `job_tolerations` · `karpenter_provisioner_name` · `manager_node_selector` · `manager_node_type` · `manager_tolerations` · `name` · `output_limit` · `pod_security_level` · `run_untagged` · `runner_cache_size_limit` · `runner_image_tag` · `runner_tags` · `runner_type` · `services_cpu_limit` · `services_cpu_limit_overwrite_max_allowed` · `services_cpu_requests` · `services_cpu_requests_overwrite_max_allowed` · `services_memory_limit` · `services_memory_limit_overwrite_max_allowed` · `services_memory_requests` · `services_memory_requests_overwrite_max_allowed` · `tags` · `terraform_other_providers_workspaces` · `terraform_workspaces`

Outputs: `iam_role_arn` · `namespace` · `runner_image_tag_debug` · `service_account_name`

# Plan

New team: namespace, IAM role, policy, registration and Helm release — a full add set. Values change: `1 in place` on the Helm release, restarting pods.

# Stop

- A plan proposes replacing `gitlab_user_runner` or destroying a namespace.
- An IAM policy would be widened without the owner's agreement.
- A change is intended to fix a bug shared with the legacy estate — it will not propagate.
