# Observability

> **Targets:** Bun 1.3.9+ | OpenTelemetry | LangSmith | Pino
> **Last updated:** 2026-04-04

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

The `FeedbackBar` component in the frontend sends thumbs up/down feedback. When a user clicks a feedback button, the `agentStore.setFeedback(index, score)` method sends the feedback with the associated `runId` to LangSmith. This allows evaluating agent response quality over time.

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

## Monitoring Endpoints

### Health Checks

Each MCP server exposes HTTP health endpoints:

| Endpoint | Response | Purpose |
|----------|----------|---------|
| `/health` | `{ status: "ok", server: "...", timestamp: "..." }` | Full health check |
| `/ping` | `pong` | Lightweight liveness probe |

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
