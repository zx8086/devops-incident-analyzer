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

1. The branch exists on GitLab (created by `gitlab_create_branch`) and carries the proposed commit.
2. The latest `main` pipeline is not red; if it is, say so in the MR body and warn the user before opening.

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

## Commit and title style

- Commit subject: `<cluster-or-deployment>: <lowercase verb phrase>`, e.g.
  `us-cld: upgrade Elasticsearch 9.4.3 -> 9.4.4`. One line, 72 characters at most
  (code-enforced by `formatCommitSubject`, which truncates interpolated lists with
  `...`, so lead with the discriminating words).
- MR title: `[<cluster>] <descriptor>: <workflow>`; it becomes the squash-commit
  subject on merge, so keep it meaningful standalone and near 72 characters.
- MR body sections explain WHY; the diff shows what changed.

## Post

Return `{mr_iid, mr_url}`. Caller posts to user and writes to `memory/runtime/context.md`.

## Refuse

- Do not call `gitlab_*_approve` or `gitlab_*_merge` on this MR. Ever.
