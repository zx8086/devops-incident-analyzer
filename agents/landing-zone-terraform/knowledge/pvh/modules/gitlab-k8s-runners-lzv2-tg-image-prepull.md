---
type: Module
title: runners-lzv2/tg-image-prepull
description: A DaemonSet that pre-pulls runner container images onto every node so job startup does not wait on a registry fetch.
resource: gitlab-k8s-runners-lzv2/modules/tg-image-prepull
change_class: gitops-hcl
tags: [aws-lz, kubernetes, daemonset, images, performance]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: gitlab-k8s-runners-lzv2/modules/tg-image-prepull
    title: Module source as checked out
  - id: parent
    resource: gitlab-k8s-runners-lzv2
    title: Consuming root — see /repos/gitlab-k8s-runners-lzv2.md
---

# When this applies

The set of pre-pulled runner images changes, or job start-up latency is being tuned.

# Surface

**Edit:** `gitlab-k8s-runners-lzv2/modules/tg-image-prepull/` — `main.tf`, `variables.tf`.

Called from `runners.tf` in the v2 runners root. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/gitlab-k8s-runners-lzv2.md](/repos/gitlab-k8s-runners-lzv2.md).


# Traps

- **A DaemonSet runs on every node.** Adding images increases pull traffic and node disk usage across the whole cluster, not just where the jobs run.
- Images are pulled through the ECR pull-through cache on a separate provider alias. An image reference that bypasses the cache pulls from the internet on every node.
- Changing the DaemonSet triggers a rolling restart across all nodes; that is a cluster-wide event, not a local one.
- It has one output and six inputs — a small interface for a cluster-wide effect. The blast radius is not proportional to the diff size.
- This is a performance optimisation. If it is removed, jobs still run — they start slower. Do not treat a failure here as a CI outage.

# Fields

Inputs: `image` · `image_pull_secrets` · `name` · `namespace` · `node_selector` · `tolerations`

Outputs: `daemonset_name`

# Plan

Image list change: `1 in place` on the DaemonSet, with a rolling restart across every node.

# Stop

- An image reference would bypass the pull-through cache.
- The change is being made during a period when a cluster-wide DaemonSet restart is unacceptable.
