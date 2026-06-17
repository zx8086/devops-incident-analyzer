# Couchbase Agent Memory as a Swappable Live-Memory Backend

- Date: 2026-06-17
- Project: [DevOps Incident Analyzer](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a)
- Status: Design (awaiting spec review -> writing-plans)

## Context

The repo already implements the **gitagent.sh (Open GAP) memory standard** as git-tracked
markdown (the "gitagent memory types"): live runtime memory (`memory/runtime/{context,key-decisions,dailylog}.md`)
and a compiled LLM wiki (`memory/wiki/{index,log}.md` + `pages/`). These are loaded by
`gitagent-bridge` into `LoadedMemory`, read into prompts via `prompt-context.ts`, and written by the
single sync writer `packages/agent/src/memory-writer.ts` (gated by `LIVE_MEMORY_ENABLED`, all writes
PII-redacted). The backlog epics that introduced this are SIO-843 (bridge parse, EPIC 0),
SIO-845 (live memory, EPIC 3), SIO-847 (wiki, EPIC 2), SIO-849 (PR-based HITL, EPIC 1),
SIO-846 (lifecycle hooks, EPIC 7).

Today this memory is flat files: no semantic recall, no TTL/decay, no cross-session search. The
`migrate/api-docs/` Couchbase **Agent Memory** REST service provides exactly those (users/sessions/
memory blocks, semantic vector search, TTL decay) and its documented DevOps/SRE use case matches this
agent. This change maps the existing gitagent memory types onto Agent Memory as a **swappable backend**
behind the unchanged writer API, integrated for both "users": the **incident-analyzer** (devops) agent
and the **elastic-iac** agent.

Outcome: with `LIVE_MEMORY_BACKEND=agent-memory`, durable context/decisions/wiki become semantic
`facts`, incident breadcrumbs become conversational `messages` with a short TTL, and on each new session
the agent recalls relevant past incidents/decisions via semantic search — while the file backend remains
the default and fallback.

## Decisions (locked)

1. **Backend behind the existing API.** Keep `readLiveMemory()/appendDailyLog()/recordKeyDecision()`
   as the single interface. Select backend by `LIVE_MEMORY_BACKEND=file|agent-memory` (default `file`).
   Files stay as fallback; no behavior change when unset.
2. **Type mapping.** `context.md` + `key-decisions.md` + wiki pages -> Agent Memory `facts`
   (durable, no TTL). `dailylog` turns -> conversational `messages` (short TTL, decays). Recall via
   `POST /users/{uid}/sessions/{sid}/memory/search` with a natural-language query.
3. **One Agent Memory user per agent.** `user_id="incident-analyzer"`, `user_id="elastic-iac"`.
   Each LangGraph chat thread (`threadId`) maps to an Agent Memory `session_id`.
4. **Direct shared REST client.** Lives in `packages/shared` (Zod-validated, no `.default()`, strict TS,
   no `any`). Called from `memory-writer.ts` + the `lifecycle.ts` registration seams. **No new MCP
   server** — memory is infrastructure, not an LLM tool.

## Architecture

```
memory-writer.ts (sync API, unchanged signatures)
   |  isEnabled() + redactPiiContent()  (PII never leaves the process unredacted)
   |  branch on selectedBackend()
   +-- "file"          -> appendFileSync  (existing path, fallback)
   +-- "agent-memory"  -> enqueue*()  (write-behind queue in memory-backend.ts)
                                  |
lifecycle.ts (async, per-session, keyed by threadId)
   bootstrap: load_live_memory -> readLiveMemory() (file context) + registered recaller (semantic search)
   teardown:  flush_daily_log + registered flusher -> drain queue + endSession()
                                  |
packages/shared/src/agent-memory.ts  -> AgentMemoryClient (fetch) -> Couchbase Agent Memory REST
```

The write-behind queue resolves the sync/async tension: sync writers enqueue and return immediately;
the queue drains at the already-async teardown seam (and on a size/interval threshold). Recaller and
flusher use the established registration-seam idiom (`registerGraphWarmer`/`registerMemoryPrOpener`),
so `lifecycle.ts` never imports the client and all calls are best-effort (never block a session).

## Couchbase Agent Memory REST contract (used subset)

- `POST /users` — create user (swallow 409 conflict). `POST /users/{uid}/sessions` — create session (swallow 409).
- `POST /users/{uid}/sessions/{sid}/memory` — body `{ messages?: ChatMessage[], facts?: string[], annotations?, memory_block_ttl?, async_processing? }`.
- `POST /users/{uid}/sessions/{sid}/memory/search` — body `{ query?, filters?: { session_ids?: "all", relevant_k? } }`; returns `{ memory_blocks: MemoryBlock[], count }`. Only `status:"ready"` blocks appear (async extraction).
- `POST /users/{uid}/sessions/{sid}/end` — end session. `PUT /users/{uid}/ttl` — bulk TTL (reserved; not on the hot path).
- Auth: optional OIDC `Authorization: Bearer <jwt>` (when `OIDC_AUTH_ENABLED`). Base URL is **required config** (docs are inconsistent 8070 vs 8080, so no default).

## Components

### 1. `packages/shared/src/agent-memory.ts` (new)

Config schema mirrors `datasource.ts` style (strict, no `.default()`):

```ts
export const AgentMemoryConfigSchema = z.object({
  baseUrl: z.string().url(),
  enabled: z.boolean(),
  bearerToken: z.string().optional(),
  dailyLogTtlSeconds: z.number().int().positive().optional(),
});
export type AgentMemoryConfig = z.infer<typeof AgentMemoryConfigSchema>;

export interface AgentMemoryUserRef { userId: string; sessionId: string; }
export interface ChatMessageBlock { user_content: string; assistant_content: string; }

export interface AgentMemoryClient {
  ensureUser(userId: string, name: string): Promise<void>;        // create-if-missing (409-tolerant)
  ensureSession(userId: string, sessionId: string): Promise<void>; // create-if-missing (409-tolerant)
  addFacts(ref: AgentMemoryUserRef, facts: string[], ttlSeconds?: number): Promise<void>;
  addMessages(ref: AgentMemoryUserRef, messages: ChatMessageBlock[], ttlSeconds?: number): Promise<void>;
  searchMemory(ref: AgentMemoryUserRef, query: string,
    opts?: { allSessions?: boolean; relevantK?: number }): Promise<string[]>; // summary ?? fact of ready blocks
  endSession(ref: AgentMemoryUserRef): Promise<void>;
}

export function createFetchAgentMemoryClient(config: AgentMemoryConfig): AgentMemoryClient;
export function resolveAgentMemoryConfig(env?: NodeJS.ProcessEnv): AgentMemoryConfig;
```

- `resolveAgentMemoryConfig` reads `AGENT_MEMORY_BASE_URL`, `AGENT_MEMORY_ENABLED`,
  `AGENT_MEMORY_BEARER_TOKEN`, `AGENT_MEMORY_DAILYLOG_TTL_SECONDS`, builds the object explicitly
  (`enabled: flag === "true" || flag === "1"`), then `.parse()`s — same shape as `resolveMemoryPrConfig`.
- Private `amFetch<T>` mirrors memory-pr's `ghFetch`: JSON content-type, `Authorization: Bearer`
  when `bearerToken` present, throws on non-ok except `ensureUser`/`ensureSession` which catch 409.
- `searchMemory` filters client-side to `status === "ready"`, returns `summary ?? fact`.
- Export all of the above from `packages/shared/src/index.ts`.

### 2. `packages/agent/src/memory-backend.ts` (new)

Owns backend selection, the user-id mapping, the write-behind queue, and the injectable client.

```ts
export type LiveMemoryBackend = "file" | "agent-memory";
export function selectedBackend(): LiveMemoryBackend;     // env, default "file"
export function resolveUserId(agentName: string): string; // "incident-analyzer" | "elastic-iac"
export function __setAgentMemoryClient(c: AgentMemoryClient | null): void; // test injection
// write-behind: enqueueFact/enqueueMessage push redacted blocks, return immediately;
// flushAgentMemory() awaits the chain. Each enqueue does ensureUser+ensureSession first (idempotent).
```

### 3. `packages/agent/src/memory-writer.ts` (modify — signatures UNCHANGED)

Inside `appendDailyLog`/`recordKeyDecision`, after the existing `isEnabled()` gate and `redactPiiContent`,
branch on `selectedBackend()`:
- `file`: existing `appendFileSync` path (unchanged).
- `agent-memory`: `recordKeyDecision` -> `enqueueFact(...)`; `appendDailyLog` -> `enqueueMessage(...)`
  (breadcrumb as `assistant_content`, `ttlSeconds = dailyLogTtlSeconds`).
`readLiveMemory()` stays file-based for durable prompt context; semantic recall happens at the lifecycle
layer, not in the sync reader. Redaction already runs before the branch, so `enqueue*` only sees redacted
strings — add a comment so future edits keep redaction upstream.

### 4. `packages/agent/src/lifecycle.ts` (modify)

- Add `BootstrapContext { threadId; agentName; firstUserQuery? }` to `runBootstrap(ctx)`; add
  `threadId`/`agentName` to `TeardownContext`.
- Add seams mirroring the existing ones: `registerMemoryRecaller(fn)` and `registerMemoryFlusher(fn)`.
- `load_live_memory` step: keep `readLiveMemory()`, AND when a recaller is registered,
  `await memoryRecaller({ agentName, threadId, query: firstUserQuery })` and append the result to
  `result.liveMemoryContext` (try/catch + warn, like `warm_knowledge_graph`).
- Teardown: after `flush_daily_log`, `await memoryFlusher?.({ agentName, threadId })` to drain + end session.
- **Recall timing:** at bootstrap, keyed on the first user message (`searchMemory(..., { allSessions: true })`);
  no new graph node. Degrades to durable-fact listing if no query yet.

### 5. `packages/agent/src/agent-memory-install.ts` (new — parallels `memory-promotion.ts`)

`installAgentMemory()` registers the recaller (ensureUser/ensureSession + `searchMemory`) and the flusher
(`flushAgentMemory()` + `endSession`), each guarded by `selectedBackend() === "agent-memory"`. Export
`installAgentMemory`, `selectedBackend`, `resolveUserId`, `__setAgentMemoryClient` from `packages/agent/src/index.ts`.

### 6. `apps/web/src/lib/server/agent.ts` (modify — the threadId/agentName seam)

- Call `installAgentMemory();` once at module load (next to `installMemoryPromotion()`/`installGraphWarmer()`, lines 24-25).
- Resolve `agentName` (`options.agentName ?? "incident-analyzer"`) **before** `sessionBootstrap`, and pass
  `agentName` + first user-message text into `sessionBootstrap`, which calls
  `runBootstrap({ threadId, agentName, firstUserQuery })`.
- `sessionTeardown` accepts `agentName` and calls `runTeardown({ threadId, agentName, dailyLogEntry })`.
  `session_id = threadId` (already flows into both graphs as `configurable.thread_id`).

### 7. `packages/agent/src/iac/nodes.ts` (modify — close the elastic-iac gap)

The elastic-iac SOUL says it reads `memory/runtime/context.md` on bootstrap and writes back after each
job, but no wiring exists today (`bootstrapIac`/`teardownIac` never call the writer).
- `bootstrapIac`: read durable context via `readLiveMemory()` and attach to state for prompt injection.
  Semantic recall is already covered by the shared lifecycle recaller (user_id `elastic-iac`, session = threadId).
- `teardownIac`: after the summary, call `appendDailyLog({ requestId, services: [cluster], datasources: ["elastic-iac"], summary })`.
  Routes to Agent Memory automatically when the backend is selected; both stay sync (no signature change).

## Backlog mapping

| Gitagent memory type (epic) | File today | Agent Memory block |
|---|---|---|
| Live context + key-decisions (SIO-845) | `memory/runtime/{context,key-decisions}.md` | `facts` (durable, no TTL) |
| Daily log breadcrumb (SIO-845) | `memory/runtime/dailylog.md` | `messages` (short TTL, decays) |
| Compiled wiki pages (SIO-847) | `memory/wiki/pages/*.md` | `facts` (durable, annotated) |
| Lifecycle bootstrap/teardown (SIO-846) | `lifecycle.ts` steps | session create / search / `end` |
| PR-based HITL (SIO-849) | `memory-pr` package | unchanged (git-PR review path) |

The PR/wiki-review HITL path (EPIC 1/2) is preserved — Agent Memory backs the *runtime* tier, not the
human-reviewed durable-learning workflow.

## TTL / decay

- dailylog `messages`: `memory_block_ttl = AGENT_MEMORY_DAILYLOG_TTL_SECONDS` (e.g. days) — incident noise decays.
- context / key-decisions / wiki `facts`: no TTL — durable across sessions. Matches the docs' DevOps/SRE use case.

## Config / env (`.env.example`)

```
LIVE_MEMORY_BACKEND=file            # file | agent-memory (default file)
AGENT_MEMORY_BASE_URL=http://localhost:8070
AGENT_MEMORY_ENABLED=false
AGENT_MEMORY_BEARER_TOKEN=          # only when OIDC_AUTH_ENABLED on the server
AGENT_MEMORY_DAILYLOG_TTL_SECONDS=  # optional; omit for no decay on breadcrumbs
```

## Verification

1. `bun run typecheck && bun run lint` (strict, no `any`).
2. `bun test packages/shared/src/agent-memory.test.ts packages/agent/src/memory-backend.test.ts packages/agent/src/lifecycle.test.ts apps/web/src/lib/server/agent.test.ts`.
   - config parse (missing `baseUrl` throws); fetch client against a `globalThis.fetch` mock — 409 swallowed on ensure*, TTL sent for messages but not facts, non-`ready` blocks filtered from search.
   - `__setAgentMemoryClient(fake)`: `appendDailyLog`/`recordKeyDecision` enqueue **redacted** blocks under `agent-memory`, still write files under `file`.
   - lifecycle: fake recaller output appended to `liveMemoryContext`; teardown drains + ends session; failures swallowed.
3. **Backend parity:** `LIVE_MEMORY_BACKEND` unset + `LIVE_MEMORY_ENABLED=true` -> files written, zero behavior change.
4. **Manual smoke (needs running Agent Memory service):** `AGENT_MEMORY_BASE_URL` set + `LIVE_MEMORY_BACKEND=agent-memory`; run one incident-analyzer turn -> `POST /users`, `POST .../sessions`, `POST .../memory` fire; a second session's bootstrap recall returns the prior breadcrumb once blocks reach `status:"ready"`.
5. **elastic-iac:** run one gitops turn -> `teardownIac` writes a dailylog message under `user_id="elastic-iac"`; bootstrap recall returns in-flight context on the next session.

## Files

| File | Change |
|---|---|
| `packages/shared/src/agent-memory.ts` | new — Zod config + `AgentMemoryClient` fetch impl |
| `packages/shared/src/index.ts` | export the above |
| `packages/agent/src/memory-backend.ts` | new — backend select, user-id map, write-behind queue, injectable client |
| `packages/agent/src/memory-writer.ts` | modify — branch sync writer onto backend (signatures unchanged) |
| `packages/agent/src/lifecycle.ts` | modify — threadId/agentName plumbing, recaller/flusher seams, recall step |
| `packages/agent/src/agent-memory-install.ts` | new — register recaller + flusher |
| `packages/agent/src/index.ts` | export install + helpers |
| `apps/web/src/lib/server/agent.ts` | modify — install seam, pass threadId/agentName/firstUserQuery |
| `packages/agent/src/iac/nodes.ts` | modify — `bootstrapIac` read context, `teardownIac` write dailylog |
| `.env.example` | add `LIVE_MEMORY_BACKEND` + `AGENT_MEMORY_*` |
| tests | `agent-memory.test.ts`, `memory-backend.test.ts`, extend `lifecycle.test.ts` + `agent.test.ts` |

## Out of scope

- New MCP server / LLM-callable memory tools (memory stays infrastructure).
- Migrating existing markdown files into Agent Memory (the file backend remains; no backfill).
- Changing the PR-based HITL / wiki-review flow (EPIC 1/2).
- Agent Memory server deployment/hosting (assumed available at `AGENT_MEMORY_BASE_URL`).
- Knowledge-graph nodes (separate gated feature).

## Linear

A `SIO-XX` issue will be created with this spec (goals, steps, acceptance criteria) before implementation,
per project rules. Related backlog: SIO-843, SIO-845, SIO-846, SIO-847, SIO-849.
