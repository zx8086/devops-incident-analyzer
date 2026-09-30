# Observability

> **Targets:** Bun 1.3.9+ | OpenTelemetry | LangSmith | Pino
> **Last updated:** 2026-09-30

The observability stack provides structured logging, distributed tracing, and agent run tracking across the DevOps Incident Analyzer. Three systems work together: Pino for structured logging, OpenTelemetry for distributed tracing, and LangSmith for LLM-specific agent trace capture and feedback collection.

---

## Logging Architecture

### Logger Factory

All services create loggers through `createMcpLogger` from `@devops-agent/shared`. This factory produces a Pino logger with ECS-formatted output, automatic trace context injection, and sensitive data redaction.

```typescript
import { createMcpLogger, getChildLogger } from "@devops-agent/shared";

const logger = createMcpLogger("mcp-server-kafka");
const toolLogger = getChildLogger(logger, "tool-handler");
```

The `observability` package re-exports a convenience wrapper:

```typescript
import { getLogger, getChildLogger } from "@devops-agent/observability";

const logger = getLogger("agent-pipeline");
const nodeLogger = getChildLogger(logger, "classify-node");
```

### Log Levels

| Level | When to Use |
|-------|-------------|
| `silent` | Disable all logging (testing) |
| `debug` | Tool execution details, span timing, internal state transitions |
| `info` | Server startup/shutdown, tool registration, connection events |
| `warn` | Recoverable issues, deprecated usage, missing optional config |
| `error` | Tool failures, connection errors, unhandled exceptions |

Set the log level via `LOG_LEVEL` environment variable (defaults to `info`).

### Structured JSON Output

In production and staging (`NODE_ENV=production` or `NODE_ENV=staging`), logs are emitted as ECS-compatible NDJSON to stderr. Each log line includes:

```json
{
  "@timestamp": "2026-04-04T10:30:00.000Z",
  "log.level": "info",
  "message": "Tool completed: kafka_list_topics",
  "service.name": "mcp-server-kafka",
  "service.version": "0.1.0",
  "service.environment": "production",
  "trace.id": "abc123...",
  "span.id": "def456...",
  "langsmith.run_id": "run-789...",
  "langsmith.trace_id": "trace-012...",
  "langsmith.project": "kafka-mcp-server",
  "duration": 42
}
```

ECS formatting is provided by `@elastic/ecs-pino-format` with the following options:

- `apmIntegration: false` -- OTEL is used instead of Elastic APM
- `convertErr: true` -- Error objects are serialized with stack traces
- `convertReqRes: true` -- HTTP request/response objects are serialized

### Pino-Pretty (Development)

In development (`NODE_ENV` is not `production` or `staging`), logs are formatted as colorized human-readable output to stderr:

```
10:30:00 AM info: Tool completed: kafka_list_topics {"duration":42}
10:30:01 AM debug: Operation started: describeTopic {"operation":"describeTopic"}
10:30:01 AM error: Tool failed: kafka_describe_topic {"error":"Connection refused"}
```

The `formatLogLine` function strips ECS metadata fields and formats the remaining context as inline JSON. Color codes are applied per level: green for info, cyan for debug, yellow for warn, red for error.

### Sensitive Data Redaction

The logger automatically redacts sensitive fields at both top-level and nested positions. Redacted fields are replaced with `[REDACTED]`.

**Redacted field names:**

```
token, password, secret, apiKey, api_key, authorization,
credential, accessToken, access_token
```

This applies to any nesting depth -- both `{ password: "..." }` and `{ config: { password: "..." } }` are redacted.

---

## OpenTelemetry Tracing

### Trace Initialization

Telemetry is initialized through the shared package's `initTelemetry` function, which configures the OpenTelemetry Node SDK with span, metric, and log exporters.

```typescript
import { buildTelemetryConfig, initTelemetry } from "@devops-agent/shared";

const config = buildTelemetryConfig("mcp-server-kafka");
const sdk = initTelemetry(config);
```

Or through the `observability` package wrapper:

```typescript
import { initOtel, shutdownOtel } from "@devops-agent/observability";

initOtel("mcp-server-kafka");
// ... on shutdown:
await shutdownOtel();
```

**Configuration via environment variables:**

| Variable | Purpose | Default |
|----------|---------|---------|
| `TELEMETRY_MODE` | Export mode: `console`, `otlp`, or `both` | (disabled if unset) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint URL | `http://localhost:4318` |

The `TelemetryConfig` object:

```typescript
interface TelemetryConfig {
  enabled: boolean;       // true when TELEMETRY_MODE is set
  serviceName: string;    // e.g., "mcp-server-kafka"
  mode: "console" | "otlp" | "both";
  otlpEndpoint: string;
}
```

**Export modes:**

- `console` -- routes spans, metrics, and logs through Pino (custom `PinoSpanExporter`, `PinoMetricExporter`, `PinoLogRecordExporter`) to stderr
- `otlp` -- sends to an OTLP-compatible collector via HTTP (`/v1/traces`, `/v1/metrics`, `/v1/logs`)
- `both` -- dual export to both console and OTLP

### Span Creation

The `traceSpan` utility wraps async operations in OTel spans with automatic status codes and error recording:

```typescript
import { traceSpan } from "@devops-agent/shared";

const result = await traceSpan(
  "mcp-server-kafka",        // tracer name
  "listTopics",              // span name
  async (span) => {
    span.setAttribute("topic.filter", filter);
    return await service.admin.listTopics();
  },
  { "custom.attr": "value" } // optional attributes
);
```

The span automatically:

- Sets `SpanStatusCode.OK` on success
- Sets `SpanStatusCode.ERROR` with message on failure
- Records the exception via `span.recordException`
- Calls `span.end()` in the `finally` block

### Cross-Service Trace Propagation

W3C Traceparent headers connect MCP server spans to the calling agent's trace. The `withExtractedContext` function extracts trace context from incoming HTTP headers:

```typescript
import { withExtractedContext } from "@devops-agent/shared";

// In MCP HTTP transport handler
withExtractedContext(request.headers, () => {
  // Code here runs within the extracted trace context
  // New spans become children of the caller's span
  return handleMcpRequest(request);
});
```

The `withTraceContextMiddleware` wraps a full request handler:

```typescript
import { withTraceContextMiddleware } from "@devops-agent/shared";

const handler = withTraceContextMiddleware(async (req) => {
  // Trace context automatically extracted from req.headers
  return new Response("OK");
});
```

When no `traceparent` header is present (e.g., requests from Claude Desktop via stdio), the function runs in the current context unchanged.

---

## LangSmith Integration

### Agent Trace Capture

LangSmith tracing is initialized via `initializeTracing` from the shared tracing module:

```typescript
import { initializeTracing, isTracingActive } from "@devops-agent/shared";

initializeTracing({
  apiKey: process.env.LANGSMITH_API_KEY,
  project: "kafka-mcp-server",
  endpoint: "https://api.smith.langchain.com",
});
```

**Enable flags** (either one activates tracing):

- `LANGSMITH_TRACING=true`
- `LANGCHAIN_TRACING_V2=true`

**Required for activation:**

- One of the enable flags above
- `LANGSMITH_API_KEY` or `LANGCHAIN_API_KEY`

Initialization is idempotent -- calling it multiple times uses the first configuration.

### Per-Server Projects

Each MCP server traces to its own LangSmith project for isolation:

| Server | Environment Variable | Project Name |
|--------|---------------------|-------------|
| Elasticsearch | `ELASTIC_LANGSMITH_PROJECT` | `elastic-mcp-server` |
| Kafka | `LANGSMITH_PROJECT` | `kafka-mcp-server` |
| Couchbase | `CB_LANGSMITH_PROJECT` | `couchbase-mcp-server` |
| Konnect | `KONNECT_LANGSMITH_PROJECT` | `konnect-mcp-server` |
| Agent | `LANGSMITH_PROJECT` | `devops-agent` |

### Agent Eval Experiments

The on-demand `bun run eval:agent` pipeline (`packages/agent/src/eval/`) runs the full 32-node graph against the `devops-incident-eval` LangSmith dataset and writes its results as a LangSmith experiment named `incident-analyzer-eval-<git-sha>`. Each query produces four evaluator scores -- `datasources_covered`, `datasources_precision` (SIO-1694) and `confidence_threshold` (deterministic) plus `response_quality` (gpt-4o-mini judge) -- visible in the dataset's "Experiments" tab.

The git-sha-tagged experiment prefix lets you compare runs across commits: filter the experiment list by prefix pattern to see whether a description tweak or graph change moved any score. Per-example breakdowns include the full agent trace, so node-level drift is debuggable from the same UI.

See [docs/development/testing.md](../development/testing.md#evals--quality-harness) for the run procedure and `packages/agent/src/eval/README.md` for the canonical reference.

### Compliance Metadata

The `traceToolCall` function tags every tool invocation with structured metadata:

```typescript
metadata: {
  tool_name: "kafka_list_topics",
  data_source_id: "kafka",
  session_id: "claude-desktop-1712234567-abc123",
  connection_id: "conn-xyz",
  client_name: "Claude Desktop",
}
tags: [
  "mcp-tool",
  "tool:kafka_list_topics",
  "datasource:kafka",
  "client:claude-desktop",
  "transport:stdio",
]
```

### Feedback Collection

The `FeedbackBar` component in the frontend sends thumbs up/down feedback. When a user clicks a feedback button, `agentStore.setFeedback(index, score)` posts `{ runId, score, threadId, agentName }` to `POST /api/agent/feedback` (`apps/web/src/routes/api/agent/feedback/+server.ts`). The route does two independent things with it.

**1. LangSmith feedback, against the run LangSmith actually created (SIO-1835).** The `runId` is the trace root's id, learned from the stream: the SSE pump (`apps/web/src/lib/server/sse-pump.ts`) takes the `run_id` of the first stream event and sends it to the browser as a `run_id` event. The app cannot choose that id (a `configurable.run_id` never reaches the tracer), and feedback filed against an invented one resolved to no run at all. The route also checks LangSmith's response now: a rejected score logs `LangSmith rejected user feedback` and returns HTTP 502 instead of reporting success.

**2. A learning signal, against the thread's candidates (SIO-1890).** When the body carries `threadId` and `agentName` and the score is exactly 0 or 1, the verdict is recorded as `task_success` on every learning candidate that thread produced. It runs before, and independently of, the LangSmith write:

- It is bound to a known thread first: the checkpointer must hold an assistant turn for that agent on that thread, otherwise the verdict is ignored and logged as `learning feedback ignored: unknown thread`.
- Thumbs-up confirms `task_success`; thumbs-down rejects the candidate. A changed vote can reopen a candidate that an earlier thumbs-down rejected; a rejection made in the review pane stands.
- The write is bounded by `LEARNING_FEEDBACK_DEADLINE_MS` (default 5000) and is best-effort: a slow or failing memory backend logs `learning feedback failed; LangSmith feedback continues` and never fails the request.
- Success logs `learning feedback` with `transitions`, and writes a `learning-feedback` row to the decision metrics below.

See [Agent Memory](../architecture/agent-memory.md#human-feedback-on-candidates-sio-1890) for what a candidate is and what the verdict unlocks.

---

## Agent Pipeline Tracing

### Node-Level Spans

Each node in the LangGraph pipeline (classify, entityExtractor, supervise, align, aggregate, validate) creates an OTel span. The span hierarchy mirrors the graph execution:

```
agent.run (root span)
  |
  +-- classify (SpanKind.INTERNAL)
  |
  +-- entityExtractor
  |
  +-- supervise
  |     |
  |     +-- mcp.tool.kafka_list_topics (SpanKind.SERVER)
  |     +-- mcp.tool.elasticsearch_search_logs (SpanKind.SERVER)
  |
  +-- align
  +-- aggregate
  +-- validate
```

### Request ID Correlation

Every user request generates a unique `requestId` stored in `AgentState`. This ID propagates through all sub-agent calls and MCP tool invocations, enabling end-to-end request tracing:

```
User request (requestId: "req-abc123")
  -> classify node
  -> entityExtractor node
  -> supervisor fans out to:
       elastic-agent (requestId: "req-abc123")
       kafka-agent   (requestId: "req-abc123")
  -> align, aggregate, validate
```

### Tool Call Tracking

The `traceToolCall` function in `shared/src/tracing/tool-trace.ts` wraps every MCP tool invocation with both OTel and LangSmith tracing:

```typescript
traceToolCall("kafka_list_topics", handler, {
  dataSourceId: "kafka",
  toolArgs: { filter: "order-*" },
});
```

This creates:

- An OTel span named `mcp.tool.kafka_list_topics` with `SpanKind.SERVER`
- A LangSmith run of type `tool` with execution timing and session metadata
- Attributes: `mcp.tool.name`, `mcp.tool.timestamp`, `mcp.data_source_id`

### Connection Tracing

The `traceConnection` function wraps MCP connection lifecycle events:

```typescript
traceConnection(
  { connectionId, transportMode: "http", clientInfo, sessionId },
  handler,
  { dataSourceId: "kafka" },
);
```

Connection spans are named with the client and transport: `mcp.connection.Claude Desktop (STDIO) [abc123]`.

---

## Decision and Usage Signals

Signals added after the three core systems above. None of them needs a collector: two are structured log lines, one is a local SQLite table.

### Decision Metrics (SIO-1858)

Every model-assisted decision seam writes one row per decision to a `decision_metrics` SQLite table (`packages/shared/src/decision-metrics.ts`, written through `recordDecision()` in `packages/agent/src/decision-recorder.ts`). It is a separate table from the tool-call counters on purpose: those are lifetime upsert counters per tool, which cannot answer "before vs after" for a window and cannot see a call that is not an MCP tool.

- **Enable:** set `DECISION_METRICS_DB_PATH`. Unset (the default) makes every write a no-op, and it is ignored when `NODE_ENV=test` so a test run cannot write into a developer's real database.
- **Never breaks a request:** writes are fire-and-forget and every failure (open or write) is swallowed after a warning; a metrics problem can cost a row, never a turn.
- **Columns:** `at`, `seam`, `outcome` (`applied`, `skipped`, `failed`), `request_id`, `model`, `latency_ms`, `input_tokens`, `items_in`, `items_dropped`, `top_score`, `bottom_score`, `rank_correlation`, `note`. `note` is a short enum-like string, never upstream error text.
- **Seams recording today:** `atlassian-rerank`, `action-selector`, `learning-gate`, `learning-feedback`, `learning-review`. `seam` is free text, so a new seam needs no schema change.

```bash
sqlite3 "$DECISION_METRICS_DB_PATH" "select seam, outcome, count(*) from decision_metrics group by 1, 2"
```

The applied/failed ratio per seam is the safety property each of those features promises, which is why it is a column and not a log line.

### Token and Cache Usage (SIO-1226, SIO-1697)

Every model instance logs `LLM token usage` after each call (`logTokenUsage()` in `packages/agent/src/llm.ts`) with `role`, `model`, `inputTokens`, `outputTokens`, `totalTokens`, `cacheReadTokens` and `cacheWriteTokens`. The callback sits on the model instance, so streaming calls and the sub-agent ReAct loop are covered too.

The two cache counters are read from `usage_metadata.input_token_details` (`cache_read`, `cache_creation`), which is where `@langchain/aws` puts Bedrock's counters on both the streaming and the non-streaming path; the raw Converse `usage` block is only a fallback because it exists on the non-streaming path alone. `inputTokens` already includes the cached tokens. Reading them: a `cacheReadTokens` of zero across consecutive calls of the same role means something volatile sits inside the cached prefix. For a sub-agent, a read count that stays flat at the system-prompt size while `inputTokens` climbs means the rolling history cache points are not landing (see [Sub-Agent Context Assembly](../architecture/sub-agent-context-assembly.md#in-loop-context-controls)).

### Loop-Guard Stops (SIO-1791)

`subagent.loop_guard_stop` (info) is logged each time the loop guard refuses a tool call:

| Field | Meaning |
|---|---|
| `dataSourceId`, `deploymentId`, `toolName`, `iteration` | Which sub-agent run and which call was refused |
| `unproductiveSearches` | The `elasticsearch_search` counter only; 0 on every generic stop |
| `unproductiveForTool` | Unproductive results for the stopped tool (per-tool cap 3) |
| `totalUnproductive` | Unproductive results across the run (run-wide backstop 8) |
| `reason` | `duplicate-call`, `unproductive-streak`, `run-backstop` or `aws_service_absent` |

Related events: `subagent.final_turn_forced` (three fully refused rounds, SIO-1779), `subagent.final_turn_reserved` (recursion limit near), `subagent.aws_service_absent_early_exit` and `subagent.aws_absence_not_proven` (with `blockedBy`).

### Tool-Budget Truncation (SIO-1767)

`tool budget truncated the bound set` (info) is logged only when the 25-tool budget actually drops a tool, with `dataSourceId`, `max`, `minAction`, `requested`, `bound`, `droppedHead`, `droppedTail` and `droppedNames` (capped at 30 names, flagged by `droppedNamesTruncated`; the counts stay exact). Absence of the line means nothing was cut. Do not infer truncation from `filtered: true` on `Creating ReAct agent with tools`: that flag is true whenever the server exposes more than 25 tools. See [Action Tool Maps](../development/action-tool-maps.md#order-of-the-cut).

### Fleet Path (SIO-1660)

Every pi-coms hub call goes through one instrumented seam in `packages/agent/src/action-tools/pi-coms-client.ts`: `pi.hub.call` (info; heartbeats at debug), `pi.hub.call.failed` (warn, with the HTTP status and the hub's error code) and `pi.hub.call.unreachable` (warn, a transport failure with no response), each with `duration_ms`. Lifecycle events: `pi.hub.registered`, `pi.hub.message.sent`, `pi.hub.await.done` and `pi.hub.await.exhausted` (a spoke that never answered, as distinct from a silent success). The web fleet pane (`apps/web/src/lib/server/pi-fleet.ts`) adds `pi.fleet.agents.listed`/`.failed`, `pi.fleet.send.start`/`.register_failed`/`.done` and `pi.fleet.mailbox.read`. No log call carries the hub token, a request or response body, a prompt or spoke reply text.

### Landing Zone Agent (SIO-1875)

Each completed Landing Zone turn logs `agent.landing-zone.turn` with categorical telemetry only (`intent`, repository names, per-source `evidenceAvailability`, `riskTier`, `outcome`, `memoryUsed`, `knowledgeGraphUsed`, `responseTime`), projected by `projectLandingZoneTurnTelemetry()` in `packages/agent/src/landing-zone/telemetry.ts`. Prompts, evidence text, account scope and generated content are deliberately kept out of it and out of LangSmith trace metadata. Details: [Landing Zone Terraform Agent](../architecture/landing-zone-terraform-agent.md) and the [Landing Zone agent runbook](../operations/landing-zone-agent-runbook.md).

---

## Monitoring Endpoints

### Health Checks

Each MCP server in HTTP transport mode exposes health endpoints. AgentCore mode has its own framework health surface (see `packages/shared/src/transport/agentcore.ts`) and does not need these.

| Endpoint | Response | Purpose | k8s probe |
|----------|----------|---------|-----------|
| `/health` | `{ status: "ok" }` | Process is alive | `livenessProbe` |
| `/ready` | `{ ready, components, errors?, cachedAt }` (200 or 503) | Enabled upstreams are reachable | `readinessProbe` |
| `/ping` | `pong` | Lightweight liveness probe (AgentCore transport only) | n/a |

`/ready` (kafka MCP) probes the kafka broker via `clientManager.withAdmin(a => a.metadata({}))` plus any enabled HTTP-backed Confluent services (REST Proxy, Schema Registry, Kafka Connect, ksqlDB) via each service's `probeReachability()`. Results are cached for 30 seconds with a thundering-herd guard, so k8s/AgentCore liveness loops don't fan out to upstreams on every request. Components configured but disabled (e.g. `KSQL_ENABLED=false`) appear as `"disabled"` in the response and do not fail the probe.

When any enabled component is unreachable, `/ready` returns HTTP 503 with the component map and a per-component error message; otherwise it returns 200. `/ready` returns HTTP 404 when no readiness probe is wired (stdio mode).

### MCP Server Health Polling

The frontend `agentStore` polls server health every 15 seconds (`HEALTH_POLL_INTERVAL_MS = 15_000`) to maintain the `connectedDataSources` list. Disconnected servers appear as disabled (strikethrough, red border) in the `DataSourceSelector` component.

The agent pipeline also checks MCP server connectivity before fanning out to sub-agents. If a server is unreachable, its datasource is skipped and the result is logged.

---

## Cross-References

- [Environment Variables](../configuration/environment-variables.md) -- telemetry and tracing config
- [System Overview](../architecture/system-overview.md) -- how observability fits in the architecture
- [Troubleshooting](./troubleshooting.md) -- debugging with structured logs and traces

---

## Changelog

| Date | Change |
|------|--------|
| 2026-04-04 | Initial version |
| 2026-09-30 | SIO-1897 docs sync (SIO-1635..1896 window): Feedback Collection rewritten (feedback filed against the real LangSmith run, SIO-1835; thumbs recorded as `task_success` on the thread's learning candidates, SIO-1890); new "Decision and Usage Signals" section covering decision metrics (SIO-1858), Bedrock cache counters (SIO-1697), the `loop_guard_stop` fields (SIO-1791), the tool-budget truncation log (SIO-1767), fleet path events (SIO-1660) and Landing Zone turn telemetry (SIO-1875); eval experiment name and evaluator count corrected (SIO-1694) |
