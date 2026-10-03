# MCP Server Integration

> **Targets:** Bun 1.3.9+ | LangGraph | TypeScript 5.x | MCP SDK 1.30.0
> **Last updated:** 2026-09-30

The agent connects to up to ten MCP (Model Context Protocol) servers over Streamable HTTP transport. Seven are the incident datasources, providing access to 210+ tools across Elasticsearch, Kafka, Couchbase Capella, Kong Konnect, GitLab, Atlassian (Jira/Confluence), and AWS. The other three serve the rest of the agent set: `elastic-iac` and `landing-zone-iac` (the two IaC agents' GitOps facades) and the in-process `knowledge-graph` server the web app mounts itself. The `mcp-bridge.ts` module manages connections via `MultiServerMCPClient`, handles independent failure isolation, periodic health polling, automatic reconnection, and W3C traceparent propagation for cross-service observability. AWS additionally fans out per-estate via the `awsEstateRouter` graph node: one logical MCP connection serves N target AWS accounts via cross-account `AssumeRole`.

All ten MCP servers (the seven datasources plus the peer `elastic-iac`, `landing-zone-iac` and `knowledge-graph` servers) share a unified bootstrap and a single MCP SDK baseline. As of the SIO-1410..1443 modernization wave they pin `@modelcontextprotocol/sdk` on `1.30.0` (root catalog + override), register every tool/prompt/resource through the SDK's `server.registerTool()` / `registerPrompt()` / `registerResource()` API (the older `server.tool()` sugar is now build-forbidden, see [Tool registration](#tool-registration-registertool--toolannotations) below), attach machine-readable `ToolAnnotations` via `deriveToolAnnotations`, and are progressively adopting `outputSchema` + `structuredContent` on tool responses. See [Adding MCP Tools](../development/adding-mcp-tools.md) for the authoring contract.

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
| 101-117 | | 11-61 | | 43     | | 67+     | | proxy+  | | proxy+   |
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

The diagram shows six of the ten connections. The other four follow the same shape: `aws-mcp` (through the local SigV4 proxy on :3001), `elastic-iac-mcp` (:9086), `landing-zone-iac-mcp` (:9088) and `knowledge-graph-mcp` (:9087).

Each MCP server runs as an independent Bun process, exposing tools via the `/mcp` HTTP endpoint and health status via `/health`. The one exception is the knowledge-graph server, which the web app mounts in its own process (SIO-967) and then reaches over localhost like the others. The agent connects to each server individually using `MultiServerMCPClient` from `@langchain/mcp-adapters`.

---

## Connection Model

### MultiServerMCPClient Configuration

The agent creates one `MultiServerMCPClient` instance per MCP server, rather than a single client for all servers. This is done intentionally so that a connection failure to one server does not block tool loading from the others.

Server URLs are configured via environment variables, read by `getMcpConfig()` in `apps/web/src/lib/server/agent.ts`. There is no default in code: a URL that is unset leaves that server out of the connection set. The values below are the local ones from `.env.example`.

| Env Var | Local value | Server |
|---------|-------------|--------|
| `ELASTIC_MCP_URL` | `http://localhost:9080` | Elasticsearch MCP |
| `KAFKA_MCP_URL` | `http://localhost:9081` | Kafka MCP |
| `COUCHBASE_MCP_URL` | `http://localhost:9082` | Couchbase Capella MCP |
| `KONNECT_MCP_URL` | `http://localhost:9083` | Kong Konnect MCP |
| `GITLAB_MCP_URL` | `http://localhost:9084` | GitLab MCP |
| `ATLASSIAN_MCP_URL` | `http://localhost:9085` | Atlassian MCP (Jira/Confluence). The upstream Rovo endpoint the local proxy forwards to is `ATLASSIAN_UPSTREAM_MCP_URL`. |
| `AWS_MCP_URL` | `http://localhost:3001` | AWS MCP, through the local SigV4 proxy |
| `ELASTIC_IAC_MCP_URL` | `http://localhost:9086` | Elastic IaC MCP (the `elastic-iac` agent) |
| `LANDING_ZONE_IAC_MCP_URL` | `http://localhost:9088` | Landing Zone IaC MCP (the `landing-zone-terraform` agent) |
| (none, derived) | `http://localhost:9087` | Knowledge Graph MCP. Not an env URL: `getKnowledgeGraphMcpUrl()` returns the in-process server's address, or `undefined` when the KG is disabled, failed to start, or the port is held by something whose tools must not be registered (SIO-1645). The port is `KNOWLEDGE_GRAPH_MCP_PORT`. |

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
    connect("aws-mcp", awsUrl + "/mcp"),
    connect("elastic-iac-mcp", elasticIacUrl + "/mcp"),
    connect("landing-zone-iac-mcp", landingZoneIacUrl + "/mcp"),
    connect("knowledge-graph-mcp", knowledgeGraphUrl + "/mcp"),
])
```

Each connect is bounded by `connectTimeoutFor(name)`: 10 s for a directly reached server. The two AgentCore-backed servers (`kafka-mcp`, `aws-mcp`) cold-start through a SigV4 proxy that retries until `jsonRpcRetryDeadlineMs()` (60 s default, `AGENTCORE_JSONRPC_RETRY_DEADLINE_MS` overrides), so their connect timeout is derived from that same reader plus a 15 s margin rather than copied as a constant (SIO-1871). The proxy treats the deadline as a hard bound, clamping each TCP try to the time left, so the bridge never abandons a connect the proxy is still completing.

If a server is unreachable at startup:
- That server is logged as a warning and skipped
- Its tools are not added to the tool registry
- The `connectedServers` set does not include it
- The supervisor skips that datasource (0 tools -> skipped)
- Other servers proceed normally

### Streamable HTTP Transport

All ten connections use Streamable HTTP transport. The AWS MCP server is additionally fronted by a local SigV4-signed proxy (port 3001) when the runtime is deployed in AgentCore. The transport endpoint is always `<baseUrl>/mcp`. Each server also exposes:
- `GET /health` -- health check endpoint for periodic polling
- The standard MCP protocol messages over HTTP POST to `/mcp`

The `beforeToolCall` hook on the client injects W3C traceparent headers for cross-service trace correlation (see Trace Propagation section).

---

## Tool Scoping

The `getToolsForDataSource()` function routes datasource IDs to their corresponding MCP server tools.

| DataSource ID | Server Name | MCP URL Env Var | Tool Count |
|---------------|-------------|-----------------|------------|
| `elastic` | `elastic-mcp` | `ELASTIC_MCP_URL` | 117 (101 cluster incl. 9 ML anomaly-detection + 4 ES\|QL/async-search SIO-1391 + 16 conditional cloud/billing on `EC_API_KEY`) |
| `kafka` | `kafka-mcp` | `KAFKA_MCP_URL` | 11-61 (11 base + up to 50 gated SR + ksqlDB + Connect + REST Proxy) |
| `couchbase` | `couchbase-mcp` | `COUCHBASE_MCP_URL` | 43 (official Couchbase tools SIO-1107, plus Search service and diagnostics tools) |
| `konnect` | `konnect-mcp` | `KONNECT_MCP_URL` | 15 enhanced + proxy |
| `gitlab` | `gitlab-mcp` | `GITLAB_MCP_URL` | proxy + 5-8 custom |
| `atlassian` | `atlassian-mcp` | `ATLASSIAN_MCP_URL` | proxy + 4 custom |
| `aws` | `aws-mcp` | `AWS_MCP_URL` | ~40 read-only AWS tools + `aws_list_estates`. Multi-estate via cross-account `AssumeRole`. |
| `elastic-iac` | `elastic-iac-mcp` | `ELASTIC_IAC_MCP_URL` | the `elastic-iac` agent's GitOps facade |
| `landing-zone-iac` | `landing-zone-iac-mcp` | `LANDING_ZONE_IAC_MCP_URL` | 10 read tools, 14 with governed writes enabled |
| `knowledge-graph` | `knowledge-graph-mcp` | (in-process) | curated `kg_*` tools, see [Knowledge Graph](knowledge-graph.md) |

The mapping is defined in `mcp-bridge.ts`:

```typescript
export const DATASOURCE_TO_MCP_SERVER: Record<string, string> = {
    elastic: "elastic-mcp",
    kafka: "kafka-mcp",
    couchbase: "couchbase-mcp",
    konnect: "konnect-mcp",
    gitlab: "gitlab-mcp",
    atlassian: "atlassian-mcp",
    aws: "aws-mcp",
    "elastic-iac": "elastic-iac-mcp",
    "landing-zone-iac": "landing-zone-iac-mcp",
    "knowledge-graph": "knowledge-graph-mcp",
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

### Elasticsearch MCP (117 tools)

**Purpose:** Read-only access to Elasticsearch clusters for log search, index management, cluster health, shard allocation, mapping inspection, and snapshot operations. When `EC_API_KEY` is set, also exposes Elastic Cloud organization tools (deployment topology, plan auditing, hardware-profile simulation, and billing).

**Tool count:** 101 cluster tools always (incl. 9 ML anomaly-detection tools SIO-1148, and the 4 ES|QL/async-search tools `elasticsearch_esql_query` / `elasticsearch_async_search_submit` / `_get` / `_delete` added by SIO-1391); +16 cloud/billing tools registered conditionally on `EC_API_KEY` (SIO-822–826) by `registerCloudAndBillingTools` in `server.ts` (which logs "Registered 16..."). 117 total with `EC_API_KEY`. Counts verified by a live `registerAllTools` recount (returns `ToolInfo[].length === 101`), not a grep of tool-name literals.

**Tool categories:**
- Cluster operations: health, stats, settings, allocation explanation
- Index management: list, stats, mappings, settings, aliases
- Search: full-text search, aggregations, count, scroll
- Document operations: get, multi-get (read-only)
- Snapshot: repository listing, snapshot status
- Monitoring: node stats, hot threads, pending tasks
- **Elastic Cloud + Billing (16, conditional on `EC_API_KEY`)** -- registered by `registerCloudAndBillingTools` in `packages/mcp-server-elastic/src/server.ts`:
  - Cloud (10): `elasticsearch_cloud_list_deployments`, `elasticsearch_cloud_get_deployment`, `elasticsearch_cloud_get_es_resource`, `elasticsearch_cloud_get_plan_activity`, `elasticsearch_cloud_get_plan_history`, `elasticsearch_cloud_get_account`, `elasticsearch_cloud_cancel_pending_plan`, `elasticsearch_cloud_list_hardware_profiles`, `elasticsearch_cloud_get_hardware_profile`, `elasticsearch_cloud_simulate_hardware_profile_change`
  - Billing (6): `elasticsearch_billing_get_org_costs`, `elasticsearch_billing_get_deployment_costs`, `elasticsearch_billing_get_org_charts`, `elasticsearch_billing_list_instances`, `elasticsearch_billing_get_instance_items`, `elasticsearch_billing_get_instance_charts`
  - All hit `https://api.elastic-cloud.com` and use the org-scoped `EC_API_KEY`, distinct from per-deployment cluster keys. (Note: the `CLOUD_BILLING_TOOLS` set in `tools/index.ts` has only 10 names — it is a `deployment`-arg exclusion filter, NOT the registrar, so it undercounts the 16 registered here.)

**Configuration:** Multi-deployment pattern via `ELASTIC_DEPLOYMENTS=eu-cld,us-cld`. Per-deployment environment variables provide URL and API key (`ELASTIC_EU_CLD_URL`, `ELASTIC_EU_CLD_API_KEY`, etc.; hyphens become underscores). Cluster tools accept a per-call `deployment` arg with fallback chain: explicit arg -> `x-elastic-deployment` HTTP header -> `ELASTIC_DEFAULT_DEPLOYMENT` -> first ID in `ELASTIC_DEPLOYMENTS`. See `packages/mcp-server-elastic/src/tools/index.ts:302-391`.

**Error and discovery behaviour:**
- `elasticsearch_scroll_search` classifies a failure structurally and returns the shared `{ _error }` envelope, as `elasticsearch_search` does (SIO-1690). A rejected query DSL arrives as `bad-query` with advice that `query` takes a bare clause, instead of a bare `-32603` the sub-agent could not act on.
- The `search` action in `agents/incident-analyzer/tools/elastic-logs.yaml` also carries `elasticsearch_get_mappings`, `elasticsearch_get_field_mapping` and `elasticsearch_index_exists` (SIO-1855), so a search dispatch can look a field name up in the mapping before guessing it. Previously those tools were reachable only under `index_management`, and `action` is a single-string enum.

**Transport:** Streamable HTTP (`/mcp`), SSE, stdio, and AWS Bedrock AgentCore.

### Kafka MCP (11-61 tools depending on gating)

**Purpose:** Multi-component access to Kafka clusters and the surrounding Confluent stack. 11 core read tools always register; up to 50 additional tools register conditionally based on which Confluent components are enabled and whether write/destructive flags are set.

**Tool categories:**
- Kafka core (11 core reads always; `coreReads = 11` in `packages/mcp-server-kafka/src/tools/index.ts:83`): broker list, cluster info, topics list/describe, partition details, consumer groups list/describe/lag, message consume, plus write/destructive (`kafka_produce_message`, `kafka_create_topic`, `kafka_alter_topic_config`, `kafka_delete_topic`, `kafka_reset_consumer_group_offsets`) gated by `KAFKA_ALLOW_WRITES`/`KAFKA_ALLOW_DESTRUCTIVE`.
- Schema Registry (`SCHEMA_REGISTRY_ENABLED=true`): 8 reads (list/get subjects, schemas, versions, configs). With write gates: 3 writes (`sr_register_schema`, `sr_check_compatibility`, `sr_set_compatibility`) and 4 destructives (soft/hard delete subject + version) —.
- ksqlDB (`KSQL_ENABLED=true`): 7 tools (list streams/tables/queries, execute statement, server info, etc.).
- Connect (`CONNECT_ENABLED=true`): 4 reads (cluster info, list connectors, get connector status, get task status). With write gates: 3 writes (`connect_pause_connector`, `connect_resume_connector`, `connect_restart_connector`) and 2 destructives (`connect_restart_connector_task`, `connect_delete_connector`) —.
- REST Proxy (`RESTPROXY_ENABLED=true`): 3 metadata reads (`restproxy_list_topics`, `restproxy_get_topic`, `restproxy_get_partitions`). With `KAFKA_ALLOW_WRITES`: 6 writes (`restproxy_produce`, `restproxy_create_consumer`, `restproxy_subscribe`, `restproxy_consume`, `restproxy_commit_offsets`, `restproxy_delete_consumer`) —.

**Services:** `KafkaService` (kafka-core), `SchemaRegistryService`, `KsqlService`, `ConnectService`, and `RestProxyService` (the latter introduced in). Each service's tools register only when its own `*_ENABLED` flag is set.

**Configuration:** Provider-based selection via `KAFKA_PROVIDER=local|msk|confluent`. Feature gates `KAFKA_ALLOW_WRITES` / `KAFKA_ALLOW_DESTRUCTIVE` control write operations across kafka-core, Connect, SR, and REST Proxy in a unified way.

**Tool count formula:** see `tests/tools/full-stack-tools.test.ts` — the formula is asserted directly (`expect(tools.length).toBe(11)` baseline, `toBe(61)` full stack). Maximum (full Confluent stack with both write flags on) is 61.

**Transport:** Streamable HTTP (`/mcp`), SSE, stdio, and AWS Bedrock AgentCore.

### Couchbase Capella MCP (43 tools)

**Purpose:** Read-only access to Couchbase Capella clusters for bucket health, N1QL query execution (reads only by default), index analysis, Search (FTS) index inspection, and system vitals. The count is the number of entries in `packages/mcp-server-couchbase/src/__tests__/tools-list-snapshot.json`.

> **No auto-reload in development (SIO-1931):** unlike the other MCP servers, `bun run dev` here runs without `--hot` or `--watch`; restart it by hand after an edit. The native `couchbase` SDK cannot reload in-process safely:
> - **`--hot`:** every reload opens a new cluster and abandons the old one with its sockets, threads and health-check timer (24 reloads left 25 live clusters, RSS 111 to 745 MB). Under one-minute reloads the server exited after 8 reloads, unable to reconnect, and a long dev session segfaulted.
> - **`--watch`:** the restart runs before the async shutdown reaches `cluster.close()`, so the native sockets survive into the restarted process (7 to 190 Capella connections over 12 reloads).
> - **Without either:** the server held 1 connection and flat RSS over 2 hours of load.

> **SDK v2 dual-era pilot (SIO-1424/1436/1443):** this server carries a second, side-by-side entrypoint (`src/server-v2.ts` / `index-v2.ts`, `src/v2/`) that ports the same tool surface onto MCP SDK v2.0.0, plus its own `ResourceRegistry` (`src/resources/resource-registry.ts`, SIO-1412) that walks its own registered-resource map instead of reaching into the SDK's private `_registeredResources`. The v2 port is a parity pilot — it does not add tools to the agent's connected surface, so the count is unchanged.

**Tool categories:**
- Cluster: health check, node status, system vitals, auto-failover status
- Buckets: list, stats, collection/scope management (read-only)
- Queries: N1QL execution (SELECT), query plan analysis, active query monitoring
- Indexes: list, stats, advisor recommendations
- Security: user listing, role descriptions
- Search service (SIO-1823): `capella_list_fts_indexes`, `capella_get_fts_index_definition`, `capella_run_fts_query`. All three are classified read-only: running a Search query mutates nothing.
- Diagnostics (SIO-1823): `capella_get_cluster_diagnostics_report` reads the SDK's cached connection state with no network I/O.

**Configuration:** Single cluster: `COUCHBASE_URL`, `COUCHBASE_USERNAME`, `COUCHBASE_PASSWORD`. The incident analyzer restricts N1QL to SELECT queries via the compliance layer.

**Read-only gate (`READ_ONLY_QUERY_MODE`, default `true`):** one server setting, `config.server.readOnlyQueryMode`, covers both write paths.

- **SQL++ (`capella_run_sql_plus_plus_query`, and the EXPLAIN leg of `capella_explain_sql_plus_plus_query` / `capella_suggest_query_optimizations`).** The gate in `src/lib/sqlppParser.ts` is an allow-list (SIO-1822): a statement whose leading keyword is not provably a read is refused. The allowed heads are `SELECT`, `FROM`, `WITH`, `INFER`, `EXPLAIN`, `ADVISE`, and the transaction/session heads `BEGIN`, `START`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `SET`. Everything else is refused, which closed the bypass the old deny-list left open (`FLUSH COLLECTION` and `TRUNCATE COLLECTION` both empty a collection and both passed it). `PREPARE` and `EXECUTE` stay refused because they run server-side statements the gate cannot inspect.
- **Reading the keyword the way the query service does (SIO-1813).** The head is taken per `;`-separated statement, past opening parentheses and comments, cut at the first non-letter (so ``UPDATE`c` `` is `UPDATE`), with quoting that follows the query service lexer. A comment becomes a space, not an empty string, so it cannot splice two tokens into one.
- **KV document writes (SIO-1109).** `capella_upsert_document_by_id` and `capella_delete_document_by_id` call `readOnlyRefusal()` (`src/lib/readOnlyGuard.ts`) as their first step, one guard shared by the v1 and v2 handlers. Before this the mode was enforced only on the SQL++ path, so the KV tools mutated a server configured read-only. The refusal is a `bad-input` error envelope, which is non-degrading: a policy refusal is not a malfunction and does not count toward the degraded-subagent confidence cap.

The tool's `ToolAnnotations` are derived from the same setting, so a boot with the mode disabled reports `capella_run_sql_plus_plus_query` as writable and destructive.

**Tool response shape:** the 10 `queryAnalysis` tools return `effectiveLimit` (the LIMIT actually applied after server-side capping) and `actualCount` (rows returned) so the agent can detect truncation. parameterized all SQL++ in these tools to prevent injection — user-supplied bucket/scope/collection identifiers are now bound parameters rather than string-interpolated.

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

**Tool response shape:** the 15 list tools return observed pagination metadata (`offset`, `nextOffset`, `totalCount`) extracted from the Konnect API response so the agent can decide whether to paginate without an extra HEAD-style call. `nextOffset` is `null` when the page is the last one. Per-tool handlers are now typed via `z.infer<typeof validator>` and the read-only check is applied once at the bootstrap chokepoint rather than per tool.

**Transport:** Streamable HTTP (`/mcp`), SSE, stdio, and AWS Bedrock AgentCore.

### GitLab MCP (proxy + 5-8 custom tools)

**Purpose:** Read-only access to GitLab for CI/CD pipeline status, merge request history, issue tracking, code blame, commit diffs, and semantic code search. Correlates code changes with incident timing.

**Architecture:** Unlike other MCP servers that implement tools directly, the GitLab MCP uses a hybrid proxy + custom pattern. It connects to GitLab's native MCP endpoint (`/api/v4/mcp`) at startup, discovers available tools, and re-registers them locally with a `gitlab_` prefix. Custom code-analysis tools (blame, commit diff, file content, repository tree, commit listing) are registered alongside the proxied tools.

**Schema conversion for proxied tools** (`packages/mcp-server-gitlab/src/tools/proxy/index.ts`): the discovered JSON Schema is converted to Zod so the model is constrained before a request leaves the process.
- An `enum` on a string property becomes a `z.enum`, and an `array` recurses on `items` so the element contract (including its enum) is kept (SIO-1656). Arrays used to fall through to `z.unknown()`, so every array parameter was schema-less and GitLab rejected the model's guess mid-investigation.
- GitLab enforces some caps it never declares. `UNDECLARED_MAX_ITEMS` supplies the known one, `include: 1` on `get_merge_request` and `get_pipeline` (one facet per call), only where upstream declares no `maxItems` (SIO-1854), so a future upstream declaration wins on its own.

**Tool categories:**
- Issues: create, get, notes, saved views (via proxy)
- Merge requests: get, commits, diffs, pipelines, conflicts (via proxy)
- Pipelines: manage, get jobs (via proxy)
- Search: global search, labels, semantic code search with deferred retry for embedding readiness (via proxy)
- Code analysis: file content, blame, commit diff, commit listing, repository tree (custom REST tools)

**Configuration:** Token-based authentication via `GITLAB_PERSONAL_ACCESS_TOKEN` (requires `api` scope) for the custom code-analysis tools. The proxy connection to `/api/v4/mcp` uses OAuth 2.0 Dynamic Client Registration as a public client (RFC 8252, `token_endpoint_auth_method: "none"`) with PKCE; this is what GitLab DCR actually issues for unverified MCP clients. Scope is pinned to `mcp` (GitLab MR !208967 default). Instance URL via `GITLAB_INSTANCE_URL` (defaults to `https://gitlab.com`). Callback port on `GITLAB_OAUTH_CALLBACK_PORT` (default 9184). See [OAuth credential persistence](#oauth-credential-persistence) below for the seeding flow.

**Transport:** Streamable HTTP (`/mcp`), SSE, stdio, and AWS Bedrock AgentCore.

### Atlassian MCP (proxy + custom tools)

**Purpose:** Read-only access to Atlassian Cloud (Jira and Confluence) for incident ticket lookup, project metadata, runbook page retrieval, and ticket creation gated by compliance policy. Supplements GitLab code-change context with process and documentation context.

**Architecture:** Proxy + custom pattern, like the GitLab MCP. Connects to Atlassian's hosted MCP endpoint (`https://mcp.atlassian.com/v1/mcp`) at startup via OAuth 2.0, discovers available tools, and re-registers them locally with an `atlassian_` prefix. Custom tools extend proxied capabilities with incident-specific filtering.

**Tool categories:**
- Jira: issue search, get issue, project listing, status transitions (gated by `ATLASSIAN_READ_ONLY`)
- Confluence: page search, page content, space listing
- Incident-project narrowing: `ATLASSIAN_INCIDENT_PROJECTS` is optional. It defaults to empty, and an empty list means the custom tools search ALL projects the account can see. When set, the custom tools add `project in (...)` to their JQL. It narrows the custom incident tools only, it is not a visibility allowlist for the proxied tools. Keys that do not exist on the site are dropped with a `configWarning` rather than silently returning nothing (SIO-1184).

**Custom tools** (4, `packages/mcp-server-atlassian/src/tools/custom/`): `findLinkedIncidents`, `getRunbookForAlert`, `getIncidentHistory`, and an `atlassian_getJiraIssue` override of the proxied tool.

`findLinkedIncidents` (SIO-1802, PR #832):
- The service clauses and the keyword clauses are two separate searches run with `Promise.allSettled`. In one `OR` they competed for the same `limit` slots under `ORDER BY created DESC`, and a generic keyword won every time. Service hits always rank first, keyword-only hits fill what is left, and a failed half is named in `configWarning` instead of discarding the half that worked.
- JQL `text ~ "a b"` is a stemmed bag of words, not a phrase. A keyword containing whitespace is sent as a quoted phrase; a single word stays unquoted so stemming still helps it.
- Each returned ticket carries `matchedBy` (`service-label`, `component`, `service-text`, `keyword:<term>`) and a `score` (label or component 3, service in the text 2, each keyword 1), computed deterministically from the fields already fetched. The agent's Atlassian extractor drops weak hits (no structural match and fewer than two keywords) on a focused run.
- A genuinely empty result at the requested window (default 30 days) retries once at `WIDENED_WINDOW_DAYS` = 120 (SIO-1863). The retry widens the window, never the query text, and does not run when either narrow search failed, so an upstream outage is not reported as "nothing recent exists".
- Both Jira composers name the fields they read (`LINKED_INCIDENT_FIELDS`, `INCIDENT_HISTORY_FIELDS`), because the upstream default set omits `resolutiondate` and left `resolvedAt` and MTTR null for every ticket (SIO-1805).
- The agent then reranks the findings card against the incident text (`packages/agent/src/atlassian-rerank.ts`, SIO-1837, `ATLASSIAN_RERANK_ENABLED` defaults ON).

`getRunbookForAlert` (SIO-1806, SIO-1844):
- Query 1 retrieves runbook-like pages about the service or citing a keyword: labels `runbook`, `kb-how-to-article`, `kb-troubleshooting-article`, or a title word such as `playbook`, `support`, `guide`, `troubleshooting`. Query 2 retrieves pages citing the error (a phrase stands alone, a single word must co-occur with the service). A broad fallback runs only when those leave slots empty. No `ORDER BY`, so Confluence orders by relevance.
- It reads the real `searchConfluenceUsingCql` result shape (`content.id`, `content.title`, `content.metadata.labels`, `lastModified`, `resultGlobalContainer.displayUrl`). The previous code read fields that do not exist at the top level, so every match had an undefined id and link.
- Its description is scoped to what the corpus holds: procedural and onboarding documentation. Incident runbooks live in the agent's own knowledge tree and are selected by the orchestrator (SIO-1844).

**Configuration:** OAuth 2.0 (DCR returns a `client_secret`, so `token_endpoint_auth_method: "client_secret_post"` is used) with `ATLASSIAN_SITE_NAME` identifying the Cloud site. Callback port on `ATLASSIAN_OAUTH_CALLBACK_PORT` (default 9185). MCP server port on `ATLASSIAN_MCP_PORT` (default 9085). Read-only enforced by `ATLASSIAN_READ_ONLY=true` (default). Optional `ATLASSIAN_INCIDENT_PROJECTS` and `ATLASSIAN_TIMEOUT`. See [OAuth credential persistence](#oauth-credential-persistence) below for the seeding flow.

**Transport:** Streamable HTTP (`/mcp`), stdio, and AWS Bedrock AgentCore.

### Landing Zone IaC MCP (10 read tools, 14 with governed writes)

**Purpose:** GitLab-backed evidence for the `landing-zone-terraform` agent, with an optional, policy-gated GitOps proposal facade. Not an incident datasource: the supervisor never fans out to it. The agent, its review gates and its rollout are documented in [Landing Zone Terraform Agent](landing-zone-terraform-agent.md) and the [Landing Zone agent runbook](../operations/landing-zone-agent-runbook.md); this section only lists the tool surface (`packages/mcp-server-landing-zone-iac/src/server.ts`).

| Group | Tools | Registered |
|-------|-------|------------|
| Read (10, `readOnlyHint: true`) | `lz_list_repositories`, `lz_read_repository_files`, `lz_find_representative_examples`, `lz_list_open_changes`, `lz_list_historical_merge_requests`, `lz_read_merge_request`, `lz_list_merge_request_pipelines`, `lz_list_project_deployments`, `lz_read_pipeline_plan`, `lz_extract_terraform_topology` | always |
| Governed write (3, `readOnlyHint: false`, `destructiveHint: false`) | `lz_create_branch`, `lz_commit_allowed_files`, `lz_open_merge_request` | only when `LANDING_ZONE_WRITE_ENABLED=true` and the write policy validates |
| Pipeline watch (1, read-only) | `lz_watch_pipeline` (observes existing merge-request pipelines, never triggers CI) | with the governed writes, since it checks the write allowlist |

With writes disabled the four gated tools are absent from `tools/list`, not registered-and-refusing. Every read is bounded (`LANDING_ZONE_IAC_MAX_RESPONSE_BYTES`) and resolves its `repository` argument against the approved catalog.

**Transport:** Streamable HTTP (`/mcp`, port 9088) and stdio.

### OAuth credential persistence

GitLab and Atlassian MCP both use OAuth 2.0 Dynamic Client Registration through the `BaseOAuthClientProvider` in `@devops-agent/shared`. The two share storage layout, persistence semantics, file-mode hardening, and headless-mode behavior; they differ only in `clientMetadata` (auth method, scope, client name) per the table above.

**On-disk state:** `~/.mcp-auth/<namespace>/<sanitized-mcp-url>.json` (mode 0o600, dir 0o700). Each file holds `clientInformation` (the DCR registration), `tokens` (access + refresh), and a transient `codeVerifier` cleared after the token exchange completes. Filenames are byte-stable across releases (regression-tested in `packages/shared/src/__tests__/oauth/base-provider.test.ts`).

**Stale-registration migration:** if a persisted `clientInformation` was saved with a different `token_endpoint_auth_method` than the current code expects (e.g. legacy GitLab registrations stored as `client_secret_post` before), the base provider auto-discards the registration and re-registers via DCR. No manual `rm` required.

**Headless mode:** set `MCP_OAUTH_HEADLESS=true` in non-interactive contexts (eval pipeline, AgentCore deployments, CI). The provider throws a typed `OAuthRequiresInteractiveAuthError` instead of opening a browser, which the agent's alignment node classifies as a non-retryable auth error. Headless is also auto-detected when `process.stdout.isTTY === false`. To seed tokens once interactively, run `bun run oauth:seed:gitlab` or `bun run oauth:seed:atlassian` -- the seed CLI explicitly unsets `MCP_OAUTH_HEADLESS` so it always opens the browser. See `docs/operations/oauth-seeding.md` for the full procedure.

---

## Tool registration (registerTool + ToolAnnotations)

All MCP servers share one SDK baseline and one registration idiom, enforced at build time (SIO-1410..1421):

- **SDK 1.30.0, pinned centrally.** The root `package.json` declares `@modelcontextprotocol/sdk` in the workspace `catalog` at `^1.30.0` plus an `overrides` entry pinning `1.30.0`; every server package depends on `"catalog:"` rather than its own range, so there is exactly one SDK version in the tree (SIO-1410).
- **`server.registerTool()` only — no sugar.** Servers register tools, prompts, and resources through the SDK's typed `registerTool()` / `registerPrompt()` / `registerResource()` API. The older `server.tool()` / `server.prompt()` / `server.resource()` sugar is **build-forbidden**: `packages/tools-verify/src/verify-no-sugar-registration.ts` fails the build on any sugar call (its `NOT_YET_CONVERTED` allowlist is empty — zero sugar repo-wide). When adding a tool, grep for `server.registerTool(`, not `server.tool(`.
- **`ToolAnnotations` on every tool.** Each `registerTool` call attaches machine-readable annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) derived by the shared `deriveToolAnnotations` helper (`packages/shared/src/tool-annotations.ts`), so read-only vs. destructive intent is declared in the protocol, not just in prose.
- **`outputSchema` + `structuredContent` (wave 1, in progress).** Newer tools declare an `outputSchema` and return `structuredContent` alongside the text block (SIO-1422); the agent consumes it directly in `sub-agent-instrumentation.ts` / `sub-agent.ts` (SIO-1437) instead of re-parsing the text. Response builders (e.g. `packages/mcp-server-kafka/src/lib/response-builder.ts`) support both shapes. Not every tool has an output schema yet — this is a rolling conversion.
- **SDK-agnostic bootstrap seam.** The lifecycle glue (`registerMcpApplication`, transport wiring, logging) lives in `packages/shared/src/bootstrap-lifecycle.ts` (SIO-1423), separate from the SDK-version-specific `bootstrap.ts` (v1) and `bootstrap-v2.ts` (the couchbase v2 pilot), so a server can be moved to a newer SDK era without rewriting its lifecycle.

The full author-facing contract (step-by-step, with the annotation and output-schema examples) is in [Adding MCP Tools](../development/adding-mcp-tools.md).

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
| 2026-05-07 | Documented Elastic Cloud + Billing tool family and per-call `deployment` arg fallback chain; updated tool count from ~78 to ~84 |
| 2026-05-09 | Extracted shared OAuth provider base; GitLab MCP switched to public-client + PKCE (`auth_method: "none"`, `scope: "mcp"`); added `MCP_OAUTH_HEADLESS` env, `bun run oauth:seed:<service>` CLIs, stale-registration auto-discard, file-mode 0o600 enforcement |
| 2026-07-19 | SIO-1039..1161 sync: refreshed stale tool counts — elastic ~84/~93 -> **112** with `EC_API_KEY` (96 cluster incl. 9 ML anomaly-detection tools SIO-1148 + 16 cloud/billing; live-recount corrected the long-standing cluster undercount); couchbase ~15 -> **~39** (official Couchbase tools, SIO-1107). |
| 2026-08-08 | SIO-1162..1459 sync. Corrected tool counts to live recounts: elastic **112 -> 117** (cluster **96 -> 101**: SIO-1391 added 4 ES\|QL/async-search tools; `registerAllTools` returns `ToolInfo[].length === 101`); kafka **15-55 -> 11-61** (`coreReads = 11`, full-stack test asserts `toBe(61)` — the old 15/55 figures never matched the asserted formula); couchbase **~39 -> ~39**. Documented the SIO-1410..1443 MCP SDK modernization wave: the unified **SDK 1.30.0** baseline, the build-forbidden `server.tool()` sugar / `registerTool` + `deriveToolAnnotations` idiom, `outputSchema`/`structuredContent` (SIO-1422/1437), the `bootstrap-lifecycle.ts` SDK-agnostic seam (SIO-1423), and the couchbase **SDK v2 dual-era pilot** + own `ResourceRegistry` (SIO-1424/1436/1443/1412). Added the new "[Tool registration](#tool-registration-registertool--toolannotations)" section. |
| 2026-09-30 | SIO-1897 docs sync (SIO-1635..1896 window): counts and the URL table now cover all ten connections (seven incident datasources plus `elastic-iac`, `landing-zone-iac`, in-process `knowledge-graph`), and the Couchbase URL variable is corrected to `COUCHBASE_MCP_URL`; new Landing Zone IaC section (`lz_*` tools, gated writes); Couchbase count is 43 from the snapshot, with the Search service and diagnostics tools (SIO-1823) and the read-only gate (SIO-1109, SIO-1813, SIO-1822); Atlassian `findLinkedIncidents` and `getRunbookForAlert` behaviour (SIO-1802, SIO-1805, SIO-1806, SIO-1844, SIO-1863, rerank SIO-1837) and `ATLASSIAN_INCIDENT_PROJECTS` described as optional narrowing; GitLab proxy schema conversion (SIO-1656) and undeclared caps (SIO-1854); Elastic scroll-search error envelope (SIO-1690) and field lookup on the search path (SIO-1855); AgentCore connect timeout derived from the proxy retry deadline (SIO-1871). |
