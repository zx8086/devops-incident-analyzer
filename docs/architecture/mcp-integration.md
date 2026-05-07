# MCP Server Integration

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x
> **Last updated:** 2026-04-23

The agent connects to six MCP (Model Context Protocol) servers over Streamable HTTP transport, providing access to 210+ tools across Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, GitLab, and Atlassian (Jira/Confluence). The `mcp-bridge.ts` module manages connections via `MultiServerMCPClient`, handles independent failure isolation, periodic health polling, automatic reconnection, and W3C traceparent propagation for cross-service observability.

---

## Architecture

```
+---------------------------------------------+
|           LangGraph Agent                    |
|  (packages/agent/src/mcp-bridge.ts)          |
|                                              |
|  +-----------------------------------------+ |
|  | MultiServerMCPClient                    | |
|  |  - Independent per-server connections   | |
|  |  - Streamable HTTP transport (/mcp)     | |
|  |  - W3C traceparent injection            | |
|  +-+----------+---------+---------+--------+--------+--------+ |
|    |          |         |         |        |         |          |
+----+----------+---------+---------+--------+---------+----------+
     |          |         |         |        |         |
     v          v         v         v        v         v
+---------+ +-------+ +--------+ +---------+ +---------+ +----------+
| elastic | | kafka | |couchbase| | konnect | | gitlab  | |atlassian |
|  -mcp   | | -mcp  | |  -mcp  | |  -mcp   | |  -mcp   | |  -mcp    |
|         | |       | |        | |         | |         | |          |
| ~84     | | 15+15 | | ~15    | | 15+prx  | | proxy+  | | proxy+   |
| tools   | | opt   | | tools  | | tools   | | custom  | | custom   |
|         | |       | |        | |         | |         | |          |
| :9080   | | :9081 | | :9082  | | :9083   | | :9084   | | :9085    |
+---------+ +-------+ +--------+ +---------+ +---------+ +----------+
     |          |         |         |        |         |
     v          v         v         v        v         v
+---------+ +-------+ +--------+ +---------+ +---------+ +----------+
| Elastic | | Kafka | |Couchbase| | Kong   | | GitLab  | | Jira /   |
| search  | |Clusters| |Capella | |Konnect | | API +   | | Conflu-  |
| Clusters| |       | |Cluster | | API    | | Repos   | | ence     |
+---------+ +-------+ +--------+ +---------+ +---------+ +----------+
```

Each MCP server runs as an independent Bun process, exposing tools via the `/mcp` HTTP endpoint and health status via `/health`. The agent connects to each server individually using `MultiServerMCPClient` from `@langchain/mcp-adapters`.

---

## Connection Model

### MultiServerMCPClient Configuration

The agent creates one `MultiServerMCPClient` instance per MCP server, rather than a single client for all servers. This is done intentionally so that a connection failure to one server does not block tool loading from the others.

Server URLs are configured via environment variables:

| Env Var | Default | Server |
|---------|---------|--------|
| `ELASTIC_MCP_URL` | `http://localhost:9080` | Elasticsearch MCP |
| `KAFKA_MCP_URL` | `http://localhost:9081` | Kafka MCP |
| `CAPELLA_MCP_URL` | `http://localhost:9082` | Couchbase Capella MCP |
| `KONNECT_MCP_URL` | `http://localhost:9083` | Kong Konnect MCP |
| `GITLAB_MCP_URL` | `http://localhost:9084` | GitLab MCP |
| `ATLASSIAN_MCP_URL_LOCAL` | `http://localhost:9085` | Atlassian MCP (Jira/Confluence). Separate from `ATLASSIAN_MCP_URL` which is the upstream Atlassian Cloud endpoint. |

Each URL gets `/mcp` appended as the transport endpoint. The connection initialization in `createMcpClient()` uses `Promise.allSettled()` to connect to all servers concurrently and independently.

### Independent Connections

```
Promise.allSettled([
    connect("elastic-mcp", elasticUrl + "/mcp"),
    connect("kafka-mcp",   kafkaUrl   + "/mcp"),
    connect("couchbase-mcp", capellaUrl + "/mcp"),
    connect("konnect-mcp", konnectUrl + "/mcp"),
    connect("gitlab-mcp",  gitlabUrl  + "/mcp"),
    connect("atlassian-mcp", atlassianUrl + "/mcp"),
])
```

If a server is unreachable at startup:
- That server is logged as a warning and skipped
- Its tools are not added to the tool registry
- The `connectedServers` set does not include it
- The supervisor skips that datasource (0 tools -> skipped)
- Other servers proceed normally

### Streamable HTTP Transport

All six MCP servers use Streamable HTTP transport (SIO-595). The transport endpoint is always `<baseUrl>/mcp`. Each server also exposes:
- `GET /health` -- health check endpoint for periodic polling
- The standard MCP protocol messages over HTTP POST to `/mcp`

The `beforeToolCall` hook on the client injects W3C traceparent headers for cross-service trace correlation (see Trace Propagation section).

---

## Tool Scoping

The `getToolsForDataSource()` function routes datasource IDs to their corresponding MCP server tools.

| DataSource ID | Server Name | MCP URL Env Var | Tool Count |
|---------------|-------------|-----------------|------------|
| `elastic` | `elastic-mcp` | `ELASTIC_MCP_URL` | ~84 (~77 cluster + 7 conditional cloud/billing) |
| `kafka` | `kafka-mcp` | `KAFKA_MCP_URL` | 15 base + 15 optional |
| `couchbase` | `couchbase-mcp` | `CAPELLA_MCP_URL` | ~15 |
| `konnect` | `konnect-mcp` | `KONNECT_MCP_URL` | 15 enhanced + proxy |
| `gitlab` | `gitlab-mcp` | `GITLAB_MCP_URL` | proxy + 5-8 custom |
| `atlassian` | `atlassian-mcp` | `ATLASSIAN_MCP_URL_LOCAL` | proxy + custom |

The mapping is defined in `mcp-bridge.ts`:

```typescript
const serverMap: Record<string, string> = {
    elastic: "elastic-mcp",
    kafka: "kafka-mcp",
    couchbase: "couchbase-mcp",
    konnect: "konnect-mcp",
    gitlab: "gitlab-mcp",
    atlassian: "atlassian-mcp",
};
```

When a sub-agent calls `getToolsForDataSource("elastic")`, it receives only the tools registered by the `elastic-mcp` server. This scoping prevents sub-agents from accidentally calling tools on the wrong datasource.

If a datasource ID is not in the server map, `getToolsForDataSource()` returns all tools as a defensive fallback. This should not happen in normal operation.

---

## Health Monitoring

### Periodic Health Polling

After initial connection, the MCP bridge starts a 30-second interval timer that polls all configured servers via their `/health` endpoints.

```
Health Poll (every 30s)
  |
  +-- For each server URL:
  |     GET <baseUrl>/health (5s timeout)
  |       |
  |       +-- 200 OK -> server is healthy
  |       +-- any other -> server is unhealthy
  |
  +-- Evaluate state transitions:
        |
        +-- Was disconnected, now healthy, has cached tools -> mark connected
        +-- Was disconnected, now healthy, no cached tools -> reconnect (full tool reload)
        +-- Was connected, now unhealthy -> mark disconnected
```

The poll cycle is protected by an `isPolling` guard to prevent overlapping poll executions. The timer is created by `startHealthPolling()` and can be stopped with `stopHealthPolling()`.

### Automatic Reconnection

When a previously-disconnected server becomes healthy again:

1. If tools are already cached in `toolsByServer` (server briefly went down and came back): the server is simply re-added to `connectedServers` without re-fetching tools
2. If no tools are cached (server was never successfully connected or tools were purged): a full reconnection is attempted, creating a new `MultiServerMCPClient`, fetching tools, and updating the tool registry

During reconnection, stale tools for the server are removed from `allTools` before new tools are appended. This prevents duplicate tool registrations.

### Graceful Degradation

The system degrades gracefully when servers are unavailable:

- **At startup:** servers that fail to connect are skipped. The agent operates with whatever tools are available.
- **During operation:** if a health check marks a server as disconnected, `getToolsForDataSource()` returns an empty array for that datasource. The supervisor skips datasources with 0 tools.
- **Sub-agent behavior:** when `queryDataSource` finds 0 tools, it returns an error result (`"No tools available for <datasource>. MCP server may not be connected."`) rather than invoking the ReAct agent with no tools.
- **Alignment handling:** the alignment node detects the error result and may retry if the server comes back online during the retry window.

---

## Trace Propagation

### W3C Traceparent Injection

The MCP bridge injects W3C `traceparent` headers into every tool call via the `beforeToolCall` hook on `MultiServerMCPClient`:

```typescript
function injectTraceHeaders(): { headers: Record<string, string> } | undefined {
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);
    return Object.keys(headers).length > 0 ? { headers } : undefined;
}
```

This uses OpenTelemetry's `propagation.inject()` with the active span context. The resulting `traceparent` header is forwarded to the MCP server, which can extract it and create child spans that link back to the agent's trace.

### Cross-Service Correlation in LangSmith

Each graph node is wrapped with `traceNode()`, which creates an OpenTelemetry span with:
- `agent.node.name` -- the node identifier (e.g., "queryDataSource")
- `request.id` -- the per-request UUID for end-to-end correlation
- `data_source_id` -- the active datasource (for sub-agent spans)

Sub-agent invocations pass metadata and tags through LangGraph's `RunnableConfig`:
- Metadata: `data_source_id`, `request_id`
- Tags: `sub-agent`, `datasource:<id>`

This creates a complete trace from the SvelteKit frontend through the LangGraph agent, through the MCP client, to each MCP server's tool execution.

---

## MCP Server Summary

### Elasticsearch MCP (~84 tools)

**Purpose:** Read-only access to Elasticsearch clusters for log search, index management, cluster health, shard allocation, mapping inspection, and snapshot operations. When `EC_API_KEY` is set, also exposes Elastic Cloud organization tools (deployment topology + billing).

**Tool count:** ~77 cluster tools always; +7 cloud/billing tools registered conditionally on `EC_API_KEY`.

**Tool categories:**
- Cluster operations: health, stats, settings, allocation explanation
- Index management: list, stats, mappings, settings, aliases
- Search: full-text search, aggregations, count, scroll
- Document operations: get, multi-get (read-only)
- Snapshot: repository listing, snapshot status
- Monitoring: node stats, hot threads, pending tasks
- **Elastic Cloud + Billing (conditional, `EC_API_KEY`, SIO-674):** `elasticsearch_cloud_list_deployments`, `elasticsearch_cloud_get_deployment`, `elasticsearch_cloud_get_plan_activity`, `elasticsearch_cloud_get_plan_history`, `elasticsearch_billing_get_org_costs`, `elasticsearch_billing_get_org_charts`, `elasticsearch_billing_get_deployment_costs` -- all hit `https://api.elastic-cloud.com` (`/api/v1/*` for cloud, `/api/v2/*` for billing after SIO-678) and use the org-scoped `EC_API_KEY`, distinct from per-deployment cluster keys.

**Configuration:** Multi-deployment pattern via `ELASTIC_DEPLOYMENTS=eu-cld,us-cld`. Per-deployment environment variables provide URL and API key (`ELASTIC_EU_CLD_URL`, `ELASTIC_EU_CLD_API_KEY`, etc.; hyphens become underscores). Cluster tools accept a per-call `deployment` arg (SIO-675) with fallback chain: explicit arg -> `x-elastic-deployment` HTTP header -> `ELASTIC_DEFAULT_DEPLOYMENT` -> first ID in `ELASTIC_DEPLOYMENTS`. See `packages/mcp-server-elastic/src/tools/index.ts:302-391`.

**Transport:** Streamable HTTP (`/mcp`), SSE, stdio, and AWS Bedrock AgentCore.

### Kafka MCP (15 base tools + 15 optional)

**Purpose:** Read-only access to Kafka clusters for topic listing, consumer group lag monitoring, message consumption, and broker health checks.

**Tool categories:**
- Cluster: broker list, cluster info, controller status
- Topics: list, describe, partition details, configuration
- Consumer groups: list, describe, lag analysis, offset positions
- Messages: consume from topic/partition (read-only)

**Configuration:** Provider-based selection via `KAFKA_PROVIDER=local|msk|confluent`. Feature gates control write operations (`KAFKA_ENABLE_WRITE_OPERATIONS=false` by default, enforced for the incident analyzer).

**Transport:** Streamable HTTP (`/mcp`), SSE, stdio, and AWS Bedrock AgentCore.

### Couchbase Capella MCP (~15 tools)

**Purpose:** Read-only access to Couchbase Capella clusters for bucket health, N1QL query execution (SELECT only), index analysis, and system vitals.

**Tool categories:**
- Cluster: health check, node status, system vitals, auto-failover status
- Buckets: list, stats, collection/scope management (read-only)
- Queries: N1QL execution (SELECT), query plan analysis, active query monitoring
- Indexes: list, stats, advisor recommendations
- Security: user listing, role descriptions

**Configuration:** Single cluster: `CB_HOSTNAME`, `CB_USERNAME`, `CB_PASSWORD`. The incident analyzer restricts N1QL to SELECT queries via the compliance layer.

**Transport:** Streamable HTTP (`/mcp`), SSE, stdio, and AWS Bedrock AgentCore.

### Kong Konnect MCP (15 enhanced tools + proxy surface)

**Purpose:** Read-only access to Kong Konnect API gateway for service listing, route inspection, plugin configuration, consumer management, upstream health, and request analytics.

**Tool categories:**
- Services: list, get, associated routes/plugins
- Routes: list, get, associated plugins
- Plugins: list, get, enabled plugins, plugin schema
- Consumers: list, get, credentials (read-only)
- Upstreams: list, get, targets, health status
- Certificates and SNIs: list, get
- Control planes: list, get, group membership
- Data plane nodes: list, get
- Analytics: request metrics, latency data

**Configuration:** Token-based authentication via `KONNECT_ACCESS_TOKEN` with region selection via `KONNECT_REGION=us|eu|au|me|in`.

**Transport:** Streamable HTTP (`/mcp`), SSE, stdio, and AWS Bedrock AgentCore.

### GitLab MCP (proxy + 5-8 custom tools)

**Purpose:** Read-only access to GitLab for CI/CD pipeline status, merge request history, issue tracking, code blame, commit diffs, and semantic code search. Correlates code changes with incident timing.

**Architecture:** Unlike other MCP servers that implement tools directly, the GitLab MCP uses a hybrid proxy + custom pattern. It connects to GitLab's native MCP endpoint (`/api/v4/mcp`) at startup, discovers available tools, and re-registers them locally with a `gitlab_` prefix. Custom code-analysis tools (blame, commit diff, file content, repository tree, commit listing) are registered alongside the proxied tools.

**Tool categories:**
- Issues: create, get, notes, saved views (via proxy)
- Merge requests: get, commits, diffs, pipelines, conflicts (via proxy)
- Pipelines: manage, get jobs (via proxy)
- Search: global search, labels, semantic code search with deferred retry for embedding readiness (via proxy)
- Code analysis: file content, blame, commit diff, commit listing, repository tree (custom REST tools)

**Configuration:** Token-based authentication via `GITLAB_PERSONAL_ACCESS_TOKEN` (requires `api` scope). Instance URL via `GITLAB_INSTANCE_URL` (defaults to `https://gitlab.com`). Optional `GITLAB_DEFAULT_PROJECT_ID` for default project scoping.

**Transport:** Streamable HTTP (`/mcp`), SSE, stdio, and AWS Bedrock AgentCore.

### Atlassian MCP (proxy + custom tools)

**Purpose:** Read-only access to Atlassian Cloud (Jira and Confluence) for incident ticket lookup, project metadata, runbook page retrieval, and ticket creation gated by compliance policy. Supplements GitLab code-change context with process and documentation context.

**Architecture:** Proxy + custom pattern, like the GitLab MCP. Connects to Atlassian's hosted MCP endpoint (`https://mcp.atlassian.com/v1/mcp`) at startup via OAuth 2.0, discovers available tools, and re-registers them locally with an `atlassian_` prefix. Custom tools extend proxied capabilities with incident-specific filtering.

**Tool categories:**
- Jira: issue search, get issue, project listing, status transitions (gated by `ATLASSIAN_READ_ONLY`)
- Confluence: page search, page content, space listing
- Incident-project filtering: `ATLASSIAN_INCIDENT_PROJECTS` restricts visibility to an allowlist of projects

**Configuration:** OAuth 2.0 with `ATLASSIAN_SITE_NAME` identifying the Cloud site. Callback port on `ATLASSIAN_OAUTH_CALLBACK_PORT` (default 9185). MCP server port on `ATLASSIAN_MCP_PORT` (default 9085). Read-only enforced by `ATLASSIAN_READ_ONLY=true` (default). Optional `ATLASSIAN_INCIDENT_PROJECTS` and `ATLASSIAN_TIMEOUT`.

**Transport:** Streamable HTTP (`/mcp`), stdio, and AWS Bedrock AgentCore.

---

## Dynamic Tool Prompts

### Gitagent-Driven Descriptions

Each tool facade in `agents/incident-analyzer/tools/*.yaml` can define a `prompt_template` with Handlebars-style conditionals. The gitagent bridge's `buildToolPrompt()` resolves these templates with runtime context:

```yaml
prompt_template: >
  Search Elasticsearch logs within a time window for a specific service.
  {{#if datasources}}Available data sources: {{datasources}}.{{/if}}
  {{#if compliance_tier}}Compliance tier: {{compliance_tier}} -- all queries are logged.{{/if}}
```

This produces different descriptions depending on the agent's active configuration. For the incident analyzer with medium compliance tier:

```
Search Elasticsearch logs within a time window for a specific service.
Available data sources: elastic-logs, kafka-introspect, couchbase-health, konnect-gateway, gitlab-api, atlassian-api, notify-slack, create-ticket.
Compliance tier: medium -- all queries are logged.
```

### Related Tools (Workflow Chaining)

Tool definitions include `related_tools` arrays that suggest next steps after a tool is used. These hints guide the LLM toward cross-datasource correlation:

```yaml
related_tools:
  - "Use kafka-consumer-lag to check if log spikes correlate with Kafka backpressure"
  - "Use couchbase-cluster-health to verify database health during the same time window"
  - "Use konnect-api-requests to check if API gateway errors correlate with log patterns"
```

The bridge's `buildRelatedToolsMap()` collects these into a lookup table, and `withRelatedTools()` enriches tool responses with the suggestions. This encourages the agent to explore multiple datasources rather than stopping after one.

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial document created from codebase analysis |
| 2026-04-13 | Added GitLab MCP as 5th server (proxy + custom tools, OAuth, deferred retry) |
| 2026-04-23 | Added Atlassian MCP as 6th server (Jira/Confluence, OAuth 2.0, read-only enforced, port 9085) |
| 2026-05-07 | Documented Elastic Cloud + Billing tool family (SIO-674) and per-call `deployment` arg fallback chain (SIO-675); updated tool count from ~78 to ~84 |
