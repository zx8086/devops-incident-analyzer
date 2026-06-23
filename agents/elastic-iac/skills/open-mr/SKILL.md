---
name: open-mr
description: Create a GitLab merge request from an agent branch into main. Adds standard labels, milestone, and description template.
inputs:
  branch: { type: string, required: true }
  title: { type: string, required: true }
  body: { type: string, required: true }
  labels: { type: array, required: false }       # defaults to ["agent-generated", "iac"]
  milestone: { type: string, required: false }
outputs:
  mr_iid: { type: number }
  mr_url: { type: string }
---

# Open MR

## Pre-flight

1. Branch must exist remotely. If not, push it first.
2. Branch must have ≥1 commit ahead of `main`.
3. CI must not be in a broken state on `main` — check the latest pipeline.

## Action

Body template lives in `knowledge/reference/mr-template.md` — load and fill per the category-driven rules there.

Call `gitlab_create_merge_request` with:

- source: `<branch>`
- target: `main`
- title: `<title>`
- description: `<body>` (built from `knowledge/reference/mr-template.md`) + auto-appended footer:

```
---
Opened by pvh-elastic-iac-agent v<version>
Requires: 1 approval from CODEOWNERS for stacks/<cluster>/
```

- labels: `["agent-generated", "iac"] + <user-supplied>`
- assignee: leave unset (human picks up)
- remove_source_branch: true
- squash: true

## Post

Return `{mr_iid, mr_url}`. Caller posts to user and writes to `memory/runtime/context.md`.

## Refuse

- Do not call `gitlab_*_approve` or `gitlab_*_merge` on this MR. Ever.
