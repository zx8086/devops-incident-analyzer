---
type: Module
title: dhco-gitlab-terraform/personal-aws-sandbox-repository
description: Seeds the starter files committed into an individual's AWS sandbox GitLab repository.
resource: dhco-gitlab-terraform/modules/personal-aws-sandbox-repository
change_class: gitops-hcl
tags: [aws-lz, gitlab, sandbox, repository-file]
generated: { by: agent:claude-cowork, at: 2026-08-27T00:00:00Z }
status: draft
stale_after: 2026-11-30
sources:
  - id: src
    resource: dhco-gitlab-terraform/modules/personal-aws-sandbox-repository
    title: Module source as checked out
  - id: parent
    resource: dhco-gitlab-terraform
    title: Consuming root — see /repos/dhco-gitlab-terraform.md
---

# When this applies

A personal AWS sandbox repository is created for someone, or the files seeded into those repositories change.

# Surface

**Edit:** `dhco-gitlab-terraform/modules/personal-aws-sandbox-repository/` — `_variables.tf`, `main.tf`.

Called from the per-person `module` blocks in `aws-sandbox.tf`. Its inputs are the caller's contract: a change to a
variable name or an output shape is a breaking change for
[/repos/dhco-gitlab-terraform.md](/repos/dhco-gitlab-terraform.md).

This module has **no README**. The `.tf` is the only source for its contract.

# Traps

- **`gitlab_repository_file` writes into someone else's repository.** A change here rewrites files in every sandbox repo the module is instantiated for, overwriting whatever the owner has since put there.
- The module is instantiated once per person by name. Removing a block deletes the seeded files, not the repository.
- It takes two inputs and returns nothing. There is no output to key downstream behaviour on.
- Seeded content is committed on apply with no review in the target repo — the review is this MR.

# Fields

Inputs: `owner_name` · `parent_id`

Outputs: none

# Plan

New sandbox: `N to add` for the seeded files. Content change: `N in place` across every sandbox instance — a fan-out.

# Stop

- A content change would overwrite files sandbox owners have modified.
- The change was not scoped to the fan-out across every instantiated sandbox.
