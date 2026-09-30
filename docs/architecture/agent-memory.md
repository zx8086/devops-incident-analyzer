# Agent Memory (live-memory backend)

What the agents persist to Couchbase Agent Memory, when, and how it maps onto Agent Memory's user/session/block model.

Source: `packages/shared/src/agent-memory.ts` (REST client), `packages/agent/src/memory-backend.ts` (backend select + write-behind queue + recall), `packages/agent/src/memory-writer.ts` (single writer), `packages/agent/src/lifecycle.ts` (bootstrap/teardown seams). Introduced in SIO-938; design spec: `docs/superpowers/specs/2026-06-17-couchbase-agent-memory-backend-design.md`.

## What this is (and is not)

This is the **live-memory tier** — durable, cross-session knowledge the agent reads at the start of a session and appends to at safe boundaries. It is NOT the LangGraph checkpointer: the checkpointer (`packages/checkpointer`) holds transient per-thread graph state for resume/interrupt and is discarded; live memory persists across threads and sessions.

When `LIVE_MEMORY_BACKEND=agent-memory`, that tier is stored in Couchbase Agent Memory instead of git-tracked markdown. Per the Couchbase concept docs, Agent Memory is the persistence layer (storage + semantic retrieval); it does not provide reasoning over the memories — our pipeline decides when to read and write.

> See also: [Agent Concepts](agent-concepts.md) for how live memory relates to the other agent-architecture concepts (LLM Wiki, SkillsFlow, Knowledge Tree, lifecycle hooks, SOD, shared context). This doc is the deep-dive for the memory tier specifically.

## The Agent Memory service model

This section describes the **Couchbase Agent Memory service itself** — its data model and retrieval semantics — independent of how our agents use it. The next sections cover our usage. If you are integrating a different agent against the same service, this is the part that generalizes.

Agent Memory is a standalone REST service backed by Couchbase. It owns three things our pipeline does not reimplement: a hierarchical store, server-side embeddings, and TTL-based decay. The REST contract we use is documented in the design spec (`docs/superpowers/specs/2026-06-17-couchbase-agent-memory-backend-design.md`) and implemented in `packages/shared/src/agent-memory.ts`.

### Data model: user -> session -> block

```
User (user_id)                  one per agent identity
  └── Session (session_id)      one per conversation thread
        └── Memory block        one fact OR one conversational message
```

- **User** — a top-level namespace. Created idempotently via `POST /users` (409-conflict tolerant).
- **Session** — a thread of activity under a user, created via `POST /users/{uid}/sessions`. Search can be scoped to one session or across all of a user's sessions (`filters.session_ids: "all"`).
- **Memory block** — the unit of storage. Two flavors:
  - **Fact** (semantic / profile memory): a durable statement. Written via `facts: string[]`. No TTL by default.
  - **Message** (conversational memory): a `{ user_content, assistant_content }` turn. Written via `messages: ChatMessage[]`, typically with a `memory_block_ttl` so it decays.

Blocks are written with `POST /users/{uid}/sessions/{sid}/memory` and a body of `{ messages?, facts?, annotations?, memory_block_ttl?, async_processing? }`.

### Retrieval: TWO modes — semantic ranking vs deterministic filter

Recall is `POST /users/{uid}/sessions/{sid}/memory/search` with `{ query?, filters? }`. Per the
service's own API reference: *"Provide a natural-language `query` to rank blocks by relevance, **or
use `filters` alone for deterministic retrieval.**"* Those are two DIFFERENT code paths:

**Semantic mode (`query` present).** The service:
1. embeds the natural-language `query` with its configured embedding model,
2. runs FTS-KNN (vector nearest-neighbour) over stored block embeddings,
3. takes the top `relevant_k` (default **10**) by **`rel_score`**, **then** applies the annotation
   filter to that already-truncated window.

**Deterministic mode (no `query`, `filters` alone).** The annotation/time/block-id filters are the
authoritative WHERE clause — no embedding, no `rel_score`, no top-k truncation. Every block matching
the filter is returned (`count`-bounded only).

> **GOTCHA (SIO-998).** In semantic mode the annotation filter runs AFTER the top-`relevant_k`
> ranking, not before. The OpenAPI spec proves this by ASYMMETRY: `FilterOptions.start_time` /
> `created_start_time` are documented as *"a pre-filter inside the FTS KNN index, so only blocks ...
> enter the candidate pool"* — but `annotations` carries NO such note. Time bounds pre-filter; the
> annotation map post-filters the already-truncated top-k. So an exact-key recall (`{ query: "iac
> change", filters: { kind:"iac-change", mr_url:X }, relevant_k: 8 }`) can return **0** even when the
> block exists — the target ranks outside the top-8 by semantic relevance to the query STRING and is
> truncated before the `mr_url` filter is applied. Proven live: the same filter returned `0` at
> `relevant_k:8`, `1` at `12`, `2` at `100`; with `query` DROPPED (deterministic mode) it returned all
> `2` at the default k. **Rule: for an identifier-keyed recall (by mr_url / pipeline_id /
> config_change_id), send `filters` alone and OMIT `query`. Reserve `query` for fuzzy "what did we do
> like X" recall, never for "fetch THIS record".** Full spec vendored at
> [`docs/reference/agent-memory-openapi.json`](../reference/agent-memory-openapi.json) +
> [`agent-memory-api-reference.md`](../reference/agent-memory-api-reference.md).

The bootstrap recaller (latest-user-message → ranked hits) is a legitimate semantic-mode use. The
iac-change recalls (`recallIacChangeIntent`, `recallSessionProgress`, `recallLastIacChange`) are
identifier-keyed and use deterministic mode.

### Server-side embeddings and async extraction

Clients never generate, send, or store vectors — there is no embedding field on any write. On write, the **service** generates the block's vector embedding and an LLM summary using its configured Model Service. This extraction is **asynchronous by default**: a freshly written block is not in the vector index (and so not searchable) until it reaches `status: "ready"`. Search only ever returns `ready` blocks. A write can opt into synchronous extraction (`async_processing=false`) to block until the result is searchable — see the freshness section below for how we expose this.

### Decay and conflict resolution (service-owned)

- **Decay** is per-block TTL (`memory_block_ttl`). Expired blocks drop out of the cluster automatically; there is no client-side sweep.
- **Conflict resolution** between contradictory blocks is ordered by timestamp. Clients send `created_at` (when the information was *true*, not when it was ingested) so the service resolves conflicts by data-time. We never re-rank or merge conflicting memories client-side.

### REST contract (the subset we use)

| Endpoint | Purpose |
|---|---|
| `POST /users` | create user (swallow 409) |
| `POST /users/{uid}/sessions` | create session (swallow 409) |
| `POST /users/{uid}/sessions/{sid}/memory` | write blocks (`messages` / `facts`) |
| `POST /users/{uid}/sessions/{sid}/memory/search` | semantic recall (returns `ready` blocks only) |
| `POST /users/{uid}/sessions/{sid}/end` | end session |
| `GET /health` | readiness probe (gates recall; 503 carries `retry_after_seconds`) |
| `PUT /users/{uid}/ttl` | bulk TTL (reserved; not on the hot path) |

Auth is optional OIDC (`Authorization: Bearer <jwt>`, when the service runs with `OIDC_AUTH_ENABLED`). The base URL is **required config** with no default (the service docs are inconsistent between ports 8070 and 8080).

On our side, the client method `searchMemory(query)` *is* this embedding-powered semantic search -- there is no separate "embed" call. The rest of this doc covers how the four top-level agents (incident-analyzer, elastic-iac, landing-zone-terraform, pi-fleet-console) map onto the model above.

## Identity mapping

| Agent Memory concept | Our value |
|---|---|
| **User** (`user_id`) | the agent: `incident-analyzer`, `elastic-iac`, `landing-zone-terraform` or `pi-fleet-console` (one user per agent; the identity map in `memory-backend.ts` throws for any other name) |
| **Session** (`session_id`) | the chat `threadId` (one session per conversation thread) |
| **Memory block** | one fact or one conversational message (below) |

User/session are created idempotently on first write or first recall (`ensureUser` / `ensureSession`, 409-conflict tolerant).

## What we save, and to which block type

The single writer (`memory-writer.ts`) emits two kinds of block. Both run `redactPiiContent` **before** the block leaves the process (SSN, credit card, email, phone — IPv4 is intentionally kept).

### 1. Daily-log breadcrumb -> conversational **message** (short TTL)

Written once per completed investigation. Maps to Agent Memory **Conversational Memory** and carries `memory_block_ttl = AGENT_MEMORY_DAILYLOG_TTL_SECONDS` so resolved-incident noise decays (the "DevOps/SRE copilot" use case in the Couchbase docs).

- **incident-analyzer** — terminal `followUp` node (`follow-up-generator.ts` `recordDailyLog`). Fields: `requestId`, affected `services`, `severity`, `confidenceScore`, the queried `datasources`. Stored as a `{ user_content, assistant_content }` message where `assistant_content` is the `req=… services=[…] datasources=[…] severity=… confidence=…` breadcrumb.
- **elastic-iac** — `teardownIac` node (`iac/nodes.ts`). Fields: `requestId`, `cluster` as the service, `datasources=["elastic-iac"]`, and a summary of `intent` + `MR=<url>` / `rejected` + `pipeline=<status>`. This closes the SOUL.md "I write back after every job" promise that previously had no code path.

### 2. Key decision -> durable **fact** (no TTL)

`recordKeyDecision()` -> Agent Memory **Profile / Semantic Memory** fact: `"<decision> (rationale: <rationale>)"`, no TTL (durable across sessions). `recordKeyDecision` IS on the hot path (HIL apply, IaC change/reconcile, landing-zone breadcrumbs, pi verdict memory); `memory-pr` is the separate human-reviewed wiki/skill/runbook channel. On the file backend the writer resolves the agent's runtime dir from the request context's `agentName` (SIO-1887); outside a request it falls back to incident-analyzer.

The compiled wiki (`memory/wiki/`) maps conceptually to durable facts too, but is not yet pushed to Agent Memory by this change (see Out of scope).

## Scenario catalog

Beyond the two block types above, the agents read and write memory in a number of specific scenarios. The `agent-memory` backend (not the file default) is what makes the identifier-keyed recalls and direct durable facts below possible — on the file backend the durable-fact paths are PR-gated or no-ops. The single writer (`memory-writer.ts`) feeds a write-behind queue (`memory-backend.ts`) that drains to the REST client (`agent-memory.ts`); recall reads go straight through `searchAgentMemory` / `recallAgentMemory`.

### Writes

| # | Scenario | Where | Trigger | What is written |
|---|----------|-------|---------|-----------------|
| W1 | Incident daily-log | `follow-up-generator.ts` `recordDailyLog` | terminal `followUp` (incident-analyzer) | conversational **message** (short TTL): requestId, services, severity, confidence, datasources |
| W2 | IaC daily-log | `iac/nodes.ts` `teardownIac` | `teardown` (elastic-iac) | conversational **message**: requestId, cluster, intent + MR url/rejected + pipeline status |
| W3 | IaC change proposal fact | `iac/nodes.ts` `buildIacChangeDecision` -> `recordKeyDecision` | after `openMr` on the gitops path | durable **fact**, TTL'd (`IAC_PROPOSAL_FACT_TTL_SECONDS`, default 90d) so it auto-expires once reconciliation writes the terminal fact; annotations `kind:iac-change`, `config_change_id`, `mr_url`, `mr_iid`, `deployment`, `stack`, `stack_instance`, `workflow`, `version`, `pipeline_id`, `change_summary`, `outcome` |
| W4 | Fleet-upgrade dispatched + terminal facts | `iac/nodes.ts` `recordKeyDecision` | fleet-upgrade dispatch, then terminal pipeline | durable **fact(s)**: `kind:fleet-upgrade-dispatched` (for cross-session re-poll), then a terminal fact on completion (SIO-943/957/958/959) |
| W5 | Reconciliation terminal fact | `iac/reconcile.ts` (`reconcileOne`/`buildReconciledIacAnnotations`) | the reconcile sweep finds an MR reached a terminal live state | durable **fact** with `lifecycle` = `applied` / `apply-failed` / `closed` + `apply_pipeline_id`; append-only (SIO-1005) |
| W6 | Skill-learning proposal fact | `skill-learner.ts` `buildSkillFactText`/`buildSkillAnnotations` | post-turn learner seam, incident-analyzer only | durable **fact** `kind:skill` with `skill_name`, `task_category`, seeded `confidence="0.5"`, `learned_from`, usage/success/failure counters (SIO-1015) |
| W7 | Session annotations | `memory-backend.ts` `setSessionDatasources` / `setSessionOutcome` (SIO-952) | session create / teardown | session-level annotations: `datasources` span at first write, `outcome` at end |
| W8 | Investigation telemetry binding | `record-bindings.ts` `recordConfirmedBindings` -> `recordKeyDecision` (SIO-1100) | end of turn, per confirmed binding (incident-analyzer); `KG_BINDINGS_WRITE_ENABLED` defaults on, set =false to disable | durable **fact** `kind:kg-binding` with annotations `service`, `service_normalized`, `binding_kind`, `resource_id`, `locator`, `datasource`, `discovered_by`, `incident_id`, `confidence`, `alias_raw`. Dedup key `(service, binding_kind, resource_id)` (same idiom as `config_change_id ?? mr_url`); the graph `hasBinding` check gates the write so a re-confirmation is graph-only. System of record for the KG's `OBSERVED_IN` projection — the `knowledge-graph:rebuild` CLI replays these facts. The graph write is independent (SIO-970): it happens even on the `file` backend, only the fact needs `agent-memory`. |
| W9 | KG incident mirror fact | (removed, SIO-1135) | -- | no longer written per run: only curated investigations become durable memory and facts are immutable, so a per-run mirror would resurrect every uncurated incident on rebuild. The graph MERGE still records the `Incident` row for the session; the mirror fact is written at curation time (`learn/apply.ts`). |
| W10 | KG root-cause mirror fact | (removed, SIO-1135) | -- | same reasoning as W9: the graph MERGE links `HAS_ROOT_CAUSE` for the session, and the durable `kind:kg-root-cause` fact is written at curation time from `rootCauseForIncident`, so a rebuild reconstructs only curated root causes. |
| W11 | HIL-learning applied items | `learn/apply.ts` `applyLearnings` (SIO-1126/1127) | `applyLearnings`, per human-approved item in the learning lane | durable **fact(s)** from a resolved ticket: human-corrected root cause + resolution (`kind:root-cause`, via `recordRootCause` + `linkResolution`), transferable diagnostic heuristics (`kind:skill`), corrected telemetry bindings (`kind:binding`), and free-form memory facts (`kind:memory-fact`) — each grounded in verbatim ticket-comment quotes. Applying also **curates** the matched KG `Incident` (writes its `ticketKey`); SIO-1135's retention sweep purges uncurated incidents and mirrors the curated facts. See the [HIL learning lane](agent-pipeline.md#hil-learning-lane). |

### Reads (recall)

| # | Scenario | Where | Trigger | Mode |
|---|----------|-------|---------|------|
| R1 | Bootstrap semantic recall | `memory-backend.ts` `recallAgentMemory` | `load_live_memory` bootstrap (all four top-level agents declare it) | **semantic** -- `searchMemory(latest user message, allSessions, relevant_k=8)` ranked by `rel_score` |
| R2 | IaC change intent recall | `iac/nodes.ts` `recallIacChangeIntent` -> `searchAgentMemory` | "check my MR" / plan-review enrichment | **deterministic** — filter `{kind:iac-change, mr_url}` alone (SIO-998) |
| R3 | Last IaC change recall (cross-thread) | `iac/nodes.ts` `recallLastIacChange` | a cleared thread mints a new threadId | **deterministic** — `mr_iid`/deployment filter, `allSessions` (SIO-990) |
| R4 | Plan-review memory enrich | `iac/graph-knowledge.ts` `memoryEnrichIac` | pre-draft, after `graphEnrichIac` (SIO-970) | **deterministic** — filter `{stack_instance, kind:iac-change}` -> `priorLearnings` |
| R5 | In-flight fleet-upgrade recall | `memory-backend.ts` `recallInFlightFleetUpgrades` | session bootstrap (proactive, SIO-960) + "how's the upgrade going?" | **deterministic** — filter `{kind:fleet-upgrade-dispatched}` |
| R6 | Skill dedup check | `skill-learner.ts` `proposalExists` -> `searchAgentMemory` | before writing a new `kind:skill` fact | **deterministic** — filter `{kind:skill, skill_name}` |
| R7 | On-demand LLM recall (`search_memory` tool) | `iac/local-tools.ts` `runMemorySearch` -> `searchAgentMemory` | elastic-iac's own LLM decides to call it mid-turn | **semantic** — `query` kept deliberately (model-driven fuzzy recall is the point), `relevant_k` widened to 25 so an optional `{deployment, stack, kind}` filter still has a real candidate pool post-truncation (SIO-998-aware mitigation, not full deterministic mode) |

The semantic-vs-deterministic distinction (and *why* identifier-keyed recalls MUST omit `query`) is the SIO-998 gotcha documented in [Retrieval: TWO modes](#retrieval-two-modes--semantic-ranking-vs-deterministic-filter) above.

**No MCP server, but one LLM-callable tool.** Agent Memory has no MCP server and is never exposed via `tools/list` the way the Knowledge Graph's `kg_*` tools are (`packages/agent/src/iac/local-tools.ts`'s header comment: "only `search_memory` stays LOCAL because agent memory is REST infrastructure, not MCP-exposed"). That is a narrower claim than "no LLM tool surface at all" — `search_memory` (R7 above) IS a real, LangChain-native tool bound into elastic-iac's tool set whenever the agent-memory backend is selected (`createSearchMemoryTool`, wired via `infoTools()` in `iac/nodes.ts`). R1–R6 are all code-driven recalls the LLM never chooses to trigger; R7 is the one seam where the model itself decides to search memory.

### Dedup (SIO-973 / SIO-1005)

Agent Memory facts are durable and undeletable (no client delete API, no TTL on facts), so re-recording the same change permanently doubles it, and an `allSessions` recall returns both copies. `memory-backend.ts` exposes two order-preserving dedupers, both keyed on **annotations** (not the text — the service paraphrases facts on ingest):

- `dedupeHitsBy(hits, keyFn)` — first hit per key wins (SIO-973).
- `dedupePreferring(hits, keyFn, rankFn)` — highest-ranked hit per key wins, list order preserved (SIO-1005; used by `renderLearnings` to upgrade a `(deployment, stack)` row to its reconciled fact via `lifecycleRank` without reordering).

Keys are `pipeline_id` for fleet learnings and `config_change_id ?? mr_url` for gitops learnings.

### Lifecycle reconciliation (SIO-1005 / SIO-1021)

An IaC change proposal fact (W3) is written `proposed` and TTL-decays. A background sweep (`iac/reconcile.ts` `reconcileAll`, driven by `Bun.cron` with a `setInterval` fallback under Node, SIO-1021, plus a bounded refresh in `bootstrapIac`) enumerates unreconciled `kind:iac-change` facts, re-checks each MR's live state, and **appends** an authoritative terminal fact (`lifecycle: applied | apply-failed | closed`) when the MR reaches a terminal outcome. The append-only model + `dedupePreferring` means the panel shows one row per change at its latest lifecycle. The `outcome:"completed"` annotation means "proposal turn done", NOT applied; `lifecycleTag()` maps it to `proposed` so the UI never mislabels a still-open change as live.

### Learning loop (SIO-1015 / 1016 / 1017 / 1018, generalised to every agent in SIO-1886..1896)

Every top-level agent (SIO-1889). After a turn, the post-turn learner seam (`skill-learner.ts`) pre-gates on a `complex` query plus either `confidence >= 0.6` and >= 2 datasources (the orchestrator) or the graph's own `completed` outcome (the others); a Jev gate (`learning-gate.ts`: task_success >= 0.5 as a hard precondition, then a mean of three questions >= 0.6, agent-beacon's rule) runs before the full-model judge; the judge, over a PII-redacted transcript, proposes a reusable skill with verbatim evidence quotes (verified against the transcript) which must pass the lesson-quality rubric; the result is a `kind:skill` **candidate fact** carrying `status` / `source` / `task_success` / `task_success_source` (deduped by `skill_name`, R6) -- never auto-loaded. A state change is a newer fact with the same `skill_name`; readers keep the latest (`listLearningCandidates`). **Reflect (SIO-1893).** `reflect:analyze --emit-candidates drafts.json` also writes the analysis's `create` portfolio items as `kind:skill` candidate drafts (source `reflect`, evidence from the finding's excerpts, filed rejected with `task_success` 0 when a session carried a negative user reaction), in the same file shape `learn:ingest` reads. Humans promote a candidate into a real `SKILL.md` or runbook through a PR, by either of two paths: approving it in the review pane, which attempts the promotion PR described under [Promotion PR](#promotion-pr-sio-1896), or the `skill:promote` CLI (SIO-1017, `--pr` for the git-native branch and PR, SIO-1345). Thereafter the skill's confidence evolves from per-turn outcomes via Laplace smoothing on its frontmatter (SIO-1016), traced by the per-turn skill-application signal (SIO-1018). Requires the agent-memory backend (the file backend has no fact storage for proposals).

### Human feedback on candidates (SIO-1890)

A thumbs click in the chat is the human `task_success` signal. `POST /api/agent/feedback` (`apps/web/src/routes/api/agent/feedback/+server.ts`) calls `recordTurnFeedback()` when the body carries `threadId` and `agentName` and the score is exactly 0 or 1. The verdict is first bound to a known thread (the checkpointer must hold an assistant turn for that agent on that thread; otherwise it is ignored with a warning). It is then stored as its own `kind:feedback` fact and applied to every candidate that thread produced as a newer fact: thumbs-up sets `task_success=1` with `task_success_source=feedback`; thumbs-down sets the candidate to `rejected`. A changed vote reopens: a candidate rejected by an earlier thumbs-down returns to `candidate` on a later thumbs-up, while a rejection from the review pane, or a supersession, stands. The memory work is bounded by `LEARNING_FEEDBACK_DEADLINE_MS` (default `5000`; any non-positive or non-numeric value falls back to the default) so a stalled backend can never hold up the LangSmith write that follows, and a failure here never fails the request.

### Promotion PR (SIO-1896)

Approval never activates anything by itself: it records the decision and then tries to open a draft PR through `packages/memory-pr` (`openMemoryPr`, `packages/memory-pr/src/index.ts`). Merge of that PR is the only activation.

**Two entry points, one opener.**

| Entry point | What it promotes |
|---|---|
| `POST /api/agent/memory/candidates` with `action: "approve"` (`reviewCandidate`, `packages/agent/src/learning-review.ts`) | A reviewed learning candidate. A `kind:skill` candidate becomes a `SKILL.md` plus the `agent.yaml` `skills:` insertion, built from the base branch's live manifest, on branch `agent/learn/<agent>/skill-<name>`. A `kind:runbook` candidate becomes one markdown file under the agent's runbook tree on branch `agent/learn/<agent>/runbook-<name>`. |
| `POST /api/agent/memory/promote` (`apps/web/src/routes/api/agent/memory/promote/+server.ts`) | An explicit proposal validated against `MemoryPrProposalSchema` (`kind`: `wiki-page`, `key-decision`, `new-skill` or `runbook`), passed straight to the opener. Returns 400 on an invalid body. |

The same opener also serves the `open_memory_pr` teardown step (queued wiki and key-decision proposals) and the incident-close workflow (SIO-1357), which is gated separately by `CLOSURE_LEARNING_ENABLED` and is **off** unless that is `true` or `1`.

**What the opener returns.** It never throws for the expected "off" paths:

| Result | When |
|---|---|
| `skipped` | `MEMORY_PR_ENABLED` is not `true`/`1` (this is opt-in, unlike the capability flags); the kill switch is active; `GITHUB_TOKEN` or `MEMORY_PR_REPO` is missing; or the branch already exists with no PR (a partial earlier attempt, which the reason names so an operator can delete it and retry). |
| `blocked` | The proposal's branch equals the base branch; the secret scan finds a credential in any file (before any GitHub write); or the branch already has a PR, open or closed (into the configured base, checked before any write; into any base when branch creation reports that the branch exists). The result then carries that PR's `url` and `number`. |
| `opened` | A draft PR was created against `MEMORY_PR_BASE` (default `main`). Labeling is best-effort and cannot turn `opened` into a failure. |

**Rules the code enforces.**

- **Refs are never moved.** Branch creation is the only ownership test. A branch that already has a PR blocks; nothing is reused, refreshed or force-updated, because GitHub's ref API has no compare-and-swap. A concurrent attempt that loses the PR-creation race (HTTP 422) resolves to the same `blocked` result.
- **Blocked reasons name the next step.** An open PR says to review that PR; a closed or merged one says the proposal was already reviewed and is not re-proposed automatically; a branch without a PR says to delete the branch to retry.
- **The promotion outcome is its own fact.** The outcome (`opened`, `skipped`, `blocked`, `failed`, plus the PR URL) is stored as a separate `kind:promotion` fact and merged into the review row at read time. Stored as another approved skill fact it could outrank a reject or supersede written while the PR was opening.
- **Only unpromoted approvals are retried.** Approving an already-approved candidate writes no second transition and retries only the PR, and only when the recorded outcome is `skipped` or `failed` (`RETRYABLE_PROMOTIONS`). `opened` is done, `blocked` would fail the same way, and an outcome that was never recorded is treated as done. Those cases return 409. If the outcome could not be stored after the PR call, the response says so (`promotionStored: false`) and the row cannot be retried from the pane.
- **Runbook `target_dir` is bounded.** A runbook candidate whose stored `target_dir` lies outside the owning agent's runbook tree is refused at approval (409) and at `learn:ingest`, before anything is written.
- **Approval preconditions are unchanged.** `task_success` must be confirmed (`1`), and when the action carries the `expectedStatus` the reviewer saw, it must still match the stored status, otherwise the action is refused as stale (409).

Configuration: `MEMORY_PR_ENABLED`, `MEMORY_PR_REPO`, `MEMORY_PR_BASE`, `GITHUB_TOKEN` (see the block at the end of this doc).

### Measuring learning (SIO-1894)

Whether learning helps is answered from two existing instruments, never from log lines.

**Decision rows.** Three seams write to the SIO-1858 `decision_metrics` table through `recordDecision` (`packages/agent/src/decision-recorder.ts`), which is a no-op unless `DECISION_METRICS_DB_PATH` is set:

| Seam | Written by | `outcome` | `note` |
|---|---|---|---|
| `learning-gate` | `learning-gate.ts` (the Jev gate, SIO-1889) and `skill-learner.ts` (the rubric) | `applied` (Jev answered; `topScore` = mean, `bottomScore` = task_success), `skipped` (flag off, no key, or `rubric:<item>`), `failed` (call failed; `status-<code>` or `call-failed`) | `qualifies`, the failing question, or the rubric item |
| `learning-feedback` | `skill-learner.ts` `recordTurnFeedback` (SIO-1890) | `applied` when every eligible transition was stored, else `failed` | `thumbs-up:<stored>/<eligible>` or `thumbs-down:...` |
| `learning-review` | `learning-review.ts` (SIO-1891) | `applied` for a stored decision, `skipped` for a refusal | `<action>:<what>`, e.g. `approve:approved-skill-opened`, `approve:task-success-unconfirmed`, `reject:stale` |

The applied/skipped/failed counts per seam are then one query away (divide by the seam's total for the ratio):

```bash
sqlite3 "$DECISION_METRICS_DB_PATH" "select seam, outcome, count(*) from decision_metrics where seam like 'learning-%' group by 1, 2"
```

Calibrate the Jev gate thresholds (agent-beacon's 0.5 floor and 0.6 mean, `learning-gate.ts`) from the `learning-gate` rows after the first week, the way `RERANK_DROP_BELOW` was tuned from the rerank rows: `topScore` and `bottomScore` carry the two numbers the rule compares.

**Replay eval, before and after.** Approved knowledge activates only by PR merge (a skill under `agents/<agent>/skills/`, a runbook under the agent's knowledge tree). Its effect is measured with the incident replay eval, which tags each experiment with the git revision (`packages/agent/src/eval/run-incident-replay-eval.ts`): run `bun run --filter @devops-agent/agent eval:incident-replay` on `main` immediately before and immediately after the promotion PR merges, then compare the two experiments in LangSmith on `root_cause_accuracy`, `runbook_selection_vs_usage` and `citation_grounding`. One run each side sits inside judge and model noise (the harness says so), so use its repetition option for at least three runs per side with the same judge model, and compare medians; the live datasources drift between runs too, so a small movement is not a verdict. A learning that moves none of them is a candidate for supersession in the review pane. Supersession changes only the stored candidate state: once the promotion PR has merged, the skill file and its `agent.yaml` entry (or the runbook file) stay live until a separate PR removes them.
**Fleet channel (SIO-1892).** An unreviewed journal lesson never reaches a model at runtime and no spoke reads another's state; a lesson reaches a spoke's model only after a human approves it as a runbook, the PR merges, and `publish-fleet.sh` ships the persona's knowledge, which is the whole path below. An operator runs `bun packages/pi-coms/scripts/fleet-harvest.ts --bundle s3://<dist>/fleet --spoke <account>/<agent> ... --out drafts.json` (the SIO-1745 checkpoint, same credentials as `publish-fleet.sh`): it reads each spoke's journaled diagnoses, joins the actionability verdicts, groups recurring causes (2+ spokes or 3+ occurrences), redacts every string (account ids become an 8-hex origin digest) and writes `kind:runbook` candidate drafts with `task_success` from the fleet's own verdict. `bun run --filter @devops-agent/agent learn:ingest -- --file drafts.json --agent incident-analyzer` then applies the rubric, the Jev gate and dedupe, and records each survivor as a candidate fact. Approval in the SIO-1891 pane stages the runbook under `agents/incident-analyzer/knowledge/aws/runbooks/` (which `aws-spoke` references by knowledge), and `publish-fleet.sh` ships it to the spokes on merge: the `deploy/suppressions.yaml` precedent.

### Block-ID logging (SIO-991)

`addFacts`/`addMessages` return `AddMemoryResult { blockIds }`, and `searchMemory` surfaces each hit's `blockId`. The writer logs the `user_id` + `session_id` + `block_id` of every flushed write and recall (log markers `flushed agent-memory writes`, `agent-memory search|recall`, `recallIacChangeIntent`) so a write/recall can be cross-referenced to its Couchbase block during diagnosis.

## Lifecycle: when reads and writes happen

Driven by each agent's `hooks/hooks.yaml` lifecycle steps, run per session (keyed by `threadId`) from `apps/web/src/lib/server/agent.ts`. incident-analyzer, elastic-iac and landing-zone-terraform declare the same bootstrap set (`load_live_memory`, `load_wiki_index`, `warm_knowledge_graph`, `emit_session_start`) and the teardown steps `flush_daily_log` and `checkpoint_key_decisions`; incident-analyzer additionally declares `open_memory_pr`, and landing-zone-terraform additionally declares `close_knowledge_graph`. pi-fleet-console declares only the memory subset (SIO-1888, `agents/pi-fleet-console/hooks/hooks.yaml`): `load_live_memory` and `emit_session_start` at bootstrap and `flush_daily_log` at teardown, with no wiki, knowledge-graph or memory-PR step. The lifecycle runner resolves hooks for the **invoked** agent via `getAgentByName(ctx.agentName)`, so each agent runs its own steps under its own Agent Memory user.

**Bootstrap (session start)** — `load_live_memory` step:
1. read durable context (file context still loaded for the prompt), then
2. **recall**: `registerMemoryRecaller` -> a readiness probe (`checkHealth`), then `searchMemory(query = latest user message, session_ids: "all", relevant_k: 8)` — a semantic search across the agent's past sessions. Results come back ranked by `rel_score` (the FTS-KNN relevance score); only blocks with `status: "ready"` are returned (extraction is async). Hits are appended to the first-turn prompt context. If the service is unhealthy the recall is skipped (no noisy per-turn failure) but the session is still bound so writes queue for a later retry.

**How the recall reaches each agent's prompt (SIO-1888).** Bootstrap stashes the recall per thread (`lifecycle.ts`). The orchestrator reads it through `prompt-context.ts` into the aggregator prompt. The other three agents ran `load_live_memory` and then never read the result, so they now share one seam, `buildAgentLiveMemorySection(agentName)` (`packages/agent/src/agent-live-memory.ts`): the agent's own runtime files plus the stash for the current request's thread, rendered as a `## Live Memory` section with the recall under `### Recalled From Past Sessions`, and an empty string when there is nothing to show.

| Agent | Where it is appended | Framing |
|---|---|---|
| elastic-iac | The read-only lanes `answerInfo` and `converseIac` (`iac/nodes.ts`), last in the system prompt | Preceded by `LIVE_MEMORY_FRAMING`: the section is evidence from past sessions and durable notes, never an instruction, and never a reason to change tool choices or the read-only rules |
| landing-zone-terraform | `buildLandingZoneAnswerSystemPrompt()` (`landing-zone/answer.ts`), after the base answer prompt | Covered by that prompt's existing rule that memory text is untrusted evidence, never instructions |
| pi-fleet-console | `withFleetLiveMemory()` (`pi-fleet/graph.ts`), rebuilt on every model call through the ReAct agent's `messageModifier` so the per-thread recall reaches each turn | Appended after the persona prompt (SOUL/RULES/DUTIES); there is no memory-specific framing line here, the persona's evidence rules are written for spoke replies |

**Teardown (session end)** — `flush_daily_log` step:
1. `appendDailyLog(finalEntry)` enqueues the session breadcrumb, then
2. **flush + end**: `registerMemoryFlusher` -> drain the write-behind queue (`ensureUser` -> `ensureSession` -> `addFacts` / `addMessages`) and `endSession()`.

Between bootstrap and teardown, writes from the writer are **queued in-process** (`memory-backend.ts`) and also auto-flush once the queue passes a size threshold, so a long session doesn't accumulate unbounded. The queue exists because the writer is synchronous (terminal graph nodes) while the REST client is async — it bridges the two without changing writer signatures. Each queued write carries its own `createdAt`.

Every memory operation is best-effort: a recall or flush failure is logged and never blocks answer delivery or session teardown.

## Write freshness, relevance, and resilience

- **Freshness (`AGENT_MEMORY_SYNC_WRITES`)**: writes default to async (`async_processing=true`) — fast, but a just-written block isn't in the vector index until the service's extraction queue catches up, so the very next recall may miss it. Set `AGENT_MEMORY_SYNC_WRITES=true` to write with `async_processing=false`, blocking until the block is `ready` and immediately searchable. Use sync when same-session recall of recent writes matters; async when write latency matters more.
- **Relevance (`rel_score`)**: `searchMemory` returns `MemoryHit { text, score }` ranked by the service's relevance score; an optional `minScore` drops weak matches. The recaller currently keeps the service ranking and joins the text.
- **Resilience (health + 503 + backend outage)**: `checkHealth()` (`GET /health`) gates recall. On a 503 (extraction queue saturated) the client raises `ServiceUnavailableError` carrying `retry_after_seconds`, and the flush **requeues the unsent tail** (front of queue) rather than dropping it, so the next flush or session teardown retries; writes the service already accepted earlier in the batch are never resent (SIO-1646 fixed a whole-batch requeue that double-wrote them). Three error classes since SIO-1646: 409 is swallowed by `ensureUser`/`ensureSession`; `ServiceUnavailableError` (503 saturation) drives the SIO-1364 flush-only cooldown; `BackendUnavailableError` (a 503 `DATABASE_UNAVAILABLE`, or a 400 `USER_ERROR` whose body carries `category=couchbase.network` -- the service's Couchbase store is down while `/health` still says healthy) and fetch-level failures arm a **process-wide cooldown** (60 s, or the service's retry hint) that short-circuits the **write** sites -- the direct durable-fact write and the threshold/per-turn flushes -- at debug level, so an outage costs ONE warn per window. The observed outage class is **write-only** (the service's Couchbase reads and FTS search keep working while mutations fail), so **read** sites (recall/search/fleet-recall) are NOT gated: they attempt a best-effort user/session ensure (a transient failure there is swallowed) and still run the search, so recall keeps working against already-created sessions during a write outage; a read that does fail transiently degrades to an empty result and folds into the same window. The teardown flush stays ungated as the last chance to drain. `ensureUser`/`ensureSession` are memoized per process (added only after success; a session entry is dropped on `SESSION_ALREADY_ENDED`/`SESSION_NOT_FOUND` and after `endSession`). The queue is bounded at 200 writes (drop oldest; the count surfaces once as `droppedOverflow` on the next flush log). A 404 `SESSION_NOT_FOUND` at teardown (the session was never created because the backend was down at session start) is a debug no-op like `SESSION_ALREADY_ENDED`. The startup probe also asks `GET /health/couchbase` and warns when the store is unreachable. Other failures are logged and dropped (best-effort).

## Conflict resolution and decay (our settings)

The mechanism is service-owned (see [Decay and conflict resolution](#decay-and-conflict-resolution-service-owned) above). Our choices on top of it:

- **Decay**: short TTL on dailylog **messages** (`AGENT_MEMORY_DAILYLOG_TTL_SECONDS`), none on **facts** — so resolved-incident noise expires while durable decisions persist.
- **Conflict resolution**: we send `created_at` (data-creation time) on every write so the service resolves contradictions by when the information was true, not by ingestion order. We never re-rank client-side.

## Configuration

```bash
LIVE_MEMORY_ENABLED=true            # master gate for the live-memory tier (no-op when false)
LIVE_MEMORY_BACKEND=agent-memory    # file (default) | agent-memory
AGENT_MEMORY_BASE_URL=http://localhost:8070
AGENT_MEMORY_ENABLED=true           # informational only: the backend switch is LIVE_MEMORY_BACKEND (SIO-1646)
AGENT_MEMORY_BEARER_TOKEN=          # required only if the service runs with OIDC_AUTH_ENABLED (RS256 JWT)
AGENT_MEMORY_DAILYLOG_TTL_SECONDS=  # short TTL for breadcrumbs; omit for no decay (facts never decay)
AGENT_MEMORY_SYNC_WRITES=false      # true => async_processing=false: blocks are searchable on write
IAC_PROPOSAL_FACT_TTL_SECONDS=      # TTL on the iac-change proposal fact (W3); default 90d, expires once reconciliation writes the terminal fact
SKILL_LEARNING_ENABLED=true         # post-turn learning-candidate learner for every agent (W6); kill-switch, agent-memory backend only
LEARNING_JEV_GATE_ENABLED=true      # SIO-1889 Jev gate before the judge; kill-switch, self-skips without TYPESAFE_API_KEY
LEARNING_INGEST_ENABLED=true        # SIO-1892 learn:ingest of harvested candidate drafts (fleet-harvest.ts output)
LEARNING_REVIEW_ENABLED=true        # SIO-1891 review pane + /api/agent/memory/candidates; approve records the decision and attempts the promotion PR
LEARNING_FEEDBACK_DEADLINE_MS=5000  # SIO-1890 bound on the thumbs-feedback memory write (default 5000)
MEMORY_PR_ENABLED=                  # opt-in: only true/1 lets memory-pr open PRs; unset => every promotion is "skipped"
MEMORY_PR_REPO=                     # <owner>/<repo> the promotion PRs are opened against (required with GITHUB_TOKEN)
MEMORY_PR_BASE=main                 # base branch for promotion PRs (default main)
GITHUB_TOKEN=                       # token memory-pr uses; missing => "skipped"
CLOSURE_LEARNING_ENABLED=           # SIO-1357 incident-close learning chain; OFF unless true/1
LIVE_MEMORY_IMMUTABLE=              # SIO-845 file backend: true/1 writes dailylog entries as hash-chained JSON lines (tamper-evident); OFF by default
```

Requires a running Agent Memory Docker container connected to your Capella cluster, with an embedding model + LLM available for vector embeddings and summaries. With async writes (default), semantic search returns a block only once it reaches `status: "ready"`; with `AGENT_MEMORY_SYNC_WRITES=true` a block is `ready` by the time the write returns.
