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

On our side, the client method `searchMemory(query)` *is* this embedding-powered semantic search — there is no separate "embed" call. The rest of this doc covers how the incident-analyzer and elastic-iac agents map onto the model above.

## Identity mapping

| Agent Memory concept | Our value |
|---|---|
| **User** (`user_id`) | the agent: `incident-analyzer` or `elastic-iac` (one user per agent — `resolveUserId()`) |
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

`recordKeyDecision()` -> Agent Memory **Profile / Semantic Memory** fact: `"<decision> (rationale: <rationale>)"`, no TTL (durable across sessions). NOTE: in the file backend, durable learnings are PR-gated (EPIC 1, `memory-pr`); the direct `recordKeyDecision` writer exists for API completeness and is not on the incident-analyzer hot path today.

The compiled wiki (`memory/wiki/`) maps conceptually to durable facts too, but is not yet pushed to Agent Memory by this change (see Out of scope).

## Lifecycle: when reads and writes happen

Driven by each agent's `hooks/hooks.yaml` lifecycle steps, run per session (keyed by `threadId`) from `apps/web/src/lib/server/agent.ts`. Both agents have a `hooks.yaml`: incident-analyzer declares the full set (`load_live_memory`, `load_wiki_index`, `warm_knowledge_graph`, `emit_session_start` / `flush_daily_log`, `checkpoint_key_decisions`, `open_memory_pr`); elastic-iac declares the memory subset (`load_live_memory`, `emit_session_start` / `flush_daily_log`) — it has no wiki, knowledge-graph, or memory-pr trees. The lifecycle runner resolves hooks for the **invoked** agent via `getAgentByName(ctx.agentName)`, so each agent runs its own steps under its own Agent Memory user.

**Bootstrap (session start)** — `load_live_memory` step:
1. read durable context (file context still loaded for the prompt), then
2. **recall**: `registerMemoryRecaller` -> a readiness probe (`checkHealth`), then `searchMemory(query = latest user message, session_ids: "all", relevant_k: 8)` — a semantic search across the agent's past sessions. Results come back ranked by `rel_score` (the FTS-KNN relevance score); only blocks with `status: "ready"` are returned (extraction is async). Hits are appended to the first-turn prompt context. If the service is unhealthy the recall is skipped (no noisy per-turn failure) but the session is still bound so writes queue for a later retry.

**Teardown (session end)** — `flush_daily_log` step:
1. `appendDailyLog(finalEntry)` enqueues the session breadcrumb, then
2. **flush + end**: `registerMemoryFlusher` -> drain the write-behind queue (`ensureUser` -> `ensureSession` -> `addFacts` / `addMessages`) and `endSession()`.

Between bootstrap and teardown, writes from the writer are **queued in-process** (`memory-backend.ts`) and also auto-flush once the queue passes a size threshold, so a long session doesn't accumulate unbounded. The queue exists because the writer is synchronous (terminal graph nodes) while the REST client is async — it bridges the two without changing writer signatures. Each queued write carries its own `createdAt`.

Every memory operation is best-effort: a recall or flush failure is logged and never blocks answer delivery or session teardown.

## Write freshness, relevance, and resilience

- **Freshness (`AGENT_MEMORY_SYNC_WRITES`)**: writes default to async (`async_processing=true`) — fast, but a just-written block isn't in the vector index until the service's extraction queue catches up, so the very next recall may miss it. Set `AGENT_MEMORY_SYNC_WRITES=true` to write with `async_processing=false`, blocking until the block is `ready` and immediately searchable. Use sync when same-session recall of recent writes matters; async when write latency matters more.
- **Relevance (`rel_score`)**: `searchMemory` returns `MemoryHit { text, score }` ranked by the service's relevance score; an optional `minScore` drops weak matches. The recaller currently keeps the service ranking and joins the text.
- **Resilience (health + 503)**: `checkHealth()` (`GET /health`) gates recall. On a 503 (extraction queue saturated) the client raises `ServiceUnavailableError` carrying `retry_after_seconds`, and the flush **requeues the batch** (front of queue) rather than dropping it, so the next flush or session teardown retries. Non-503 failures are logged and dropped (best-effort).

## Conflict resolution and decay (our settings)

The mechanism is service-owned (see [Decay and conflict resolution](#decay-and-conflict-resolution-service-owned) above). Our choices on top of it:

- **Decay**: short TTL on dailylog **messages** (`AGENT_MEMORY_DAILYLOG_TTL_SECONDS`), none on **facts** — so resolved-incident noise expires while durable decisions persist.
- **Conflict resolution**: we send `created_at` (data-creation time) on every write so the service resolves contradictions by when the information was true, not by ingestion order. We never re-rank client-side.

## Configuration

```bash
LIVE_MEMORY_ENABLED=true            # master gate for the live-memory tier (no-op when false)
LIVE_MEMORY_BACKEND=agent-memory    # file (default) | agent-memory
AGENT_MEMORY_BASE_URL=http://localhost:8070
AGENT_MEMORY_ENABLED=true
AGENT_MEMORY_BEARER_TOKEN=          # required only if the service runs with OIDC_AUTH_ENABLED (RS256 JWT)
AGENT_MEMORY_DAILYLOG_TTL_SECONDS=  # short TTL for breadcrumbs; omit for no decay (facts never decay)
AGENT_MEMORY_SYNC_WRITES=false      # true => async_processing=false: blocks are searchable on write
```

Requires a running Agent Memory Docker container connected to your Capella cluster, with an embedding model + LLM available for vector embeddings and summaries. With async writes (default), semantic search returns a block only once it reaches `status: "ready"`; with `AGENT_MEMORY_SYNC_WRITES=true` a block is `ready` by the time the write returns.
