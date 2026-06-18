# Memory model mapping: gitagent <-> Couchbase Agent Memory

How the two memory models line up. gitagent's file/git-native memory and Couchbase Agent Memory's `user -> session -> block` hierarchy are the **same shape**; the SIO-938 backend swaps the storage substrate while preserving that shape. The one tier that deliberately does *not* map is the PR-gated durable-learning path, which stays in git.

Source (gitagent side): `agents/<agent>/memory/`, `agents/<agent>/hooks/hooks.yaml`, `packages/gitagent-bridge/src/{memory,hooks}.ts`, `packages/memory-pr/`. Source (Agent Memory side): `packages/shared/src/agent-memory.ts`, `packages/agent/src/{memory-backend,memory-writer,lifecycle}.ts`. Companion doc: [`agent-memory.md`](agent-memory.md) (the Agent Memory tier in depth). Design spec: `docs/superpowers/specs/2026-06-17-couchbase-agent-memory-backend-design.md`.

## The two models

```
gitagent (file / git-native)                Couchbase Agent Memory
----------------------------                ----------------------
agent (agent.yaml)               --------->  User      (user_id = agent name, one per agent)
  chat thread (LangGraph threadId) ------->  Session   (session_id = threadId; active / ended)

    Memory Blocks, grouped by memory type:
    memory/runtime/dailylog.md   --------->  CONVERSATIONAL  message block (short TTL, decays)
    memory/runtime/key-decisions.md ------>  PROFILE         fact block (durable, no TTL)
    memory/runtime/context.md    --------->  PROFILE         fact block (durable, no TTL)
    memory/wiki/pages/*.md       --------->  SEMANTIC        fact block (durable, annotated)

  hooks.yaml (bootstrap/teardown) ------->  session create / search / end
memory-pr (agent/learn/* PR)     --- x --->  (stays in git; NOT in Agent Memory)
```

Both models are a three-level hierarchy: an identity that owns everything (agent / user), a per-conversation scope (thread / session), and the unit of stored knowledge (markdown file / memory block). On the Agent Memory side those blocks are unified into three memory types — Conversational, Profile, Semantic — detailed below.

## Structural mapping

| gitagent | Agent Memory | Code |
|---|---|---|
| agent (`agent.yaml`) | **User** (`user_id`) | `resolveUserId()` -> `incident-analyzer` or `elastic-iac`, one per agent |
| chat thread (`threadId`) | **Session** (`session_id`) | spec decision 3: each LangGraph thread maps to a session; `setActiveMemorySession(agentName, threadId)` |
| runtime + wiki `.md` files | **Memory block** | `addMessages` / `addFacts` -> `POST /users/{u}/sessions/{s}/memory` |

User and session are created idempotently on first write or first recall (`ensureUser` / `ensureSession`, 409-conflict tolerant).

## Memory-type mapping

Agent Memory unifies different memory types into a single retrieval system. gitagent's runtime tiers land on those three types (definitions per the Couchbase concept docs). The split is deliberate: the daily breadcrumb is conversational continuity, the decisions/context are the agent's profile, and the wiki is the semantic knowledge base.

### Conversational memory

Short-term memory scoped to **1 session**. It captures the flow of the current conversation to maintain dialog continuity.

- **Source:** `memory/runtime/dailylog.md` (one breadcrumb per completed run)
- **Block kind:** `message` (`{ user_content, assistant_content }`)
- **Lifecycle:** short TTL via `AGENT_MEMORY_DAILYLOG_TTL_SECONDS`, decays
- **Written:** appended directly (not PR-gated), always PII-redacted

### Profile memory

Long-term memory that spans **multiple sessions**. It stores facts and preferences extracted from conversations to personalize future responses.

- **Source:** `memory/runtime/key-decisions.md` + `memory/runtime/context.md` (durable estate facts and prior decisions)
- **Block kind:** `fact`
- **Lifecycle:** durable, no TTL
- **Written:** promoted (human-in-the-loop) or appended, always PII-redacted

### Semantic memory

Long-term memory that stores **knowledge and facts**. Agents retrieve this information for factual grounding.

- **Source:** `memory/wiki/pages/*.md` (compiled, cross-referenced knowledge pages)
- **Block kind:** `fact`, annotated
- **Lifecycle:** durable
- **Written:** compiled, via the PR-gated review path (below)

## What every block carries

Each Agent Memory block = **original message/fact + vector embedding + LLM summary + timestamp** (Couchbase data model). In our flow:

- **Embedding + summary are service-side.** We never generate or send vectors; the Agent Memory container produces them from the POSTed text using its configured Model Service. See [`agent-memory.md`](agent-memory.md) ("Embeddings are service-side").
- **Recall** = `searchMemory(..., { allSessions: true })` -> semantic search returning only `status: "ready"` blocks (`memory-backend.ts` `recallAgentMemory`). Recall runs at bootstrap, keyed on the first user message.
- **Freshness.** With `AGENT_MEMORY_SYNC_WRITES=true`, a write blocks until the embedding is ready (`async_processing=false`), so a just-written block is immediately searchable; otherwise extraction is async and the block appears in search shortly after.

## Lifecycle mapping

gitagent declares lifecycle in `hooks.yaml` (validated by `packages/gitagent-bridge/src/hooks.ts`); the lifecycle steps drive Agent Memory session calls.

| gitagent hook step | Agent Memory effect |
|---|---|
| `bootstrap: load_live_memory` | `ensureUser` + `ensureSession` + `searchMemory` (recall across past sessions) |
| `teardown: flush_daily_log` | drain write-behind queue -> `addMessages`/`addFacts`, then `endSession` |

Writes are enqueued synchronously during a turn and drained at safe boundaries (per-turn and at teardown), so a memory write never blocks or fails an investigation. The bootstrap/teardown step enums (gitagent-bridge): bootstrap = `load_live_memory`, `load_wiki_index`, `warm_knowledge_graph`, `emit_session_start`; teardown = `flush_daily_log`, `checkpoint_key_decisions`, `open_memory_pr`, `close_knowledge_graph`.

## What does NOT map: the PR-gated learning path

gitagent's durable-learning workflow (`packages/memory-pr`) stays entirely in git. A proposed wiki page, promoted key-decision, or new skill is staged on an `agent/learn/*` branch and opened as a human-reviewed PR against the agent's own `memory/wiki/` and `memory/runtime/key-decisions.md` (secret-scanned, never auto-merged). Agent Memory backs the **runtime** tier — fast semantic recall — not the human-in-the-loop review.

Consequence: a durable learning lives in **two** places by design:
1. The reviewed markdown in git — source of truth, versioned, diff-able.
2. A queryable `fact` block in Couchbase — fast cross-session recall.

## Caveats

- **No backfill.** Existing `.md` files are not imported into Agent Memory (out of scope in SIO-938). Blocks accrue from new turns going forward; historical wiki/decisions live only in git until rewritten.
- **Backend is swappable.** `LIVE_MEMORY_BACKEND` defaults to `file` (git-tracked markdown remains source of truth). The mapping above applies only when `LIVE_MEMORY_BACKEND=agent-memory`; the writer signatures and file paths are unchanged when it is unset.
