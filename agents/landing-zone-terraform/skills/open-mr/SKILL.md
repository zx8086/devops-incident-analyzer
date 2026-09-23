---
name: open-mr
description: Use only after a human approves an evidence-backed PVH Landing Zone change proposal and the governed GitOps write facade is explicitly enabled.
---

# Open a governed Landing Zone merge request

This skill proposes reviewed configuration through GitLab. It does not authorize Terraform execution or delivery.

## Preconditions

Before invoking a write tool:

1. Read the repository concept, current target, schema or validator, generator or consumer, tests, and three to five active examples where available.
2. Check the live default branch and open merge requests. Keep observed, inferred, proposed, and unverified claims separate.
3. Validate the candidate with the repository-configured checks. Record unavailable checks accurately; do not report a text comparison as validation.
4. Present the files, diff summary, evidence, validation results, risk, expected plan shape, stop conditions, and unresolved facts to the human reviewer.
5. Continue only with an explicit approval decision and the short-lived review token issued for that approved payload.

## Ordered tool sequence

1. Call `lz_create_branch` with the verified project ID, default branch, exact base SHA, non-default `agent/landing-zone/` branch, change summary, and review token.
2. Call `lz_commit_allowed_files` with the returned branch SHA and the expected blob SHA for every update. Use `null` only for a file proven absent on that branch.
3. Stop on any stale SHA, identity mismatch, disallowed path, generated section, secret, state file, backend-policy failure, or unexpected concurrent file.
4. Call `lz_open_merge_request` with the exact source SHA plus the evidence, validation results, risk summary, and expected Terraform plan shape. The merge request must remain a draft.
5. Call `lz_watch_pipeline` to observe an existing MR pipeline and, when available, its plan evidence. Report status and plan risk to the human.

Never reuse approval after the reviewed payload changes. Return to review for amendments, new files, a changed base SHA, expanded IAM/network scope, or a different expected plan.

## Permanent boundaries

- Never write to the default branch.
- Never trigger or retry a pipeline.
- Never run `terraform apply`, destroy, import, state surgery, or force-unlock.
- Never merge or approve a merge request.
- Never create a tag, release, deployment, or AWS mutation.
- Never broaden an allowlist, backend scope, project scope, or credential permission to complete a proposal.
- Treat pipeline success as validation evidence, not proof that infrastructure was applied.
