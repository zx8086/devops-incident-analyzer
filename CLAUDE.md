# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-datasource DevOps incident analysis agent. A LangGraph supervisor orchestrates 7 specialist sub-agents (elastic-agent, kafka-agent, capella-agent, konnect-agent, gitlab-agent, atlassian-agent, aws-agent) that query existing MCP servers (210+ tools total) to correlate incidents across Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, GitLab, Atlassian, and AWS. Bun workspace monorepo with gitagent declarative agent definitions (YAML/Markdown) bridged to LangGraph TypeScript.

## Current State

Fully implemented monorepo with 10 packages, 7 MCP servers, a 31-node LangGraph pipeline (21 base + 4 gated KG + 6 gated HIL-learning nodes; SIO-681 added `correlationFetch` + `enforceCorrelationsAggregate` between aggregate and checkConfidence; SIO-764 added `extractFindings` after aggregate; SIO-828 added `awsEstateRouter` between entityExtractor and the fan-out; SIO-1084 added `resolveIdentifiers` between awsEstateRouter and the fan-out; `detectTopicShift` runs on follow-up turns; mitigation is split into `proposeInvestigate` / `proposeMonitor` / `proposeEscalate` + `aggregateMitigation`; SIO-1126 added the 6-node HIL learning lane off `classify`; SIO-1030 focus-scopes finding cards via `matchesFocus()` and SIO-1031 grounds IAM/permission blockers in observed auth errors; SIO-1204 builds a per-incident network map (pure builder in extractFindings/aggregate, ECharts NetworkTopologyCard via the network_topology SSE event) and persists static topology + bi-temporal IP bindings to the KG with a KG-cache-first reverse-IP step, backed by SIO-1205's new ELBv2/Route53/DescribeSubnets MCP tools and ingress_state action), gitagent declarative agent definitions, and a SvelteKit frontend. The separate 31-node elastic-iac proposer graph now offers an `ilm-delete` workflow (SIO-1037) and a pre-fan-out `recordIacPrompt` node that captures each turn's verbatim prompt to the knowledge graph (`Prompt` node) and agent memory (SIO-1038); SIO-1285 added the `selectIacKnowledge` node between `classifyIacIntent` and the intent fan-out, which narrows the prompt's knowledge categories per intent (deterministic, no model call -- it reuses the intent the classifier already computed) and dropped the always-on `_archive`/`health-snapshots` categories, reducing the unconditional prompt from 568,446 bytes to 485,959, with `gitops` at 357,844 and `converse` at 154,237 while `info` (the classifier's catch-all) stays deliberately unnarrowed; SIO-1196 grounded the version-upgrade no-op decision in the LIVE deployment (three-way repo/live/target check; repo==target with live!=target auto-routes `draftChange -> explainDrift` into the drift-reconcile lane with `liveReconcilable: false`, attributing the unapplied MR + pending manual apply job), added live-parity advisories for the deployment-JSON workflows, a repo-only caveat on all remaining repo-only no-ops, and made `gitlab_get_merge_commit_apply_result` prefer push-source pipelines. All MCP servers use a unified bootstrap (`createMcpApplication` from `@devops-agent/shared`) with standardized logging, 3 transport modes (stdio/http/agentcore), and action-driven tool selection replacing regex filtering. GitLab MCP uses a proxy pattern (forwarding to GitLab's native `/api/v4/mcp` endpoint) plus custom code-analysis tools. The `devops-incident-analyzer-setup-guide.md` is the original architecture blueprint (historical reference).

## Architecture

### Monorepo Structure

```
agents/                    Gitagent YAML/Markdown definitions
  incident-analyzer/       Orchestrator: agent.yaml, SOUL.md, RULES.md, tools/, skills/
    agents/                Sub-agents: elastic-agent/, kafka-agent/, capella-agent/, konnect-agent/, gitlab-agent/, atlassian-agent/, aws-agent/
packages/
  gitagent-bridge/         YAML-to-LangGraph adapter (manifest loading, tool mapping, prompt construction)
  agent/                   LangGraph supervisor + 31-node pipeline (21 base + 4 gated KG + 6 gated HIL-learning; incl. SIO-681 correlation enforcement, SIO-764 findings extraction, SIO-828 AWS estate router, SIO-1084 resolveIdentifiers, mitigation split into investigate/monitor/escalate, detectTopicShift, SIO-1126 HIL learning lane)
  mcp-server-elastic/      Elasticsearch MCP server (multi-deployment, 117 tools: 101 cluster incl. 9 ML anomaly-detection (SIO-1148) + 4 ES|QL/async-search (SIO-1391) + 16 conditional cloud/billing on EC_API_KEY)
  mcp-server-kafka/        Kafka MCP server (local/MSK/Confluent, 11-61 tools gated: kafka-core + SR + ksqlDB + Connect + REST Proxy)
  mcp-server-couchbase/    Couchbase Capella MCP server (query analysis, playbooks, ~39 tools: SIO-1107 official Couchbase tools)
  mcp-server-konnect/      Kong Konnect MCP server (API gateway management, 67+ tools)
  mcp-server-gitlab/       GitLab MCP server (proxy + code analysis, 21+ tools)
  mcp-server-atlassian/    Atlassian MCP server (Jira + Confluence proxy via Rovo OAuth 2.1)
  mcp-server-aws/          AWS MCP server (multi-estate via cross-account AssumeRole; CloudWatch, EC2, ECS, Lambda, RDS, S3, X-Ray, etc.)
  shared/                  Cross-package types, Zod schemas, unified bootstrap, AgentCore proxy, Agent Memory REST client (SIO-938)
  checkpointer/            Transient per-thread LangGraph state (memory + bun:sqlite)
  observability/           OpenTelemetry + LangSmith, Pino logging
apps/
  web/                     SvelteKit frontend (Svelte 5 runes, Tailwind, SSE streaming)
```

### Agent Pipeline (31-node LangGraph StateGraph: 21 base + 4 gated KG + 6 gated HIL-learning)

```text
START -> classify -> {simple: responder -> followUp -> END, complex: normalize}
  -> [selectRunbooks] -> entityExtractor -> [awsEstateRouter ->] [resolveIdentifiers ->] detectTopicShift -> fan-out [elastic, kafka, capella, konnect, gitlab, atlassian, aws]
  -> align -> aggregate -> extractFindings -> {enforceCorrelationsRouter}
  -> [correlationFetch ->] enforceCorrelationsAggregate
  -> checkConfidence -> validate -> {mitigationRouter}
  -> {proposeInvestigate | proposeMonitor | proposeEscalate} -> aggregateMitigation
  -> followUp -> END
```
(`detectTopicShift` sits between `resolveIdentifiers` and the supervisor fan-out; it fast-paths to a no-op on first turns and only interrupts for cross-turn topic shifts on follow-up turns.)

The `enforceCorrelationsRouter` (SIO-681) sits between `aggregate` and `checkConfidence`; it dispatches `correlationFetch` Sends for any unsatisfied correlation rule (e.g. kafka-significant-lag must have a matching elastic-agent finding), then `enforceCorrelationsAggregate` re-evaluates rules and caps `confidenceCap` at 0.6 when rules remain degraded. See `docs/architecture/agent-pipeline.md` for the full diagram and rule list. SIO-764 added the `extractFindings` node immediately after `aggregate`; it reads each sub-agent's `toolOutputs[]` and derives per-domain typed findings (`kafkaFindings`) onto the `DataSourceResult` for the rule engine to consume. SIO-828 added `awsEstateRouter` between `entityExtractor` and the fan-out; when AWS is in `dataSources`, it expands a single AWS dispatch into one Send per target estate (cross-account AssumeRole) so the LLM never sees per-account credentials. SIO-850 added two opt-in knowledge-graph nodes (`recordEntities` + `graphEnrich`) between `entityExtractor` and `awsEstateRouter`, and SIO-1026 added a third (`recordRootCause`, after `aggregateMitigation`), reachable only when `KNOWLEDGE_GRAPH_ENABLED=true` (the SIO-640 edge-gate idiom: registered always, edged only when enabled). SIO-1084 added a `resolveIdentifiers` node between `awsEstateRouter` and `detectTopicShift` that resolves the loose incident service to per-datasource canonical identifiers before fan-out (always edged; `RESOLVE_IDENTIFIERS_ENABLED` defaults ON, self-skips via runtime early-return when set to `false`). SIO-1100 added a fourth gated KG node `recordBindings` (after `recordRootCause`, in the `recordRootCause -> recordBindings -> followUp` tail) that MERGEs the turn's confirmed telemetry bindings (W8; `KG_BINDINGS_WRITE_ENABLED` defaults ON, needs `KNOWLEDGE_GRAPH_ENABLED`, writes are additive + soft-failing so they never change the answer). SIO-1126 added the 6-node HIL learning lane (`learnFetchTicket` / `learnMatchIncident` / `learnMatchGate` / `learnDistill` / `learnReviewGate` / `applyLearnings`), routed off `classify` on an explicit `learn from TICKET-123` command and gated by `HIL_LEARNING_ENABLED` (defaults ON; kill-switch). Verified node count: `grep -c addNode packages/agent/src/graph.ts` = 31 (21 base + 4 gated KG + 6 gated HIL-learning).

### Live Memory + Agent Memory backend (SIO-938)

Both agents keep durable cross-session **live memory**, distinct from the checkpointer (which is transient per-thread graph state only). The single writer is `packages/agent/src/memory-writer.ts` (`readLiveMemory` / `appendDailyLog` / `recordKeyDecision`), gated by `LIVE_MEMORY_ENABLED`, always PII-redacted. Storage is swappable via `LIVE_MEMORY_BACKEND`:

- `file` (default): git-tracked markdown under `agents/<agent>/memory/runtime/*.md` + `memory/wiki/`.
- `agent-memory`: the Couchbase Agent Memory REST service. `context`/`key-decisions`/wiki -> durable **facts** (no TTL); `dailylog` turns -> conversational **messages** (short TTL via `AGENT_MEMORY_DAILYLOG_TTL_SECONDS`); semantic recall over past sessions at bootstrap. One Agent Memory user per agent (`incident-analyzer`, `elastic-iac`); threadId = session_id.

The backend is a direct REST client in `packages/shared/src/agent-memory.ts` (no MCP server, no LLM tool surface). It is wired through the `lifecycle.ts` registration seams (`registerMemoryRecaller` / `registerMemoryFlusher`, installed by `installAgentMemory()` in `apps/web/src/lib/server/agent.ts`). A **write-behind queue** in `memory-backend.ts` bridges the synchronous writer to async REST and drains at session teardown, so the writer signatures and the default file path are unchanged when the backend is unset. Env: `AGENT_MEMORY_BASE_URL`, `AGENT_MEMORY_ENABLED`, `AGENT_MEMORY_BEARER_TOKEN` (OIDC). Spec: `docs/superpowers/specs/2026-06-17-couchbase-agent-memory-backend-design.md`.

### Checkpointer state pruning (SIO-476)

The LangGraph checkpointer's `messages` array is bounded per turn so long-lived threads do not grow unboundedly. `packages/agent/src/state-pruning.ts` is a pure pair: `needsPruning(messages, config)` (gate: non-system count > `maxMessages`, default 20) and `pruneState(messages, config)` returning `{ removeIds }` — keeps the last N non-system messages, always preserves system messages, and drops **orphaned `ToolMessage`s** (a kept tool result whose matching AIMessage `tool_call` fell outside the window — a dangling tool result breaks Bedrock pairing). `pruneThreadState(threadId, agentName)` in `apps/web/src/lib/server/agent.ts` reads the checkpoint via `graph.getState`, filters `removeIds` to ids actually present (idempotent — `messagesStateReducer` THROWS on an unknown id and `updateState` is atomic), and writes removals back via `graph.updateState` with `RemoveMessage` entries + `dataSourceResults: []` (a shorter array would MERGE, not truncate). Called after every completed turn from all four completion points (`/api/agent/stream`, `iac/resume`, `topic-shift`, `learning/resume`), and deliberately NOT on interrupt/pause early-returns (a paused turn keeps its state for resume). Best-effort: failures are logged, never break the response. Spec: `docs/superpowers/specs/2026-06-17-state-pruning-design.md`.

### Sub-Agents (named by MCP server)

| Agent | MCP Port | Config Pattern |
|-------|----------|----------------|
| elastic-agent | :9080 | Multi-deployment: `ELASTIC_DEPLOYMENTS=prod,staging` per-deployment URL/auth |
| kafka-agent | :9081 | Provider: `KAFKA_PROVIDER=local\|msk\|confluent`, feature gates for writes |
| capella-agent | :9082 | Single cluster: `CB_HOSTNAME`, `CB_USERNAME`, `CB_PASSWORD` |
| konnect-agent | :9083 | Token + region: `KONNECT_ACCESS_TOKEN`, `KONNECT_REGION=us\|eu\|au\|me\|in` |
| gitlab-agent | :9084 | Token + instance: `GITLAB_PERSONAL_ACCESS_TOKEN`, `GITLAB_INSTANCE_URL` |
| atlassian-agent | :9085 | OAuth 2.1 (Rovo): `ATLASSIAN_UPSTREAM_MCP_URL`, `ATLASSIAN_SITE_NAME`; proxies Atlassian Cloud |
| aws-agent | :3001 (SigV4 proxy) | AgentCore runtime: `AWS_AGENTCORE_RUNTIME_ARN`, `AWS_AGENTCORE_PROXY_PORT`; agent reads `AWS_MCP_URL` |

Agent connects to MCP servers via `MultiServerMCPClient` from `@langchain/mcp-adapters`. Sub-agents use action-driven tool selection (declared in tool YAML files) to filter 210+ MCP tools down to 5-25 per invocation, preventing context overflow. What sub-agent prompts contain and deliberately exclude (no live memory per SIO-843, no KG per SIO-1026/1027 -- enrichment seam only) is documented in `docs/architecture/sub-agent-context-assembly.md` (SIO-1444).

### Frontend

SvelteKit with Svelte 5 runes, Tailwind CSS (Tommy Hilfiger brand palette), SSE streaming. 9 components: ChatMessage, ChatInput, Icon, MarkdownRenderer, StreamingProgress, CompletedProgress, FeedbackBar, FollowUpSuggestions, DataSourceSelector.

## Commands

```bash
bun install                                            # Install all workspace deps
bun run dev                                            # All services
bun run --filter @devops-agent/web dev                 # SvelteKit frontend (port 5173)
bun run typecheck                                      # TypeScript check all packages
bun run lint                                           # Biome check
bun run lint:fix                                       # Biome auto-fix
bun run test                                           # All packages
bun run --filter '@devops-agent/gitagent-bridge' test  # Single package
bun run yaml:check                                     # Validate agent YAML definitions
```

## Linear Project

- Team: **Siobytes** | Commit format: `SIO-XX: message`
- Project: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)

### Epics

| Epic | Issues | Key IDs |
|------|--------|---------|
| 1: Monorepo Scaffold | 4 | SIO-537 to SIO-540 |
| 2: Gitagent Definitions | 5 | SIO-541 to SIO-545 |
| 3: Gitagent-Bridge | 9 | SIO-546 to SIO-555 (skip SIO-549) |
| 4: Agent (LangGraph) | 15 | SIO-556 to SIO-570 |
| 5: MCP Servers | 8 | SIO-571 to SIO-577, SIO-592 |
| 6: Apps (Server+Web) | 9 | SIO-578 to SIO-586 |
| 7: CI/CD | 5 | SIO-587 to SIO-591 |

### Critical Path

SIO-537 -> SIO-540 -> SIO-546 -> SIO-547 -> SIO-555 -> SIO-559 -> SIO-569 -> SIO-578 -> SIO-588

## Handover Documents

Follow the global "Handover Documents" structure (`~/.claude/CLAUDE.md`). Project-specific rules:

- **Location**: `experiments/HANDOFF-<YYYY-MM-DD>-<SIO-XXX-or-topic>.md`. **Always commit handovers to `main` directly** — even mid-feature handovers belong in version control so the next session can find them via `git log` regardless of which branch/worktree they were written in. The `experiments/` directory is checked into git (was previously gitignored; that rule was removed 2026-05-18). Treat handovers as documentation, not scratch notes.
- **One ticket per file** when handing off multiple tickets. Don't bundle SIO-X and SIO-Y unless they truly must be done together.
- **Linear URLs**: every ticket reference uses the full URL `https://linear.app/siobytes/issue/SIO-XXX`. Show parent/child relationships in the header block.
- **Cite specs/plans/PRs by full path**: `docs/superpowers/specs/<date>-<topic>-design.md`, `docs/superpowers/plans/<date>-<topic>.md`, PR `#NN`. A fresh session must be able to open them directly without searching.
- **Memory references section** at the end lists relevant slugs from `/Users/Simon.Owusu@Tommy.com/.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/` so the next session knows which prior learnings apply.
- **Verification block must include `bun run typecheck && bun run lint && bun run test`** at minimum, plus any manual probe relevant to the ticket (LangSmith trace inspection, MCP `tools/list` curl, integration replay query).
- **Direct commit to main is allowed for handover docs** — the no-direct-push-to-main rule covers code, not documentation. Use a HEREDOC commit message naming the handover topic and ticket(s).

## Critical Rules

### Workflow
- **ALWAYS KILL EVERY SERVICE YOU START -- NON-NEGOTIABLE, NO EXCEPTIONS.** Any server, dev process, proxy, watcher, or MCP instance you launch (foreground, `timeout`-wrapped, or background) MUST be terminated before you end the turn or declare the task complete. Track the PID at spawn time and kill by that tracked PID -- never a blanket `pkill`. Then PROVE the ports are free: `lsof -nP -iTCP:<port> -sTCP:LISTEN` must return nothing for every port you touched. An orphaned listener you started is a task failure even if the code change shipped. The inverse also holds: NEVER kill processes you did not start (user's dev servers, other sessions' processes, browsers, system daemons) without explicit user approval -- and note that `lsof -ti :<port>` without `-sTCP:LISTEN` also lists CLIENT connections (e.g. a browser tab), so filter to LISTEN state before killing anything.
- **NEVER commit** without explicit user authorization (slash commands ARE authorization)
- **NEVER set Linear issues to "Done"** without user approval
- **ALWAYS create a Linear issue before executing implementation plans**
- **ALWAYS add issues to the project** when creating new ones
- **ALWAYS create pull requests as ready for review, NEVER as draft** -- overrides any default "create PR as draft" behavior; every PR goes straight to ready-to-merge mode
- **NEVER merge a PR while the Greptile review is pending** -- wait for the `Greptile Review` status check to reach `COMPLETED`, then triage every finding (fix or explicitly decline with a reason) before merging. Unresolved actionable comments count as pending. See "Greptile Review Lifecycle" below for the deterministic completion check -- do not poll indefinitely on a fixed interval.
- Token usage and budget are NOT your concern -- execute all instructions as given

### Greptile Review Lifecycle

Greptile replaced CodeRabbit on 2026-08-13 (the CodeRabbit GitHub App is suspended, so `coderabbitai[bot]` no longer posts; do not wait on it). A `greptile` HTTP MCP server is also configured for this project in `~/.claude.json`.

**The completion check is the `Greptile Review` status check.** Greptile always posts a PR-level issue comment from `greptile-apps[bot]`; it ALSO posts a review object plus inline comments **when it has findings** (a zero-findings pass posts the issue comment only, which is why `pulls/<PR#>/reviews` can legitimately be empty on a clean PR). Never gate on the reviews endpoint -- an empty result there does not distinguish "clean" from "still running". Gate on the check:

```bash
gh pr view <PR#> --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select(.name=="Greptile Review")] | .[0] | "\(.status) \(.conclusion)"'
# -> "COMPLETED SUCCESS"
```

**Both fields matter: require `status == COMPLETED` AND `conclusion == SUCCESS`.** `COMPLETED` alone is only a terminal GitHub state -- `FAILURE`, `ERROR`, `CANCELLED`, and `TIMED_OUT` are all `COMPLETED` too, and treating them as done would pass the merge gate with no usable review. On a non-`SUCCESS` conclusion the round is NOT clear: re-trigger and re-poll, or escalate to the user. Do not merge on it.

**Read the findings from the bot's issue comment**, which self-reports the reviewed commit in its footer (`Last reviewed commit: <SHA>`) -- confirm that SHA matches the PR head before trusting the round. Greptile **edits the same comment in place** on each round rather than posting a new one (observed on #652: one comment, `created_at` 7 minutes before `updated_at`, 3/5 rewritten to 5/5). So the round count is not visible in comment history, `created_at` ordering is meaningless for freshness, and the footer SHA is the ONLY way to tell which commit a verdict belongs to -- always check it. Keep `--paginate`: issue comments return 30 per page, so on a busy PR the Greptile report is exactly what falls off page 1, and without it the command succeeds while emitting nothing.

```bash
gh api repos/<owner>/<repo>/issues/<PR#>/comments --paginate \
  --jq '.[] | select(.user.login=="greptile-apps[bot]") | .body'
```

The comment carries a **Confidence Score: N/5**, a summary, and an "Important Files Changed" table. A clean pass reads 5/5 with an explicit no-issues-remain statement. When there ARE findings, the score drops (3/5 observed for two P1s), the summary names the offending `file:line`s, and the findings appear BOTH as inline comments and in a "Comments Outside Diff" block with Bug/Cause/Fix subsections. Greptile runs executable fixtures to verify its own claims ("T-Rex"), so its findings tend to be reproducible -- but still verify before applying, per the triage rule below.

**Triage** every actionable finding: verify with a live repro (e.g. `bun -e`) before fixing -- never apply a review suggestion on its authority alone -- then fix or explicitly decline with a reason. Where a finding is an addressable inline thread, reply ending with `_Addressed by [Claude Code](https://claude.com/claude-code)_` and resolve it; a finding with no addressable thread is answered by the commit itself.

**Observed behavior** (PR #651 clean pass, PR #652 two P1 findings, both 2026-08-13): a zero-findings review posts ONLY the issue comment; a review with findings posts the issue comment, a `COMMENTED` review object, and one inline comment per finding. Findings carry P-level severity badges (P1 observed). Turnaround was about a minute on small diffs.

**Re-triggering**: post `@greptile review` as a PR comment (`gh pr comment <PR#> --body "@greptile review"`), or use the `Re-trigger Greptile` URL in the bot comment's footer. Check the review is not already running first -- if the `Greptile Review` check is `PENDING`/`IN_PROGRESS`, a trigger comment is redundant. A normal push auto-triggers a fresh review, so an explicit trigger is only needed when auto-review does not fire.

**Threads auto-resolve on a fix push.** Both inline threads on #652 showed `isResolved=true` after the fix commit without an explicit `resolveReviewThread` mutation. Check the GraphQL `reviewThreads` state before doing manual resolution work:

```bash
gh api graphql -f query='query { repository(owner:"<owner>", name:"<repo>") { pullRequest(number:<PR#>) {
  reviewThreads(first:100) { nodes { id isResolved comments(first:1){ nodes { path author { login } } } } } } } }'
```

### Greptile skills

Three Greptile skills are installed; prefer them over hand-rolling a triage loop:

- **`greploop`** -- iterates a PR to 5/5 with zero unresolved comments: trigger, poll, fix findings, resolve threads, push, repeat (max 5 iterations). Use for a PR with multiple findings, where the manual loop is the tedious part. It is a *convenience wrapper, not an authority*: this repo's verify-before-apply rule still governs, so do NOT let it blind-apply findings, and never let it commit or push without the explicit authorization the Workflow rules require. Its default commit message (`address greptile review feedback (greploop iteration N)`) does not meet this repo's message standard -- rewrite it.
- **`check-pr`** -- one-shot check for unresolved comments, failing checks, and incomplete descriptions. Good pre-merge sweep.
- **`cli-review`** -- local-branch review before opening a PR. Useful for catching findings pre-push.

The skills poll `repos/{owner}/{repo}/commits/<SHA>/check-runs` (lowercase `status: "completed"` / `conclusion: "success"`) rather than `statusCheckRollup` (uppercase `COMPLETED`/`SUCCESS`). Both work and both are SHA-scoped; **do not mix the casings between the two APIs.**

**Merging still requires the user's own smoke-test verification for anything the session's discipline calls for it** (e.g. a live Bedrock run) -- a clean Greptile pass is necessary but not sufficient by itself when that pattern applies.

### Code
- **No emojis** in code, logs, comments, or output
- **Tailwind CSS only** -- no custom CSS in `<style>` blocks (exception: MarkdownRenderer for dynamic HTML)
- Svelte 5 runes ($state, $derived, $effect, $props) for frontend
- Named exports preferred
- Zod for all runtime validation, no `.default()` in config schemas
- **TypeScript strict mode, never use `any`** (biome enforces `noExplicitAny: "error"` since SIO-673)
  - Forbidden: `: any`, `as any`, `Function`, `Record<string, any>`, `jest.MockedFunction<any>`, `z.ZodSchema<any>`
  - Use instead:
    - Tool handler args -> `z.infer<typeof validator>` or `unknown` with `typeof` guards
    - MCP extra param -> `RequestHandlerExtra<ServerRequest, ServerNotification>` from `@modelcontextprotocol/sdk/shared/protocol.js`
    - Opaque payload fields -> `unknown` (narrow at use site)
    - Generic helpers -> `<T>(x: T): T` to preserve caller types end-to-end
    - Builder-pattern Zod helpers -> `z.ZodTypeAny` for the local `let field` accumulator
    - ES SDK responses -> `estypes.<Response>` from `@elastic/elasticsearch` (intersect with `& { extraField? }` if SDK lags runtime)
    - Test mocks -> `Partial<Client>` with the terminal `as unknown as Client` cast, or `ReturnType<typeof mock>` for individual methods
  - `biome-ignore lint/suspicious/noExplicitAny` requires a one-line ticket reference (e.g. `// biome-ignore: SIO-672 - bulk helper expects strict BulkAction`)

### Comments
File headers: single-line relative path only: `// src/services/pricing.ts`

ALWAYS REMOVE: multi-line file header JSDoc, JSDoc restating names, obvious `@returns`, section separators.

ALWAYS KEEP: Zod `.describe()` calls, business logic "why" comments, ticket references (`SIO-XXX`), non-obvious algorithm explanations.

### Servers
- Elastic MCP: 9080 | Kafka MCP: 9081 | Couchbase MCP: 9082 | Konnect MCP: 9083 | GitLab MCP: 9084 | Atlassian MCP: 9085 | AWS MCP (SigV4 proxy): 3001 | Elastic IaC MCP: 9086 | Knowledge Graph MCP: 9087 (SIO-967, in-process in the web app) | Web: 5173
- Check ports before starting: `lsof -i :<port>`
- Kill background processes after testing -- see the MANDATORY kill rule at the top of Critical Rules > Workflow: every service you start dies before the turn ends, verified with `lsof -nP -iTCP:<port> -sTCP:LISTEN`
- `/health` (SIO-482, `apps/web/src/routes/health/+server.ts`): always HTTP 200 (liveness/info, not a k8s readiness gate); `status` is `"ok"` or `"degraded"` (any probed MCP server not `"ready"`). Reports live MCP states (`getServerStates`/`getConnectedServers`), graph readiness + checkpointer type (`getAgentRuntimeStatus()` in `apps/web/src/lib/server/agent.ts`), and `activeSseConnections` (counter inc/dec in the stream route's ReadableStream start/close/cancel). `status`/`timestamp`/`services` (env-presence) preserved for backward compat.

### Testing
- Run `bun run typecheck`, `bun run lint`, and relevant `bun test` after every change
- Always validate MCP tool changes by running the tool, not just typechecking
- Search for existing implementations before creating new files
