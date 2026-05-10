# Troubleshooting

> **Targets:** Bun 1.3.9+ | MCP SDK 1.27+ | TypeScript 5.x
> **Last updated:** 2026-04-23

Symptom-based problem resolution for the DevOps Incident Analyzer. Issues are organized by subsystem: MCP servers, LangGraph agent, SvelteKit frontend, configuration, and AWS/AgentCore deployment.

---

## MCP Server Issues

### Server Fails to Start

**Symptoms:** Process exits immediately, error on startup, port already in use.

**Check port conflicts:**

```bash
lsof -i :9080    # Elastic MCP
lsof -i :9081    # Kafka MCP
lsof -i :9082    # Couchbase MCP
lsof -i :9083    # Konnect MCP
lsof -i :9084    # GitLab MCP
lsof -i :9085    # Atlassian MCP
lsof -i :9185    # Atlassian OAuth callback
```

If a port is occupied, kill the existing process:

```bash
kill <pid>
```

**Check environment variables:** The `createMcpApplication` bootstrap function validates all required config via Zod schemas on startup. A Zod validation error means a required environment variable is missing or has an invalid value:

```
ZodError: [
  { code: "invalid_type", expected: "string", received: "undefined", path: ["kafka", "clientId"] }
]
```

Fix: check `.env` file exists and has the required variables. Bun auto-loads `.env` -- no dotenv import needed.

**Check datasource connectivity:** If the server starts but fails during datasource initialization (Step 3 of `createMcpApplication`), verify the backend service is reachable:

```bash
# Kafka
kafkacat -b localhost:9092 -L

# Elasticsearch
curl -s http://localhost:9200/_cluster/health

# Couchbase
curl -s http://localhost:8091/pools/default
```

### Server Returns No Tools

**Symptoms:** MCP client connects but `tools/list` returns empty array.

Check server logs for registration errors. Each tool category registers separately -- one failure may prevent subsequent registrations:

```
debug: Registering read tools
debug: Registering extended read tools
debug: Registering write tools
error: Failed to register schema tools: Schema Registry is not configured
info: All tools registered successfully
```

If tools depend on optional services (Schema Registry, ksqlDB, Connect, REST Proxy), verify the feature flag:

```bash
SCHEMA_REGISTRY_ENABLED=true
KSQL_ENABLED=true
CONNECT_ENABLED=true
RESTPROXY_ENABLED=true
```

For SIO-682 write/destructive tools (5 Connect + 7 SR + 6 REST Proxy writes that need it), the per-server `*_ENABLED` flag is necessary but not sufficient — the gates `KAFKA_ALLOW_WRITES=true` and (for destructive operations) `KAFKA_ALLOW_DESTRUCTIVE=true` must also be set, or those tools are silently omitted from `tools/list`.

### Kafka MCP Optional Service Reachability (SIO-684)

When `SCHEMA_REGISTRY_ENABLED`, `KSQL_ENABLED`, `CONNECT_ENABLED`, or `RESTPROXY_ENABLED` is true, the Kafka MCP server probes each enabled endpoint at startup with a 5s timeout (`GET /subjects`, `GET /info`, `GET /`, `GET /topics` respectively). The server boots regardless of probe outcome — tools stay registered so partial reachability is supported — but each probe emits one log line:

```
info: schema-registry reachable          { component, url }
error: ksqldb unreachable - tools registered but calls will fail   { component, url, error }
```

If the probe is missing for an `*_ENABLED=true` service, the server is older than SIO-684. If you see the `error` line, the underlying tool calls (e.g. `ksql_get_server_info`) will fail with the same error string in their MCP response, and each failed call now emits a `Tool call error` log line in addition to returning `isError: true` to the agent. This is the loud signal — quiet `info "Tool call completed"` lines no longer mask connectivity failures.

A common cause on AgentCore deployments is a missing cross-account network path between the AgentCore VPC and the Confluent (or self-hosted) endpoints. Probe failures are the first place to look in CloudWatch.

### Health Check Fails

**Symptoms:** `/health` returns non-200, `/ping` does not respond.

Verify the HTTP transport is running (not just stdio):

```bash
curl -s http://localhost:9081/health | jq .
curl -s http://localhost:9081/ping
```

If using Docker, verify the container exposes the correct port and the health check command matches:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8000/ping || exit 1
```

### Tool Call Timeout

**Symptoms:** Tool invocations hang or exceed the timeout threshold.

Check datasource connectivity from inside the server process. Common causes:

- Kafka broker unreachable (MSK security group rules, VPC peering)
- Elasticsearch cluster in red/yellow state
- Couchbase node failover in progress
- Konnect API rate limiting
- GitLab API token expired or insufficient scope

### GitLab MCP Server Connection Issues

**Symptoms:** GitLab tools fail with 401/403 errors, proxy tools return empty results, or semantic code search always times out.

**Verify token and instance URL:**

```bash
curl -H "PRIVATE-TOKEN: $GITLAB_PERSONAL_ACCESS_TOKEN" "$GITLAB_INSTANCE_URL/api/v4/user"
```

If this returns 401, the token is expired or invalid. Generate a new token with `api` scope.

**Check proxy connection:** The GitLab MCP server connects to GitLab's native MCP endpoint at startup. If this connection fails, proxy tools will be unavailable but custom code-analysis tools will still work. Check server logs for:

```
[gitlab-mcp] Failed to connect to GitLab MCP endpoint
```

**Semantic code search returns "embeddings not ready":** First-time use on a project triggers embedding indexing. The proxy retries automatically (10s, 20s, 40s). If it still fails after ~70 seconds, the project may not have code search enabled. Check in GitLab UI under Settings > General > Code Search.

Increase the tool timeout if the datasource is slow but reachable:

```bash
KAFKA_CONSUME_TIMEOUT_MS=30000     # Default: 5000
```

---

## Agent Issues

### "No datasource results to aggregate"

**Symptoms:** Agent completes but responds with no data, aggregate node receives empty results.

This means MCP servers are not connected or all sub-agents were skipped:

1. Check that MCP servers are running on their expected ports (9080-9083)
2. Check that the agent's `MultiServerMCPClient` URLs are correct
3. Check that the user selected at least one datasource in `DataSourceSelector`
4. Check server logs for connection errors during the supervisor fan-out

### Validation Fails Repeatedly

**Symptoms:** Agent enters a retry loop at the validate node, responses include low confidence scores.

The validator checks that agent claims are backed by evidence from the datasource results. Repeated failures indicate:

- The LLM is generating claims not supported by the retrieved data
- Prompts may need adjustment to constrain hallucination
- The alignment step may not be properly filtering unsupported claims

Check the `retryCount` in the agent state. After the maximum retry count, the agent proceeds with the best available response and flags low confidence.

### Classification Always Returns "simple"

**Symptoms:** All queries are routed to the simple responder path, skipping the full pipeline.

The classify node determines query complexity. If it always returns "simple":

- Check that the classify node prompt correctly identifies multi-datasource queries
- Verify the entity extractor is detecting datasource signals (service names, topic names, cluster references)
- Test with an explicitly complex query: "Compare Kafka consumer lag with Elasticsearch error rates for the order-service in the last hour"

### Confidence Capped at 0.59 (SIO-681 / SIO-707 / SIO-709 / SIO-712)

**Symptoms:** Final report ships with `confidenceScore <= 0.59`. One or more of: a non-empty `degradedRules` array, a `## Gaps` section with several bullets, a `WARNING: unresolved cross-source contradiction` banner at the top of the report.

The cap value is `0.59` (was `0.6` before SIO-712) so a capped run is strictly below the 0.6 HITL gate (`checkConfidence` uses `<`). Any of the inputs below independently caps confidence — `degradedRules` may be empty even when the cap fires.

The degradation can mean any of:
- **Degraded correlation rule.** The required sub-agent (typically elastic-agent) was unreachable during the re-fan-out, or it ran but produced no findings covering the triggered service. Each `degradedRules` entry has `{ ruleId, agent, services, reason }`.
- **Tool-error rate >= 15%** (SIO-707, tightened by SIO-709). Aggregated sub-agent tool-call failures crossed the 15% threshold (was 25% before SIO-709). Check sub-agent transcripts for serialized MCP-tool errors.
- **`## Gaps` section with >= 2 bullets** (SIO-709). The aggregator's own self-reported gap list crossed the threshold. This is independent of `degradedRules` and fires even when every sub-agent succeeded.
- **`skipCoverageCheck` rule degraded** (SIO-712). A signal-as-trigger rule like `gitlab-deploy-vs-datastore-runtime` fired and the contradiction wasn't resolvable from already-collected data. The report carries a `WARNING: unresolved cross-source contradiction` banner. There is no sub-agent to retry — the cap *is* the action.
- **Predicate fail-open.** A correlation rule's trigger predicate threw and was logged as fail-open (rule auto-satisfied; check logs for `predicate error`). One bad rule cannot break the pipeline.

To recover: ensure the targeted sub-agent's MCP server is reachable, then retry the query. The rule engine's idempotency makes the next pass a clean no-op if the first pass succeeded. For tool-error or Gaps-section caps, retrying does not help by itself — investigate the underlying tool failures or gap reasons surfaced in the report.

See `docs/architecture/agent-pipeline.md` "enforceCorrelations" section for the rule list, the `skipCoverageCheck` routing, and the confidence-cap inputs.

### Elasticsearch Search Times Out at ~30 Seconds (SIO-708)

**Symptoms:** `elasticsearch_search` returns a transport timeout after ~30 s. Multiple parallel aggregation-heavy searches against the same index pattern all hit the ceiling within a few ms of each other. Sequential reruns of the same query shape complete in 5–7 s.

This is contention at the Elasticsearch SDK or server layer, not query infeasibility. SIO-708 added a per-call timeout (`searchRequestOptions.ts`) for `elasticsearch_search`, defaulting to 60 s with 0 retries, and lifted the shared client's `requestTimeout` schema cap from 60 s to 120 s.

To raise the per-call ceiling for heavy aggregations:

```bash
ELASTIC_SEARCH_REQUEST_TIMEOUT_MS=120000   # cap is 120000
ELASTIC_SEARCH_MAX_RETRIES=0               # leave at 0 to avoid silent retry stacking
```

The MCP tool description and the `elastic-logs` action YAML carry LLM-side narrowing guidance (narrow the index pattern, shorten the window, project specific fields, avoid parallel fan-outs of heavy aggregations). If the LLM keeps fanning out heavy aggregations in parallel, that is the failure mode the per-call cap is designed to surface, not mask — raising the timeout is a workaround, not the fix.

### Sub-Agent Skipped

**Symptoms:** One datasource never appears in results, even when selected.

The supervisor skips sub-agents when no tools are available for that datasource. This happens when:

- The MCP server for that datasource is not connected
- The `getToolsForDataSource` function returns an empty array
- The tool pattern matching in gitagent-bridge does not match any registered tools

Check:

```bash
# Verify tools are registered on the target server
curl -s http://localhost:9081/health
```

---

## Frontend Issues

### SSE Stream Drops

**Symptoms:** Agent response cuts off mid-stream, UI shows incomplete answer.

Check CORS configuration -- the SSE connection may be blocked:

```bash
CORS_ORIGINS=http://localhost:5173
```

Check server timeout settings. Long-running agent pipelines may exceed default timeouts. The `agentStore` uses an `AbortController` for cancellation -- verify it is not triggering prematurely.

Check browser developer tools for network errors on the `/api/agent/stream` request.

### Blank Response

**Symptoms:** Agent appears to complete but no content is rendered.

The agent may have errored internally. Check:

1. Server-side logs for errors in the agent pipeline
2. The SSE stream for error events (visible in browser network tab)
3. That `currentContent` in `agentStore` received token events
4. That `ChatMessage` is receiving the `message.content` prop

### CORS Errors

**Symptoms:** Browser console shows "blocked by CORS policy" errors.

Add the frontend origin to the allowed origins:

```bash
# In .env
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
```

For production, set to the actual deployment URL. Multiple origins are comma-separated.

---

## Configuration Issues

### Environment Variable Not Loaded

**Symptoms:** Config values are undefined despite being set in `.env`.

Bun auto-loads `.env` files from the project root. Verify:

1. The `.env` file exists in the workspace root (not in a nested package directory)
2. The variable name is spelled correctly (case-sensitive)
3. No trailing whitespace or quotes around values
4. The process is started from the workspace root (or the `.env` is in the correct CWD)

```bash
# Quick check
bun -e "console.log(Bun.env.KAFKA_PROVIDER)"
```

### Zod Validation Error on Startup

**Symptoms:** Server crashes with `ZodError` showing path and expected type.

Compare the error path against the Zod schema in the server's `config/schemas.ts`. Common issues:

- Missing required field (check `.env` for the corresponding variable)
- Wrong type (e.g., `"true"` string vs `true` boolean -- Zod parses env vars as strings)
- Invalid enum value (e.g., `KAFKA_PROVIDER=aws` should be `KAFKA_PROVIDER=msk`)

The Kafka MCP server schemas are strict (`z.object().strict()`), so extra/unknown fields also cause errors.

### Multi-Deployment Not Recognized

**Symptoms:** Elasticsearch tools only query one deployment, or deployments are missing.

Check the `ELASTIC_DEPLOYMENTS` format -- it must be comma-separated IDs that match the uppercase per-deployment variables:

```bash
ELASTIC_DEPLOYMENTS=eu-cld,us-cld
ELASTIC_EU_CLD_URL=https://eu.es.cloud.example.com
ELASTIC_EU_CLD_API_KEY=key-for-eu
ELASTIC_US_CLD_URL=https://us.es.cloud.example.com
ELASTIC_US_CLD_API_KEY=key-for-us
```

The deployment ID in `ELASTIC_DEPLOYMENTS` is lowercased and may contain hyphens; per-deployment vars use the uppercased form with hyphens converted to underscores (`eu-cld` -> `ELASTIC_EU_CLD_*`).

---

## AWS / AgentCore Issues

### Bedrock Model Access Denied

**Symptoms:** `AccessDeniedException` when the agent tries to invoke a Bedrock model.

Verify IAM permissions include:

```json
{
  "Effect": "Allow",
  "Action": [
    "bedrock:InvokeModel",
    "bedrock:InvokeModelWithResponseStream"
  ],
  "Resource": "arn:aws:bedrock:*::foundation-model/*"
}
```

Also verify the model is available in the target AWS region. Not all models are available in all regions.

### AgentCore Runtime /ping Fails

**Symptoms:** AgentCore health check fails, container is marked unhealthy.

Verify the Dockerfile exposes port 8000 (AgentCore's expected port):

```dockerfile
EXPOSE 8000
```

Verify the transport mode is set to `agentcore`:

```bash
TRANSPORT_MODE=agentcore
```

In AgentCore mode, the server binds to `0.0.0.0:8000` with a `/ping` endpoint. Check that no other process is using port 8000 inside the container.

### IAM Policy Insufficient

**Symptoms:** Various AWS API calls fail with authorization errors.

Required IAM permissions depend on the MCP server:

| Server | Required Permissions |
|--------|---------------------|
| Kafka (MSK) | `kafka:DescribeCluster`, `kafka:GetBootstrapBrokers`, `kafka-cluster:*` |
| Elasticsearch | Managed via Elastic Cloud API keys (not IAM) |
| Couchbase | Managed via Capella API keys (not IAM) |
| Konnect | Managed via Konnect access tokens (not IAM) |

---

## Debugging Techniques

### Checking Structured Logs

In production, logs are NDJSON. Use `jq` to parse:

```bash
# Filter error logs
bun run packages/mcp-server-kafka/src/index.ts 2>&1 | jq 'select(.["log.level"] == "error")'

# Extract tool timing
bun run packages/mcp-server-kafka/src/index.ts 2>&1 | jq 'select(.message | test("Tool completed")) | {tool: .message, duration}'

# Filter by trace ID
bun run packages/mcp-server-kafka/src/index.ts 2>&1 | jq 'select(.["trace.id"] == "abc123...")'
```

In development, logs are already human-readable. Set `LOG_LEVEL=debug` for verbose output:

```bash
LOG_LEVEL=debug bun run packages/mcp-server-kafka/src/index.ts
```

### Tracing via LangSmith

Use the `langsmith-fetch` CLI to inspect recent traces:

```bash
# Get API key from .env
grep "^LANGSMITH_API_KEY=" .env

# Fetch recent traces
LANGSMITH_API_KEY=<key> LANGSMITH_PROJECT=kafka-mcp-server langsmith-fetch traces /tmp/traces --limit 5 --include-metadata

# With format options
LANGSMITH_API_KEY=<key> LANGSMITH_PROJECT=devops-agent langsmith-fetch traces /tmp/traces --format pretty --last-n-minutes 30
```

### Testing MCP Tools in Isolation

Run a single MCP server and test tools directly:

```bash
# Start the Kafka MCP server
LOG_LEVEL=debug bun run packages/mcp-server-kafka/src/index.ts

# Test health
curl -s http://localhost:9081/health | jq .

# Use MCP inspector or a simple client to call tools
# The tool list is available via the MCP protocol's tools/list method
```

### Port Conflict Resolution

Find and kill processes blocking MCP server ports:

```bash
# Check all MCP ports
for port in 9080 9081 9082 9083 9084 5173; do
  pid=$(lsof -ti :$port 2>/dev/null)
  if [ -n "$pid" ]; then
    echo "Port $port: PID $pid"
  fi
done

# Kill a specific process
kill <pid>

# Force kill if unresponsive
kill -9 <pid>
```

---

## Cross-References

- [Observability](./observability.md) -- logging architecture and tracing setup
- [Environment Variables](../configuration/environment-variables.md) -- all configuration options
- [MCP Server Configuration](../configuration/mcp-server-configuration.md) -- server-specific settings
- [Getting Started](../development/getting-started.md) -- initial setup and prerequisites

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial version |
| 2026-04-23 | Added Atlassian MCP port (9085) and OAuth callback port (9185) to port-conflict checklist |
