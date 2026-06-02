# Elastic IaC Agent — natural-language maker for Elastic Cloud Terraform

**Date:** 2026-06-02
**Status:** Shipped — retroactive design/reference doc (SIO-867). Implemented across commits `55d6533`, `1b8e67c`, `62b14d9`, `542f1eb`.
**Author:** documentation pass over the shipped feature
**Related code:** `agents/elastic-iac/`, `packages/agent/src/iac/`, `packages/mcp-server-elastic-iac/`, `apps/web/src/lib/server/agent.ts`, `apps/web/src/routes/api/agent/`

## Problem

The incident-analyzer answers "what is wrong?" across seven read-only datasources. It cannot answer "change it." Routine Elastic Cloud changes — resize a tier, roll out an ILM policy — are hand-written Terraform against the `observability-elasticcloud-deployments-terraform` GitLab repo, gated by a `gl-testing` pre-check and a human-reviewed merge request. That workflow is correct but slow and easy to get subtly wrong (downsizing a hot tier with unmanaged `.alerts`, skipping the sandbox pre-check, editing prod without intent).

The Elastic IaC agent is a **natural-language maker** for that workflow: it turns a request like *"downsize eu-b2b warm tier to 8 GB"* into a minimal Terraform diff on a working branch, validates it, runs the `gl-testing` pre-check, surfaces a plan for human review, and — only on approval — opens a GitLab MR. It never applies and never merges its own MR.

## Goals

- A second agent, **peer** to the incident-analyzer (its own graph, state, and checkpointer thread) — not an 8th incident sub-agent.
- Strict **maker/checker** separation of duties: the agent reads, drafts, plans, and opens MRs; humans review, approve, and trigger pipelines.
- A **human-in-the-loop (HITL)** gate: the proposed diff + `terraform plan` + risks are surfaced in the UI and the graph pauses until the user approves or rejects.
- Mechanical safety **guards** enforced deterministically (in code, never LLM-judged) before any diff is drafted.
- A single **unified MCP server** (`elastic-iac-mcp`, :9086) exposing every tool the workflow needs (terraform, git, gitlab, elastic) behind one facade.

## Non-goals

- No `terraform apply` / `destroy` — the MCP server has no apply/destroy tools at all (read/plan/branch-only).
- No merging or approving its own MRs (maker ≠ checker ≠ executor).
- No pushing to `main`/`master`; working branches are `agent/*` only.
- No changes to the incident-analyzer 20-node pipeline (the two graphs are independent).

## Architecture

```text
apps/web UI (robot-icon agent toggle)  currentAgent = "elastic-iac"
    | POST /api/agent/stream { agentName: "elastic-iac", messages }
    v
apps/web/src/lib/server/agent.ts :: invokeAgent()
    | agentName === "elastic-iac" -> getIacGraph()  (else getGraph())
    v
packages/agent/src/iac/graph.ts  (9-node StateGraph, IacState, own checkpointer thread)
    bootstrap -> parseIntent -> readClusterState -> guard -> draftChange
        -> reviewPlan -> reviewGate (HITL interrupt) -> openMr -> teardown
    |                                   ^
    | MCP tool calls                    | interrupt: iac_clarify / iac_plan_review
    v                                   | resume: POST /api/agent/iac/resume
packages/mcp-server-elastic-iac (:9086/mcp, role "elastic-iac-mcp")
    terraform_* | git_* | gitlab_* | elastic_*  (23 tools)
        |                    |              |
        v                    v              v
   terraform CLI      git + GitLab REST   Elastic Cloud API
                      (observability-elasticcloud-deployments-terraform, project 71488350)
```

The two graphs share the LangGraph runtime, the checkpointer package, and the MCP bridge, but nothing else: `IacState` (`packages/agent/src/iac/state.ts`) is a separate annotation from the incident `AgentState`, and each conversation runs on its own checkpointer thread.

## The agent definition (`agents/elastic-iac/`)

Declared the same gitagent way as the incident sub-agents, but as a top-level peer.

| File | Purpose |
|------|---------|
| `agent.yaml` | Name `pvh-elastic-iac-agent`; model `claude-opus-4-6` (fallback `claude-sonnet-4-6`); single `elastic-iac` tool facade; 5 skills; compliance/SoD block. |
| `SOUL.md` | Identity as a **maker** in a maker/checker pipeline — reads live state, drafts a minimal diff, opens one MR; refuses to apply, skip `gl-testing`, or merge its own MR. |
| `RULES.md` | Hard constraints: always pre-check on `gl-testing`; read live state before drafting; one MR per wave; tier-downsize ordering; disclose secondary risks; never apply, never push to `main`, never print secrets, never touch prod without explicit instruction; gate hot-tier downsize on managed `.alerts`. |
| `skills/`, `knowledge/`, `workflows/`, `hooks/` | `resize-tier`, `add-ilm-policy`, `pre-check-gl-testing`, `open-mr`, `validate-cluster-state` skills; repo map / conventions / cluster inventory knowledge; `tier-resize` and `ilm-rollout` workflows. |

**Separation of duties** (from `agent.yaml`): planner + maker roles belong to `pvh-elastic-iac-agent` (read, plan, write_branch, open_mr); checker + executor roles belong to a human reviewer (review, approve, reject, trigger_pipeline). The agent is structurally barred from the checker/executor roles.

## The maker graph (`packages/agent/src/iac/graph.ts`)

`buildIacGraph({ checkpointerType?: "memory" | "sqlite" })` compiles a 9-node `StateGraph` over `IacState`.

| Node | Role | Outbound edge |
|------|------|---------------|
| `bootstrap` | Verify the `elastic-iac-mcp` connection; fail fast if unreachable. | `connected ? parseIntent : END` |
| `parseIntent` | LLM extracts the change intent (workflow, cluster, tier, sizes, policy, prod flag). May raise an `iac_clarify` interrupt. | `readClusterState` |
| `readClusterState` | MCP: `elastic_cloud_get_deployment` + `elastic_ilm_get_lifecycle(.alerts)`; snapshot current size and `.alerts` managed status. | `guard` |
| `guard` | Deterministic safety guards (max ≥ current; hot-tier downsize requires managed `.alerts`). Sets `blockedReason` to stop. | `blockedReason ? END : draftChange` |
| `draftChange` | LLM writes a **minimal** Terraform diff on a new `agent/<slug>-<yyyymmdd>` branch. No apply. | `reviewPlan` |
| `reviewPlan` | MCP: `terraform_validate` + `terraform_plan`; run the `gl-testing` pre-check; collect `risks[]`. | `reviewGate` |
| `reviewGate` | **HITL interrupt** (`iac_plan_review`): surface `IacPlanReview` (cluster, branch, title, diff, plan, risks, precheckPassed) and pause. | `reviewDecision === "approved" ? openMr : teardown` |
| `openMr` | MCP: `git_push` + `gitlab_create_merge_request`; capture the MR URL. | `teardown` |
| `teardown` | Final message: MR link, or the rejection / blocked reason. | `END` |

### Human-in-the-loop interrupts

Two `interrupt()` points, both surfaced over SSE and resumed via `POST /api/agent/iac/resume`:

1. **`iac_clarify`** (in `parseIntent`) — when the cluster or change is ambiguous, the graph pauses with a one-line `question` and resumes with `{ answer }`.
2. **`iac_plan_review`** (in `reviewGate`) — the graph pauses with the full review payload and resumes with `{ decision: "approved" | "rejected" }`.

`IacState` (`state.ts`) carries the workflow: `requestId`, `iacRequest`, `clusterState`, `branch`, `proposedDiff`, `terraformPlan`, `risks[]`, `precheckPassed`, `planReview`, `reviewDecision`, `mrUrl`, `connected`, `blockedReason`.

## The MCP server (`packages/mcp-server-elastic-iac`, :9086)

`@devops-agent/mcp-server-elastic-iac` boots via the shared `createMcpApplication()` with role `elastic-iac-mcp` and serves `:9086/mcp`. Unlike the seven datasource servers (which use the 4-pillar `config/` directory), it uses a single `src/config.ts` `loadConfig()` with a Zod schema and explicit env fallbacks. It is deliberately **read/plan/branch-only** — there are no apply or destroy tools.

**23 tools across four families** (registered in `src/server.ts`):

- **Terraform (5):** `terraform_fmt`, `terraform_validate`, `terraform_plan`, `terraform_search_modules`, `terraform_search_providers` — all read-only / local sanity checks.
- **Git (7):** `git_clone`, `git_checkout`, `git_create_branch` (`agent/*` only), `git_commit`, `git_push` (never `main`/`master`, never `--force`), `git_status`, `git_diff`.
- **GitLab (5):** `gitlab_get_repository_tree`, `gitlab_get_file_content`, `gitlab_create_merge_request` (squash + remove-source-branch; never merges/approves), `gitlab_get_merge_request`, `gitlab_get_merge_request_pipelines`.
- **Elastic Cloud (6):** `elastic_cloud_list_deployments`, `elastic_cloud_get_deployment`, `elastic_cloud_get_plan_history`, `elastic_get_cluster_health`, `elastic_get_index_template`, `elastic_ilm_get_lifecycle`.

The agent reaches it via the single `elastic-iac` tool facade, whose `action_tool_map` (`agents/elastic-iac/tools/elastic-iac.yaml`) scopes the 23 tools per action (`read_state`, `read_repo`, `draft`, `plan`, `open_mr`, `review_pipeline`).

### GitLab REST now, native MCP later (commit `542f1eb`)

The GitLab tools call the GitLab REST API (`/api/v4`) directly because the target instance does not yet expose native MCP. The intended end-state is to switch them to the native-MCP proxy pattern used by `packages/mcp-server-gitlab` once the instance supports it; the server's self-contained isolation stays the same.

## UI integration (`apps/web`)

- **Agent toggle** — `agentStore.currentAgent: "incident-analyzer" | "elastic-iac"` (`lib/stores/agent.svelte.ts`); the robot icon in `routes/+page.svelte` calls `switchAgent()`, which clears the chat and switches graphs.
- **Plan-review SSE** — `lib/server/sse-pump.ts :: emitIacInterrupt()` translates the graph's interrupts into SSE events: `iac_clarify` (`{ threadId, question }`) and `iac_plan_review` (`{ threadId, review, message }`). `lib/stores/agent-reducer.ts` routes them into `iacClarify` / `iacPlanReview` store state.
- **Review card** — `lib/components/PlanReviewCard.svelte` renders cluster, branch, title, the Terraform diff and plan (collapsible), the risk list, and the pre-check status, with Approve / Reject buttons.
- **Resume** — `POST /api/agent/iac/resume` with `{ threadId, decision?, answer? }` resumes the interrupted graph and streams the continuation (including any follow-on interrupt) back over SSE.

## Running locally

```bash
# 1. Start the IaC MCP server (:9086)
bun run --filter @devops-agent/mcp-server-elastic-iac dev

# 2. Point the agent at it (.env)
#    ELASTIC_IAC_MCP_URL=http://localhost:9086
#    GITLAB_PERSONAL_ACCESS_TOKEN=...   (for MR creation / repo reads)
#    EC_API_KEY=...                     (for Elastic Cloud reads)

# 3. Start the web app and toggle to the IaC agent (robot icon)
bun run --filter @devops-agent/web dev   # http://localhost:5173
```

Then type e.g. *"downsize eu-b2b warm tier to 8 GB"*: the graph parses intent (may ask a clarifying question), reads live cluster state, runs the guards, drafts a diff, plans + pre-checks, pauses for your approval in the plan-review card, and opens an MR only if you approve.

See [Environment Variables → Elastic IaC MCP](../../configuration/environment-variables.md#elastic-iac-mcp) for the full variable list and [MCP Server Configuration → Elastic IaC MCP Server](../../configuration/mcp-server-configuration.md#elastic-iac-mcp-server) for the config schema.

## Testing

| Test | Coverage |
|------|----------|
| `packages/agent/src/iac/graph.test.ts` | Graph compiles; exposes `streamEvents`/`getState`; contains the `guard`/`reviewGate`/`openMr`/`teardown` nodes. |
| `packages/agent/src/iac/guards.test.ts` | The mechanical guards (max ≥ current; hot-tier downsize requires managed `.alerts`). |
| `packages/mcp-server-elastic-iac/src/server.test.ts` | Config defaults (port 9086, project 71488350); server constructs and exposes `connect`. |

## Safety model (summary)

1. **No apply path exists** — the MCP server ships no apply/destroy tools, so the agent cannot mutate live infrastructure even if instructed.
2. **Deterministic guards** run before drafting (`guard` node / `guards.ts`), independent of the LLM.
3. **Mandatory `gl-testing` pre-check** before review.
4. **HITL gate** — no MR without explicit human approval.
5. **Branch/merge constraints** — `agent/*` branches only, never push to `main`, never merge its own MR.
6. **Secrets** — credentials (`GITLAB_PERSONAL_ACCESS_TOKEN`, `EC_API_KEY`) are server-side only and never printed.

## Future work

- Switch the GitLab tools to native MCP once the instance exposes it (`542f1eb`).
- Optional estate/prod confirmation parity with the incident agent's routing.
