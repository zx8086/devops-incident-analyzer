# Bootstrap

Run on every agent invocation, before any user-facing action.

## Steps

1. Read `memory/runtime/context.md`. If absent, create with header only.
2. Read `knowledge/cluster-inventory.md` + `knowledge/conventions.md`.
3. Verify GitLab MCP is connected: `gitlab_get_mcp_server_version`.
4. Verify Elastic MCP is connected: `elasticsearch_cloud_list_deployments` (1 element minimum).
5. Confirm `main` branch CI is green on the IaC repo (latest pipeline). If red, warn the user before proposing any change.
6. If user has not specified a cluster, do not infer — ask.

## On startup, post one line:

```
Ready. Connected to {n} Elastic Cloud deployments. Last MR: {iid} ({state}). Open in-flight items: {count}.
```
