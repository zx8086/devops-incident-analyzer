# MCP Connect Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound each `MultiServerMCPClient.getTools()` call in `packages/agent/src/mcp-bridge.ts` with a 10-second per-server timeout so an unreachable MCP server fails fast instead of hanging the agent indefinitely.

**Architecture:** Extract a generic `withTimeout<T>(promise, ms, label): Promise<T>` helper that races the input promise against `AbortSignal.timeout(ms)`. Wire it into both `getTools()` call sites (initial connect at line 109; reconnect at line 197). Re-export under `_withTimeoutForTest` for unit tests. Three unit tests cover the resolve-fast / timeout / propagate-error branches.

**Tech Stack:** TypeScript strict mode, Bun test runner, web-standard `AbortSignal.timeout()` (Node 17+ / Bun compatible).

**Spec:** `docs/superpowers/specs/2026-05-09-mcp-connect-timeout-design.md` (commit `602d770`).

**Decisions locked at plan-writing time:**
- Commit prefix: `SIO-680,SIO-682:` (continuation of the work whose verification surfaced the bug; rides originating tickets per memory rule).
- 2-commit TDD split: helper + tests first, then wire into call sites.

---

## Task 1: New `withTimeout` helper + 3 unit tests

The helper is meaningless without the call-site wiring (Task 2), but landing it as its own commit lets the test commit be independently revertable if a wiring change ever needs to be backed out without losing the helper.

**Files:**
- Modify: `packages/agent/src/mcp-bridge.ts` (add helper at module scope + test re-export at file end)
- Create: `packages/agent/src/mcp-bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/agent/src/mcp-bridge.test.ts`:

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

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test packages/agent/src/mcp-bridge.test.ts
```

Expected: failure with `Cannot find module '_withTimeoutForTest'` or similar import error -- the export doesn't exist yet. This is the failing baseline.

- [ ] **Step 3: Add the constant and helper near the top of mcp-bridge.ts**

Open `packages/agent/src/mcp-bridge.ts`. Locate line 41 (`const HEALTH_POLL_INTERVAL_MS = 30_000;`). Add the new constant immediately after line 41:

```typescript
const HEALTH_POLL_INTERVAL_MS = 30_000;
const MCP_CONNECT_TIMEOUT_MS = 10_000;
```

Then locate the next blank line (line 42 in the current file -- right before the `function injectTraceHeaders(...)` block at line 43). Add the `withTimeout` helper there:

```typescript
const HEALTH_POLL_INTERVAL_MS = 30_000;
const MCP_CONNECT_TIMEOUT_MS = 10_000;

// SIO-680/682: Generic timeout wrapper. Races the input promise against
// AbortSignal.timeout(ms); rejects with a descriptive error if the promise
// hasn't settled by deadline.
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

function injectTraceHeaders(): { headers: Record<string, string> } | undefined {
```

- [ ] **Step 4: Add the test re-export at the bottom of the file**

Open `packages/agent/src/mcp-bridge.ts` and scroll to the very last line. After the existing `stopHealthPolling()` export, add:

```typescript
export function stopHealthPolling(): void {
	if (healthPollTimer) {
		clearInterval(healthPollTimer);
		healthPollTimer = null;
		logger.info("MCP health polling stopped");
	}
}

// SIO-680/682: exported for testing only. Do not import from production code.
export { withTimeout as _withTimeoutForTest };
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
bun test packages/agent/src/mcp-bridge.test.ts
```

Expected: 3 pass / 0 fail. The "stuck-call" test should complete in ~50ms (the timeout); the other two should complete sub-millisecond.

- [ ] **Step 6: Run the full agent test suite to confirm no regression**

```bash
bun run --filter @devops-agent/agent test
```

Expected: 193 pass / 0 fail (190 baseline + 3 new in mcp-bridge.test.ts). No existing tests should break -- nothing yet uses the helper from production code.

- [ ] **Step 7: Run typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/agent/src/mcp-bridge.ts packages/agent/src/mcp-bridge.test.ts
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: add withTimeout helper to mcp-bridge for bounded connects

Generic Promise<T> -> Promise<T> wrapper that races the input against
AbortSignal.timeout(ms). Re-exported under _withTimeoutForTest for
unit tests so the timeout logic gets full coverage without mocking
the @langchain/mcp-adapters SDK.

3 new tests in packages/agent/src/mcp-bridge.test.ts cover the three
branches: resolves-on-time, rejects-on-timeout, propagates-real-error.

Known limitation documented in JSDoc: the timeout doesn't cancel
the underlying operation (SDK v1.1.3 has no AbortSignal parameter).
The leaked promise is reclaimed at process exit, and in production
the health-poll cycle attempts fresh connects every 30s.

Helper is unused in production until the next commit wires it into
the two getTools() call sites at lines 109 (createMcpClient) and 197
(reconnectServer).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire `withTimeout` into the 2 `getTools()` call sites

Both `createMcpClient` (initial connect) and `reconnectServer` (health-poll recovery) need their `getTools()` calls bounded. Same timeout constant, same label format `MCP <verb> to '<name>' (<url>)`.

**Files:**
- Modify: `packages/agent/src/mcp-bridge.ts` (2 call-site swaps)

- [ ] **Step 1: Replace `getTools()` in `createMcpClient`**

Open `packages/agent/src/mcp-bridge.ts`. Locate line 109 (the inner `client.getTools()` call inside the `Promise.allSettled` block in `createMcpClient`):

Find this exact line:
```typescript
				const tools = await client.getTools();
```

Replace with:
```typescript
				const tools = await withTimeout(
					client.getTools(),
					MCP_CONNECT_TIMEOUT_MS,
					`MCP connect to '${name}' (${url})`,
				);
```

The surrounding context (the `MultiServerMCPClient` construction on lines 100-108 and the `return { name, tools }` on line 110) is unchanged. Only the single `await` line is replaced.

- [ ] **Step 2: Replace `getTools()` in `reconnectServer`**

Locate line 197 (the `client.getTools()` call inside `reconnectServer`):

Find this exact line:
```typescript
		const tools = await client.getTools();
```

Replace with:
```typescript
		const tools = await withTimeout(
			client.getTools(),
			MCP_CONNECT_TIMEOUT_MS,
			`MCP reconnect to '${name}' (${mcpUrl})`,
		);
```

Note the label uses `mcpUrl` here (the parameter name in `reconnectServer`), not `url` (which is the parameter name in `createMcpClient`'s map callback). Both produce the same human-readable shape but reference the in-scope variable.

- [ ] **Step 3: Run the helper's existing tests to confirm no regression**

```bash
bun test packages/agent/src/mcp-bridge.test.ts
```

Expected: 3 pass / 0 fail. The unit tests don't depend on the call-site wiring -- they should still pass unchanged.

- [ ] **Step 4: Run the full agent test suite**

```bash
bun run --filter @devops-agent/agent test
```

Expected: 193 pass / 0 fail. The MCP-bridge consumer tests (if any exist that touch `createMcpClient` or `reconnectServer`) should still pass -- the timeout only fires if `getTools()` doesn't resolve within 10 seconds, which doesn't happen in any test fixture.

- [ ] **Step 5: Run typecheck + lint**

```bash
bun run typecheck && bun run lint
```

Expected: PASS. The `MCP_CONNECT_TIMEOUT_MS` and `withTimeout` references are now used; verify no "unused symbol" warnings appear.

- [ ] **Step 6: Manual smoke (optional, recommended for confidence)**

Verify the timeout actually fires against a deliberately-hung server:

```bash
# Terminal 1: spin up a fake MCP endpoint that never responds
bun -e "Bun.serve({port: 9999, fetch: () => new Promise(() => {})})" &
FAKE_PID=$!

# Terminal 2 (or same shell): run a one-off test that points createMcpClient at the fake
bun -e "
import { createMcpClient } from './packages/agent/src/mcp-bridge.ts';
const start = Date.now();
await createMcpClient({ elasticUrl: 'http://localhost:9999' });
console.log('createMcpClient returned after', Date.now() - start, 'ms');
"

# Cleanup
kill $FAKE_PID
```

Expected: console output shows `createMcpClient returned after ~10000-10500 ms`. The agent log (visible above the console.log) should include a warn line: `Failed to connect to MCP server, skipping` with `error: MCP connect to 'elastic-mcp' (http://localhost:9999/mcp) timed out after 10000ms`.

If the smoke fails (returns instantly with success, or hangs >15s), the wiring isn't right -- inspect the diff to ensure `withTimeout(...)` wraps the `getTools()` call and the labels reference the in-scope variables.

- [ ] **Step 7: Commit**

```bash
git add packages/agent/src/mcp-bridge.ts
git commit -m "$(cat <<'EOF'
SIO-680,SIO-682: wire withTimeout into mcp-bridge connect + reconnect

Wraps both client.getTools() call sites in mcp-bridge.ts -- line 109
(createMcpClient) and line 197 (reconnectServer) -- with the
withTimeout helper landed in the previous commit. 10s per-server
deadline (MCP_CONNECT_TIMEOUT_MS).

Effect: an unreachable MCP server now fails the connect attempt
within ~10s with a descriptive error in the warn log
(`MCP connect to '<name>' (<url>) timed out after 10000ms`). The
existing Promise.allSettled in createMcpClient continues to isolate
per-server failures; before this commit, a single hung server
blocked the entire connect call indefinitely because allSettled
waits for every promise to settle, hung or not.

The reconnectServer path's existing try/catch already logs warn
on thrown errors -- timeout errors propagate through unchanged.

Closes the bug surfaced during the eval-pipeline verification at
commit ae806d3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Final cross-check before push

- [ ] **Step 1: Re-run the full validation sweep**

```bash
bun run typecheck && bun run lint && bun test packages/agent/src/mcp-bridge.test.ts && bun run --filter @devops-agent/agent test
```

Expected: PASS on all four. Agent suite: 193/0 (190 baseline + 3 new).

- [ ] **Step 2: Inspect the two commits**

```bash
git log origin/main..HEAD --stat
```

Expected: 3 commits (the spec at `602d770` from the prior session plus the 2 implementation commits from Tasks 1-2). Total ~60 lines of code change across `mcp-bridge.ts` and `mcp-bridge.test.ts`.

- [ ] **Step 3: Push (await user authorization)**

The user must explicitly authorize `git push`. When authorized:

```bash
git push origin main
```

---

## Verification (manual smoke after merge)

The Task 2 Step 6 smoke is the canonical verification. To repeat it post-merge against the deployed env:

1. Identify any one MCP server URL in `.env` and replace with `http://localhost:9999`.
2. Spin up `Bun.serve({port: 9999, fetch: () => new Promise(() => {})})` in another terminal.
3. Run any code path that calls `createMcpClient` (e.g. the eval entry: `bun run eval:agent`, or the web app via `bun run --filter @devops-agent/web dev` then hit any endpoint).
4. Confirm: ~10s after the agent starts, a warn log appears with the timeout reason. The other 5 servers connect normally in parallel.

Restore `.env` and kill the fake server when done.

## Out of scope

- `MCP_CONNECT_TIMEOUT_MS` env-var override (declined per spec).
- AbortController integration into `MultiServerMCPClient` (SDK v1.1.3 doesn't support it).
- Retry-on-timeout in `createMcpClient` (the existing 30s health-poll already retries via `reconnectServer`).
- Documentation updates to `docs/architecture/mcp-integration.md` (no architectural change).
- Pushing to remote -- last step requires explicit user authorization per repo guardrails.
