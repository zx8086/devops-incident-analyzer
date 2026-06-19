# HANDOFF — SIO-967: Knowledge Graph + Agent Memory as MCP servers

| | |
|---|---|
| **Date** | 2026-06-19 |
| **This ticket** | [SIO-967](https://linear.app/siobytes/issue/SIO-967/investigation-expose-the-knowledge-graph-agent-memory-as-mcp-servers) — *Investigation only* (Backlog) |
| **Builds on (merged)** | [SIO-965](https://linear.app/siobytes/issue/SIO-965) (PR #259, merge `cf621ad`), [SIO-966](https://linear.app/siobytes/issue/SIO-966) (PR #258, merge `1346af5`) |
| **Foundation** | [SIO-850](https://linear.app/siobytes/issue/SIO-850) (KG behind GraphStore), [SIO-954](https://linear.app/siobytes/issue/SIO-954) (KG enabled by default; lbug teardown constraint) |
| **Repo state** | `main` @ `1346af5` (both 965 & 966 merged). Clean. |
| **Suggested branch** | `sio-967-kg-mcp-investigation` (spike); design doc commits to `main` |
| **Parent epic** | Epic 4 (Agent / LangGraph) + the knowledge-graph workstream |

---

## TL;DR

SIO-965 + SIO-966 are **merged**. The elastic-iac agent can now query the knowledge graph and durable memory **in-process** via two curated LangChain tools (`query_knowledge_graph`, `search_memory`) — **no raw Cypher, no MCP server for the graph**. SIO-967 asks whether to replace that bespoke in-process wiring with a **standard MCP surface** (consumed through the same `MultiServerMCPClient` every other datasource uses), possibly adopting the upstream `LadybugDB/mcp-server-ladybug`, and whether to expose **arbitrary Cypher** at all. It is **investigation-only**: deliverable is a design doc + a spike + a go/no-go, NOT a production server. The central blocker to settle is **embedded-lbug cross-process concurrency** (the native DB segfaults Bun at teardown; a separate MCP process opening the same `.data/knowledge-graph` file raises single-writer/locking questions).

---

## Context — how this ticket came to be

A user asked "can the elastic-iac agent run cypher queries and then call on agent memory for queries?" The honest answer at the time was *no* — both systems were **push-only** (auto-injected at fixed pipeline points). We then:

1. **SIO-965** modelled the elastic-iac repo as a three-layer knowledge graph and linked it to durable memory via shared annotation keys.
2. **SIO-966** added two **curated** (not Cypher, not MCP) LLM-callable tools so the agent can *pull* on demand.
3. The user pointed at `langchain-mcp-adapters` (JS) and `LadybugDB/mcp-server-ladybug` and asked whether the *full* outcome (Cypher through the Ladybug MCP) was done. It is **not** — that became **SIO-967**, scoped as investigation because of a real unresolved concurrency blocker.

So SIO-967 is the "should we do this the standard MCP way, and do we want raw Cypher" decision — deliberately deferred, not skipped.

---

## What SIO-965 achieved (merged — `cf621ad`)

Three-layer KG grounded in the **live** `observability-elastic-iac` GitLab repo (structure verified via API, not guessed).

**Model** (`packages/knowledge-graph/src/schema.ts`):
```
Module {name, howto}
Stack {name} -[:USES_MODULE]-> Module          (parsed from stacks/<name>/main.tf; can be many)
ElasticDeployment {name, ecId?, region?}
StackInstance {id="<dep>/<stack>"} -[:OF_STACK]-> Stack, -[:ON_DEPLOYMENT]-> ElasticDeployment
ConfigChange {id, workflow, filePath, summary, createdAt, outcome}
   -[:TARGETS]-> StackInstance
   -[:VIA_WORKFLOW]-> Workflow {name}
   -[:IN_SESSION]-> Session {threadId}
   -[:PROPOSED_IN]-> MergeRequest {url}
MergeRequest -[:RAN]-> Pipeline {id, status, url}
```
Existing `ElasticDeployment -[:CHANGED_BY]-> ConfigChange` retained for back-compat.

**Verified repo facts** (memory: `reference_elastic_iac_repo_three_layer_structure`):
- 31 modules, 24 stacks, 10 deployments (+ special `_deployments`/`_shared` dirs).
- **Stack→Module is NOT name-derivable** (`slos`→`slo`, `agent-policies`→`agent-policy`; `deployments` uses TWO modules) → the seeder must parse `main.tf`.
- **StackInstance = (deployment, stack) is SPARSE** (eu-cld has 17/24 stack dirs).
- dev/stg/prd are namespaces, not clusters.

**Code landed:**
- `packages/knowledge-graph/src/schema.ts` — new node/rel tables (`CREATE IF NOT EXISTS`) + `ALTER_MIGRATIONS` (the one non-additive DDL: `outcome`/`ecId`/`region`, run tolerantly in `store.init()`).
- `packages/knowledge-graph/src/writer.ts` — extended `recordIacChange`; new `recordPipeline`, `setChangeOutcome`, `seed*` writers.
- `packages/knowledge-graph/src/reader.ts` — `stacksUsingModule`, `deploymentsRunningStack`, `changeHistoryForStackInstance`; `buildIacGraphContext` 3rd optional arg (2-arg form byte-identical).
- `packages/knowledge-graph/src/seed-iac.ts` (NEW) — idempotent CLI `knowledge-graph:seed-iac`, seeds the skeleton from the live repo. **Live run produced: 30 modules, 24 stacks (27 module edges), 10 deployments, 88 sparse stack instances.**
- `packages/agent/src/iac/{graph,graph-knowledge,state,nodes}.ts` — `recordIacOutcome` node (edge-gated after `watchPipeline`); `threadId` state field captured in `bootstrapIac` (survives the resume leg).
- **MR labels**: both `openMr` sites pass `AGENT_MR_LABELS = ["agent-generated","iac"]` explicitly (the MCP tool already defaulted to them; now visible at the call site, can't silently regress).
- **KG↔Memory linkage**: `teardownIac` writes a durable `iac-change` fact on every gitops MR turn (agent-memory backend only), annotated with the **same keys as the KG nodes** (`config_change_id`, `thread_id`, `deployment`, `stack`, `stack_instance`, `workflow`, `version`, `mr_url`, `pipeline_id`, `pipeline_status`, `outcome`). **`threadId` is the shared join key** between the KG `Session` node and the Agent Memory `sessionId`.

## What SIO-966 achieved (merged — `1346af5`)

Two **LOCAL** (non-MCP) LangChain tools so the LLM can *decide* to query during `answerInfo` / `converseIac`:
- `query_knowledge_graph` — curated query types (`deployments_running_stack`, `stacks_using_module`, `stack_instance_history`, `deployment_history`) wrapping the SIO-965 readers. **No raw Cypher → injection-safe.**
- `search_memory` — semantic recall across past sessions + optional `{deployment, stack, kind}` annotation filter that joins to the KG node keys.

Both **soft-fail** to a friendly string when their backend is disabled.

**Code:** `packages/agent/src/iac/local-tools.ts` (NEW, tool factories + pure handlers), `packages/agent/src/memory-backend.ts` (`searchAgentMemory(agentName, query, filter?)`), `packages/agent/src/iac/nodes.ts` (`infoTools()` appends the locals; new `dispatchInfoToolCall()` resolves calls from the in-scope tools array because `callTool()` only resolves MCP tools).

**This is exactly what SIO-967 may supersede / standardize.**

---

## Where the bodies are buried (current-state file:line refs SIO-967 needs)

**The graph is read in-process, NOT via MCP today:**
- `packages/knowledge-graph/src/store.ts:191` — `getGraphStore()` (lazy singleton `Promise<GraphStore>`; `store.run(cypher, params)` is the only execution path). **In-process only — no MCP wrapper exists.**
- `packages/knowledge-graph/src/store.ts` `close()` is a **deliberate no-op** — the lbug native `Database` finalizer segfaults Bun at teardown (SIO-954). Quote (paraphrased): *"deliberately do NOT call the native db.close(); lbug's Database destructor segfaults Bun's runtime at teardown. Embedded lbug flushes writes on every query, so durability does not depend on an explicit close."* **This is the crux of the SIO-967 concurrency question.**
- `packages/knowledge-graph/src/reader.ts` — the curated readers SIO-967 would expose as MCP tools (already tested, parameterized).

**The standard MCP path every other datasource uses:**
- `packages/agent/src/mcp-bridge.ts:169` and `:497` — `const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");` then `new MultiServerMCPClient({...})`. This is the JS adapter the user linked. **We already depend on `@langchain/mcp-adapters@^1.1.3`** (root `package.json:12`, `packages/agent/package.json:24` via `catalog:`).
- `packages/shared/src/bootstrap.ts:84` — `createMcpApplication<T>(options)` — the unified MCP server bootstrap (stdio / http / agentcore-proxy via `mode`). A new `packages/mcp-server-knowledge-graph` would use this.
- `packages/mcp-server-elastic-iac/src/server.ts` — reference MCP server entrypoint to mirror for the build option.

**What SIO-966 wired (the thing being evaluated for replacement):**
- `packages/agent/src/iac/local-tools.ts` — the curated tools (in-process).
- `packages/agent/src/iac/nodes.ts` `infoTools()` + `dispatchInfoToolCall()` — where MCP tools would slot in instead.
- `agents/elastic-iac/tools/elastic-iac.yaml` — action-driven tool selection (planner metadata; MCP tools get selected here, local tools do not).

---

## The SIO-967 investigation (step-by-step)

> Investigation only. Do NOT build a production MCP server or migrate consumers in this ticket — those are follow-ups gated on the go/no-go.

### Step 1 — Evaluate `LadybugDB/mcp-server-ladybug`
- URL: https://github.com/LadybugDB/mcp-server-ladybug
- Answer: what tools does it expose — **arbitrary Cypher, or curated queries?** Transport modes (stdio/http)? Read-only enforcement? Does it run embedded against an existing lbug DB file or require its own server process? Maturity + licence (we vendor `lbug ^0.14.3`).
- Decide: **adopt as-is / fork / build our own** `packages/mcp-server-knowledge-graph` (via `createMcpApplication`, wrapping our `reader.ts` functions — curated, no Cypher).

### Step 2 — Settle the concurrency blocker (the spike)
- Seed a graph: `KNOWLEDGE_GRAPH_ENABLED=true KNOWLEDGE_GRAPH_PATH=/tmp/sio967/db bun run --filter @devops-agent/knowledge-graph knowledge-graph:seed-iac` (needs `ELASTIC_IAC_GITLAB_TOKEN` in `.env`).
- Open the **same DB file** from a second process (the MCP server) while the agent process also has it open. **Does lbug support concurrent cross-process readers? A writer + reader?** This is the make-or-break technical fact.
- Confirm the Bun teardown segfault behaviour: does running the MCP server as a separate process **avoid** the in-graph finalizer crash (it would, since the agent process no longer opens the file directly)? Note any locking.

### Step 3 — Decide the tool surface
- **Curated vs raw Cypher.** Recommendation leans curated (read-only, validated) — raw Cypher is an injection/footgun risk, and lbug has binder quirks (memory `reference_lbug_cypher_and_teardown_gotchas`: vars don't cross two `MATCH` clauses; `ORDER BY` after `RETURN DISTINCT` must use the projected alias — we hit both in SIO-965). If raw Cypher is wanted, design read-only guards + validation.

### Step 4 — Decide memory
- Should Agent Memory ALSO become an MCP server, or stay the direct REST client (`packages/shared/src/agent-memory.ts`)? It is already REST — wrapping as MCP may be redundant. Likely: leave memory as-is, MCP-ify only the graph.

### Step 5 — Migration plan for SIO-966
- If MCP is adopted: do the SIO-966 local tools retire in favour of MCP tools selected via `elastic-iac.yaml`? Define the deprecation path. Scope: elastic-iac only, or also incident-analyzer (which has its own incident-side graph-enrich)?

### Step 6 — Deliverables
- Design doc: `docs/superpowers/specs/2026-06-XX-knowledge-graph-mcp-server-design.md` with: build-vs-adopt recommendation, transport choice, **the embedded-lbug concurrency verdict**, tool surface (curated vs Cypher), migration plan for SIO-966.
- Spike artifacts/notes (concurrency behaviour observed).
- Go/no-go + effort estimate.

---

## Verification (current `main` baseline — confirm green before starting)

```bash
git checkout main && git pull
bun run typecheck            # expect 0 errors
bun run lint                 # expect clean
bun run --filter @devops-agent/knowledge-graph test   # expect 33 pass / 0 fail
bun run --filter @devops-agent/agent test             # expect ~1242 pass / 0 fail
```

**lbug teardown gotcha when running tests:** `bun test <single-file>` against the real embedded engine **segfaults at teardown** (exit 133) even though the tests PASS. Use `bun run --filter @devops-agent/knowledge-graph test` (the package script) which exits 0. To see a single real-engine test's actual error, run `bun test <file> -t "<name>"`. (memory: `reference_lbug_cypher_and_teardown_gotchas`)

**Seeder smoke test (proves the live-repo path still works):**
```bash
cd packages/knowledge-graph
set -a; source ../../.env; set +a
export KNOWLEDGE_GRAPH_ENABLED=true KNOWLEDGE_GRAPH_PATH=/tmp/sio967-seed/db
bun run src/seed-iac.ts     # expect: seeded 30 modules, 24 stacks (27 module edges), 10 deployments, 88 stack instances
```

---

## Files to read first (in order)

| File | Why |
|---|---|
| `packages/knowledge-graph/src/store.ts` | The in-process GraphStore + the deliberate no-op `close()` (the concurrency crux) |
| `packages/knowledge-graph/src/reader.ts` | The curated queries a KG MCP server would expose |
| `packages/agent/src/mcp-bridge.ts` (`MultiServerMCPClient` usage) | The standard adapter path SIO-967 would route the graph through |
| `packages/shared/src/bootstrap.ts` (`createMcpApplication`) | How to build a new MCP server if "build" wins |
| `packages/agent/src/iac/local-tools.ts` | The SIO-966 in-process tools this may supersede |
| `agents/elastic-iac/tools/elastic-iac.yaml` | Action-driven MCP tool selection (where MCP tools register) |

---

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| lbug does not support concurrent cross-process access to one DB file | **High / unknown** | The Step-2 spike is gating; if single-writer-only, the MCP server may need its own copy or a read-replica strategy — possibly a no-go for embedded lbug, pushing toward the eventual Neo4j port (SIO-850's design intent) |
| Raw Cypher exposed to the LLM | Medium | Recommend curated-only; if Cypher, add read-only validation + reject DDL/write keywords |
| MCP server adds a process to manage (ports, health, lifecycle) | Medium | Reuse `createMcpApplication` + the existing port conventions (CLAUDE.md "Servers"); pick a free port (9087?) |
| Duplicated query logic (MCP server vs SIO-966 local tools) | Low | If go: migrate SIO-966 tools to MCP, delete the local ones; if no-go: keep SIO-966 as the answer |

## Out of scope (SIO-967)
Writing the production MCP server; migrating consumers; the Neo4j port. Those are follow-up implementation tickets if the investigation says go.

## Memory references
- `reference_lbug_cypher_and_teardown_gotchas` — Kuzu binder rules + the Bun teardown segfault + how to run the tests.
- `reference_elastic_iac_repo_three_layer_structure` — the verified live repo structure (31/24/10, sparse instances, main.tf parse).
- `reference_iac_trace_two_leg_mechanism` — the leg1/leg2 (stream/resume) flow that `recordIacOutcome` runs in.
- `project_deployment_target_agentcore` — deployment target is AgentCore, relevant if the MCP server needs hosting.
