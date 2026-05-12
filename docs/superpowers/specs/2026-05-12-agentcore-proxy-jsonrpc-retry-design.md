# AgentCore Proxy: Retry on JSON-RPC -320xx Server Errors

Date: 2026-05-12
Status: Draft (awaiting user review)
Owner: Simon Owusu
Related code: `packages/shared/src/agentcore-proxy.ts`

## 1. Problem

The local SigV4 proxy at `localhost:3000` forwards MCP `tools/call` requests
to the AgentCore-hosted Kafka MCP runtime. When the underlying runtime
container is briefly unhealthy -- typically during cold-start after an idle
window -- AgentCore returns the request envelope as `200 OK` with a
JSON-RPC error body whose `code` is in the `-32099..-32000` server-error
band, most commonly `-32010 "Runtime health check failed or timed out"`.

The proxy currently retries only on transport-level failures
(`TimeoutError`, `aborted`, `ECONNRESET`) at line 339-343 of
`agentcore-proxy.ts`. JSON-RPC errors arrive inside successful HTTP
envelopes and slip past that filter, so every transient runtime hiccup is
surfaced to the agent as a hard tool-call failure.

Observed in production on 2026-05-12 at 10:24:58 UTC: 7 parallel tool calls
all returned `-32010`. The agent's automatic retry 20s later (10:25:18 UTC)
hit the same error. The final aggregated answer carried confidence 0.1
with `allToolsFailed: true`. Direct sequential probes through the same
proxy at 10:28:21 UTC succeeded -- proving the failure was transient.

## 2. Goal

Add a retry layer inside the SigV4 proxy that recovers from transient
AgentCore-side server errors (`-32099..-32000`) without papering over real
upstream tool failures (`-32603` ksqlDB 503, `-32602` invalid params,
etc.).

Non-goals:

- Retry logic outside the AgentCore code path. Other MCP servers
  (elastic, couchbase, konnect, gitlab, atlassian) run as plain local
  HTTP and do not emit -320xx codes.
- Changing the cold-start behaviour of the AgentCore runtime itself.
- Adding circuit-breaker / open-state behaviour. Out of scope for this
  spec; the deadline guard below provides sufficient back-pressure for
  now.

## 3. Design

### 3.1 Retry decision

After every successful `fetch` in the POST `/mcp` handler:

1. Clone the response body (already done at line 312 for logging).
2. Parse with a new helper:
   ```ts
   export function extractJsonRpcErrorCode(rawBody: string): number | undefined
   ```
   Reuses `classifyToolStatus`'s SSE-frame stripping (`data: ` prefix
   handling), JSON-parses the last data frame, returns `parsed.error.code`
   when `error` is an object with a numeric `code`. Returns `undefined`
   otherwise (success, malformed body, non-object error).
3. If the code is in the inclusive range `[-32099, -32000]`, treat as
   transient and enter the retry loop.
4. Any other outcome -- success, parse failure, or a code outside the
   reserved band -- returns the response untouched.

The `-32000..-32099` range is the JSON-RPC 2.0 "Implementation defined
server-errors" band. AgentCore reserves it for transport-layer failures
(runtime unhealthy, throttled, paused). Codes outside the band originate
from the tool implementation itself and must not be retried.

### 3.2 Retry budget

| Attempt | Backoff (base) | Jittered range |
|---|---|---|
| 1 -> 2 | 300ms | 240-360ms |
| 2 -> 3 | 800ms | 640-960ms |
| 3 -> 4 | 1500ms | 1200-1800ms |
| 4 -> 5 | 3000ms | 2400-3600ms |
| 5 fail | (give up) | -- |

Jitter formula: `base * (0.8 + Math.random() * 0.4)`, computed
independently per attempt so parallel callers de-sync over rounds.

Best-case recovery: one retry, ~300ms added latency.
Worst-case retry cost: ~5.6s of backoff sleep plus 5 fetch RTTs.

### 3.3 Cumulative deadline

Per-attempt timeout (`AbortSignal.timeout(30_000)` at line 293) stays
unchanged. Add a cumulative deadline at the top of the POST handler:

```ts
const deadline = Date.now() + 30_000;
```

Before each retry sleep, check `Date.now() + nextBackoff >= deadline`. If
yes, return the most recent error response immediately. This caps total
wallclock at 30s per `/mcp` call regardless of how many attempts the
backoff schedule would have allowed.

### 3.4 DELETE / session-reset abort

Today the DELETE handler at line 377-380 clears the module-scope
`mcpSessionId` so a fresh `initialize` will mint a new one. To make this
abort in-flight retries cleanly:

1. Introduce a module-scope `currentSessionAbort: AbortController` paired
   with `mcpSessionId`. Lazy-initialise on first POST.
2. Each POST captures a reference at entry:
   `const sessionAbort = currentSessionAbort;`
3. Each `fetch` receives a composed signal:
   `AbortSignal.any([AbortSignal.timeout(30_000), sessionAbort.signal])`.
4. The retry sleep wraps `Bun.sleep` in a promise that races against
   `sessionAbort.signal`.
5. DELETE handler:
   ```ts
   currentSessionAbort?.abort(new Error("Session reset via DELETE"));
   mcpSessionId = undefined;
   currentSessionAbort = new AbortController();
   ```
6. When a retry is aborted by the session signal, the proxy returns 502
   with the existing JSON-RPC error envelope shape:
   ```json
   {"jsonrpc":"2.0","error":{"code":-32000,"message":"Session reset during retry"},"id":null}
   ```

### 3.5 Logging

Per-attempt visibility. All new fields extend the existing `logFields`
record at line 328 -- no new code paths.

Happy path (no retries) -- log lines identical to today.

Retry path:
```
info  Proxying tool call: kafka_get_cluster_info (id=2)
warn  Tool call proxied: kafka_get_cluster_info -> jsonrpc-error
        { jsonRpcCode: -32010, attempt: 1, maxAttempts: 5, retryAfterMs: 312 }
warn  Tool call proxied: kafka_get_cluster_info -> jsonrpc-error
        { jsonRpcCode: -32010, attempt: 2, maxAttempts: 5, retryAfterMs: 723 }
info  Tool call proxied: kafka_get_cluster_info -> ok
        { recoveredAfterAttempts: 3 }
```

Exhausted:
```
warn  Tool call proxied: kafka_get_cluster_info -> jsonrpc-error
        { jsonRpcCode: -32010, attempt: 5, maxAttempts: 5, gaveUpAfterMs: 5612 }
```

DELETE-aborted:
```
warn  Tool call proxied: kafka_get_cluster_info -> aborted
        { reason: "session-reset", duringAttempt: 3 }
```

Deadline-aborted:
```
warn  Tool call proxied: kafka_get_cluster_info -> jsonrpc-error
        { jsonRpcCode: -32010, attempt: 3, gaveUpDueToDeadline: true, totalMs: 29800 }
```

Field naming: camelCase, no emojis, per project convention.

### 3.6 Interaction with existing TCP-error retry

The existing `for (let attempt = 1; attempt <= maxAttempts; attempt++)`
loop at line 278 retries on `TimeoutError`, `aborted`, and `ECONNRESET`
with `maxAttempts = 2`. Two distinct retry decisions remain:

- **TCP-layer**: catch block, max 2 attempts, no backoff sleep. Existing
  behaviour preserved.
- **JSON-RPC -320xx**: post-fetch body parse, max 5 attempts, jittered
  backoff. New.

Both share the cumulative 30s deadline introduced in section 3.3. A
single request can chain the two policies (e.g. one TCP retry that
succeeds, then four -320xx retries on the response body) as long as the
cumulative deadline allows. The TCP retry does not count against the
-320xx attempt counter and vice versa.

## 4. Tests

New file: `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`.
Pattern: fake AgentCore upstream via `Bun.serve()` on an ephemeral port,
scripted response sequences, same harness as the SIO-733 roundtrip suite.

| Test | Upstream sequence | Expectation |
|---|---|---|
| Retries -32010 and recovers | `[-32010, -32010, ok]` | client sees ok; `recoveredAfterAttempts: 3` |
| Retries -32011 and -32012 | `[-32011, ok]`, `[-32012, ok]` | both recover; full band covered |
| Does NOT retry -32603 | `[-32603]` | error propagated on first attempt |
| Does NOT retry -32602 | `[-32602]` | error propagated on first attempt |
| Does NOT retry plain ok | `[ok]` | single fetch; no retry log |
| Gives up after 5 attempts | `[-32010] x 5` | client sees -32010; log shows `gaveUpAfterMs` |
| Respects 30s deadline | `[-32010] x 5` with 8s upstream delay | second retry blocked by deadline |
| DELETE aborts in-flight retry | `[-32010, hang]` + DELETE during backoff | 502 with "session-reset" message |
| Applies +/-20% jitter | `[-32010, ok]` x 50 runs | first sleep observed in [240ms, 360ms] |
| Parallel calls de-sync | 5 parallel callers, each `[-32010, ok]` | retry timestamps spread >=100ms |
| Preserves mcp-session-id across attempts | `[-32010, ok]`, observe headers | both fetches carry same session id |
| TCP retry still works alongside | first throws ECONNRESET, second ok | recovers without entering -320xx loop |

All tests run under `bun test`; no real AgentCore traffic, no AWS calls.

## 5. Acceptance criteria

1. `bun run typecheck` passes.
2. `bun run lint` passes (no new biome warnings).
3. `bun test packages/shared` passes including 12 new retry tests.
4. The 11 existing SIO-733 roundtrip tests continue to pass unchanged.
5. Manual smoke: re-running this morning's failing prompt
   ("Can you check my Kafka cluster and also KSQL, Schema Registry,
   REST Proxy and Connect ?") against a freshly-idle AgentCore runtime
   succeeds with no `allToolsFailed: true` warning.

## 6. Out of scope

- Cross-process circuit breaker for sustained AgentCore degradation.
- Configurable retry policy via env vars. The constants live in the file
  for now; a follow-up can lift them to env-getters if needed.
- Mirror retry behaviour for any future AgentCore-hosted MCP. Today
  only the Kafka MCP runs on AgentCore; when a second one ships, the
  proxy is already shared so this fix covers it automatically.
