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

## What is NOT yet wired (required to make it do anything)

The Knowledge Graph is the incident-correlation store (`FindingNode`,
`IncidentNode`, `ServiceNode`; embedded LadybugDB via the optional `lbug` native
addon). To make it functional for elastic-iac, three things are still needed:

1. **Install the native engine + turn on the flag** (process-level, affects the
   whole app, not just this agent):
   ```bash
   bun add lbug --cwd packages/knowledge-graph
   node packages/knowledge-graph/node_modules/lbug/install.js
   export KNOWLEDGE_GRAPH_ENABLED=true
   export KNOWLEDGE_GRAPH_PATH=.data/knowledge-graph   # optional; this is the default
   bun run --filter @devops-agent/knowledge-graph knowledge-graph:migrate
   bun run --filter @devops-agent/knowledge-graph knowledge-graph:seed
   ```
   With the flag off (the default), `warm_knowledge_graph` returns immediately.

2. **Add graph read/write nodes to the IaC graph.** The KG pipeline nodes
   (`recordEntities` + `graphEnrich`) live ONLY in the main incident-analyzer
   graph (`packages/agent/src/graph.ts`), edge-gated on `KNOWLEDGE_GRAPH_ENABLED`
   (the SIO-850 / SIO-640 idiom). The IaC graph (`packages/agent/src/iac/graph.ts`)
   has NO such nodes. Until equivalent nodes are added there, warming the store
   gives elastic-iac a graph it never reads or writes.

3. **Decide what an IaC "entity" is.** The graph's schema is incident-shaped
   (findings/incidents/services). For elastic-iac to benefit it would need a
   model for IaC concepts (clusters, MRs, config changes, waves) — a design
   decision, not just plumbing.

## Why it's staged this way

Enabling the hook now is the cheap, reversible half (no infra, no graph reads).
The expensive half — native dependency, app-wide flag, new IaC graph nodes, and
a graph schema for IaC — is tracked as SIO-954. See `docs/architecture/agent-pipeline.md`
for the main-graph KG idiom (SIO-850/SIO-640 edge-gate).
