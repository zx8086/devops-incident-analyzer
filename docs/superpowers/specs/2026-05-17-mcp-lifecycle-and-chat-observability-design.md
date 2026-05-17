# MCP Lifecycle Unification + Chat Observability Wiring

**Date:** 2026-05-17
**Status:** Spec — pending user review
**Linear:** [SIO-779](https://linear.app/siobytes/issue/SIO-779/mcp-lifecycle-unification-chat-observability-wiring)

## TL;DR

Two related gaps in the current observability stack:

1. **Lifecycle divergence.** All 7 MCP servers route through `createMcpApplication` in `packages/shared/src/bootstrap.ts` — except the AWS and Kafka MCP servers, which fork into a bespoke 20-line branch when running in AgentCore SigV4-proxy mode. That branch skips `initTracing`, OTEL `initTelemetry`, the `uncaughtException`/`unhandledRejection` handlers, and the structured shutdown sequence (only `proxy.close()` → `process.exit(0)`).

2. **Chat session not bracketed in logs.** The SvelteKit `/api/agent/stream` endpoint wraps each request in an OTEL `traceSpan("agent.request", …)` and stamps LangSmith metadata with `session_id`/`run_id`, but emits **zero Pino log lines** at request start or end. Downstream node logs (`responder`, `classify`, etc.) don't carry `threadId`/`runId`/`requestId`. Result: if LangSmith is unavailable, there is no way to grep "all tool calls for chat #7" in Pino logs.

This spec proposes one Linear ticket / one PR with five changes that converge on a single correlation envelope `{ threadId, runId, requestId }` propagated through `AsyncLocalStorage` so Pino, OTEL, and LangSmith all stamp the same IDs. The AgentCore proxy branch collapses into a `mode: "proxy"` option on `createMcpApplication`, gaining all the standard bootstrap signals (telemetry, signal handlers, structured shutdown) plus an OTEL span around `proxy.connect` / `proxy.close`.

## Context — how this came to be

- The unified MCP bootstrap was introduced earlier in Epic 5 (`createMcpApplication` in `packages/shared/src/bootstrap.ts`). All 7 MCP server entry points (`elastic`, `kafka`, `couchbase`, `konnect`, `gitlab`, `atlassian`, `aws`) call it.
- SigV4 proxy mode for AWS was added in SIO-758 / SIO-759 (AWS datasource design, AgentCore deployment phase). Kafka's proxy mode predates that. Both copied the same minimal pattern — start proxy, install `SIGINT`/`SIGTERM`, exit — rather than threading the proxy lifecycle through `createMcpApplication`.
- The chat endpoint at `apps/web/src/routes/api/agent/stream/+server.ts` was last touched for SIO-751 (topic-shift interrupt resume). It carries OTEL + LangSmith correlation but no Pino lifecycle records.
- Memory slug `reference_sio774_per_server_connect_timeouts` shows we already invested in proxy connection observability (35s timeouts for kafka-mcp + aws-mcp to outlast AgentCore's 30s retry deadline). The proxy bootstrap should now match the same fidelity bar.

## Where the bodies are buried

### Lifecycle divergence

`packages/shared/src/bootstrap.ts:52-161` — the canonical 8-step bootstrap (tracing → telemetry → datasource → server factory → transport → re-entrant shutdown → process handlers → onStarted).

`packages/mcp-server-aws/src/index.ts:17-37` — the bespoke proxy branch. Notable omissions vs `createMcpApplication`:

```ts
if (process.env.AWS_AGENTCORE_RUNTIME_ARN) {
  // (no initTracing call -- LangSmith env vars not set)
  // (no initTelemetry call -- OTEL never initialized)
  const proxy = await startAgentCoreProxy(config);
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    await proxy.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  // (no uncaughtException handler)
  // (no unhandledRejection handler)
  // (no shutdownTelemetry call -- there's nothing to shut down)
  // (no logger.flush)
}
```

`packages/mcp-server-kafka/src/index.ts:77-96` — identical pattern with `KAFKA_` prefix and the same omissions.

### Chat session not bracketed

`apps/web/src/routes/api/agent/stream/+server.ts:28-144` — POST handler. The full body of the SSE producer is wrapped in `traceSpan("agent", "agent.request", …)` at line 56 with attributes `{ "request.id": requestId, "thread.id": threadId }`, but no `logger.info("agent.request.start")` / `.end` Pino calls exist. The `done` SSE event at line 114 carries `responseTime` + `toolsUsed` to the client but doesn't log them server-side.

`apps/web/src/lib/server/agent.ts:69-129` — `invokeAgent`. Calls `graph.streamEvents` with `metadata: { request_id, session_id }` and `configurable: { thread_id, run_id }`, but does not pass a `runName` or `tags` to the root LangSmith run. As a result the run is named `LangGraph` (default) and only filterable by `session_id` field, not by `chat` / `thread:<id>` tags.

`packages/observability/src/logger.ts:1-13` — `getLogger(service)` returns `baseLogger.child({ service })`. No request-context awareness. Downstream node logs (e.g. `packages/agent/src/responder.ts:28` `logger.info("Simple query responder invoked")`) emit without correlation IDs.

`packages/shared/src/tracing/session.ts:1-50` — `SessionContext` AsyncLocalStorage scaffolding exists for MCP transport sessions (used by `tool-trace.ts`). The chat path needs a parallel-but-separate context.

## The fix (step by step)

### Step 1: Add `RequestContext` AsyncLocalStorage in shared

`packages/shared/src/logger.ts` already owns the pino mixin that injects OTEL `trace.id`, LangSmith `run_id`/`trace_id`, and retention expiry fields (lines 63-97). The chat correlation envelope must live in the **same package** so the existing mixin can read it (`@devops-agent/observability` already depends on `@devops-agent/shared`, not the other way around).

New file `packages/shared/src/request-context.ts`:

```ts
// packages/shared/src/request-context.ts
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  threadId: string;
  runId: string;
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return storage.run(ctx, fn);
}

export function getCurrentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
```

Export from `packages/shared/src/index.ts`. Also re-export from `packages/observability/src/index.ts` so existing consumers can import either way.

### Step 2: Extend the existing mixin to include correlation IDs

Modify `packages/shared/src/logger.ts:63-97` — inside the existing `mixin()`, add three lines that pull `RequestContext` if present:

```ts
mixin() {
  const fields: Record<string, string> = {};

  // (existing) retention expiry
  if (retentionPeriod) { /* ... */ }

  // (existing) OTEL trace context
  const span = trace.getActiveSpan();
  if (span) { /* ... */ }

  // (existing) LangSmith context
  try { /* ... */ } catch { /* ... */ }

  // NEW: chat request correlation
  const ctx = getCurrentRequestContext();
  if (ctx) {
    fields.threadId = ctx.threadId;
    fields.runId = ctx.runId;
    fields.requestId = ctx.requestId;
  }

  return fields;
},
```

Top-level `const logger = createMcpLogger(...)` call sites need zero changes — the mixin evaluates on every log call and picks up `RequestContext` whenever the call site is inside `runWithRequestContext`. Outside the context, the three fields are omitted entirely (no empty-string pollution).

`packages/observability/src/logger.ts` does NOT need modification — it already delegates to `createMcpLogger`. The new fields flow through unchanged.

### Step 3: Add `mode: "proxy"` to `createMcpApplication`

Modify `packages/shared/src/bootstrap.ts`:

```ts
export interface McpApplicationOptions<T> {
  name: string;
  logger: BootstrapLogger;
  initTracing: () => void;
  telemetry: TelemetryConfig;
  initDatasource: () => Promise<T>;
  mode?: "server" | "proxy";                                       // NEW, default "server"
  createServerFactory?: (datasource: T) => () => McpServer;        // optional iff mode = "proxy"
  createTransport: (
    serverFactory: (() => McpServer) | undefined,
    datasource: T,
  ) => Promise<BootstrapTransportResult>;                          // serverFactory may be undefined in proxy mode
  cleanupDatasource?: (datasource: T) => Promise<void>;
  onStarted?: (datasource: T) => void;
  readOnly?: ReadOnlyMiddlewareConfig;
}
```

Inside `createMcpApplication`, after `initDatasource`:

```ts
if (options.mode !== "proxy" && !options.createServerFactory) {
  throw new Error("createServerFactory is required when mode != 'proxy'");
}

const innerFactory = options.mode === "proxy" ? undefined : options.createServerFactory!(datasource);
const readOnlyConfig = options.readOnly;
const serverFactory: (() => McpServer) | undefined =
  innerFactory && readOnlyConfig
    ? () => {
        const server = innerFactory();
        installReadOnlyChokepoint(server, readOnlyConfig.manager);
        return server;
      }
    : innerFactory;

const transport = await options.createTransport(serverFactory, datasource);
```

All remaining steps (re-entrant shutdown, SIGINT/SIGTERM/uncaughtException/unhandledRejection, onStarted, telemetry shutdown, logger.flush) execute identically in both modes.

### Step 4: Add `createAgentCoreProxyTransport` shared helper

New file `packages/shared/src/transport/agentcore-proxy.ts`:

```ts
// packages/shared/src/transport/agentcore-proxy.ts
import { startAgentCoreProxy, loadProxyConfigFromEnv } from "../agentcore-proxy.ts";
import { traceSpan } from "../telemetry/telemetry.ts";
import type { BootstrapLogger, BootstrapTransportResult } from "../bootstrap.ts";

export async function createAgentCoreProxyTransport(
  prefix: "AWS" | "KAFKA",
  logger: BootstrapLogger,
): Promise<BootstrapTransportResult> {
  const config = loadProxyConfigFromEnv(prefix);
  const proxy = await traceSpan(
    "agentcore-proxy",
    "proxy.connect",
    async () => startAgentCoreProxy(config),
    { "proxy.prefix": prefix, "proxy.runtimeArn": config.runtimeArn },
  );
  logger.info("AgentCore proxy ready", { prefix, port: proxy.port, url: proxy.url });
  return {
    closeAll: async () => {
      await traceSpan(
        "agentcore-proxy",
        "proxy.close",
        async () => proxy.close(),
        { "proxy.prefix": prefix },
      );
      logger.info("AgentCore proxy closed", { prefix });
    },
  };
}
```

Re-export from `packages/shared/src/transport/index.ts`.

### Step 5: Collapse AWS + Kafka proxy branches

`packages/mcp-server-aws/src/index.ts` becomes:

```ts
if (import.meta.main) {
  if (process.env.AWS_AGENTCORE_RUNTIME_ARN) {
    createMcpApplication<{ config: ProxyConfig }>({
      name: "aws-mcp-server",
      logger: createBootstrapAdapter(logger),
      initTracing: () => initializeTracing(),
      telemetry: buildTelemetryConfig("aws-mcp-server"),
      mode: "proxy",
      initDatasource: async () => ({ config: loadProxyConfigFromEnv("AWS") }),
      createTransport: async () => createAgentCoreProxyTransport("AWS", createBootstrapAdapter(logger)),
      onStarted: (ds) => {
        logger.info({ arn: ds.config.runtimeArn, transport: "agentcore-proxy" }, "AWS MCP server ready");
      },
    });
  } else {
    // existing server-mode createMcpApplication call -- unchanged
  }
}
```

Same shape for `packages/mcp-server-kafka/src/index.ts` with `KAFKA_AGENTCORE_RUNTIME_ARN` and `loadProxyConfigFromEnv("KAFKA")`.

### Step 6: Bracket chat requests with `runWithRequestContext` + Pino lifecycle logs

Modify `apps/web/src/routes/api/agent/stream/+server.ts`:

```ts
import { getLogger } from "@devops-agent/observability";
import { runWithRequestContext } from "@devops-agent/observability";

const log = getLogger("api.agent.stream");

// inside POST handler, after threadId/runId/requestId are minted:
await runWithRequestContext({ threadId, runId, requestId }, async () => {
  log.info("agent.request.start");

  await traceSpan("agent", "agent.request", async () => {
    const startTime = Date.now();
    send({ type: "run_id", runId });
    // ... existing logic ...
    try {
      const eventStream = await invokeAgent(body.messages, {
        threadId, runId, /* existing fields */
        runName: "agent.request",
        tags: buildLangSmithTags({ threadId, dataSources: body.dataSources, isFollowUp: body.isFollowUp }),
        metadata: { request_id: requestId, session_id: threadId },
      });
      const { toolsUsed } = await pumpEventStream(eventStream, send);
      // ... rest unchanged ...
      const responseTime = Date.now() - startTime;
      log.info({ responseTime, toolsUsed: toolsUsed.length, toolNames: toolsUsed }, "agent.request.end");
      send({ type: "done", /* existing fields */ responseTime, toolsUsed, dataSourceContext });
    } catch (err) {
      log.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : err }, "agent.request.error");
      throw err;
    }
  }, { "request.id": requestId, "thread.id": threadId, "run.id": runId });
});
```

Add `buildLangSmithTags` helper in the same file or a small `apps/web/src/lib/server/langsmith-tags.ts`:

```ts
export function buildLangSmithTags(opts: {
  threadId: string;
  dataSources?: string[];
  isFollowUp?: boolean;
}): string[] {
  const tags = ["chat", `thread:${opts.threadId}`];
  tags.push(opts.dataSources?.length ? `datasources:${[...opts.dataSources].sort().join(",")}` : "datasources:auto");
  if (opts.isFollowUp) tags.push("follow-up");
  return tags;
}
```

### Step 7: Forward `runName` + `tags` through `invokeAgent` to LangSmith

Modify `apps/web/src/lib/server/agent.ts:69-129` — accept `runName?: string` and `tags?: string[]` in `invokeAgent` options, pass to `graph.streamEvents`:

```ts
return graph.streamEvents(
  { /* state */ },
  {
    configurable: { thread_id: options.threadId, ...(options.runId && { run_id: options.runId }) },
    version: "v2",
    recursionLimit: getGraphRecursionLimit(),
    signal: AbortSignal.timeout(getGraphTimeoutMs()),
    runName: options.runName,
    tags: options.tags,
    metadata: { ...complianceToMetadata(getAgent().manifest.compliance), ...options.metadata },
  },
);
```

LangGraph forwards `runName` and `tags` to the LangSmith parent run.

### Step 8: Apply the same wrapping to the resume endpoint

`apps/web/src/routes/api/agent/topic-shift/+server.ts` must also wrap in `runWithRequestContext` with the **same** `threadId` from the body, a fresh `runId`, and a fresh `requestId`. Log lines: `agent.request.resume.start` / `.resume.end`. LangSmith tags include `"resumed"` (in addition to the existing chat tags).

## Files to modify

| File | Change |
|---|---|
| `packages/shared/src/request-context.ts` | NEW — `RequestContext`, `runWithRequestContext`, `getCurrentRequestContext` |
| `packages/shared/src/logger.ts` | Extend existing mixin (lines 63-97) to inject `threadId`/`runId`/`requestId` |
| `packages/shared/src/index.ts` | Export `runWithRequestContext`, `getCurrentRequestContext`, `RequestContext` |
| `packages/observability/src/index.ts` | Re-export the same three symbols for ergonomic imports |
| `packages/shared/src/bootstrap.ts` | Add `mode?: "server" \| "proxy"`, validate, skip `createServerFactory` in proxy mode |
| `packages/shared/src/transport/agentcore-proxy.ts` | NEW — `createAgentCoreProxyTransport(prefix, logger)` with OTEL spans |
| `packages/shared/src/transport/index.ts` | Re-export |
| `packages/mcp-server-aws/src/index.ts` | Collapse 20-line proxy branch to `mode: "proxy"` call |
| `packages/mcp-server-kafka/src/index.ts` | Same |
| `apps/web/src/lib/server/agent.ts` | Accept and forward `runName` + `tags` |
| `apps/web/src/lib/server/langsmith-tags.ts` | NEW — `buildLangSmithTags` |
| `apps/web/src/routes/api/agent/stream/+server.ts` | `runWithRequestContext` wrap, Pino start/end/error logs, pass `runName` + `tags` |
| `apps/web/src/routes/api/agent/topic-shift/+server.ts` | Same wrapping pattern with `resumed` tag |

| Test file | Type |
|---|---|
| `packages/shared/src/__tests__/request-context.test.ts` | NEW |
| `packages/shared/src/__tests__/bootstrap.test.ts` | MODIFY — add proxy-mode cases |
| `packages/shared/src/transport/__tests__/agentcore-proxy.test.ts` | NEW |
| `apps/web/src/routes/api/agent/stream/server.test.ts` | MODIFY — assert lifecycle logs + tags |
| `apps/web/src/routes/api/agent/topic-shift/+server.test.ts` | MODIFY/NEW — resume lifecycle logs |

## Testing strategy

### `packages/shared/src/__tests__/request-context.test.ts` (NEW)

1. `getCurrentRequestContext()` returns `undefined` outside `runWithRequestContext`.
2. Inside `runWithRequestContext({ threadId, runId, requestId }, ...)`, `getCurrentRequestContext()` returns the same object.
3. Context survives `await Promise.resolve()` inside the callback.
4. Nested `runWithRequestContext` shadows the outer one (inner sees its own ctx).
5. A pino logger created via `createMcpLogger` emits `threadId`/`runId`/`requestId` on log records inside the run, and omits them outside. Assert via a pino destination stream.

### `packages/shared/src/__tests__/bootstrap.test.ts` (MODIFY)

1. `mode: "proxy"` + missing `createServerFactory` → does NOT throw.
2. `mode: "server"` (default) + missing `createServerFactory` → throws `"createServerFactory is required when mode != 'proxy'"`.
3. `mode: "proxy"`: `initTracing`, `initTelemetry`, `initDatasource`, `createTransport` all called; `createServerFactory` NOT called; SIGINT/SIGTERM/uncaughtException/unhandledRejection handlers registered.
4. `mode: "proxy"` shutdown sequence: `transport.closeAll` → `cleanupDatasource` (skipped when undefined) → `shutdownTelemetry` → `process.exit(0)`.

### `packages/shared/src/transport/__tests__/agentcore-proxy.test.ts` (NEW)

1. `createAgentCoreProxyTransport("AWS", logger)` calls `loadProxyConfigFromEnv("AWS")` and `startAgentCoreProxy(config)`.
2. OTEL span `proxy.connect` is created with attribute `proxy.prefix: "AWS"` and ends OK on success.
3. On `closeAll()`, OTEL span `proxy.close` is created and ends OK after `proxy.close()` resolves.
4. If `startAgentCoreProxy` rejects, `proxy.connect` span is marked ERROR and the error propagates.
5. Logger.info called with `prefix`, `port`, `url` on ready, and `prefix` on close.

### `apps/web/src/routes/api/agent/stream/server.test.ts` (MODIFY)

1. POST `/api/agent/stream` emits `agent.request.start` Pino record with `threadId`, `runId`, `requestId` fields.
2. After SSE `done` event, `agent.request.end` record fires with `responseTime`, `toolsUsed`, same correlation IDs.
3. On thrown error inside `invokeAgent`, `agent.request.error` record fires with `err` field, same correlation IDs. SSE `error` event still sent.
4. `invokeAgent` called with `runName: "agent.request"` and `tags` containing `"chat"` and `"thread:<threadId>"`. With `dataSources: ["elastic"]`, tags include `"datasources:elastic"`. With `isFollowUp: true`, tags include `"follow-up"`.
5. AsyncLocalStorage propagation: a log emitted from a stub `invokeAgent` carries the same correlation IDs.

### `apps/web/src/routes/api/agent/topic-shift/+server.test.ts` (MODIFY or NEW)

1. Resume request emits `agent.request.resume.start` and `.resume.end` with the threadId from the request body, a fresh `runId`, fresh `requestId`. Tags include `"resumed"`.

### Regression coverage

Existing tests for `mcp-server-aws` and `mcp-server-kafka` server-mode boot must continue to pass post-change. The proxy-mode branch is now covered in shared/transport tests — no need to duplicate per-server.

## Verification

```bash
bun install
bun run typecheck
bun run lint
bun run test

# Targeted suites
bun run --filter '@devops-agent/observability' test
bun run --filter '@devops-agent/shared' test
bun run --filter '@devops-agent/web' test

# Manual: AWS MCP proxy lifecycle
AWS_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-west-1:352896877281:runtime/aws-mcp-server-rt-XXXX \
  bun run --filter '@devops-agent/mcp-server-aws' start &
PID=$!
sleep 2
# Expect Pino lines: "Initializing datasource for aws-mcp-server",
#                    "AgentCore proxy ready" (with prefix/port/url),
#                    "aws-mcp-server started successfully"
kill -INT $PID
# Expect Pino lines: "Shutting down aws-mcp-server...",
#                    "AgentCore proxy closed",
#                    "aws-mcp-server shutdown completed"

# Manual: chat lifecycle
bun run --filter '@devops-agent/web' dev &
WEB=$!
curl -N -X POST http://localhost:5173/api/agent/stream \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"check elastic health"}],"dataSources":["elastic"]}'
# Expect Pino lines in web stdout:
#   {"threadId":"...","runId":"...","requestId":"...","msg":"agent.request.start"}
#   {"threadId":"...","runId":"...","requestId":"...","responseTime":..,"toolsUsed":..,"msg":"agent.request.end"}
# Expect any agent-node logs (classify, responder, etc.) to carry the same threadId/runId/requestId

# LangSmith verification
LANGSMITH_API_KEY=$(grep "^LANGSMITH_API_KEY=" .env | cut -d= -f2) \
LANGSMITH_PROJECT=devops-incident-analyzer \
langsmith-fetch traces /tmp/traces --limit 1 --include-metadata
# Expect: parent run name = "agent.request",
#         tags include "chat", "thread:<id>", "datasources:elastic"
```

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| `createMcpLogger` already owns the mixin; new fields collide with existing OTEL/LangSmith keys | None | New fields use `threadId`/`runId`/`requestId` namespace; OTEL uses `trace.id`/`span.id`, LangSmith uses `langsmith.run_id`/`langsmith.trace_id`. No overlap. |
| `mixin` evaluates on every log call → measurable overhead | Low | Pino mixins are documented for this exact use case; `getCurrentRequestContext()` is an O(1) ALS lookup. The mixin already does 3 lookups (OTEL, LangSmith, retention); a 4th is negligible. |
| Top-level `const logger = createMcpLogger(...)` captures empty context at module load | Resolved by design | Mixin evaluates at each log call, not at logger creation |
| Resume endpoint not wrapped → orphan LangSmith runs | Handled | Step 8 wraps `/api/agent/topic-shift` identically |
| LangSmith callback flusher logs without context | Acceptable | Framework-internal noise, not request-scoped business logs |
| Client disconnects mid-stream → no `agent.request.end` | Acceptable | Out of scope for this ticket; AbortController wiring tracked separately |
| Existing server-mode call sites break | None | Default `mode: "server"` keeps all 7 servers' server branches working unchanged |

## Out of scope

- Wiring `AbortController` to the SSE request signal so client disconnects cancel the LangGraph run. Tracked as a separate follow-up.
- Adding correlation IDs to MCP-server-side logs when invoked from the agent (would require propagating IDs through MCP `_meta` headers).
- LangSmith run-name standardization across non-chat endpoints (`actions`, `feedback`, `available`). This ticket only standardizes the chat + resume paths.
- Renaming the existing `SessionContext` in `packages/shared/src/tracing/session.ts`. It stays as the MCP transport session concept.

## Related code references

- `packages/shared/src/bootstrap.ts:52-161` — canonical bootstrap
- `packages/shared/src/logger.ts:63-97` — existing pino mixin (OTEL + LangSmith + retention); this spec extends it
- `packages/shared/src/agentcore-proxy.ts` — `startAgentCoreProxy`, retry policy, `loadProxyConfigFromEnv`
- `packages/shared/src/tracing/session.ts` — MCP-session AsyncLocalStorage (parallel concept, not modified)
- `packages/shared/src/telemetry/telemetry.ts:88-114` — `traceSpan` helper
- `apps/web/src/routes/api/agent/stream/+server.ts:28-144` — existing chat handler
- `apps/web/src/lib/server/agent.ts:69-129` — existing `invokeAgent`
- `apps/web/src/routes/api/agent/topic-shift/+server.ts` — resume endpoint

## Memory references

- `reference_sio774_per_server_connect_timeouts` — proxy connection observability bar set by SIO-774
- `reference_proxy_mcp_upstream_vs_local_env_vars` — proxy MCP env-var pattern
- `reference_oauth_proactive_refresh_in_proxy_connect` — OAuth tick activation lives in `proxy.connect()`, complements the new `proxy.connect` OTEL span
