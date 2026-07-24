---
name: version-upgrade
description: Bump an Elastic Cloud deployment's Elasticsearch version via the GitOps deployment JSON and an MR. Grounds the "already on that version" no-op decision in the LIVE deployment (SIO-1196), never in the repo file alone.
inputs:
  cluster: { type: string, required: true }       # e.g. "eu-b2b", "us-cld"
  version: { type: string, required: true }       # target, e.g. "9.4.4"
  reason: { type: string, required: false }
outputs:
  mr_url: { type: string }
  branch: { type: string }
---

# Version upgrade

The change is one field: `.version` in `environments/_deployments/<cluster>.json` (RULES.md Must-always #9). CI computes the plan on the MR; a human merges; the post-merge apply job is `when: manual` -- an operator must start it. That last step is exactly why the repo file alone can lie about reality.

## The three-way live check (RULES.md Must-always #8)

Before deciding anything, read the repo file AND the live deployment (`elastic_cloud_get_deployment`; the live version sits at `resources.elasticsearch[0].info.version`). Then:

| Repo `.version` | Live version | Verdict |
|---|---|---|
| == target | == target | Genuine no-op. Say "verified the LIVE deployment is running <version>". |
| == target | != target | **DRIFT -- never "no change needed".** A merged MR was never applied. Attribute it (which MR via the file's `last_commit_id` -> `gitlab_get_commit_merge_requests`; what happened to its apply via `gitlab_get_merge_commit_apply_result`) and route into the drift-reconcile gate. If the apply is currently running, report that instead and stop. |
| == target | unreadable | No-op with the explicit repo-only caveat ("I could NOT read the live deployment..."). |
| != target | (any) | Normal propose: branch + commit + MR. If live also differs from the repo baseline, add the live-parity advisory to the review card (the previous change may never have applied; merging moves live directly to the target at apply). |

## Drift remediation direction (critical)

When repo==target and live lags, the fix is live-catches-up-to-repo: the reconcile gate offers **Reconcile to GitLab** (a plan-neutral marker MR that re-runs the `deployments` stack plan for the cluster; the apply job is still MANUAL). Writing the live version back into the repo ("reconcile to live") is deliberately not offered -- it would silently undo the intended upgrade.

## Apply-result reading gotchas (SIO-1196 incident)

- The pipelines-for-sha API needs the FULL 40-char sha; short shas silently return nothing. The file's `last_commit_id` is already full-length.
- Prefer the `source=push` pipeline for a merge commit. An api-source pipeline (synthetics trigger) can land at the same sha minutes later, produce a green "no-op" child, and shadow the real pipeline -- both in the GitLab UI and in naive latest-pipeline reads.
- The GitLab Environments widget ("Deployed to <env>") reflects the most recently touched environment, NOT where a given merge deployed.

## Open the MR (repo != target path)

Title format from `knowledge/reference/mr-template.md`: `[<cluster>] <old> -> <new>: version-upgrade`. Category `version-bump`, Risk LOW for patch-level bumps. Reviewer notes must state: the `_deployments` stack is a single shared Terraform state across all clusters, and the post-merge apply is a MANUAL job an operator must start -- the MR is NOT done at merge.

## Hand off

Post the MR URL. Append to `memory/runtime/context.md` `## in-flight`. Stop. Do not approve, do not merge, do not start the apply.
