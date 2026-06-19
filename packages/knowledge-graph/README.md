# @devops-agent/knowledge-graph

Entity + correlation knowledge graph (SIO-850 / EPIC 6). Embedded
[LadybugDB](https://ladybugdb.com/) (npm `lbug`, a Kuzu successor) as a
placeholder for Neo4j, behind a `GraphStore` interface so the eventual Neo4j
swap is a driver change, not a pipeline change.

The store is **off by default** and the `lbug` native engine is an **optional**
dependency: the package typechecks, builds, and unit-tests (against an in-memory
fake) without it. The real engine activates only when you enable the feature.

## Enable the embedded graph

```bash
# 1. Install the native engine (optional dependency; ships prebuilt binaries).
bun add lbug --cwd packages/knowledge-graph

# 2. Materialize its entry points. Bun blocks native postinstall scripts by
#    default; run the package's install step once (it copies the prebuilt
#    binary for your platform -- no compilation):
node packages/knowledge-graph/node_modules/lbug/install.js

# 3. Turn it on and apply the schema + seed the topology.
export KNOWLEDGE_GRAPH_ENABLED=true
bun run --filter @devops-agent/knowledge-graph knowledge-graph:migrate
bun run --filter @devops-agent/knowledge-graph knowledge-graph:seed
```

The incident pipeline's `recordEntities` / `graphEnrich` nodes, the elastic-iac
maker graph's `recordIacEntities` / `graphEnrichIac` nodes (SIO-954), and the
`warm_knowledge_graph` lifecycle hook all gate on `KNOWLEDGE_GRAPH_ENABLED`; with
it unset the graph is never opened and both pipelines run unchanged.

## IaC change history (SIO-954)

Beyond the incident-correlation model, the schema carries an IaC change-history
slice for elastic-iac: `ElasticDeployment -[:CHANGED_BY]-> ConfigChange
-[:PROPOSED_IN]-> MergeRequest`. `recordIacChange` (writer) records each maker
turn after its MR is opened; `priorChangesForDeployment` + `buildIacGraphContext`
(reader) surface a deployment's recent changes into the plan-review payload so a
later turn against the same cluster can reference what changed before. The same
`migrate` command applies these tables (additive `IF NOT EXISTS`).

## Vector similarity

`similarIncidents` uses LadybugDB's native vector index, which requires the
`vector` extension (downloaded on first `INSTALL vector`). Where the extension
is unavailable (e.g. an air-gapped host), index setup is skipped with a warning
and similarity search returns `[]` -- the rest of the graph still works.

## Porting to Neo4j

`schema.ts` is the single source of truth for node labels, relationship types,
and DDL. A `Neo4jStore` implements the same `GraphStore` interface (in `store.ts`)
and is the only file that changes; the writer, reader, and pipeline nodes are
driver-agnostic. LadybugDB also ships a Neo4j migration extension for moving data.
