# Agent Memory (live-memory backend)

What the agents persist to Couchbase Agent Memory, when, and how it maps onto Agent Memory's user/session/block model.

Source: `packages/shared/src/agent-memory.ts` (REST client), `packages/agent/src/memory-backend.ts` (backend select + write-behind queue + recall), `packages/agent/src/memory-writer.ts` (single writer), `packages/agent/src/lifecycle.ts` (bootstrap/teardown seams). Introduced in SIO-938; design spec: `docs/superpowers/specs/2026-06-17-couchbase-agent-memory-backend-design.md`.

## What this is (and is not)

This is the **live-memory tier** — durable, cross-session knowledge the agent reads at the start of a session and appends to at safe boundaries. It is NOT the LangGraph checkpointer: the checkpointer (`packages/checkpointer`) holds transient per-thread graph state for resume/interrupt and is discarded; live memory persists across threads and sessions.

When `LIVE_MEMORY_BACKEND=agent-memory`, that tier is stored in Couchbase Agent Memory instead of git-tracked markdown. Per the Couchbase concept docs, Agent Memory is the persistence layer (storage + semantic retrieval); it does not provide reasoning over the memories — our pipeline decides when to read and write.

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

Driven by each agent's `hooks/hooks.yaml` lifecycle steps, run per session (keyed by `threadId`) from `apps/web/src/lib/server/agent.ts`.

**Bootstrap (session start)** — `load_live_memory` step:
1. read durable context (file context still loaded for the prompt), then
2. **recall**: `registerMemoryRecaller` -> `searchMemory(query = latest user message, session_ids: "all", relevant_k: 8)` — a semantic search across the agent's past sessions. Only blocks with `status: "ready"` are returned (extraction is async). Hits are appended to the first-turn prompt context.

**Teardown (session end)** — `flush_daily_log` step:
1. `appendDailyLog(finalEntry)` enqueues the session breadcrumb, then
2. **flush + end**: `registerMemoryFlusher` -> drain the write-behind queue (`ensureUser` -> `ensureSession` -> `addFacts` / `addMessages`) and `endSession()`.

Between bootstrap and teardown, writes from the writer are **queued in-process** (`memory-backend.ts`) and also auto-flush once the queue passes a size threshold, so a long session doesn't accumulate unbounded. The queue exists because the writer is synchronous (terminal graph nodes) while the REST client is async — it bridges the two without changing writer signatures.

Every memory operation is best-effort: a recall or flush failure is logged and never blocks answer delivery or session teardown.

## Conflict resolution and decay (handled by the service)

- **Decay**: block TTL. We set a short TTL on dailylog messages and none on facts; expired blocks drop out of the cluster automatically.
- **Conflict resolution**: Agent Memory uses block timestamps to prefer the most recent of contradictory memories — we do not implement this; we only write timestamped blocks.

## Known gap: elastic-iac has no `hooks.yaml`

`agents/incident-analyzer/hooks/hooks.yaml` declares the bootstrap/teardown steps, so the incident-analyzer recall-at-bootstrap and flush-at-teardown both fire. `agents/elastic-iac/` has **no `hooks.yaml`**, so its lifecycle steps don't run: the `teardownIac` breadcrumb is still enqueued, but it is only flushed by the queue size-threshold (or the next incident-analyzer teardown in the same process), and elastic-iac gets **no semantic recall at bootstrap**. To make elastic-iac a first-class memory user, add an `elastic-iac/hooks/hooks.yaml` with `load_live_memory` (bootstrap) and `flush_daily_log` (teardown) steps. Tracked as follow-up to SIO-938.

## Configuration

```bash
LIVE_MEMORY_ENABLED=true            # master gate for the live-memory tier (no-op when false)
LIVE_MEMORY_BACKEND=agent-memory    # file (default) | agent-memory
AGENT_MEMORY_BASE_URL=http://localhost:8070
AGENT_MEMORY_ENABLED=true
AGENT_MEMORY_BEARER_TOKEN=          # required only if the service runs with OIDC_AUTH_ENABLED (RS256 JWT)
AGENT_MEMORY_DAILYLOG_TTL_SECONDS=  # short TTL for breadcrumbs; omit for no decay (facts never decay)
```

Requires a running Agent Memory Docker container connected to your Capella cluster, with an embedding model + LLM available for vector embeddings and summaries (semantic search returns nothing until blocks reach `status: "ready"`).
