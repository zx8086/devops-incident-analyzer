---
type: Stack
title: gitlab-k8s-runners-lzv2
description: The Landing Zone v2 runner platform — an EKS cluster plus per-team GitLab runners defined in schema-validated YAML, including the runners that execute the aws-lz-* pipelines.
resource: gitlab-k8s-runners-lzv2
archetype: k8s-platform-root
change_class: gitops-config
tags: [gitlab-runners, eks, kubernetes, helm, yaml, platform]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: agents-md
    resource: AGENTS.md
    title: PVH AWS Landing Zone Terraform Module Instructions
    author: team:ccoe-platform
  - id: runners
    resource: gitlab-k8s-runners-lzv2/runners/_defaults.yaml
    title: Runner defaults merged into every team file
  - id: schemas
    resource: gitlab-k8s-runners-lzv2/schemas/runner-config.schema.json
    title: Runner configuration schema
---

# When this applies

A team's GitLab runner is added, resized, re-scoped or retired; the EKS cluster,
its node pools, its addons or its networking change; the runner container image
catalog changes.

**This repo sits between GitLab and AWS.** A runner defined here executes the
pipeline of an `aws-lz-*` repository — `runners/prd/aws-lz-finops.yaml` and
`runners/prd/network-core.yaml` are the runners for those repos. A pipeline that
never picks up a job is usually a change here, not in the consuming repo.

# Surface

**Edit:** `runners/<env>/<team>.yaml` — one file per team, merged over
`runners/_defaults.yaml`. [^runners] `environments/<env>.tfvars` for
cluster-level inputs. `images/catalog.yaml` and the image directories for the
runner image catalog.

**Never edit:** `versions.tf`, and **all of `modules/terraform-aws-eks/`** — it
is a vendored copy of the upstream community EKS module (264 inputs, 96
outputs). Changing a vendored module makes it un-upgradable. A needed change
there is an escalation.

# Traps

- **This repo is not governed by the estate's Terraform defaults.** It requires
  Terraform `>= 1.14.3` and AWS provider `>= 6.28` — both far ahead of every
  `aws-lz-*` root. A version habit carried over from those repos will be wrong
  here.
- **It uses a fourth shared CI template** (`.terraform-generic-dev-stg-prd.yml`),
  not either of the two `AGENTS.md` names. [^agents-md] It has three
  environments, not the two most repos have.
- **Runner YAML is schema-validated in pre-commit**, and the hooks are the
  strictest in the estate — Checkov, `validate-runner-yaml`,
  `validate-k8s-yaml`, `validate-pod-yaml`, `validate-node-manifests`,
  `check-subnet-tags`, `check-hardcoded-secrets` and `check-doc-links`. [^schemas]
  Run pre-commit; skipping it moves a clear schema error into an opaque Helm
  failure.
- `runners/_defaults.yaml` is **merged into every team file**. A defaults change
  fans out to every runner in that environment. Scope the MR and say so.
- A team YAML names the AWS accounts its runner may reach and the GitLab group
  it is registered to. Widening either grants a team's CI access it did not have
  — a privilege change that plans as a Helm value update.
- **Runners are `helm_release` and `kubernetes_*` resources, not AWS
  resources.** A "destroy and recreate" on a `helm_release` interrupts every job
  running on that runner at that moment. There is no drain step in the plan.
- Two provider aliases exist (`ecr`, `shared`) alongside the default. Pod images
  come from a pull-through cache in the ECR account; a resource on the wrong
  alias silently targets the wrong account.
- The vendored EKS module carries its own `moved` blocks in its `migrations.tf`
  files. They belong to upstream; do not touch them.
- **The runner module is forked locally, not consumed from the shared group.**
  `runners.tf` sources `./modules/k8s-gitlab-runner`; the remote pinned source
  sits commented out beside it. This repo and
  [/repos/gitlab-k8s-runners-terraform.md](/repos/gitlab-k8s-runners-terraform.md)
  therefore run *different* runner module code despite the shared name. A fix
  applied to one does not reach the other.
- **`modules/gitlab-runner` has no caller.** It is an earlier implementation
  left in place; `modules/k8s-gitlab-runner` is the live one. Editing the wrong
  directory changes nothing.
- `.archive/` holds superseded configuration. It is a record, not an
  instruction.
- Uses DynamoDB state locking with a backend `assume_role` into the shared
  account.

# Fields

`runners/<env>/<team>.yaml`: `version` · `team.{name, description, owner,
gitlab_group, cost_center}` · `aws_accounts` · `runners[].{name, description,
enabled, ...}` — the full key set is in
`schemas/runner-config.schema.json`, which is authoritative.

Root inputs include: `account_id` · `environment` · `region` · `vpc_id` ·
`subnet_ids` · `subnet_ids_default` · `subnet_ids_isolated` ·
`subnet_ids_pods` · `subnet_tags_default` · `subnet_tags_isolated` ·
`subnet_tags_pods` · `pod_network_cidr` · `create_pod_subnets` ·
`cluster_endpoint_public_access_cidrs` · `eks_admin_role_arn` ·
`ecr_account_id` · `ecr_url` · `shared_account_id` · `aws_account_ids` ·
`cache_bucket_name` · `gitlab_registry_secret_id` · `mandatory_tags`.

Root outputs are the EKS cluster surface plus `all_runners` and
`access_entries`.

# Plan

New team runner: `N to add` for a `helm_release`, a namespace, an IAM role and
its policy. Resource-profile change: `1 in place` on the Helm release, which
restarts the runner pods. `_defaults.yaml` change: fans out across every runner
in the environment. Node-pool change: touches the vendored EKS module — read
the plan closely for node group replacement.

# Stop

- A plan proposes replacing a node group or the cluster.
- A `helm_release` would be destroyed and recreated while jobs are running.
- A change would edit anything under `modules/terraform-aws-eks/`.
- A team YAML would gain an AWS account or GitLab group without the owner's
  agreement.
- A `_defaults.yaml` change has not been scoped to the runners it affects.
