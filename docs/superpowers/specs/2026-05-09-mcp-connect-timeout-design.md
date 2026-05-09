# Spec: bound MCP connect attempts with a per-server timeout

**Date:** 2026-05-09
**Tickets:** SIO-680, SIO-682 (continuation -- the bug surfaced during the eval pipeline verification at commit `ae806d3`).

## Context

While verifying the eval-pipeline fix at commit `ae806d3`, I tried to spawn `kafka-mcp` and `konnect-mcp` locally so all 6 MCP servers would be reachable. That attempt revealed a separate bug: in `packages/agent/src/mcp-bridge.ts`, both `createMcpClient` (line 109) and `reconnectServer` (line 197) call `await client.getTools()` without any timeout. When an MCP server is unreachable in a way that doesn't quickly produce an error (e.g. port bound by a process that doesn't speak HTTP, or a half-open TCP connection), `getTools()` never returns.

The `Promise.allSettled` at line 93 was meant to isolate per-server failures, but it only resolves when EVERY per-server promise settles -- a single hung `getTools()` blocks the whole connect call indefinitely. The eval verification's `runAgent` invocation was hung for 5+ minutes with zero stdout output until I killed it.

In production this is a latent reliability hole: an MCP server that gets into a half-open state takes the agent's startup down for an unbounded period. The SIO-684 startup probes added by the kafka MCP itself help on the *server* side, but the *client* side has no analogous bound.

## Goal

Wrap each `client.getTools()` call in a 10-second per-server timeout so an unreachable MCP server fails fast (rejects with a descriptive error) instead of hanging. Both call sites in `mcp-bridge.ts` use a shared helper. Bug isolated to one file plus a new test file.

## Decisions (locked via brainstorming)

1. **Timeout value:** 10 seconds. Generous enough for slow MCP boots (kafka with Confluent stack probes can take ~5-7s per SIO-684); tight enough that 6 hung servers cap startup at ~10s wall-clock since `Promise.allSettled` runs them in parallel.
2. **Scope:** both call sites (`createMcpClient` line 109 + `reconnectServer` line 197). DRY'd via a shared helper.
3. **Testable seam:** extract a generic `withTimeout<T>(promise, ms, label)` helper. Pure function, trivial to unit-test. Re-export under `_withTimeoutForTest` alias for the test file. The MCP client construction is plumbing; integration tests for the live path are out of scope.
4. **Commit prefix:** `SIO-680,SIO-682:` (ride the originating tickets per memory rule -- the bug surfaced during their verification work and the fix is robustness for the same code path). No new Linear issue.
5. **No env-var override** -- 10s is a sensible default; adding `MCP_CONNECT_TIMEOUT_MS` would be YAGNI for a robustness fix.

## Detailed design

### Change 1: New `withTimeout` helper in `mcp-bridge.ts`

Add at module scope, near the existing constants block (around line 41):

```typescript
const MCP_CONNECT_TIMEOUT_MS = 10_000;

// Generic timeout wrapper. Races the input promise against AbortSignal.timeout(ms);
// rejects with a descriptive error if the promise hasn't settled by deadline.
//
// KNOWN LIMITATION: when the timeout fires, the underlying operation is NOT
// cancelled -- the in-flight HTTP request inside MultiServerMCPClient.getTools()
// keeps running until it resolves on its own (the SDK in @langchain/mcp-adapters
// v1.1.3 doesn't accept an AbortSignal parameter). The leaked promise is reclaimed
// when the agent process exits. In production the next health-poll cycle attempts
// a fresh connect via reconnectServer, so the leak is bounded by the poll interval.
//
// Re-exported as _withTimeoutForTest at the bottom of the file for unit testing.
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	const timeoutPromise = new Promise<never>((_, reject) => {
		const signal = AbortSignal.timeout(ms);
		signal.addEventListener("abort", () => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		});
	});
	return Promise.race([promise, timeoutPromise]);
}
```

At the bottom of the file (after the existing exports), add the test re-export:

```typescript
// SIO-680/682: exported for testing only. Do not import from production code.
export { withTimeout as _withTimeoutForTest };
```

### Change 2: Replace inline construction in `createMcpClient`

The existing block at lines 92-112:

```typescript
const results = await Promise.allSettled(
	serverEntries.map(async ({ name, url }) => {
		const beforeToolCall = name === "elastic-mcp" ? injectElasticHeaders : injectTraceHeaders;
		const client = new MultiServerMCPClient({
			mcpServers: {
				[name]: {
					transport: "http",
					url,
					beforeToolCall: () => beforeToolCall(),
				} as never,
			},
		});
		const tools = await client.getTools();
		return { name, tools };
	}),
);
```

becomes:

```typescript
const results = await Promise.allSettled(
	serverEntries.map(async ({ name, url }) => {
		const beforeToolCall = name === "elastic-mcp" ? injectElasticHeaders : injectTraceHeaders;
		const client = new MultiServerMCPClient({
			mcpServers: {
				[name]: {
					transport: "http",
					url,
					beforeToolCall: () => beforeToolCall(),
				} as never,
			},
		});
		const tools = await withTimeout(
			client.getTools(),
			MCP_CONNECT_TIMEOUT_MS,
			`MCP connect to '${name}' (${url})`,
		);
		return { name, tools };
	}),
);
```

The existing rejection branch at line 132-134 already logs `Failed to connect to MCP server, skipping` with `result.reason` -- timeout errors will surface there with the descriptive label (`MCP connect to 'kafka-mcp' (http://localhost:9081/mcp) timed out after 10000ms`). No additional logging changes needed.

### Change 3: Replace inline construction in `reconnectServer`

Lines 183-219 currently construct the client inline:

```typescript
async function reconnectServer(name: string, mcpUrl: string): Promise<void> {
	try {
		const { MultiServerMCPClient } = await import("@langchain/mcp-adapters");
		const beforeToolCall = name === "elastic-mcp" ? injectElasticHeaders : injectTraceHeaders;
		const client = new MultiServerMCPClient({
			mcpServers: {
				[name]: {
					transport: "http",
					url: mcpUrl,
					beforeToolCall: () => beforeToolCall(),
				} as never,
			},
		});
		const tools = await client.getTools();
		// ...rest unchanged
```

Replace the `const tools = await client.getTools();` line with the wrapped version:

```typescript
		const tools = await withTimeout(
			client.getTools(),
			MCP_CONNECT_TIMEOUT_MS,
			`MCP reconnect to '${name}' (${mcpUrl})`,
		);
```

The catch block (line 213-217) already logs warn with the error message -- timeout errors propagate through unchanged. No other reconnect-path edits.

### Change 4: New `mcp-bridge.test.ts`

Three tests covering all three branches of `withTimeout`'s behaviour:

```typescript
// packages/agent/src/mcp-bridge.test.ts
import { describe, expect, test } from "bun:test";
import { _withTimeoutForTest as withTimeout } from "./mcp-bridge.ts";

describe("withTimeout (SIO-680/682)", () => {
	test("resolves with value when promise settles before timeout", async () => {
		const result = await withTimeout(Promise.resolve(42), 100, "fast-call");
		expect(result).toBe(42);
	});

	test("rejects with descriptive error when promise never settles", async () => {
		const neverResolves = new Promise<number>(() => {});
		await expect(withTimeout(neverResolves, 50, "stuck-call")).rejects.toThrow(
			/stuck-call timed out after 50ms/,
		);
	});

	test("propagates the original error when promise rejects before timeout", async () => {
		const fails = Promise.reject(new Error("connection refused"));
		await expect(withTimeout(fails, 1000, "failing-call")).rejects.toThrow(/connection refused/);
	});
});
```

The "never settles" test leaks a promise after the test runner finishes, but it's reclaimed when the test process exits -- standard pattern in JS testing. The 50ms timeout in test 2 is short enough to keep the test fast (~50ms) without flaking on slow CI.

### Change 5: Out of scope

- `MCP_CONNECT_TIMEOUT_MS` env-var override -- declined per question 2; 10s is sensible.
- AbortController integration into `MultiServerMCPClient` -- the SDK doesn't support it in v1.1.3; would require upstream PR.
- Retry-on-timeout in `createMcpClient` -- the existing health-poll loop already retries every 30s via `reconnectServer`. Adding inline retry would be redundant.
- Adjusting `healthCheckServer`'s 5s timeout -- working fine, separate concern.
- Documentation update to `docs/architecture/mcp-integration.md` -- no architectural change. Mechanical robustness fix.
- Integration test against a deliberately-hung HTTP server -- documented in §Verification as a manual smoke option, not part of the test suite.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Timeout too tight, healthy MCP servers under load occasionally hit it | 10s is generous; SIO-684 probes complete in ~5-7s. Health-poll retries every 30s if the initial connect timed out. Operators can lengthen the constant if they hit it. |
| Leaked in-flight HTTP request after timeout fires | Documented as known limitation in the JSDoc above `withTimeout`. Process eventually exits and OS reclaims; no observable user-facing impact. |
| Bun's `AbortSignal.timeout` semantics differ from Node's | Bun docs confirm identical behaviour to Node 17+. The `signal.addEventListener("abort", cb)` pattern is web-standard. |
| `Promise.race` against a never-resolving promise: which side wins? | `AbortSignal.timeout` always fires after `ms` and the listener immediately rejects the timeout promise. The never-resolving promise stays pending, so `Promise.race` resolves with the timeout rejection. Verified in test 2. |
| Test 2's leaked promise affects subsequent tests | Each test gets a fresh execution context; the leaked promise has no shared state that subsequent tests can observe. The test runner exits cleanly when all tests complete. |
| The `_withTimeoutForTest` re-export pollutes the public API | Underscore prefix + JSDoc comment ("Do not import from production code") make the test-only intent explicit. Future consumers grep'ing the exports will see the convention. |

## Verification

```bash
# Unit tests for the helper
bun test packages/agent/src/mcp-bridge.test.ts
# Expected: 3 pass / 0 fail

# Existing agent tests still pass (no behaviour change for the happy path)
bun run --filter @devops-agent/agent test
# Expected: 193 pass / 0 fail (current 190 + 3 new in mcp-bridge.test.ts)

# Format checks
bun run typecheck && bun run lint
# Expected: PASS

# Manual smoke (optional, not part of the test suite):
#   1. In one terminal: bun -e "Bun.serve({port: 9999, fetch: () => new Promise(() => {})})"
#   2. In .env temporarily: ELASTIC_MCP_URL=http://localhost:9999
#   3. Run any path that calls createMcpClient (e.g. the eval entry point)
#   4. Expect: a warn log "Failed to connect to MCP server, skipping" with
#      reason "MCP connect to 'elastic-mcp' (http://localhost:9999/mcp) timed
#      out after 10000ms" after ~10 seconds, and the other 5 servers connect
#      normally in parallel.
```

## Commit shape

Single commit. ~60 lines diff:
- `packages/agent/src/mcp-bridge.ts`: +25 lines net (helper + JSDoc + 2 call-site swaps + re-export)
- `packages/agent/src/mcp-bridge.test.ts`: +25 lines new

Commit prefix: `SIO-680,SIO-682:` (ride originating tickets, no new Linear issue per memory rule -- the bug surfaced during their verification and the fix is robustness for the same code path).
