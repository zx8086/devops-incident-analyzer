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
- **IaC-side (SIO-954/965):** `ElasticDeployment` (a cluster, distinct from a microservice `Service`), `ConfigChange` (one maker turn's proposed edit), `MergeRequest`, plus the three-layer repo model `Module` -> `Stack` -> `StackInstance` (the sparse `(deployment, stack)` state cell a change targets), `Workflow`, `Session`, `Pipeline`, `Prompt` (SIO-1038: a turn's verbatim user prompt, stored RAW/untruncated; PK = `requestId`, so it links to that turn's `ConfigChange` for free).
- **Telemetry bindings (SIO-1100):** `TelemetrySource` (one observability coordinate — a log group, index, APM service name, topic — keyed `<datasource>:<kind>:<resourceId>`) and `Alias` (a raw source-specific name + its normalized canonical form).

**Relationship types** (`REL_TYPES`): incident edges `DEPENDS_ON`, `PRODUCES_TO`, `CONSUMES_FROM`, `ROUTES_TO`, `AFFECTED_BY`, `CORRELATES_WITH`, `RESOLVED_BY`, `DOCUMENTED_IN`, `DEPLOYED_AS`, `HAS_ROOT_CAUSE` (SIO-1026); telemetry-binding edges (SIO-1100) `OBSERVED_IN` (`Service` -> `TelemetrySource`, bi-temporal: `confidence`, `discoveredBy`, `evidence`, `lastVerified`, `tValid`, `tInvalid`), `RESOLVES_TO` (`Alias` -> `Service`, bi-temporal), `DISCOVERED_DURING` (`TelemetrySource` -> `Incident`, provenance); topology edge (SIO-1104) `RUNS_ON` (`Service` -> `AwsResource`, bi-temporal + `consecutiveMisses`); as of SIO-1104 the four original topology rel tables (`DEPENDS_ON`, `PRODUCES_TO`, `CONSUMES_FROM`, `ROUTES_TO`) also carry lifecycle columns (`discoveredBy`, `tValid`, `tInvalid`, `consecutiveMisses` -- in the CREATE DDL for fresh graphs and tolerant rel-table `ALTER_MIGRATIONS` for existing ones); IaC edges `CHANGED_BY`, `PROPOSED_IN`, `USES_MODULE`, `OF_STACK`, `ON_DEPLOYMENT`, `TARGETS`, `VIA_WORKFLOW`, `IN_SESSION`, `RAN`, `PROMPTED_IN` (SIO-1038: `Prompt` -> `Session`).

`reader.ts` exposes curated, parameterized read functions (`priorRelationshipsForServices`, `similarIncidents`, `rootCauseForIncident`, `priorRootCauses`, `priorChangesForDeployment`, `changeHistoryForStackInstance`, `deploymentsRunningStack`, `stacksUsingModule`, `topology`, `bindingsForServices`, `hasBinding`, …); `writer.ts` exposes MERGE-based writers (`upsertEntities`, `recordIncident`, `recordRootCause`, `recordServiceBinding`, `setIncidentEmbedding`, `recordIacChange`, `recordPipeline`, `setChangeOutcome`, `linkCorrelation`, the `seed*` functions, …).

### Service bindings — W8 write, R7 read (SIO-1100)

The bindings layer turns the graph from an enrichment side-channel into a learning substrate: what log groups, indexes, APM names and topics a service actually uses.

- **W8 writer (`recordBindings` node):** at the end of a turn, the confirmed bindings are derived deterministically — the intersection of `resolveIdentifiers`' per-datasource canonical identifiers (SIO-1084) and the datasources that produced findings **without a degrading error** (SIO-1087 `isDegradingCategory`; a routine `no-data`/`not-found` still confirms the scope, an auth/server failure does not). **Identifier-level (SIO-1102):** an identifier is kept only if it was actually *used* — it appears in one of that datasource's tool outputs (`identifierUsedInToolCalls`) — so a coordinate the probe resolved but the fan-out never touched is dropped; when a confirmed datasource has no tool outputs to judge against, it falls back to the datasource-level signal. Per-turn telemetry (`newBindings`/`reconfirmed`/`contradicted`) logs the confirmation counts. Each is MERGEd as a `Service`-`OBSERVED_IN`->`TelemetrySource` edge at `confidence 0.7` (`discoveredBy: "resolve-identifiers"`), plus a durable Couchbase `kg-binding` fact (system of record) when `LIVE_MEMORY_BACKEND=agent-memory`. Runs whenever `KNOWLEDGE_GRAPH_ENABLED` is set (`KG_BINDINGS_WRITE_ENABLED` defaults **on**; set it to `false` to disable). The writes are additive and soft-failing, so they never change the investigation's answer — only what the graph learns for next time. Re-observing a binding bumps `lastVerified` and clears `tInvalid`; the `hasBinding` gate keeps append-only facts from doubling.
- **R7 read (Stage 2, not yet wired):** a pre-fan-out read of `bindingsForServices` seeds each sub-agent with the service's known coordinates so investigation N+1 is pre-scoped.
- **`setIncidentEmbedding`** persists the per-turn Titan vector onto the `Incident` node so `similarIncidents` can actually recall it. Because the HNSW vector index locks the `embedding` column against a plain `SET`, it runs `DROP_VECTOR_INDEX` -> `SET` -> `CREATE_VECTOR_INDEX` (best-effort; degrades to an un-indexed write if the vector extension is absent).
- **Blast-radius vs GitLab Orbit (SIO-1103):** the local KG owns runtime **shared-infrastructure** blast radius — `blastRadiusForServices` returns the services that share a `DEPENDS_ON` hop, a `KafkaTopic` (via `PRODUCES_TO`), or a `TelemetrySource` (via `OBSERVED_IN`) with an incident service. `graphEnrich` reads it into `state.graphBlastRadius`, and the synchronous `shared-infra-blast-radius` correlation rule re-fans to `elastic-agent` to check whether those neighbours are also erroring (a shared-infra root cause the per-service fan-out would miss). GitLab Orbit (SIO-1076) owns cross-project **code/SDLC** blast radius (a shared library a deploy changed). Complementary, not duplicate: Orbit answers "what code imports this", the KG answers "what runtime infra do we share". As of SIO-1104 (5a) the radius also includes services sharing a currently-valid `AwsResource` (via `RUNS_ON`, populated by the topology sweep; `via: "aws-resource"` re-fans on the same terms). `Bucket` fan-in stays deferred -- nothing produces `Service`->`Bucket` edges.
- **Rebuild:** `knowledge-graph:rebuild` replays the Couchbase Agent Memory mirror facts back into a fresh graph (the "graph is a rebuildable projection" story). As of SIO-1103 it replays `kg-incident` (Incident + `AFFECTED_BY`), `kg-root-cause` (RootCause + `HAS_ROOT_CAUSE`), and `kg-binding` (telemetry bindings) — in that order, since root-cause/binding provenance `MATCH` the Incident. Still NOT rebuildable: Incident **embeddings** (facts carry no vector; re-embed is a deliberate Bedrock cost, not default) and `Finding`/`CORRELATES_WITH` (graph-only). The CLI prints exactly what it could not rebuild.

### The scheduled topology sweep (SIO-1104, 5a)

A **third write path**, belonging to neither agent pipeline: an in-process cron in the web app (`apps/web/src/lib/server/kg-topology-cron.ts` -> `runTopologySweep` in `packages/agent/src/kg-topology.ts` -> the KG writers), sharing the same MCP bridge and the single `getGraphStore()` lbug handle. Default **OFF** (`KG_TOPOLOGY_CRON_ENABLED`; unlike the other KG flags, it does live MCP I/O on a schedule -- default hourly, `KG_TOPOLOGY_CRON_SCHEDULE`).

Per sweep, each source maps live data to edges (soft-failing independently, bounded per-source wall clock):

| Source | Query | Edge |
|--------|-------|------|
| elastic | APM `service_destination` **composite** agg on `[service.name, span.destination.service.resource]` (last 24h, per `ELASTIC_DEPLOYMENTS` deployment), paginated on `after_key` up to `KG_TOPOLOGY_MAX_PAGES` (SIO-1115) | `DEPENDS_ON(Service->Service)` -- a destination is kept only when it maps (port-stripped, `normalize()`d) onto another service observed in the same sweep (P6: Service->Service only, no databases/hosts) |
| konnect | control planes -> services + routes | `ROUTES_TO(ApiRoute->Service)` |
| kafka | consumer-group describes (committed-offset topics; capped at 100 groups; SIO-1115: run through a bounded-concurrency pool with a per-describe timeout `KG_TOPOLOGY_KAFKA_DESCRIBE_TIMEOUT_MS`) | `CONSUMES_FROM(ConsumerGroup->KafkaTopic)` |
| aws | per estate (`AWS_ESTATES` + `aws_list_estates` reconcile): ECS clusters -> services, paginated on `nextToken` up to `KG_TOPOLOGY_MAX_PAGES` (SIO-1115) | `RUNS_ON(Service->AwsResource)` -- an ECS short name must `normalize()`-match a service the graph already knows or an APM caller from this sweep (never invents `Service` nodes) |

`PRODUCES_TO` is deliberately **not** collected: no available tool is a system of record for producers, and guessed topology is worse than none.

**Lifecycle:** a fresh observation MERGEs the edge with `tValid` (kept from first observation), `tInvalid=''`, `consecutiveMisses=0` and `discoveredBy: "topology-job"` -- re-observing an agent-written edge deliberately claims it for sweep management. A sweep-owned edge absent from a **complete** collection gets its miss counter bumped; at `KG_TOPOLOGY_MISS_THRESHOLD` (default 3) consecutive misses it is invalidated (`tInvalid` set -- never deleted, so as-of reads keep the history). An **incomplete** collection writes the edges it saw but never sweeps -- partial data must not accrue false misses. A collection is incomplete when a sub-call fails (failed estate/deployment/control plane) or a paginated listing hits the `KG_TOPOLOGY_MAX_PAGES` cap before exhausting its cursor. SIO-1115 replaced the elastic terms-agg truncation (fixed 500x100, `sum_other_doc_count`) with a paginated composite agg and added bounded pagination for ECS `nextToken`, so a source is now incomplete only when the page cap actually binds -- not on the first oversized page. Edge staleness SLO = interval x K. The sweep skips itself until the MCP bridge is connected (connections are lazy on the first user turn), so on a fresh Node boot the first effective sweep can be up to interval + first-turn away.

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

### incident-analyzer — 4 nodes (`packages/agent/src/graph-knowledge.ts`, `record-bindings.ts`)

| Node | Trigger | Reads / Writes |
|------|---------|----------------|
| `recordEntities` (`recordGraphEntities`) | after `entityExtractor` | **WRITE**: `upsertEntities` (affected `Service`s) + `recordIncident` (the turn's `Incident` with severity + summary, linked `AFFECTED_BY`). |
| `graphEnrich` | after `recordEntities` | **READ + WRITE**: persists this turn's Bedrock Titan embedding onto the `Incident` (`setIncidentEmbedding`, SIO-1100 — makes `similarIncidents` usable at all), then reads `priorRelationshipsForServices` (service dependencies) + `similarIncidents` (vector-nearest prior incidents, EXCLUDING this turn's own incident), each annotated with its recorded `rootCauseForIncident` (SIO-1026: "we've seen this before -- prior root cause X"). Produces `state.graphContext`, consumed by the aggregator prompt. Embedding failure is non-fatal (keeps the dependency context). |
| `recordRootCause` (`recordRootCauseData`, SIO-1026) | after `aggregateMitigation` (LATE, so the final `confidenceScore` is known) | **WRITE**: re-runs the correlation engine (a pure function of state) and, when a rule FIRED and was covered (`reason: "already covered by prior agent findings"`), `recordRootCause` — the turn's `RootCause` (class = satisfied rule name, PK = stable hash so recurrences MERGE) linked `HAS_ROOT_CAUSE` from the `Incident`. Records nothing when no cross-domain correlation held (never fabricates a cause). |
| `recordBindings` (`recordConfirmedBindings`, SIO-1100) | after `recordRootCause` | **WRITE**: the W8 telemetry-binding writer. Derives the confirmed bindings (`resolveIdentifiers` identifiers ∩ datasources that succeeded without a degrading error) and MERGEs `Service`-`OBSERVED_IN`->`TelemetrySource` edges + a durable `kg-binding` fact. `KG_BINDINGS_WRITE_ENABLED` defaults on; needs `KNOWLEDGE_GRAPH_ENABLED`; additive + soft-failing (never changes the answer). |

Edge sequence when enabled: `entityExtractor -> recordEntities -> graphEnrich -> awsEstateRouter`, and `aggregateMitigation -> recordRootCause -> recordBindings -> followUp`.

### elastic-iac — 4 graph nodes + 1 memory-enrich node (`packages/agent/src/iac/graph-knowledge.ts`)

| Node | Trigger | Reads / Writes |
|------|---------|----------------|
| `recordIacPrompt` (SIO-1038) | between `bootstrap` and `classifyIacIntent` (pre-fan-out, the only chokepoint on every intent branch) | **WRITE** (two independently-gated, soft-failing sinks): a `Prompt` node + `PROMPTED_IN` edge to the turn's `Session` (KG; PK = `requestId`, so it links to the `ConfigChange` for free; gated on `KNOWLEDGE_GRAPH_ENABLED`), and a raw `user-prompt-raw` fact to agent-memory via `recordRawUserPrompt` (gated on `LIVE_MEMORY_ENABLED` + `LIVE_MEMORY_RAW_PROMPTS_ENABLED` + the `agent-memory` backend). Stores the prompt RAW/untruncated and **bypasses PII redaction** on both sinks. Not part of the enrich chain — it runs before intent classification. |
| `graphEnrichIac` | after `readClusterState` (pre-draft) | **READ**: `priorChangesForDeployment` + per-cell `changeHistoryForStackInstance` + `deploymentsRunningStack` (blast radius). Produces `state.iacGraphContext` and `lastStackInstanceOutcome`; when the last change to this exact `(deployment, stack)` cell was `failed`, `reviewPlan` raises a HIGH risk on the plan-review card (SIO-969). Stack key falls back to the workflow's stack pre-draft (`stackForWorkflow`, the verified inverse of `stackFromPaths`). |
| `recordIacEntities` | after `openMr` | **WRITE**: `recordIacChange` — the `ElasticDeployment` + `ConfigChange` (workflow, file paths, summary, MR url, optional `StackInstance`/`Session`), outcome seeded `proposed`. |
| `recordIacOutcome` | after `watchPipeline` | **WRITE**: `recordPipeline` (the MR's CI `Pipeline`) + `setChangeOutcome` promoting the change to its terminal value (`applied` on pipeline success, `failed`, or `rejected`). |
| `memoryEnrichIac` (SIO-970) | after `graphEnrichIac` (pre-draft) | **READ Agent Memory, not the graph** — gated independently on the `agent-memory` backend (works even with the graph off). Deterministic recall of prior `iac-change` facts for the same `stack_instance` -> `state.priorLearnings` on the plan-review card. Listed here because it shares the enrich chain; see [agent-memory.md](agent-memory.md). |

Edge sequence when enabled: `readClusterState -> graphEnrichIac -> memoryEnrichIac -> guard`, and `openMr -> recordIacEntities -> watchPipeline -> recordIacOutcome -> teardown`. Unlike the enrich nodes, `recordIacPrompt` is **edged unconditionally** (`bootstrap -> recordIacPrompt -> classifyIacIntent`) — only its two writes are gated internally — so it is always registered *and* always reached.

## Node counts (verified)

The graph nodes are why the registered node counts exceed the base graphs:

- **incident-analyzer:** `grep -c addNode packages/agent/src/graph.ts` = **31** — 21 base nodes + the 4 gated KG nodes (`recordEntities`, `graphEnrich`, `recordRootCause`, and SIO-1100 `recordBindings`) + the 6 gated HIL-learning nodes (`learnFetchTicket`, `learnMatchIncident`, `learnMatchGate`, `learnDistill`, `learnReviewGate`, `applyLearnings`, SIO-1126). The HIL nodes are unrelated to the knowledge graph — they gate on `HIL_LEARNING_ENABLED` (default on) and branch off `classify` on an explicit `learn from TICKET-123` command (see [agent-pipeline.md](agent-pipeline.md#hil-learning-lane)); they are listed here only so the total reconciles with the grep.
- **elastic-iac:** `grep -c addNode packages/agent/src/iac/graph.ts` = **30** — base proposer/sub-flow nodes + `recordIacPrompt` (SIO-1038, always-edged pre-fan-out capture) + `graphEnrichIac`, `recordIacEntities`, `recordIacOutcome` (KG) + `memoryEnrichIac` (Agent Memory) + `amendChange`.

## Agent asymmetry

| Aspect | incident-analyzer | elastic-iac |
|--------|-------------------|-------------|
| Write nodes | `recordEntities` (services + incidents) + `recordRootCause` (SIO-1026) + `recordBindings` (SIO-1100 W8 telemetry bindings; on by default) | `recordIacEntities` + `recordIacOutcome` (changes + pipelines) |
| Read/enrich node | `graphEnrich` (deps + vector-similar incidents + their prior root causes) | `graphEnrichIac` (change history + blast radius) |
| LLM-callable `kg_*` tools | none (graph used only via internal nodes) | yes — curated `kg_*` + `kg_run_cypher` via the in-process MCP server |
| `warm_knowledge_graph` hook | yes (bootstrap opens + `init`s the store) | no |

incident-analyzer consumes the graph purely through internal enrich nodes -- it has no LLM-callable `kg_*` tools by design (its graph use is enrichment, not a ReAct tool loop; the entity extractor only routes the seven user datasources, so a graph sub-agent would never be dispatched). SIO-1026 brought prior-root-cause recall into that enrichment path and added the shared `kg_prior_root_causes` MCP tool, which is available to elastic-iac's `kg_run_cypher`/curated surface and to any future ad-hoc caller.

SIO-1104 (5a) adds a **third write path** outside both agent pipelines: the scheduled topology sweep (see "The scheduled topology sweep" above) -- an apps/web in-process cron writing through the same `getGraphStore()` singleton, gated by `KG_TOPOLOGY_CRON_ENABLED` (default off).

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
