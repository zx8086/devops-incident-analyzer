# Knowledge Graph (lbug / LadybugDB)

The embedded entity-and-correlation graph both agents write to and read from when `KNOWLEDGE_GRAPH_ENABLED` is set. It records the entities a turn touches (services, incidents, deployments, config changes) and the relationships between them, so a later turn can recall prior dependencies, similar past incidents, and a deployment's change history.

Source: `packages/knowledge-graph/` (store + schema + readers + writers), `packages/mcp-server-knowledge-graph/` (the in-process MCP server, SIO-967), `packages/agent/src/graph-knowledge.ts` (incident-side nodes), `packages/agent/src/iac/graph-knowledge.ts` (elastic-iac nodes). Design spec: [`../superpowers/specs/2026-06-19-knowledge-graph-mcp-server-design.md`](../superpowers/specs/2026-06-19-knowledge-graph-mcp-server-design.md). Foundation tickets: SIO-850 (graph + incident nodes), SIO-954 (IaC nodes + enable), SIO-965 (three-layer IaC model), SIO-967 (MCP server).

## What this is (and is not)

This is the **structured-correlation tier** — a typed graph of entities and edges queried for *relationships* ("what depends on X", "what changed on this deployment", "have we seen an incident like this"). It is distinct from the other two knowledge tiers:

- **Agent Memory** ([agent-memory.md](agent-memory.md)) stores *learned/episodic facts* as text blocks with semantic recall — "what did we decide", "what's the lifecycle of this MR". The graph stores *structure*; memory stores *narrative*. They are joined by shared annotation keys (`stack_instance`, `deployment`, `outcome`) so a recall in one can be correlated with the other (SIO-965/985), but they are separate stores.
- **LLM Wiki** ([agent-concepts.md](agent-concepts.md) § 2) is the agent's synthesized, PR-reviewed prose knowledge base.

The graph is **off unless enabled**. `isKnowledgeGraphEnabled(env)` (`packages/knowledge-graph/src/store.ts`) returns true only when `KNOWLEDGE_GRAPH_ENABLED` is `"true"` or `"1"`. SIO-954 "enabled by default" means the deployment/`.env` configuration sets that flag — the code default is still off, so every graph node and tool no-ops when the flag is unset.

## Store layer

`packages/knowledge-graph/src/store.ts` defines the seam that makes "LadybugDB now, Neo4j later" a driver swap rather than a pipeline change:

```
GraphStore (interface)        init() | run<T>(cypher, params) | close()
  ├── LadybugStore            embedded lbug (a Kuzu successor); the production store
  └── InMemoryGraphStore      a test fake (no native module needed)
```

- **`getGraphStore()`** — a module-level singleton. Because embedded lbug takes an **exclusive OS file lock** on its data directory, this singleton is *the one lock holder* for the whole process; every pipeline `record*`/`enrich*` node and the in-process MCP server share it.
- **`LadybugStore`** loads the `lbug` native addon through a variable specifier, so the package typechecks and unit-tests **without** the native module installed. Install it (`bun add lbug`) and set the flag to activate.
- **`run()`** executes parameterized Cypher — every value is bound as `$param`, never string-interpolated, so the writer/reader boundary is injection-safe.
- **`close()` is a deliberate no-op** (SIO-954): lbug's native finalizer can segfault Bun at teardown, so the store holds the lock for the process lifetime and relies on per-query durability. See the test gotcha below.
- **`graphPath(env)`** — `.data/knowledge-graph` by default, overridden by `KNOWLEDGE_GRAPH_PATH`.

## Schema

`packages/knowledge-graph/src/schema.ts` declares the data model up front (lbug is table-typed, unlike Neo4j's schema-optional labels). `MIGRATIONS` is the node/rel DDL, `ALTER_MIGRATIONS` adds columns additively, `VECTOR_INDEX_SETUP` builds the HNSW index where supported. Writes are MERGE-based (idempotent — safe to re-run).

**Node labels** (`NODE_LABELS`) span two domains:

- **Incident-side (SIO-850):** `Service`, `Deployment`, `KafkaTopic`, `ConsumerGroup`, `ApiRoute`, `Bucket`, `AwsAccount`, `AwsResource`, `Incident` (carries a 1024-dim Bedrock Titan embedding for similarity search), `Finding`, `Runbook`, `WikiPage`, `RootCause` (SIO-1026: a derived cause keyed by a stable class hash, linked from an `Incident` via `HAS_ROOT_CAUSE`).
- **IaC-side (SIO-954/965):** `ElasticDeployment` (a cluster, distinct from a microservice `Service`), `ConfigChange` (one maker turn's proposed edit), `MergeRequest`, plus the three-layer repo model `Module` -> `Stack` -> `StackInstance` (the sparse `(deployment, stack)` state cell a change targets), `Workflow`, `Session`, `Pipeline`.

**Relationship types** (`REL_TYPES`): incident edges `DEPENDS_ON`, `PRODUCES_TO`, `CONSUMES_FROM`, `ROUTES_TO`, `AFFECTED_BY`, `CORRELATES_WITH`, `RESOLVED_BY`, `DOCUMENTED_IN`, `DEPLOYED_AS`, `HAS_ROOT_CAUSE` (SIO-1026); IaC edges `CHANGED_BY`, `PROPOSED_IN`, `USES_MODULE`, `OF_STACK`, `ON_DEPLOYMENT`, `TARGETS`, `VIA_WORKFLOW`, `IN_SESSION`, `RAN`.

`reader.ts` exposes curated, parameterized read functions (`priorRelationshipsForServices`, `similarIncidents`, `rootCauseForIncident`, `priorRootCauses`, `priorChangesForDeployment`, `changeHistoryForStackInstance`, `deploymentsRunningStack`, `stacksUsingModule`, `topology`, …); `writer.ts` exposes MERGE-based writers (`upsertEntities`, `recordIncident`, `recordRootCause`, `recordIacChange`, `recordPipeline`, `setChangeOutcome`, `linkCorrelation`, the `seed*` functions, …).

## The in-process MCP server (port 9087, SIO-967)

The graph is exposed to the elastic-iac agent as an MCP server on the **same rails as every datasource** (one `MultiServerMCPClient` registration, boot-strict `/identity`, health polling) — but it must run **in-process**, not standalone.

**Why in-process:** the exclusive lbug file lock means a second process opening the same `.data/knowledge-graph` path fails (`Could not set lock on file`) — for a reader *or* a writer. The web/agent process already opens the graph in its pipeline `record*`/`enrich*` nodes, so a standalone KG process is impossible while the agent runs.

So `startKnowledgeGraphServer()` mounts a `Bun.serve` on `127.0.0.1:9087` **inside the web app** (`apps/web/src/lib/server/agent.ts`), and its tools reuse the same-process `getGraphStore()` singleton. The mount is gated on `KNOWLEDGE_GRAPH_ENABLED`, fire-and-forget, and **best-effort** — a start failure only disables the `kg_*` tools, never blocks the app. A pre-flight port check (SIO-987) detects an already-listening standalone server and registers read-only tools against it instead of trying to bind (which would deadlock on the lock); the boot is hardened to survive Vite SSR eager evaluation (SIO-986).

### Tool surface

Reached at `http://127.0.0.1:9087/mcp`. Four **curated** read-only tools are always registered (`tools/curated.ts`), each binding its args as params (injection-safe):

| Tool | Input | Returns | Reader |
|------|-------|---------|--------|
| `kg_deployments_running_stack` | `stack` | deployments running that stack (blast radius) | `deploymentsRunningStack` |
| `kg_stacks_using_module` | `module` | stacks wiring that module (reuse blast radius) | `stacksUsingModule` |
| `kg_stack_instance_history` | `deployment`, `stack` | recent change history for one cell, with outcome | `changeHistoryForStackInstance` |
| `kg_deployment_history` | `deployment` | recent change history for a deployment, newest first | `priorChangesForDeployment` |

A fifth tool, **`kg_run_cypher`**, is registered **by default** (`KG_MCP_ALLOW_CYPHER=false` to disable) for ad-hoc questions the curated tools don't cover. It runs `validateReadOnlyCypher()`: it rejects any write/DDL keyword (`CREATE/MERGE/SET/DELETE/DETACH/REMOVE/DROP/ALTER/COPY/CALL/...`) after stripping comments and string literals, rejects multi-statement payloads, and binds `$params`. Its description embeds a **schema card** (node tables, relationship directions, the two lbug binder quirks, worked examples) so the model can author valid read queries; `agents/elastic-iac/skills/query-knowledge-graph/SKILL.md` holds a fuller version. Schema is deliberately NOT stored in Agent Memory — it is static and versioned with the code.

**Loud-fail (SIO-968):** when the graph is disabled or the store can't open, the tools return an explicit "KNOWLEDGE GRAPH UNAVAILABLE … do NOT answer from memory, specs, or runbooks" string instead of soft prose, so the agent reports the answer as unverified rather than fabricating a confident graph result.

## Scenario catalog (the pipeline nodes)

Both pipelines register their graph nodes **always** but edge them only when the flag is set (the SIO-640 edge-gate idiom), so the node functions are type-safe and unit-testable while remaining unreachable when disabled. Every node **soft-fails** — a cold or absent graph degrades to empty context and never throws.

### incident-analyzer — 3 nodes (`packages/agent/src/graph-knowledge.ts`)

| Node | Trigger | Reads / Writes |
|------|---------|----------------|
| `recordEntities` (`recordGraphEntities`) | after `entityExtractor` | **WRITE**: `upsertEntities` (affected `Service`s) + `recordIncident` (the turn's `Incident` with severity + summary, linked `AFFECTED_BY`). |
| `graphEnrich` | after `recordEntities` | **READ**: `priorRelationshipsForServices` (service dependencies) + `similarIncidents` (Bedrock Titan embedding of the user query -> vector-nearest prior incidents), each annotated with its recorded `rootCauseForIncident` (SIO-1026: "we've seen this before -- prior root cause X"). Produces `state.graphContext`, consumed by the aggregator prompt. Embedding failure is non-fatal (keeps the dependency context). |
| `recordRootCause` (`recordRootCauseData`, SIO-1026) | after `aggregateMitigation` (LATE, so the final `confidenceScore` is known) | **WRITE**: re-runs the correlation engine (a pure function of state) and, when a rule FIRED and was covered (`reason: "already covered by prior agent findings"`), `recordRootCause` — the turn's `RootCause` (class = satisfied rule name, PK = stable hash so recurrences MERGE) linked `HAS_ROOT_CAUSE` from the `Incident`. Records nothing when no cross-domain correlation held (never fabricates a cause). |

Edge sequence when enabled: `entityExtractor -> recordEntities -> graphEnrich -> awsEstateRouter`, and `aggregateMitigation -> recordRootCause -> followUp`.

### elastic-iac — 3 graph nodes + 1 memory-enrich node (`packages/agent/src/iac/graph-knowledge.ts`)

| Node | Trigger | Reads / Writes |
|------|---------|----------------|
| `graphEnrichIac` | after `readClusterState` (pre-draft) | **READ**: `priorChangesForDeployment` + per-cell `changeHistoryForStackInstance` + `deploymentsRunningStack` (blast radius). Produces `state.iacGraphContext` and `lastStackInstanceOutcome`; when the last change to this exact `(deployment, stack)` cell was `failed`, `reviewPlan` raises a HIGH risk on the plan-review card (SIO-969). Stack key falls back to the workflow's stack pre-draft (`stackForWorkflow`, the verified inverse of `stackFromPaths`). |
| `recordIacEntities` | after `openMr` | **WRITE**: `recordIacChange` — the `ElasticDeployment` + `ConfigChange` (workflow, file paths, summary, MR url, optional `StackInstance`/`Session`), outcome seeded `proposed`. |
| `recordIacOutcome` | after `watchPipeline` | **WRITE**: `recordPipeline` (the MR's CI `Pipeline`) + `setChangeOutcome` promoting the change to its terminal value (`applied` on pipeline success, `failed`, or `rejected`). |
| `memoryEnrichIac` (SIO-970) | after `graphEnrichIac` (pre-draft) | **READ Agent Memory, not the graph** — gated independently on the `agent-memory` backend (works even with the graph off). Deterministic recall of prior `iac-change` facts for the same `stack_instance` -> `state.priorLearnings` on the plan-review card. Listed here because it shares the enrich chain; see [agent-memory.md](agent-memory.md). |

Edge sequence when enabled: `readClusterState -> graphEnrichIac -> memoryEnrichIac -> guard`, and `openMr -> recordIacEntities -> watchPipeline -> recordIacOutcome -> teardown`.

## Node counts (verified)

The graph nodes are why the registered node counts exceed the base graphs:

- **incident-analyzer:** `grep -c addNode packages/agent/src/graph.ts` = **23** — 20 base nodes + the 3 gated KG nodes (`recordEntities`, `graphEnrich`, `recordRootCause`).
- **elastic-iac:** `grep -c addNode packages/agent/src/iac/graph.ts` = **29** — base proposer/sub-flow nodes + `graphEnrichIac`, `recordIacEntities`, `recordIacOutcome` (KG) + `memoryEnrichIac` (Agent Memory) + `amendChange`.

## Agent asymmetry

| Aspect | incident-analyzer | elastic-iac |
|--------|-------------------|-------------|
| Write nodes | `recordEntities` (services + incidents) + `recordRootCause` (SIO-1026) | `recordIacEntities` + `recordIacOutcome` (changes + pipelines) |
| Read/enrich node | `graphEnrich` (deps + vector-similar incidents + their prior root causes) | `graphEnrichIac` (change history + blast radius) |
| LLM-callable `kg_*` tools | none (graph used only via internal nodes) | yes — curated `kg_*` + `kg_run_cypher` via the in-process MCP server |
| `warm_knowledge_graph` hook | yes (bootstrap opens + `init`s the store) | no |

incident-analyzer consumes the graph purely through internal enrich nodes -- it has no LLM-callable `kg_*` tools by design (its graph use is enrichment, not a ReAct tool loop; the entity extractor only routes the seven user datasources, so a graph sub-agent would never be dispatched). SIO-1026 brought prior-root-cause recall into that enrichment path. The shared `kg_prior_root_causes` MCP tool (SIO-1027) is available to elastic-iac's `kg_run_cypher`/curated surface and to any future ad-hoc caller.

## Lifecycle

The incident-analyzer's `warm_knowledge_graph` bootstrap step wires `registerGraphWarmer` (`installGraphWarmer()` in `graph-knowledge.ts`), which opens and `init()`s the embedded store at session start — a no-op when disabled. See [agent-concepts.md](agent-concepts.md) § 6 for the hook machinery.

## Configuration

```bash
KNOWLEDGE_GRAPH_ENABLED=true        # master gate (true|1); every graph node + tool no-ops when unset
KNOWLEDGE_GRAPH_PATH=.data/knowledge-graph   # embedded lbug data dir (the file-locked path)
KNOWLEDGE_GRAPH_MCP_HOST=127.0.0.1  # in-process MCP server bind host
KNOWLEDGE_GRAPH_MCP_PORT=9087       # in-process MCP server port
KNOWLEDGE_GRAPH_MCP_PATH=/mcp       # MCP endpoint path
KG_MCP_ALLOW_CYPHER=true            # register kg_run_cypher (read-only guarded); false to disable
EMBEDDINGS_MODEL=amazon.titan-embed-text-v2:0   # Bedrock embedder for Incident similarity (graphEnrich)
```

Activating the graph requires the optional `lbug` native module installed (`bun add lbug`). Seed the IaC three-layer structure from the live repo with `packages/knowledge-graph/src/seed-iac.ts` (requires the flag + lbug).

## Test gotcha (lbug teardown)

`bun run --filter @devops-agent/knowledge-graph test` (or `bun test <file>`) can exit non-zero (SIGTRAP / 133, no summary) on a machine where lbug is installed — the real-engine integration suite hits the SIO-954 teardown finalizer crash *after* the assertions pass. The tests PASS; confirm an individual case with `bun test <file> -t "<name>"`. CI stays green because lbug is absent there. (memory: `reference_lbug_cypher_and_teardown_gotchas`, `reference_lbug_exclusive_file_lock`)

## Where to go next

- The memory tier it joins with: [agent-memory.md](agent-memory.md), [memory-model-mapping.md](memory-model-mapping.md)
- The concept map: [agent-concepts.md](agent-concepts.md)
- The pipelines that host the nodes: [agent-pipeline.md](agent-pipeline.md), [elastic-iac-proposer.md](elastic-iac-proposer.md)
