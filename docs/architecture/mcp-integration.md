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
| ~84     | | 15-55 | | ~15    | | 15+prx  | | proxy+  | | proxy+   |
| tools   | | gated | | tools  | | tools   | | custom  | | custom   |
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
| `ATLASSIAN_MCP_URL` | `http://localhost:9085` | Atlassian MCP (Jira/Confluence). The upstream Rovo endpoint the local proxy forwards to is `ATLASSIAN_UPSTREAM_MCP_URL`. |

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
| `kafka` | `kafka-mcp` | `KAFKA_MCP_URL` | 15-55 (15 base + up to 40 gated SR + ksqlDB + Connect + REST Proxy) |
| `couchbase` | `couchbase-mcp` | `CAPELLA_MCP_URL` | ~15 |
| `konnect` | `konnect-mcp` | `KONNECT_MCP_URL` | 15 enhanced + proxy |
| `gitlab` | `gitlab-mcp` | `GITLAB_MCP_URL` | proxy + 5-8 custom |
| `atlassian` | `atlassian-mcp` | `ATLASSIAN_MCP_URL` | proxy + custom |

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

### Kafka MCP (15-55 tools depending on gating)

**Purpose:** Multi-component access to Kafka clusters and the surrounding Confluent stack. 15 core read tools always register; up to 40 additional tools register conditionally based on which Confluent components are enabled and whether write/destructive flags are set.

**Tool categories:**
- Kafka core (15, always): broker list, cluster info, topics list/describe, partition details, consumer groups list/describe/lag, message consume, plus write/destructive (`kafka_produce_message`, `kafka_create_topic`, `kafka_alter_topic_config`, `kafka_delete_topic`, `kafka_reset_consumer_group_offsets`) gated by `KAFKA_ALLOW_WRITES`/`KAFKA_ALLOW_DESTRUCTIVE`.
- Schema Registry (`SCHEMA_REGISTRY_ENABLED=true`): 8 reads (list/get subjects, schemas, versions, configs). With write gates: 3 writes (`sr_register_schema`, `sr_check_compatibility`, `sr_set_compatibility`) and 4 destructives (soft/hard delete subject + version) — SIO-682.
- ksqlDB (`KSQL_ENABLED=true`): 7 tools (list streams/tables/queries, execute statement, server info, etc.).
- Connect (`CONNECT_ENABLED=true`): 4 reads (cluster info, list connectors, get connector status, get task status). With write gates: 3 writes (`connect_pause_connector`, `connect_resume_connector`, `connect_restart_connector`) and 2 destructives (`connect_restart_connector_task`, `connect_delete_connector`) — SIO-682.
- REST Proxy (`RESTPROXY_ENABLED=true`): 3 metadata reads (`restproxy_list_topics`, `restproxy_get_topic`, `restproxy_get_partitions`). With `KAFKA_ALLOW_WRITES`: 6 writes (`restproxy_produce`, `restproxy_create_consumer`, `restproxy_subscribe`, `restproxy_consume`, `restproxy_commit_offsets`, `restproxy_delete_consumer`) — SIO-682.

**Services:** `KafkaService` (kafka-core), `SchemaRegistryService`, `KsqlService`, `ConnectService`, and `RestProxyService` (the latter introduced in SIO-682). Each service's tools register only when its own `*_ENABLED` flag is set.

**Configuration:** Provider-based selection via `KAFKA_PROVIDER=local|msk|confluent`. Feature gates `KAFKA_ALLOW_WRITES` / `KAFKA_ALLOW_DESTRUCTIVE` control write operations across kafka-core, Connect, SR, and REST Proxy in a unified way.

**Tool count formula:** see `tests/tools/full-stack-tools.test.ts` — the formula is asserted directly. Maximum (full Confluent stack with both write flags on) is 55.

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

**Tool response shape (SIO-664):** the 10 `queryAnalysis` tools return `effectiveLimit` (the LIMIT actually applied after server-side capping) and `actualCount` (rows returned) so the agent can detect truncation. SIO-667 + SIO-668 parameterized all SQL++ in these tools to prevent injection — user-supplied bucket/scope/collection identifiers are now bound parameters rather than string-interpolated.

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

**Tool response shape (SIO-663):** the 15 list tools return observed pagination metadata (`offset`, `nextOffset`, `totalCount`) extracted from the Konnect API response so the agent can decide whether to paginate without an extra HEAD-style call. `nextOffset` is `null` when the page is the last one. Per-tool handlers are now typed via `z.infer<typeof validator>` (SIO-670) and the read-only check is applied once at the bootstrap chokepoint (SIO-671) rather than per tool.

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

**Configuration:** Token-based authentication via `GITLAB_PERSONAL_ACCESS_TOKEN` (requires `api` scope) for the custom code-analysis tools. The proxy connection to `/api/v4/mcp` uses OAuth 2.0 Dynamic Client Registration as a public client (RFC 8252, `token_endpoint_auth_method: "none"`) with PKCE; this is what GitLab DCR actually issues for unverified MCP clients (SIO-685). Scope is pinned to `mcp` (GitLab MR !208967 default). Instance URL via `GITLAB_INSTANCE_URL` (defaults to `https://gitlab.com`). Callback port on `GITLAB_OAUTH_CALLBACK_PORT` (default 9184). Optional `GITLAB_DEFAULT_PROJECT_ID` for default project scoping. See [OAuth credential persistence](#oauth-credential-persistence) below for the seeding flow.

**Transport:** Streamable HTTP (`/mcp`), SSE, stdio, and AWS Bedrock AgentCore.

### Atlassian MCP (proxy + custom tools)

**Purpose:** Read-only access to Atlassian Cloud (Jira and Confluence) for incident ticket lookup, project metadata, runbook page retrieval, and ticket creation gated by compliance policy. Supplements GitLab code-change context with process and documentation context.

**Architecture:** Proxy + custom pattern, like the GitLab MCP. Connects to Atlassian's hosted MCP endpoint (`https://mcp.atlassian.com/v1/mcp`) at startup via OAuth 2.0, discovers available tools, and re-registers them locally with an `atlassian_` prefix. Custom tools extend proxied capabilities with incident-specific filtering.

**Tool categories:**
- Jira: issue search, get issue, project listing, status transitions (gated by `ATLASSIAN_READ_ONLY`)
- Confluence: page search, page content, space listing
- Incident-project filtering: `ATLASSIAN_INCIDENT_PROJECTS` restricts visibility to an allowlist of projects

**Configuration:** OAuth 2.0 (DCR returns a `client_secret`, so `token_endpoint_auth_method: "client_secret_post"` is used) with `ATLASSIAN_SITE_NAME` identifying the Cloud site. Callback port on `ATLASSIAN_OAUTH_CALLBACK_PORT` (default 9185). MCP server port on `ATLASSIAN_MCP_PORT` (default 9085). Read-only enforced by `ATLASSIAN_READ_ONLY=true` (default). Optional `ATLASSIAN_INCIDENT_PROJECTS` and `ATLASSIAN_TIMEOUT`. See [OAuth credential persistence](#oauth-credential-persistence) below for the seeding flow.

**Transport:** Streamable HTTP (`/mcp`), stdio, and AWS Bedrock AgentCore.

### OAuth credential persistence

GitLab and Atlassian MCP both use OAuth 2.0 Dynamic Client Registration through the `BaseOAuthClientProvider` in `@devops-agent/shared`. The two share storage layout, persistence semantics, file-mode hardening, and headless-mode behavior; they differ only in `clientMetadata` (auth method, scope, client name) per the table above.

**On-disk state:** `~/.mcp-auth/<namespace>/<sanitized-mcp-url>.json` (mode 0o600, dir 0o700). Each file holds `clientInformation` (the DCR registration), `tokens` (access + refresh), and a transient `codeVerifier` cleared after the token exchange completes. Filenames are byte-stable across releases (regression-tested in `packages/shared/src/__tests__/oauth/base-provider.test.ts`).

**Stale-registration migration:** if a persisted `clientInformation` was saved with a different `token_endpoint_auth_method` than the current code expects (e.g. legacy GitLab registrations stored as `client_secret_post` before SIO-685), the base provider auto-discards the registration and re-registers via DCR. No manual `rm` required.

**Headless mode:** set `MCP_OAUTH_HEADLESS=true` in non-interactive contexts (eval pipeline, AgentCore deployments, CI). The provider throws a typed `OAuthRequiresInteractiveAuthError` instead of opening a browser, which the agent's alignment node classifies as a non-retryable auth error. Headless is also auto-detected when `process.stdout.isTTY === false`. To seed tokens once interactively, run `bun run oauth:seed:gitlab` or `bun run oauth:seed:atlassian` -- the seed CLI explicitly unsets `MCP_OAUTH_HEADLESS` so it always opens the browser. See `docs/operations/oauth-seeding.md` for the full procedure.

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
| 2026-05-09 | Extracted shared OAuth provider base (SIO-685); GitLab MCP switched to public-client + PKCE (`auth_method: "none"`, `scope: "mcp"`); added `MCP_OAUTH_HEADLESS` env, `bun run oauth:seed:<service>` CLIs, stale-registration auto-discard, file-mode 0o600 enforcement |
