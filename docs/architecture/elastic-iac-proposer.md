# Elastic IaC GitOps Proposer

> **Last updated:** 2026-06-17 (post SIO-933)
> **Code:** `packages/agent/src/iac/` (graph) + `packages/mcp-server-elastic-iac/` (MCP, :9086)
> **Supersedes:** the original Terraform-maker design (`../superpowers/specs/2026-06-02-elastic-iac-agent-design.md`), which described the pre-SIO-873 9-node local-terraform graph. This document is the canonical reference for the current agent.

The `elastic-iac` agent is a peer to the incident-analyzer (selected by the UI agent toggle; `agentName === "elastic-iac"` routes to `buildIacGraph()` instead of the incident `buildGraph()`). It answers **"change it"** for Elastic Cloud infrastructure, as a **pure GitOps proposer**: it classifies intent, answers read-only questions, and for a change it edits the deployment/policy JSON, commits a branch, and opens a GitLab merge request **entirely via the GitLab REST API** — no local clone, no `terraform`, no local git. CI computes the Terraform plan on the MR; a human merges and triggers the apply. Beyond config edits it also handles imperative operations through CI pipeline triggers (drift reconciliation, synthetics push, Fleet binary upgrade) — always propose-only, behind a human approval gate.

The governing principle (deck "Elastic Cloud Observability · IaC Monorepo", p.18): **agent proposes, GitOps disposes.** The agent never merges, approves, or applies — that is the human/CI side of a maker/checker separation of duties.

## Graph (30 nodes)

```text
START -> bootstrap -> {connected? recordIacPrompt -> classifyIacIntent : END}
  classifyIacIntent --(info)----------> answerInfo -> END
  classifyIacIntent --(converse)------> converseIac -> END        (follow-up turns only, SIO-930)
  classifyIacIntent --(pipeline-status)-> watchPipeline -> teardown -> END
  classifyIacIntent --(drift)---------> detectDrift -> explainDrift -> reconcileGate [HITL]
       reconcileGate --(approved)--> reconcileStack -> advanceDrift -> ... -> teardown -> END
       reconcileGate --(declined)--> teardown -> END
  classifyIacIntent --(synthetics-drift)-> detectSyntheticsDrift -> syntheticsPushGate [HITL]
       syntheticsPushGate --(approved)--> pushSynthetics -> teardown -> END
  classifyIacIntent --(fleet-upgrade)-> detectFleetUpgrade -> fleetUpgradeGate [HITL]
       fleetUpgradeGate --(approved)--> applyFleetUpgrade -> teardown -> END
  classifyIacIntent --(gitops)--------> parseIntent [iac_clarify interrupt]
    -> readClusterState -> guard
       guard --(blocked)--> END
       guard -> draftChange
          draftChange --(blocked: bad token / 404 / unparseable JSON)--> END
          draftChange -> reviewPlan -> reviewGate [iac_plan_review HITL interrupt]
             reviewGate --(approved)--> openMr -> watchPipeline -> teardown -> END
             reviewGate --(rejected)--> teardown -> END
```

`buildIacGraph()` lives in `packages/agent/src/iac/graph.ts`; state in `state.ts`; nodes in `nodes.ts`. It has its own `IacState` annotation and checkpointer thread, separate from the incident pipeline. HITL pauses use `interrupt`; the UI resumes through `POST /api/agent/iac/resume`. There are five distinct flows off `classifyIacIntent`: read-only Q&A (`info`/`converse`), the GitOps config-edit path (`gitops`), and three imperative CI-triggered sub-flows (`drift`, `synthetics-drift`, `fleet-upgrade`), plus `pipeline-status` follow-ups. `recordIacPrompt` (SIO-1038) sits on the `bootstrap -> classifyIacIntent` seam — the only chokepoint that sees every intent branch — so the verbatim prompt is captured before the fan-out on all flows.

### Node responsibilities

| Node | Responsibility |
|------|----------------|
| `bootstrap` | Verify the `elastic-iac-mcp` server (:9086) is connected; surface a message and stop if not. |
| `recordIacPrompt` | (SIO-1038) Pre-fan-out capture of the turn's **verbatim** user prompt to two independently-gated, soft-failing sinks: a knowledge-graph `Prompt` node + `PROMPTED_IN` edge to `Session` (PK = `requestId`, so it links to the turn's `ConfigChange` for free; gated on `KNOWLEDGE_GRAPH_ENABLED`), and a raw `user-prompt-raw` agent-memory fact via `recordRawUserPrompt` (triple-gated on `LIVE_MEMORY_ENABLED` + `LIVE_MEMORY_RAW_PROMPTS_ENABLED` + the `agent-memory` backend). Both sinks bypass PII redaction and store RAW/untruncated. See [knowledge-graph.md](knowledge-graph.md). |
| `classifyIacIntent` | LLM one-word classify: `info` (read-only Q) / `converse` (follow-up about a prior proposal, follow-up turns only) / `gitops` (a config change) / `drift` / `synthetics-drift` / `fleet-upgrade` (imperative CI-triggered ops) / `pipeline-status` (follow-up on an open MR or pipeline). |
| `answerInfo` | Bounded read-only tool loop over a whitelisted read subset; never drafts/branches/MRs. Terminal for `info`. |
| `converseIac` | (SIO-930) Answers follow-up questions about a prior proposal using full conversation history + read-only Elastic tools. Explain-only guardrail; coerced to `info` on the first turn. |
| `parseIntent` | LLM extracts a structured `IacRequest` (workflow + fields). Asks one clarify question via `iac_clarify` interrupt when a required field is missing. |
| `readClusterState` | Reads live Elastic Cloud topology + ILM + `.alerts` state before drafting. |
| `guard` | Deterministic, mechanical safety guards only (`guards.ts`). Judgment calls go to the human, not here. |
| `draftChange` | Routes by workflow to a proposer; config edits commit JSON via the GitLab API. Can block (missing token, 404, unparseable JSON). |
| `reviewPlan` | Assembles the plan-review payload: `kind` (config-edit / terraform), diff, risks, descriptor/title. Config edits skip local terraform (CI plans on the MR). |
| `reviewGate` | The `iac_plan_review` HITL interrupt — the only path to opening an MR. Resumes with `approved` / `rejected`. |
| `openMr` | Opens the MR via the API. For a config edit the branch + commit already exist (created in `draftChange`), so no `git_push`. Body filled by the LLM from `knowledge/reference/mr-template.md`. |
| `watchPipeline` | Polls the MR pipeline (bounded budget), walks parent→child to the plan job's terraform report, reports pass/fail + the real plan + approval. Streams `iac_pipeline_progress` live. |
| `teardown` | Final message: MR link + pipeline status + plan + approval (+ a failure hint on failure). Emits a per-outcome completion chip (`IacTurnOutcome`: `completed`/`rejected`/`declined`/`blocked`/`unsupported`/`pipeline-failed`) so the UI renders the right icon/colour instead of a hardcoded green "Completed" (SIO-930). |
| `detectDrift` / `explainDrift` / `reconcileGate` / `reconcileStack` / `advanceDrift` | Drift sub-flow: detect config drift per stack, explain it, gate human approval, then trigger the reconcile CI pipeline and advance to the next stack. |
| `detectSyntheticsDrift` / `syntheticsPushGate` / `pushSynthetics` | Synthetics drift sub-flow (SIO-902): audit one deployment's monitors (source YAML vs live Kibana), gate approval, push via a single remote `SYNTH_PUSH` CI job (no repo write). |
| `detectFleetUpgrade` / `fleetUpgradeGate` / `applyFleetUpgrade` | Fleet binary upgrade sub-flow (SIO-913). See [Fleet upgrade](#fleet-upgrade) below. |
| `amendChange` | (SIO-990) In-place edit of an active proposal: a correction follow-up resolves to the existing branch/MR (`resolveBranch`) and updates it in place rather than opening a second MR, so `reviewGate` skips the duplicate `openMr`. |
| `graphEnrichIac` / `recordIacEntities` / `recordIacOutcome` | (SIO-954/965/969) Knowledge-graph nodes, gated on `KNOWLEDGE_GRAPH_ENABLED`. `graphEnrichIac` (pre-draft) reads the deployment's change history + per-cell history + blast radius -> `iacGraphContext` and `lastStackInstanceOutcome` (a prior `failed` change on the same cell raises a HIGH risk on the plan-review card). `recordIacEntities` (after `openMr`) writes the `ConfigChange`; `recordIacOutcome` (after `watchPipeline`) writes the `Pipeline` + promotes the change outcome. See [knowledge-graph.md](knowledge-graph.md). |
| `memoryEnrichIac` | (SIO-970) Agent-memory node, gated on the `agent-memory` backend (independent of the graph). Deterministic recall of prior `iac-change` facts for the targeted `stack_instance` -> `priorLearnings` on the plan-review card. See [agent-memory.md](agent-memory.md). |

## Workflows

A change is a JSON config edit (config-edit `kind`) committed via the API; CI computes the plan. The `gitops` intent fans out to one of the workflows below. The legacy local-terraform draft path was **removed** in SIO-912; an unhandled request (`workflow === "other"`) now returns a capability-aware message instead of falling through to dead terraform code.

| Workflow | Edits | Category / Risk |
|----------|-------|-----------------|
| **version-upgrade** (SIO-873) | `.version` in `environments/_deployments/<cluster>.json` | version-bump / LOW |
| **tier-resize** (SIO-879) | `elasticsearch.<tier>.size` / `.max_size` (string `"<N>g"`) in `_deployments/<cluster>.json` | tier-resize / MEDIUM |
| **ilm-rollout** (SIO-880/931/932) | nested phase patch(es) into `environments/<cluster>/lifecycle-policies/<policy>.json` | ilm / MEDIUM, **HIGH on retention reduction** |
| **ilm-delete** (SIO-1037) | deletes an ILM policy file under `environments/<cluster>/lifecycle-policies/` | ilm / LOW (destructive delete advisory) |
| **topology-edit** (SIO-919/997/999/1073) | autoscale toggle, tier `zone_count`, per-tier autoscale, SSO/OIDC `user_settings_yaml` (replace/merge/remove keys), `integrations_server`/`kibana` sizing, and the top-level `observability` monitoring-shipping block (add/update/remove) in `_deployments/<cluster>.json` | deployment-topology / HIGH (shared state; observability removal flagged destructive) |
| **slo-edit** (SIO-915) | SLO objective target, time-window duration, tags | slo / LOW |
| **alerting-edit** (SIO-916) | threshold, `windowSize`, `windowUnit`, `enabled`, `interval` | alerting / LOW |
| **dataview-edit** (SIO-917) | runtime fields, title/displayName | dataview / LOW |
| **cluster-default-edit** (SIO-917/979/980/981) | freeform `settingsPatch` (any `index.*` key) on a component/index-template's `settings.index`; multi-file via `clusterDefaults[]` | cluster-default / LOW (short danger denylist in `guards.ts`) |
| **cluster-default-delete** (SIO-1022) | deletes an override file under `environments/<cluster>/cluster-defaults/` | cluster-default / LOW |
| **cluster-settings-edit** (SIO-994/996) | whole-cluster persistent/transient settings (`PUT _cluster/settings`) in `environments/<cluster>/cluster-settings/settings.json`; can set OR remove flat dotted keys | cluster-settings / MEDIUM |
| **index-template-create** (SIO-978) | creates an index template (settings emitted at top level for the module) | index-template / LOW |
| **ingest-pipeline-create** (SIO-1019) | writes a verbatim `@custom` ingest-pipeline JSON to `environments/<cluster>/ingest-pipelines/` | ingest-pipeline / LOW |
| **ingest-pipeline-edit** (SIO-1024) | edits an existing ingest-pipeline JSON | ingest-pipeline / LOW |
| **space-edit** (SIO-918) | space displayName, description, color (roles/disabled_features untouched) | space / LOW |
| **security-edit** (SIO-918) | **additive** privilege grants (cluster/index/kibana; no removal, secrets untouched) | security / MEDIUM (privilege escalation surfaced) |
| **fleet-integration** (SIO-914) | integration package version pins (major-version bump flagged) | fleet-integration / LOW-MEDIUM |
| **dashboard-edit** (SIO-920) | whole-file NDJSON add/replace (display-only) | dashboard / LOW |

**ILM specifics (SIO-880/931/932):** policies are per-environment JSON with phase keys (`hot`/`warm`/`cold`/`delete`); retention is `delete.min_age`. `parseIntent` extracts `policyName` (the filename verbatim, e.g. `30-days@lifecycle`) + `phasesPatch` (a nested object of only the changed fields). Policies use the **repo-verified nested shape**, validated by a structural validator before commit (SIO-931) — e.g. a `set_priority` mistake errors with a message naming `priority` as the nested field. `detectRetentionReduction` flags a shorter `delete.min_age` (cross-unit) as **HIGH risk surfaced first in the review and MR body — but never auto-blocked** (the human approves at the gate; CODEOWNERS gates merge).

- **Copy-from-reference (SIO-931):** a `sourcePolicy` field supports "exact copy of X with overrides"; from-scratch policies inherit structure from a sibling policy in the same cluster or a canonical fallback.
- **Multi-file in one MR (SIO-932):** a request naming N ILM policies opens **one** branch / **one** MR with all files (`ilmPolicies[]` array + `commitOneIlmPolicy` in an atomic batch); previously only the first file was committed and the rest were silently dropped.
- **Component-template bind (SIO-933):** an optional `bindTemplate` field (a cluster-defaults file basename, no `.json`) re-points that template's `settings.index.lifecycle.name` at the created/edited policy **in the same MR** — set it only when the user explicitly asks to bind/point/attach a template's lifecycle. A missing bind target 404s and blocks; bind works with a **single** policy only (not the multi-file path). A copied policy now diffs full-file on `policyCreated`, so the renamed `name` + inherited phases are visible in the review (previously the diff walked only the patch object and hid them).
- **Delete a policy file (SIO-1037):** the `ilm-delete` workflow removes one or more ILM policy files (`ilmDeletes[]`, each a `policyName` basename with the **leading dot preserved**, e.g. `.alerts-ilm-policy`) via an atomic `gitlab_commit_files` batch with `action: delete`. It is a pure clone of `cluster-default-delete` pointed at `lifecycle-policies/`: absent files are a per-file no-op, an all-absent request is a neutral no-op (no MR), and `reviewPlan`/`teardownIac` carry the same destructive-delete risk advisory. (Adds `ilm-delete` to `WORKFLOW_VALUES`; `proposeIlmDelete()` in `nodes.ts`.)

> The legacy `agents/elastic-iac/skills/add-ilm-policy/SKILL.md` and `knowledge/reference/iac-repo-map.md` describe an older `stacks/<cluster>/ilm.tf` (Terraform HCL) layout and are **stale**; the repo uses per-env JSON config.

## Fleet upgrade

The Fleet binary upgrade (SIO-913) is an imperative operation, not a config edit, so it runs through CI pipeline triggers rather than an MR: **preview → HITL gate → apply**, propose-only throughout.

- `detectFleetUpgrade` triggers a preview pipeline and parses the upgradeable / not-upgradeable crosstab plus the rollout window. Wolfi/container agents are not Fleet-upgradeable and are reported as skipped. It also parses the request's **scope** directly from the message text (like `deployment`/`version`, no `parseIntent`): a named host list (`selectedHostnames[]` -> `buildFleetHostSelector` builds a `local_metadata` KQL), a raw pasted KQL selector (`fleetSelector`, which wins over the host list), and an optional expected-count guard (`expectedAgentCount`, "must resolve to exactly N"). The resulting `requestedSelector` is threaded into the preview and **resent on apply** so scoping survives even if an operator overrides a count-mismatch warning (SIO-1032).
- `fleetUpgradeGate` is the `iac` HITL interrupt — counts + skip note; the only path to apply. When `expectedAgentCount` is set and differs from the resolved count, the gate card prepends a **WARNING** and the summary reports `willUpgrade` (agreeing with the gate card, fixing the earlier card-vs-summary count mismatch, SIO-1032).
- `applyFleetUpgrade` triggers the bulk-upgrade apply and streams live progress, signing off with one of three outcomes:
  - **`applied`** — the rollout completed within the poll budget.
  - **`dispatched`** (SIO-926) — started but still rolling at the budget boundary; signs off honestly as dispatched (not "failed") with an expected duration computed from `rolloutSeconds`. `fleetApplyPipelineId` is persisted so a follow-up "how's the upgrade?" re-polls live progress (routed to `pipeline-status`, SIO-929) **without re-triggering** the apply.
  - **`failed`** — a real pipeline failure (`failed_silent`/`UPG_FAILED` is the ground truth; `action_status` undercounts).
- The apply passes `MAX_AGENTS=resolvedCount` to clear Fleet's 500-agent cap (SIO-927). For an "all agents" request the agent omits the selector and the repo defaults `SELECTOR="*"`.

CI contract `fleet-upgrade-report/v1`: jobs `fleet-upgrade-{preview,apply}-on-demand`, vars `FLEET_UPGRADE_{PREVIEW,APPLY}`, artifact `fleet-upgrade-report.json`.

## Configuration

The GitOps target is resolved by the MCP server; the JSON paths are agent-side templates.

| Env var | Default | Owner |
|---------|---------|-------|
| `ELASTIC_IAC_GITLAB_BASE_URL` | `https://gitlab.com` | MCP |
| `ELASTIC_IAC_GITLAB_PROJECT` | `pvhcorp/dhco/observability/observability-elastic-iac` | MCP |
| `ELASTIC_IAC_GITLAB_TOKEN` | *(required)* | MCP |
| `ELASTIC_IAC_DEPLOYMENT_JSON_TEMPLATE` | `environments/_deployments/${cluster}.json` | agent |
| `ELASTIC_IAC_ILM_POLICY_TEMPLATE` | `environments/${cluster}/lifecycle-policies/${policy}.json` | agent |
| `IAC_PIPELINE_POLL_BUDGET_MS` | `90000` | agent |
| `IAC_PIPELINE_POLL_BUDGET_MS_EXTENDED` | `90000` | agent (SIO-989: capped at the default 90s) |
| `IAC_PIPELINE_POLL_INTERVAL_MS` | `10000` | agent |
| `ELASTIC_IAC_DRIFT_POLL_BUDGET_MS` | `90000` | MCP (SIO-989: 300s -> 90s; also derives the agent's elastic-iac tool timeout) |
| `ELASTIC_IAC_MCP_URL` | `http://localhost:9086` | agent (connects to MCP) |

`${cluster}` and `${policy}` are literal placeholders the agent substitutes (config, not JS template literals). See [Environment Variables](../configuration/environment-variables.md).

## MCP server (:9086)

`mcp-server-elastic-iac` exposes 36 tools. The GitLab subset (12) drives the proposer; the `propose` action maps `gitlab_get_file_content` / `gitlab_create_branch` / `gitlab_commit_file`, `review_pipeline` maps the read-only pipeline/approval tools. The server uses GitLab's REST API directly (the instance can't host MCP yet; migration is documented in `tools/gitlab.ts`). It already has the bridge-walking helpers (`childPipelineId`, `planJob`) used to reach the child pipeline's terraform report.

## What the agent does NOT do

- **Never merges, approves, or triggers apply** — human/CI only (DUTIES).
- **`watchPipeline` reports the MR _plan_ pipeline, not the post-merge apply.** After merge, the apply runs in a child `deploy` pipeline on `main` (job `apply:<cluster>:deployments`) that the agent does not track. A `pipeline-status` follow-up after merge still reports the plan. Closing this gap is tracked in [SIO-881](https://linear.app/siobytes/issue/SIO-881).
- **From-scratch creation is now supported for some resources** — ILM onboard honoring the user's exact phase set (SIO-1001/1011), `index-template-create` (SIO-978), and `ingest-pipeline-create` (SIO-1019). Multi-wave choreography and arbitrary new-resource types remain out of scope; an unhandled request (`workflow === "other"`) returns a capability-aware message.

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
