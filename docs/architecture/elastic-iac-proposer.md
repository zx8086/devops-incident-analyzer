# Elastic IaC GitOps Proposer

> **Last updated:** 2026-06-03 (post SIO-880)
> **Code:** `packages/agent/src/iac/` (graph) + `packages/mcp-server-elastic-iac/` (MCP, :9086)
> **Supersedes:** the original Terraform-maker design (`../superpowers/specs/2026-06-02-elastic-iac-agent-design.md`), which described the pre-SIO-873 9-node local-terraform graph. This document is the canonical reference for the current agent.

The `elastic-iac` agent is a peer to the incident-analyzer (selected by the UI agent toggle; `agentName === "elastic-iac"` routes to `buildIacGraph()` instead of the incident `buildGraph()`). It answers **"change it"** for Elastic Cloud infrastructure, as a **pure GitOps proposer**: it classifies intent, answers read-only questions, and for a change it edits the deployment/policy JSON, commits a branch, and opens a GitLab merge request **entirely via the GitLab REST API** — no local clone, no `terraform`, no local git. CI computes the Terraform plan on the MR; a human merges and triggers the apply.

The governing principle (deck "Elastic Cloud Observability · IaC Monorepo", p.18): **agent proposes, GitOps disposes.** The agent never merges, approves, or applies — that is the human/CI side of a maker/checker separation of duties.

## Graph (12 nodes)

```text
START -> bootstrap -> {connected? classifyIacIntent : END}
  classifyIacIntent --(info)----------> answerInfo -> END
  classifyIacIntent --(pipeline-status)-> watchPipeline -> teardown -> END
  classifyIacIntent --(gitops)--------> parseIntent [iac_clarify interrupt]
    -> readClusterState -> guard
       guard --(blocked)--> END
       guard -> draftChange
          draftChange --(blocked: bad token / 404 / unparseable JSON)--> END
          draftChange -> reviewPlan -> reviewGate [iac_plan_review HITL interrupt]
             reviewGate --(approved)--> openMr -> watchPipeline -> teardown -> END
             reviewGate --(rejected)--> teardown -> END
```

`buildIacGraph()` lives in `packages/agent/src/iac/graph.ts`; state in `state.ts`; nodes in `nodes.ts`. It has its own `IacState` annotation and checkpointer thread, separate from the incident pipeline. HITL pauses use `interrupt`; the UI resumes through `POST /api/agent/iac/resume`.

### Node responsibilities

| Node | Responsibility |
|------|----------------|
| `bootstrap` | Verify the `elastic-iac-mcp` server (:9086) is connected; surface a message and stop if not. |
| `classifyIacIntent` | LLM one-word classify: `info` (read-only Q) / `gitops` (a change) / `pipeline-status` (follow-up on an open MR). |
| `answerInfo` | Bounded read-only tool loop over a whitelisted read subset; never drafts/branches/MRs. Terminal for `info`. |
| `parseIntent` | LLM extracts a structured `IacRequest` (workflow + fields). Asks one clarify question via `iac_clarify` interrupt when a required field is missing. |
| `readClusterState` | Reads live Elastic Cloud topology + ILM + `.alerts` state before drafting. |
| `guard` | Deterministic, mechanical safety guards only (`guards.ts`). Judgment calls go to the human, not here. |
| `draftChange` | Routes by workflow to a proposer; config edits commit JSON via the GitLab API. Can block (missing token, 404, unparseable JSON). |
| `reviewPlan` | Assembles the plan-review payload: `kind` (config-edit / terraform), diff, risks, descriptor/title. Config edits skip local terraform (CI plans on the MR). |
| `reviewGate` | The `iac_plan_review` HITL interrupt — the only path to opening an MR. Resumes with `approved` / `rejected`. |
| `openMr` | Opens the MR via the API. For a config edit the branch + commit already exist (created in `draftChange`), so no `git_push`. Body filled by the LLM from `knowledge/mr-template.md`. |
| `watchPipeline` | Polls the MR pipeline (bounded budget), walks parent→child to the plan job's terraform report, reports pass/fail + the real plan + approval. Streams `iac_pipeline_progress` live. |
| `teardown` | Final message: MR link + pipeline status + plan + approval (+ a failure hint on failure). |

## Workflows

A change is a JSON config edit (config-edit `kind`) committed via the API; CI computes the plan. Three workflows are on the proposer; everything else falls through to the legacy local-terraform draft path.

| Workflow | Edits | Helper | Category / Risk |
|----------|-------|--------|-----------------|
| **version-upgrade** (SIO-873) | `.version` in `environments/_deployments/<cluster>.json` | `setDeploymentVersion` | version-bump / LOW |
| **tier-resize** (SIO-879) | `elasticsearch.<tier>.size` / `.max_size` (string `"<N>g"`) in `_deployments/<cluster>.json` | `setDeploymentTierSize` | tier-resize / MEDIUM |
| **ilm-rollout** (SIO-880) | a nested phase patch into `environments/<cluster>/lifecycle-policies/<policy>.json` | `mergeIlmPhases` | ilm / MEDIUM, **HIGH on retention reduction** |

**ILM specifics (SIO-880):** policies are per-environment JSON with phase keys (`hot`/`warm`/`cold`/`delete`) at the top level; retention is `delete.min_age`. `parseIntent` extracts `policyName` (the filename verbatim, e.g. `30-days@lifecycle`) + `phasesPatch` (a nested object of only the changed fields). `proposeIlmChange` resolves the path, deep-merges the patch (`mergeIlmPhases`), and `detectRetentionReduction` flags a shorter `delete.min_age` (cross-unit) as **HIGH risk surfaced first in the review and MR body — but never auto-blocked** (the human approves at the gate; CODEOWNERS gates merge). Single-MR per invocation: multi-wave rollout (gl-testing→dev→stg→prod) is the human re-invoking per cluster, not graph choreography.

> The legacy `agents/elastic-iac/skills/add-ilm-policy/SKILL.md` and `knowledge/iac-repo-map.md` describe an older `stacks/<cluster>/ilm.tf` (Terraform HCL) layout and are **stale**; the repo uses per-env JSON config.

## Configuration

The GitOps target is resolved by the MCP server; the JSON paths are agent-side templates.

| Env var | Default | Owner |
|---------|---------|-------|
| `ELASTIC_IAC_GITLAB_BASE_URL` | `https://gitlab.siobytes.cloud` | MCP |
| `ELASTIC_IAC_GITLAB_PROJECT` | `siobytes/elastic-iac` | MCP |
| `ELASTIC_IAC_GITLAB_TOKEN` | *(required)* | MCP |
| `ELASTIC_IAC_DEPLOYMENT_JSON_TEMPLATE` | `environments/_deployments/${cluster}.json` | agent |
| `ELASTIC_IAC_ILM_POLICY_TEMPLATE` | `environments/${cluster}/lifecycle-policies/${policy}.json` | agent |
| `IAC_PIPELINE_POLL_BUDGET_MS` | `90000` | agent |
| `IAC_PIPELINE_POLL_INTERVAL_MS` | `10000` | agent |
| `ELASTIC_IAC_MCP_URL` | `http://localhost:9086` | agent (connects to MCP) |

`${cluster}` and `${policy}` are literal placeholders the agent substitutes (config, not JS template literals). See [Environment Variables](../configuration/environment-variables.md).

## MCP server (:9086)

`mcp-server-elastic-iac` exposes 36 tools. The GitLab subset (12) drives the proposer; the `propose` action maps `gitlab_get_file_content` / `gitlab_create_branch` / `gitlab_commit_file`, `review_pipeline` maps the read-only pipeline/approval tools. The server uses GitLab's REST API directly (the instance can't host MCP yet; migration is documented in `tools/gitlab.ts`). It already has the bridge-walking helpers (`childPipelineId`, `planJob`) used to reach the child pipeline's terraform report.

## What the agent does NOT do

- **Never merges, approves, or triggers apply** — human/CI only (DUTIES).
- **`watchPipeline` reports the MR _plan_ pipeline, not the post-merge apply.** After merge, the apply runs in a child `deploy` pipeline on `main` (job `apply:<cluster>:deployments`) that the agent does not track. A `pipeline-status` follow-up after merge still reports the plan. Closing this gap is tracked in [SIO-881](https://linear.app/siobytes/issue/SIO-881).
- **ILM/version/tier are modify-only** — creating new policies, adding/removing whole phases, and multi-wave choreography are out of scope.

## Operational notes

- **Single shared Terraform state:** the `deployments` stack shares one state across all 10 clusters, so concurrent agent MRs contend on one lock. SIO-878's `classifyPipelineFailure` recognizes the `Error acquiring the state lock` pattern and explains it. Don't fire many MRs back-to-back; an operator force-unlocks (the agent never does).
- **Cold restart for agent-definition or graph changes:** a running web server caches the loaded agent and `bun --hot` doesn't re-resolve workspace packages. Edits to `agents/elastic-iac/**` or new graph nodes need `kill $(lsof -i :5173 -sTCP:LISTEN -t) && bun run --filter @devops-agent/web dev`.
- **Branch names are deterministic** (`agent/<cluster>-<descriptor>-<workflow>-<yyyymmdd>`), so re-proposing the same change while its MR is open returns a clean `409 already exists`.

## Evolution (SIO-870 → SIO-881)

| Ticket | PR | What it delivered |
|--------|----|----|
| SIO-870 | #170 | `classifyIacIntent` (info vs gitops); `answerInfo` read-only loop; multi-deployment version reads. |
| SIO-871 | #171 | `version-upgrade` workflow + `version` field; null-tolerant `parseIntentJson`. |
| SIO-872 | #172 | Fixed the dead Bedrock model alias (was silently falling back to sonnet). |
| SIO-873 | #173 | **Core re-architecture: GitOps proposer.** JSON edit + branch + commit via API; dropped local terraform/git from the upgrade path. |
| SIO-874 | #174,#175 | MR presentation: `config-edit` review kind, kind-aware review card, LLM-filled MR body from `mr-template.md`. |
| SIO-875 | #176 | `watchPipeline`: real plan + approval from the MR pipeline. |
| SIO-876 | #178 | Live mid-poll `iac_pipeline_progress` streaming to the UI. |
| SIO-877 | #177 | "check my MR" survives reloads (falls back to the newest open agent MR). |
| SIO-878 | #179 | Failed-pipeline diagnosis: recognizes the shared-state lock pattern. |
| SIO-879 | #180 | **tier-resize** moved to the proposer. |
| SIO-880 | #181 | **ilm-rollout** moved to the proposer (general phase patch; HIGH-risk retention-reduction warning). Completes the arc. |
| SIO-881 | — | *(Backlog)* Track the post-merge apply, not just the MR plan. |

Per-ticket design records live under `../superpowers/specs/` and `../superpowers/plans/`.
