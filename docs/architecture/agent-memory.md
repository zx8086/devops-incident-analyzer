# Agent Memory (live-memory backend)

What the agents persist to Couchbase Agent Memory, when, and how it maps onto Agent Memory's user/session/block model.

Source: `packages/shared/src/agent-memory.ts` (REST client), `packages/agent/src/memory-backend.ts` (backend select + write-behind queue + recall), `packages/agent/src/memory-writer.ts` (single writer), `packages/agent/src/lifecycle.ts` (bootstrap/teardown seams). Introduced in SIO-938; design spec: `docs/superpowers/specs/2026-06-17-couchbase-agent-memory-backend-design.md`.

## What this is (and is not)

This is the **live-memory tier** — durable, cross-session knowledge the agent reads at the start of a session and appends to at safe boundaries. It is NOT the LangGraph checkpointer: the checkpointer (`packages/checkpointer`) holds transient per-thread graph state for resume/interrupt and is discarded; live memory persists across threads and sessions.

When `LIVE_MEMORY_BACKEND=agent-memory`, that tier is stored in Couchbase Agent Memory instead of git-tracked markdown. Per the Couchbase concept docs, Agent Memory is the persistence layer (storage + semantic retrieval); it does not provide reasoning over the memories — our pipeline decides when to read and write.

## Embeddings are service-side

We do not generate, store, or send vectors. There is no embedding/vector field on any write request. When a block is written, the **service** generates its vector embedding and an LLM summary using the configured Model Service. Recall sends a natural-language `query`; the service embeds the query and runs FTS-KNN over the stored embeddings. So `searchMemory(query)` *is* the embedding-powered semantic search — the client's job is only to write good text and issue queries. Blocks only enter the vector index once `status: "ready"` (see freshness below).

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

## Conflict resolution and decay (handled by the service)

- **Decay**: block TTL. We set a short TTL on dailylog messages and none on facts; expired blocks drop out of the cluster automatically.
- **Conflict resolution**: Agent Memory orders contradictory memories by timestamp. We send `created_at` (the data-creation time) on every write so the service can resolve conflicts by when the information was true, not merely by ingestion order. We never re-rank or resolve conflicts client-side.

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
