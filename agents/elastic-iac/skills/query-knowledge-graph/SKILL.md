---
name: query-knowledge-graph
description: Query the infrastructure knowledge graph for IaC change history and blast radius. Prefer the curated kg_* tools; drop to raw read-only Cypher (kg_run_cypher) only for ad-hoc questions the curated tools do not cover. Read-only; never mutates the graph.
inputs:
  question: { type: string, required: true }   # the operator question, e.g. "what changed on eu-b2b/slos and did it apply?"
outputs:
  answer: { type: string }
---

# Query the knowledge graph

The graph records the elastic-iac repo's structure (three layers: Module -> Stack -> StackInstance) and every maker turn's change history (ConfigChange -> StackInstance, MergeRequest, Pipeline, outcome). Use it to answer "what changed", "blast radius", and "has this been done before" questions without re-deriving from the repo.

## Pick the curated tool first

Most questions map to one of the four curated, parameterized tools (no Cypher needed, no quirks to remember):

| Question | Tool |
|---|---|
| Which deployments run the `<stack>` stack? | `kg_deployments_running_stack {stack}` |
| Which stacks use the `<module>` module? | `kg_stacks_using_module {module}` |
| What changed on `<deployment>/<stack>` (with outcome)? | `kg_stack_instance_history {deployment, stack}` |
| Recent changes to `<deployment>`? | `kg_deployment_history {deployment}` |

Only reach for `kg_run_cypher` when the question needs a shape the curated tools do not return (e.g. joining workflow + pipeline status, counting changes per outcome, multi-hop traversals).

## Raw Cypher: read-only, schema, quirks

`kg_run_cypher` is READ-ONLY. Write/DDL keywords (CREATE/MERGE/SET/DELETE/DETACH/REMOVE/DROP/ALTER/COPY/CALL) and multi-statement payloads are rejected by a guard. Always pass values as bound `$params`, never string-interpolated.

### IaC subgraph schema (authoritative: `packages/knowledge-graph/src/schema.ts`)

Nodes:
- `ElasticDeployment(name, ecId, region)` — a cluster, e.g. `eu-b2b`. PK `name`.
- `Stack(name)` — a root module, e.g. `slos`. PK `name`.
- `Module(name, howto)` — reusable logic, e.g. `slo`. PK `name`.
- `StackInstance(id, deployment, stack)` — a (deployment, stack) cell; `id = "<deployment>/<stack>"`. SPARSE (not every stack runs on every deployment). PK `id`.
- `ConfigChange(id, workflow, filePath, summary, createdAt, outcome)` — one maker turn's edit. `createdAt` is an ISO string (lexicographic `ORDER BY ... DESC` is chronological); `outcome` in `{proposed, applied, ...}`.
- `MergeRequest(url)`, `Workflow(name)`, `Session(threadId)`, `Pipeline(id, status, url)`.

Relationships (direction matters):
- `(Stack)-[:USES_MODULE]->(Module)`
- `(StackInstance)-[:OF_STACK]->(Stack)` and `(StackInstance)-[:ON_DEPLOYMENT]->(ElasticDeployment)`
- `(ElasticDeployment)-[:CHANGED_BY]->(ConfigChange)` and `(ConfigChange)-[:TARGETS]->(StackInstance)`
- `(ConfigChange)-[:PROPOSED_IN]->(MergeRequest)`, `(ConfigChange)-[:VIA_WORKFLOW]->(Workflow)`, `(ConfigChange)-[:IN_SESSION]->(Session)`
- `(MergeRequest)-[:RAN]->(Pipeline)`

### lbug binder quirks (these WILL bite — they are not standard Cypher)

1. A variable does **not** carry across two separate `MATCH` clauses. Chain the whole pattern in ONE `MATCH` (use `OPTIONAL MATCH` only for genuinely optional legs).
2. `ORDER BY` after `RETURN DISTINCT` must reference the **projected alias**, not the source property.

### Worked examples

Blast radius (deployments running a stack):
```cypher
MATCH (d:ElasticDeployment)<-[:ON_DEPLOYMENT]-(:StackInstance)-[:OF_STACK]->(s:Stack {name: $stack})
RETURN DISTINCT d.name AS deployment
ORDER BY deployment
```

Change history for a (deployment, stack) cell, most recent first:
```cypher
MATCH (c:ConfigChange)-[:TARGETS]->(:StackInstance {id: $sid})
RETURN c.summary AS summary, c.outcome AS outcome, c.createdAt AS createdAt
ORDER BY createdAt DESC
LIMIT 5
```

Changes joined to their MR pipeline status (a shape the curated tools don't return):
```cypher
MATCH (d:ElasticDeployment {name: $deployment})-[:CHANGED_BY]->(c:ConfigChange)-[:PROPOSED_IN]->(m:MergeRequest)-[:RAN]->(p:Pipeline)
RETURN c.summary AS change, c.outcome AS outcome, m.url AS mr, p.status AS pipeline
ORDER BY c.createdAt DESC
LIMIT 10
```

## Notes

- The graph is populated by the maker pipeline's record nodes; it is only as complete as the turns that have run. An empty result usually means "nothing recorded yet", not "definitely never happened" — say so.
- This skill is read-only. It never proposes, commits, or opens an MR.
