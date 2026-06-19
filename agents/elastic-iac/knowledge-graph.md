# Knowledge Graph (elastic-iac) — status and how to fully enable

SIO-953 added the `warm_knowledge_graph` bootstrap hook step to
`hooks/hooks.yaml`. **This is a safe no-op today** — it warms the embedded graph
store only when the graph is actually enabled, and degrades gracefully (never
blocks a session) otherwise. The step is wired so that no code change is needed
in this agent's hooks once the rest of the stack is turned on.

## What is wired now

- `hooks/hooks.yaml` bootstrap step `warm_knowledge_graph`. The handler
  (`packages/agent/src/lifecycle.ts`) calls the registered `graphWarmer`, which
  `installGraphWarmer()` (`packages/agent/src/graph-knowledge.ts`) registers to
  open + `init()` the store — but only when `isKnowledgeGraphEnabled()` is true.

## What SIO-954 added (the IaC half)

The graph now has an IaC change-history model and the elastic-iac maker graph
reads + writes it, edge-gated on `KNOWLEDGE_GRAPH_ENABLED` (the SIO-850 / SIO-640
idiom — nodes registered always, edged only when enabled):

- **Schema** (`packages/knowledge-graph/src/schema.ts`): `ElasticDeployment`,
  `ConfigChange`, `MergeRequest` node tables and `CHANGED_BY` / `PROPOSED_IN`
  relationships alongside the incident-correlation model.
- **Nodes** (`packages/agent/src/iac/graph-knowledge.ts`): `graphEnrichIac` runs
  before drafting (`readClusterState -> guard`) and loads the deployment's recent
  change history into `state.iacGraphContext` (surfaced in the plan-review
  payload); `recordIacEntities` runs after `openMr` and records this turn's
  deployment + config-change + MR. Both soft-fail to empty context.

## To actually turn it on

Install the native engine + flip the flag (process-level, affects the whole app,
not just this agent):

```bash
bun add lbug --cwd packages/knowledge-graph
node packages/knowledge-graph/node_modules/lbug/install.js
export KNOWLEDGE_GRAPH_ENABLED=true
export KNOWLEDGE_GRAPH_PATH=.data/knowledge-graph   # optional; this is the default
bun run --filter @devops-agent/knowledge-graph knowledge-graph:migrate
bun run --filter @devops-agent/knowledge-graph knowledge-graph:seed
```

With the flag off (the default), `warm_knowledge_graph` returns immediately and
both the incident and IaC pipelines run unchanged.

See `docs/architecture/agent-pipeline.md` for the main-graph KG idiom
(SIO-850/SIO-640 edge-gate).
