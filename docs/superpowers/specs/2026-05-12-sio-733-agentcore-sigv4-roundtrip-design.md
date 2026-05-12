# SIO-733: AgentCore SigV4 round-trip integration test

Status: Draft (awaiting user review)
Linear: [SIO-733](https://linear.app/siobytes/issue/SIO-733)
Audit: G1 (pre-production hardening, SIO-725-734 set)
Effort: L (~280-320 LOC of test code + 5 LOC production seam)

## Context

`packages/shared/src/agentcore-proxy.ts` is a local SigV4-signing HTTP proxy that bridges plain HTTP MCP clients to AWS Bedrock AgentCore Runtime. It is the only path the production agent uses to talk to AgentCore-hosted MCP servers.

The proxy currently has:

- **Inner-status tests** (SIO-718): `packages/shared/src/__tests__/agentcore-proxy-tool-status.test.ts` covers `classifyToolStatus` parsing the JSON-RPC tool-result body.
- **No outer round-trip tests**: nothing exercises the full sign + invoke + parse loop. The retry path, session-id propagation, header signing, and response pass-through are uncovered.

As c72 moves toward production, this is the path that matters most. This spec adds the missing coverage.

## Goals

1. Pin the SigV4 signing contract (credential scope, signed headers, x-amz-date format) so AWS-side regressions are caught offline.
2. Exercise all four SIO-718 inner-status states (ok, error(`<service> <code>`), jsonrpc-error, unparseable) end-to-end through the proxy.
3. Cover the retry transport path (retryable, exhausted, non-retryable, TimeoutError) which is currently 0% tested.
4. Cover session-id capture and replay, which is currently 0% tested.
5. No real AWS network calls. No new dependencies.

## Non-goals

- Recomputing the SigV4 signature inside the test (structural assertions only — the math is deterministic node:crypto).
- Testing `classifyToolStatus` internals (already covered by SIO-718).
- Testing `DELETE /mcp` session reset, `/health`, or `/ping` routes (out of G1 scope).
- Refactoring `agentcore-proxy.ts` to inject `fetch` (test-only seam is cheaper).
- AgentCore redeploy (carried operational item).

## Design

### File layout

Single new file: `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts`.

**Path deviation from Linear ticket**: the ticket says `packages/mcp-server-kafka/src/transport/__tests__/`. Reality: `agentcore-proxy.ts` is fully generic shared code — nothing kafka-specific. Co-locating the test with the code it tests means failures land in the package whose CI owns the file, and the suite is automatically reused by any other MCP server that adopts AgentCore. PR body will call out the deviation explicitly.

### Environment setup

```typescript
beforeAll(() => {
  process.env.AGENTCORE_RUNTIME_ARN =
    "arn:aws:bedrock:eu-central-1:123456789012:agent-runtime/test-mcp-XXXXX";
  process.env.AGENTCORE_REGION = "eu-central-1";
  process.env.AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATESTACCESSKEY123";
  process.env.AGENTCORE_AWS_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.AGENTCORE_AWS_SESSION_TOKEN = "test-session-token";
  process.env.AGENTCORE_PROXY_PORT = "0"; // ephemeral
  process.env.MCP_SERVER_NAME = "mcp-server-roundtrip-test";
});
```

Why each var matters:

- `AGENTCORE_RUNTIME_ARN` — without it, `readProxyConfig` (`agentcore-proxy.ts:14-18`) calls `process.exit(1)` and kills the test process.
- `AGENTCORE_AWS_*` — without these, `getCredentials` falls back to `Bun.spawn(["aws", "configure", "export-credentials"])` and either hits the real CLI or throws. Both unacceptable.
- `AGENTCORE_PROXY_PORT=0` — Bun.serve picks an ephemeral port; no collision in parallel runs.
- Session token set so the `x-amz-security-token` branch (`agentcore-proxy.ts:124-126`) is exercised by default; one dedicated test omits it.

Original env is snapshotted in `beforeAll` and restored in `afterAll`. Same for `globalThis.fetch`.

### Production-side seam

`getCredentials` caches creds module-level (`agentcore-proxy.ts:40-41`). The "no session token" test mutates env between proxy restarts, so the cache must be bustable.

**Single additive export** in `agentcore-proxy.ts`:

```typescript
export function clearCredentialCache(): void {
  cachedCreds = null;
  credsExpiresAt = 0;
}
```

Pure additive, not called by any production code, comment marks it as a test seam. Cheaper than DI-ing the credential resolver, which would refactor a chunk of `getCredentials`.

### Fake-fetch surface

`globalThis.fetch` is swapped per test. The proxy's `Bun.serve` does not use `globalThis.fetch` for inbound requests (it's a server, not a client), so this only intercepts outbound calls from the proxy to AgentCore.

```typescript
let fetchCalls: { url: string; init: RequestInit }[];
let fetchResponder: (call: number) => Response | Promise<Response> | Promise<never>;

beforeEach(async () => {
  fetchCalls = [];
  fetchResponder = () => new Response("not configured", { status: 500 });
  globalThis.fetch = async (input, init) => {
    const callIdx = fetchCalls.length;
    fetchCalls.push({ url: String(input), init: init ?? {} });
    return fetchResponder(callIdx);
  };
  clearCredentialCache();
  proxy = await startAgentCoreProxy();
});

afterEach(async () => {
  await proxy.close();
  globalThis.fetch = ORIG_FETCH;
});
```

The proxy-call helper uses `ORIG_FETCH`, not the swapped global, as defense-in-depth against future Bun behavior:

```typescript
async function callProxy(jsonRpcPayload: object) {
  const response = await ORIG_FETCH(`${proxy.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(jsonRpcPayload),
  });
  return { response, body: await response.text() };
}
```

### Response builders

```typescript
const SSE_HEADERS = { "content-type": "text/event-stream" };
const JSON_HEADERS = { "content-type": "application/json" };

function sseFrame(jsonRpc: object): string {
  return `event: message\ndata: ${JSON.stringify(jsonRpc)}\n\n`;
}

function sseOk(id: number, result: unknown, extra: HeadersInit = {}): Response {
  return new Response(
    sseFrame({ jsonrpc: "2.0", id, result }),
    { status: 200, headers: { ...SSE_HEADERS, ...extra } },
  );
}

function sseInnerError(id: number, text: string, extra: HeadersInit = {}): Response {
  return new Response(
    sseFrame({
      jsonrpc: "2.0",
      id,
      result: { isError: true, content: [{ type: "text", text }] },
    }),
    { status: 200, headers: { ...SSE_HEADERS, ...extra } },
  );
}

function jsonRpcError(id: number, code: number, message: string): Response {
  return new Response(
    sseFrame({ jsonrpc: "2.0", id, error: { code, message } }),
    { status: 200, headers: SSE_HEADERS },
  );
}

function toolCall(id: number, name: string, args: object = {}): object {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}
```

### Retry-aware response seeding

```typescript
function seedResponses(...responses: (Response | Error)[]) {
  fetchResponder = (call) => {
    const r = responses[call];
    if (r === undefined) {
      throw new Error(`fake fetch: no response seeded for call ${call} (seeded ${responses.length})`);
    }
    if (r instanceof Error) throw r;
    return r;
  };
}
```

Array-based seeding means "retry-then-success" reads as one line: `seedResponses(new TypeError("ECONNRESET"), sseOk(...))`.

### SigV4 assertion helper

```typescript
const SIGV4_AUTH_RE =
  /^AWS4-HMAC-SHA256 Credential=AKIA[A-Z0-9]+\/\d{8}\/eu-central-1\/bedrock-agentcore\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=[0-9a-f]{64}$/;

const AMZ_DATE_RE = /^\d{8}T\d{6}Z$/;

function assertSigV4(call: { url: string; init: RequestInit }) {
  expect(call.url).toBe(
    "https://bedrock-agentcore.eu-central-1.amazonaws.com" +
      "/runtimes/" +
      encodeURIComponent(
        "arn:aws:bedrock:eu-central-1:123456789012:agent-runtime/test-mcp-XXXXX",
      ) +
      "/invocations?qualifier=DEFAULT",
  );
  const headers = call.init.headers as Record<string, string>;
  const authMatch = headers.authorization?.match(SIGV4_AUTH_RE);
  expect(authMatch).not.toBeNull();
  const signedHeaders = authMatch?.[1]?.split(";") ?? [];
  expect(signedHeaders).toEqual(expect.arrayContaining([
    "accept", "content-type", "host", "x-amz-date", "x-amz-security-token",
  ]));
  expect(headers["x-amz-date"]).toMatch(AMZ_DATE_RE);
  expect(headers["x-amz-security-token"]).toBe("test-session-token");
  expect(headers["content-type"]).toBe("application/json");
  expect(headers.accept).toBe("application/json, text/event-stream");
  expect(headers.host).toBe("bedrock-agentcore.eu-central-1.amazonaws.com");
}
```

Why each assertion earns its keep:

- URL shape catches regressions in `readProxyConfig` (encoded ARN, qualifier, region in subdomain).
- Authorization scope `<date>/eu-central-1/bedrock-agentcore/aws4_request` is the contract with AWS. Drift = 403 in production.
- SignedHeaders set catches a dropped header in `signRequest` — that would succeed today but fail when AWS enforces stricter signing.
- `x-amz-date` format guards against a future "human-readable" change at `agentcore-proxy.ts:111-114`.
- Session-token mirroring proves the `creds.sessionToken` branch fires.

## Test matrix (11 tests, ~280 LOC)

### `describe("agentcore-proxy round trip — happy paths")`

1. **200 + sseOk passes through, SigV4 well-formed** — body contains expected text, `fetchCalls.length === 1`, `assertSigV4(fetchCalls[0]!)`.
2. **200 + raw JSON (no SSE framing) passes through with content-type preserved** — covers `agentcore-proxy.ts:292` pass-through.
3. **mcp-session-id captured and replayed on subsequent calls** — first response carries `mcp-session-id: sess-abc-123`, second outbound request must carry it; first outbound must not.
4. **Omits `x-amz-security-token` when sessionToken is unset** — sequence: (a) `proxy.close()`, (b) save and `delete process.env.AGENTCORE_AWS_SESSION_TOKEN`, (c) `clearCredentialCache()`, (d) `proxy = await startAgentCoreProxy()`, (e) seed and call. Assert outbound headers do NOT contain `x-amz-security-token` and the `SignedHeaders` list in `Authorization` excludes it. Restore env in a `finally` block.

### `describe("agentcore-proxy round trip — inner-error paths")`

5. **Inner isError ksqlDB 503 still returns HTTP 200 (envelope vs inner)** — body contains `"isError":true` and `ksqlDB error 503`.
6. **jsonrpc-error envelope passes through 200** — body parses to top-level `error: {code:-32600, ...}`.
7. **Unparseable response body passes through verbatim** — body is exactly `"totally not json"`.

### `describe("agentcore-proxy round trip — transport-error paths")`

8. **Retryable ECONNRESET on attempt 1, success on attempt 2** — single 200 to client, `fetchCalls.length === 2`.
9. **Retryable error twice — 502 with JSON-RPC error envelope** — `{jsonrpc:"2.0", error:{code:-32000, message:/ECONNRESET/}, id:null}`.
10. **TimeoutError treated as retryable** — `Object.assign(new Error("aborted"), {name: "TimeoutError"})` -> retry -> 200.
11. **Non-retryable fetch failure — 502 after a single attempt** — `new TypeError("DNS lookup failed")`, `fetchCalls.length === 1`.

### Coverage map

| Production line/branch | Test |
|---|---|
| `signRequest` headers (URL, Authorization, x-amz-date, x-amz-security-token, host) | 1, 4 |
| `x-amz-security-token` conditional | 4 |
| Content-type pass-through | 1, 2 |
| `mcpSessionId` capture + replay | 3 |
| Inner-isError pass-through (HTTP 200 envelope) | 5 |
| jsonrpc-error pass-through | 6 |
| Unparseable body pass-through | 7 |
| Retry on ECONNRESET | 8 |
| Retry exhaustion -> 502 envelope | 9 |
| Retry on TimeoutError | 10 |
| Non-retryable -> 502, no retry | 11 |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `getCredentials` cache leaks across tests | `clearCredentialCache()` in `beforeEach` |
| `process.exit(1)` in `readProxyConfig` if env vars missing | `beforeAll` sets them; future missing vars fail loudly on first run |
| `globalThis.fetch` swap leaks beyond test file | `afterEach` restores; Bun runs files in separate processes by default |
| Port conflicts in parallel runs | `AGENTCORE_PROXY_PORT=0` -> ephemeral port |
| Timer-based flake on creds expiry | Env creds set `credsExpiresAt = now + 3600_000`, safely > 5min buffer |
| `mcp-session-id` test inheriting state from prior test | Each `beforeEach` spawns a fresh proxy with fresh closure variable |
| Bun version difference in `AbortSignal.timeout` `TimeoutError` shape | Test synthesizes the error to match the retry branch check; doesn't depend on Bun internals |

## Acceptance criteria

1. Test file at `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts`. Path deviation called out in PR body.
2. `bun run --filter '@devops-agent/shared' test` exits 0 with 11 new tests green.
3. `bun run --filter '@devops-agent/mcp-server-kafka' test` still passes (283 currently).
4. `bun run typecheck` clean across all 12 packages.
5. `bun run lint` no new failures (pre-existing couchbase `mcp.d.ts:36` carries over).
6. No real AWS network calls — every outbound `fetch` returns a canned `Response`; env creds short-circuit `Bun.spawn`.
7. SigV4 contract pinned (scope, signed headers, date format, host).
8. Four SIO-718 states exercised end-to-end (ok, error(`<service> <code>`), jsonrpc-error, unparseable).
9. Retry semantics pinned (retry-once-success, retry-exhausted-502, TimeoutError-retryable, non-retryable-no-retry).
10. Session-id capture and replay pinned.
11. Production seam contained: only `clearCredentialCache` added, no behavioral change on the live path.

## PR scope

- Production: +5 LOC in `packages/shared/src/agentcore-proxy.ts` (export + comment).
- Tests: +280-320 LOC new file.
- No `package.json` changes, no new dependencies.
- One PR, one ticket (SIO-733).

## Out of scope

- AgentCore redeploy (operational, carried from prior handoffs).
- Pre-existing couchbase lint error at `mcp.d.ts:36`.
- `KAFKA_TOOL_TIMEOUT_MS` missing from `loader.ts` numberPaths.
- SDK-based round-trip — the ticket's `BedrockAgentRuntimeClient` reference is stale; production uses raw `fetch`. PR body will explain.
- `DELETE /mcp` session-reset test, `/health` and `/ping` tests.
