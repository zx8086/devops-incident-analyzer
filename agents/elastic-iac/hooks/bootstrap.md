# Bootstrap

Run on every agent invocation, before any user-facing action.

## Steps

1. Read `memory/runtime/context.md`. If absent, create with header only.
2. Read `memory/wiki/index.md` (the compiled knowledge index) and follow its
   `[[page]]` links for the topics this turn needs. Prefer the wiki distillation
   over re-deriving topology/repo-layout/workflow from raw `knowledge/`.
3. Read `knowledge/reference/cluster-inventory.md` + `knowledge/reference/conventions.md`. (Knowledge
   is now indexed via `knowledge/index.yaml`; the categories there are what the
   bridge loads into context.)
4. Warm the knowledge graph if enabled (`warm_knowledge_graph`). No-op unless
   `KNOWLEDGE_GRAPH_ENABLED=true` and `lbug` is installed; see `knowledge-graph.md`.
5. Verify GitLab MCP is connected: `gitlab_get_mcp_server_version`.
6. Verify Elastic MCP is connected: `elasticsearch_cloud_list_deployments` (1 element minimum).
7. Confirm `main` branch CI is green on the IaC repo (latest pipeline). If red, warn the user before proposing any change.
8. If user has not specified a cluster, do not infer — ask.

## On startup, post one line:

```
Ready. Connected to {n} Elastic Cloud deployments. Last MR: {iid} ({state}). Open in-flight items: {count}.
```
