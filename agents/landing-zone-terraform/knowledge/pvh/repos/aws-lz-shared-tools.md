---
type: Stack
title: aws-lz-shared-tools
description: Empty repository — a git directory with no tracked working tree; nothing to plan, nothing to change.
resource: aws-lz-shared-tools
archetype: empty-repo
change_class: human-only
tags: [aws-lz, empty]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: repo
    resource: aws-lz-shared-tools
    title: Repository contents as checked out
---

# When this applies

A task names `aws-lz-shared-tools`. Read this first and stop before planning
anything.

# Surface

None. As checked out, the repository contains only `.git` — no Terraform, no
README, no CI configuration, no pre-commit configuration.

# Traps

- **The working tree is empty.** This is not a repository with a thin root; it
  has no tracked files in the checked-out state at all.
- The cause is not determinable from the checkout alone. It may be an
  unpopulated repository, a branch with no content checked out, or a clone that
  never completed. Do not guess which.
- Do not create a scaffold here on inference. A new root needs a platform
  decision on bucket, key, role, encryption and locking values before it can be
  written. [^repo]

# Fields

None.

# Plan

None. There is no configuration to plan.

# Stop

Always, for this repo, until a human confirms what it is meant to contain and
which branch holds it. Report the empty state; do not scaffold.
