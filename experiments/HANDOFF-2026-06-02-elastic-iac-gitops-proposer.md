# Handover — elastic-iac GitOps proposer arc (SIO-870 → SIO-878)

- **Date**: 2026-06-02 (updated after SIO-879)
- **Repo state**: branch `main`, HEAD `1268a79` (PR #180 merge). All Done tickets merged; the only open elastic-iac ticket is SIO-880 (ILM, Backlog).
- **Tickets** (all Done unless noted): [SIO-870](https://linear.app/siobytes/issue/SIO-870), [SIO-871](https://linear.app/siobytes/issue/SIO-871), [SIO-872](https://linear.app/siobytes/issue/SIO-872), [SIO-873](https://linear.app/siobytes/issue/SIO-873), [SIO-874](https://linear.app/siobytes/issue/SIO-874), [SIO-875](https://linear.app/siobytes/issue/SIO-875), [SIO-876](https://linear.app/siobytes/issue/SIO-876), [SIO-877](https://linear.app/siobytes/issue/SIO-877), [SIO-878](https://linear.app/siobytes/issue/SIO-878), [SIO-879](https://linear.app/siobytes/issue/SIO-879). PRs #170–#180. **Open: [SIO-880](https://linear.app/siobytes/issue/SIO-880)** (ilm-rollout migration, Backlog).
- **Suggested branch for follow-on work**: `sio-880-<topic>` off `main` (ILM is the next obvious piece).

## TL;DR

The `elastic-iac` agent was re-architected from a broken local-terraform "maker" into a **pure GitOps proposer**: it classifies intent, answers read-only questions, and for changes (version-upgrade + tier-resize so far) it edits the deployment JSON, commits a branch + opens an MR **entirely via the GitLab REST API** (no clone, no terraform, no local git), then watches the MR's CI pipeline and reports the real Terraform plan + approval + failure cause. It never merges or applies — CI + a human do that (maker/checker SoD). Proven end-to-end against the live self-hosted instance `gitlab.siobytes.cloud/siobytes/elastic-iac`; real version-upgrade MRs (!43 ap-cld, !44 eu-b2b) are already merged through the loop. Everything works today on `main`.

## Context — how this arc came to be

The user asked whether elastic-iac could answer multi-deployment questions like `mcp-server-elastic` and distinguish "gitops action" from "request for information." That surfaced a deeper problem: the maker forced **every** request through a local-execution pipeline (clone `/tmp/elastic-iac-workspace`, run `terraform`, `git push`) that (a) was the wrong model and (b) didn't work (terraform ENOENT, MR-400 because no branch existed). The authoritative design is the deck **"Elastic Cloud Observability · IaC Monorepo"** (in repo root as a PDF, private reference), especially **p.18 "Agent proposes · GitOps disposes"** and **p.11** (a version bump is one JSON field). The arc rebuilt the agent to that model.

## Current architecture (what's on `main`)

**IaC graph** (`packages/agent/src/iac/graph.ts`, 12 nodes):
```
START -> bootstrap -> classifyIacIntent
  classifyIacIntent --(info)--> answerInfo -> END
  classifyIacIntent --(pipeline-status)--> watchPipeline -> teardown -> END
  classifyIacIntent --(gitops)--> parseIntent -> readClusterState -> guard
     guard --(blocked)--> END
     guard --> draftChange --(blocked)--> END
     draftChange -> reviewPlan -> reviewGate (HITL interrupt iac_plan_review)
        reviewGate --(approved)--> openMr -> watchPipeline -> teardown -> END
        reviewGate --(rejected)--> teardown -> END
```
Separate graph + checkpointer from the incident pipeline (`buildGraph`). HITL via `interrupt`; resume through `/api/agent/iac/resume`.

**The GitOps target is configurable** (resolved by the MCP server): `ELASTIC_IAC_GITLAB_BASE_URL` (default `https://gitlab.siobytes.cloud`), `ELASTIC_IAC_GITLAB_PROJECT` (default `siobytes/elastic-iac`), `ELASTIC_IAC_GITLAB_TOKEN` (**required**; the gitlab.com PAT 401s against siobytes). The per-deployment JSON path is **agent-side** (`ELASTIC_IAC_DEPLOYMENT_JSON_TEMPLATE`, default `environments/_deployments/${cluster}.json`). Poll knobs: `IAC_PIPELINE_POLL_BUDGET_MS` (90s), `IAC_PIPELINE_POLL_INTERVAL_MS` (10s). See `.env.example`.

## What each ticket delivered

- **SIO-870** (#170): `classifyIacIntent` node (info vs gitops); `answerInfo` read-only tool-loop; `elastic_cloud_list_deployment_versions` MCP tool (multi-deployment versions); fixed `readClusterState` cluster→deploymentId resolution.
- **SIO-871** (#171): `version-upgrade` workflow + `version` field; **null-tolerant** `parseIntentJson` (planner emits `null` for absent optionals; `.nullish()` + normalize) — was causing spurious clarifies.
- **SIO-872** (#172): fixed the dead Bedrock alias — `claude-opus-4-6` → `eu.anthropic.claude-opus-4-6-v1` in `packages/gitagent-bridge/src/model-factory.ts` (bare id was invalid; everything silently ran on the sonnet fallback).
- **SIO-873** (#173): the core re-architecture — GitOps proposer. New `gitlab_create_branch` + `gitlab_commit_file` MCP tools; `setDeploymentVersion` read-modify-write; `draftChange→proposeVersionUpgrade`; `reviewPlan` skips terraform for config edits; `openMr` skips git_push. Dropped local terraform/git from the upgrade path.
- **SIO-874** (#174, #175): MR presentation — `kind: config-edit|terraform` on the review; kind-aware `PlanReviewCard.svelte` (no false "Terraform plan/gl-testing" wording); `extractMrUrl` parses `web_url` (was matching the gravatar URL); MR body generated from the agent's own `knowledge/mr-template.md` via the LLM; resolved-value sections (no checkbox menus); refreshed the template cluster list to the real 10-cluster fleet.
- **SIO-875** (#176): `watchPipeline` node — polls the MR pipeline, walks parent→child dynamic pipeline to the plan job's `tfplan-report.json`, reports pass/fail + real plan (create/update/delete + resources) + approval. Tools `gitlab_get_pipeline`, `gitlab_get_pipeline_terraform_report`, `gitlab_get_merge_request_approvals`.
- **SIO-876** (#178): live mid-poll streaming — `dispatchCustomEvent("iac_pipeline_progress")` → SSE pump `on_custom_event` → reducer/store ticker → UI; collapses to the final message.
- **SIO-877** (#177): "check my MR" survives reloads — `gitlab_list_agent_merge_requests` + `parseLatestAgentMr`; `watchPipeline` falls back to the newest open agent MR when the thread has no `mrIid`; lifted the classifier guard.
- **SIO-878** (#179): failed-pipeline diagnosis — `gitlab_get_pipeline_plan_log` (tail of the failed plan job trace) + `classifyPipelineFailure` (recognizes the Terraform state-lock pattern) → `failureHint` rendered in teardown; `conventions.md` documents the single-shared-state lock nuance.
- **SIO-879** (#180): moved **tier-resize** to the GitOps proposer. `setDeploymentTierSize` (read-modify-write `elasticsearch.<tier>.size`/`.max_size`, strings `"<N>g"`) + `proposeTierResize` node (mirrors `proposeVersionUpgrade`); `draftChange` routes it; `parseIntent` extracts `tier`/`newSizeGb`/`newMaxGb`. Generalized `reviewPlan`'s `isUpgrade`→`isConfigEdit` (version-upgrade OR tier-resize → `kind: config-edit`); `openMr` keys off `review.kind` to skip git_push; `buildMrDescription` is workflow-aware (tier-resize → Category tier-resize / Risk MEDIUM). `guards.ts` unchanged (max≥size + hot-downsize .alerts gate already cover it). Verified live (eu-cld-monitor warm max 120g→60g → MR → plan `1 update`). **ilm-rollout still on the legacy path → SIO-880.**

## Where the bodies are buried (key file:line, all on `main`)

- `packages/agent/src/iac/nodes.ts` — all nodes + pure helpers (each exported + unit-tested):
  - `parseIntentJson:63`, `intentFromText:95`, `setDeploymentVersion:299`, `setDeploymentTierSize:315`, `extractMrUrl:602`, `extractMrIid:692`, `parseNewestPipeline:705`, `parseLatestAgentMr:723`, `parsePlanReport:739`, `formatPlanSummary:781`, `classifyPipelineFailure:789`. (Line numbers drift with edits — `grep -n "export function"` to refresh.)
  - Node-level proposers (not exported): `proposeVersionUpgrade`, `proposeTierResize:440`, `watchPipeline`, `teardownIac`. `draftChange` routes version-upgrade + tier-resize to the proposers; everything else falls through to the legacy terraform path.
  - `callTool` returns `"[status] body"`; every parse helper strips that prefix before JSON.parse.
- `packages/agent/src/iac/graph.ts` — the 12-node wiring above.
- `packages/agent/src/iac/state.ts` — `IacState` (incl. `intent`, `mrIid`, `pipelineStatus`, `planReport`, `approvalState`, `failureHint`).
- `packages/mcp-server-elastic-iac/src/tools/gitlab.ts` — all GitLab REST tools + pure walk helpers `childPipelineId`, `planJob`, `buildCommitFileBody`. 36 tools live on :9086.
- `packages/mcp-server-elastic-iac/src/config.ts` — the `gitops` config block (siobytes target).
- `packages/agent/src/llm.ts` — roles `iacClassifier`, `iacReader` (in `TOOL_BINDING_ROLES`), plus `createLlmWithTools` (binds tools to primary+fallback; needed because the manifest's preferred model went through the fallback).
- `apps/web/src/lib/server/sse-pump.ts` — `on_custom_event(iac_pipeline_progress)` forwarding.
- `apps/web/src/lib/stores/agent.svelte.ts` + `agent-reducer.ts` — `iacPipelineProgress` ticker state.
- `apps/web/src/lib/components/PlanReviewCard.svelte` + `apps/web/src/routes/+page.svelte` — kind-aware review card + live ticker render.
- `packages/shared/src/agent-state.ts` — `StreamEventSchema` (`iac_pipeline_progress` member).
- `agents/elastic-iac/` — `tools/elastic-iac.yaml` (action→tool map; `propose`/`review_pipeline` actions), `knowledge/mr-template.md` (MR house style), `knowledge/conventions.md` (lock nuance), `RULES.md`/`SOUL.md`.

## How to verify (copy-paste)

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer
bun run typecheck && bun run lint && bun run yaml:check
bun test packages/agent/src/iac
bun test packages/mcp-server-elastic-iac
```
Live MCP probe (server on :9086; needs `ELASTIC_IAC_GITLAB_TOKEN` in `.env`):
```bash
# read a deployment JSON
curl -s http://localhost:9086/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gitlab_get_file_content","arguments":{"filePath":"environments/_deployments/ap-cld.json"}}}'
```
Browser e2e (cold-restart the web server first — see gotcha below): switch to the Elastic IaC agent, `Upgrade <cluster> to 9.4.2` → approve → watch the live ticker → final shows pipeline status + real plan + approval; reload → "check my MR" recovers it. **Always close the test MR + delete the branch after** (the `deployments` stack shares one state — see lock note). Screenshots from this arc: `experiments/sio874-*.png`, `experiments/sio876-live-ticker.png`.

## Gotchas hit (don't re-learn these)

1. **Cold restart for agent-definition + graph changes.** A running web server caches the loaded agent (`agentRegistry` in `prompt-context.ts`) AND `bun --hot` doesn't re-resolve workspace packages. Any edit to `agents/elastic-iac/**` (knowledge/SOUL/RULES/skills/mr-template) or new graph nodes needs `kill $(lsof -i :5173 -sTCP:LISTEN -t) && bun run --filter @devops-agent/web dev`. Memory: `reference_agent_knowledge_cached_per_process`, `reference_bun_hot_does_not_reresolve_modules`.
2. **No module-scope `Bun.env` in `packages/agent`.** The web app runs Vite SSR (not Bun); a top-level `Bun.env` throws "Bun is not defined" at import and 500s every agent route. Read env lazily inside a function via `process.env`. Memory: `reference_no_module_scope_bun_env_in_agent`. (SIO-873 hit this.)
3. **`deployments` stack = single shared Terraform state.** All 10 clusters share one state, so concurrent agent MRs contend on one lock; a stale lock fails the next plan with `Error acquiring the state lock`. SIO-878 detects + explains it. Don't fire many test MRs back-to-back; clean them up. Operator force-unlocks (agent never does).
4. **Branch names are deterministic** (`agent/<cluster>-<version>-version-upgrade-<yyyymmdd>`), so re-proposing the same upgrade while its MR is open returns a clean `409 already exists`. Not a bug.
5. **Test-MR hygiene**: every browser e2e opens a REAL MR + branch + commit on siobytes (before approval too — the branch/commit happen in `draftChange`). Close the MR (`PUT .../merge_requests/<iid>?state_event=close`) and delete the branch (`DELETE .../repository/branches/<encoded>`) after. `main` deployment JSONs must stay untouched.

## Risks / what to watch

| Risk | Mitigation |
|---|---|
| Manifest model `claude-opus-4-6` was a dead alias | Fixed in SIO-872; but the manifest still *prefers* opus — confirm it actually resolves on deploy, else it falls back to sonnet silently |
| Self-hosted approvals API is license-gated | Verified present on siobytes; tools degrade to "unavailable" if a future instance lacks it |
| CI report path (`stacks/<stack>/tfplan-report.json`) tracks the repo's generator | `gitlab_get_pipeline_terraform_report` derives `<stack>` from the job name; returns a clear "not found" rather than crashing if CI changes |

## Out of scope (explicitly not done)

- **ilm-rollout** still uses the **legacy local-terraform path** — it's the last workflow not yet on the GitOps proposer. Tracked in **[SIO-880](https://linear.app/siobytes/issue/SIO-880)** (Backlog): materially bigger than version-upgrade/tier-resize — full policy documents under `environments/<deployment>/lifecycle-policies/<policy>.json` (not `_deployments/`) + a multi-wave, multi-environment, MR-per-wave choreography (gl-testing→dev→stg→prod, human gate between waves). Needs a design pass (single-wave-per-invocation vs. full choreography). version-upgrade + tier-resize are **done**.
- The agent never approves, merges, or triggers apply (DUTIES — human/CI only).
- Migrating the GitLab REST calls to GitLab's native MCP (the instance can't do MCP yet; `tools/gitlab.ts` header documents the intended migration).
- A standalone pipelines dashboard.

## Memory references

`project_elastic_iac_gitops_proposer_model`, `reference_agent_knowledge_cached_per_process`, `reference_no_module_scope_bun_env_in_agent`, `reference_bun_hot_does_not_reresolve_modules`, `reference_gitlab_internal_vs_public`, `feedback_guides_not_in_repo`.
