# SIO-737: AgentCore Proxy JSON-RPC -320xx Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local SigV4 proxy resilient to AgentCore runtime cold-start by retrying transient JSON-RPC server errors (`-32099..-32000`) with jittered exponential backoff, a cumulative 30s deadline, and clean abort on DELETE.

**Architecture:** Single-file change to `packages/shared/src/agentcore-proxy.ts`. Extend the existing POST `/mcp` retry loop with a JSON-RPC body classifier. Introduce two pure helpers (`extractJsonRpcErrorCode`, `computeJitteredBackoff`) and a session-scoped `AbortController`. All retry constants live as module-scope `const`s — no env vars yet. Tests use the established fetch-monkey-patch harness from SIO-733.

**Tech Stack:** Bun, TypeScript strict mode, Zod (existing config), `@modelcontextprotocol/sdk` types, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-05-12-agentcore-proxy-jsonrpc-retry-design.md`

**Linear:** [SIO-737](https://linear.app/siobytes/issue/SIO-737/sigv4-proxy-retry-on-agentcore-json-rpc-320xx-server-errors)

---

## Task 1: Pure helper `extractJsonRpcErrorCode`

**Files:**
- Modify: `packages/shared/src/agentcore-proxy.ts` (add export below existing `classifyToolStatus` at line 233)
- Create test: `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`:

```typescript
// packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
//
// SIO-737: retry behaviour for JSON-RPC -320xx server errors returned
// inside successful HTTP envelopes by the AgentCore runtime. Reuses the
// fetch-monkey-patch harness from agentcore-proxy-roundtrip.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	type AgentCoreProxyHandle,
	clearCredentialCache,
	computeJitteredBackoff,
	extractJsonRpcErrorCode,
	startAgentCoreProxy,
} from "../agentcore-proxy.ts";

const ORIG_ENV = { ...process.env };
const ORIG_FETCH = globalThis.fetch;

const TEST_ARN = "arn:aws:bedrock:eu-central-1:123456789012:agent-runtime/test-mcp-XXXXX";
const TEST_REGION = "eu-central-1";

beforeAll(() => {
	process.env.AGENTCORE_RUNTIME_ARN = TEST_ARN;
	process.env.AGENTCORE_REGION = TEST_REGION;
	process.env.AGENTCORE_AWS_ACCESS_KEY_ID = "AKIATESTACCESSKEY123";
	process.env.AGENTCORE_AWS_SECRET_ACCESS_KEY = "test-secret-key";
	process.env.AGENTCORE_AWS_SESSION_TOKEN = "test-session-token";
	process.env.AGENTCORE_PROXY_PORT = "0";
	process.env.MCP_SERVER_NAME = "mcp-server-retry-test";
});

afterAll(() => {
	process.env = ORIG_ENV;
	globalThis.fetch = ORIG_FETCH;
});

describe("extractJsonRpcErrorCode", () => {
	test("returns code for inline JSON body", () => {
		const body = `{"jsonrpc":"2.0","id":1,"error":{"code":-32010,"message":"runtime"}}`;
		expect(extractJsonRpcErrorCode(body)).toBe(-32010);
	});

	test("returns code from SSE-framed body (last data: frame)", () => {
		const body = `event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"tool"}}\n\n`;
		expect(extractJsonRpcErrorCode(body)).toBe(-32603);
	});

	test("returns undefined for successful response", () => {
		const body = `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n`;
		expect(extractJsonRpcErrorCode(body)).toBeUndefined();
	});

	test("returns undefined when error object lacks numeric code", () => {
		const body = `{"jsonrpc":"2.0","id":1,"error":{"message":"broken"}}`;
		expect(extractJsonRpcErrorCode(body)).toBeUndefined();
	});

	test("returns undefined for unparseable body", () => {
		expect(extractJsonRpcErrorCode("not json")).toBeUndefined();
		expect(extractJsonRpcErrorCode("")).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the test and watch it fail at import**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`
Expected: FAIL — `SyntaxError: Export named 'extractJsonRpcErrorCode' not found in module 'agentcore-proxy.ts'`

- [ ] **Step 3: Implement `extractJsonRpcErrorCode`**

In `packages/shared/src/agentcore-proxy.ts`, add immediately after `classifyToolStatus` (currently ends at line 233):

```typescript
// SIO-737: parse out the JSON-RPC error.code from a response body so the
// POST handler can decide whether to retry. Returns undefined for a
// success body, malformed body, or an error object without a numeric
// code. Shares SSE-frame stripping with classifyToolStatus.
export function extractJsonRpcErrorCode(rawBody: string): number | undefined {
	const dataLines = rawBody.split("\n").filter((l) => l.startsWith("data: "));
	const jsonText = dataLines.length > 0 ? dataLines[dataLines.length - 1]?.slice(6) : rawBody.trim();
	if (!jsonText) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch {
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null) return undefined;
	const obj = parsed as Record<string, unknown>;
	const err = obj.error;
	if (typeof err !== "object" || err === null) return undefined;
	const code = (err as Record<string, unknown>).code;
	return typeof code === "number" ? code : undefined;
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t extractJsonRpcErrorCode`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/agentcore-proxy.ts packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
git commit -m "SIO-737: add extractJsonRpcErrorCode helper

Pure parser for JSON-RPC error.code in proxy response bodies.
Handles inline JSON and SSE-framed (data: ...) variants. Returns
undefined for success bodies, malformed input, or error objects
without a numeric code.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure helper `computeJitteredBackoff` + constants

**Files:**
- Modify: `packages/shared/src/agentcore-proxy.ts` (add module-scope constants near top, and the helper)
- Modify: `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`

- [ ] **Step 1: Extend the test file with the backoff tests**

Append to `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`:

```typescript
describe("computeJitteredBackoff", () => {
	test("returns base ±20% on each call", () => {
		for (let i = 0; i < 200; i++) {
			const v = computeJitteredBackoff(1000);
			expect(v).toBeGreaterThanOrEqual(800);
			expect(v).toBeLessThanOrEqual(1200);
		}
	});

	test("returns 0 when base is 0", () => {
		expect(computeJitteredBackoff(0)).toBe(0);
	});

	test("is non-deterministic across calls (best-effort)", () => {
		const samples = new Set<number>();
		for (let i = 0; i < 50; i++) samples.add(computeJitteredBackoff(1000));
		expect(samples.size).toBeGreaterThan(10);
	});
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t computeJitteredBackoff`
Expected: FAIL — `Export named 'computeJitteredBackoff' not found`.

- [ ] **Step 3: Add constants and helper in `agentcore-proxy.ts`**

Near the top of `packages/shared/src/agentcore-proxy.ts`, immediately after the `import` block (around line 9, before `function readProxyConfig`), add:

```typescript
// SIO-737: retry policy for transient AgentCore JSON-RPC server errors
// (codes in the JSON-RPC 2.0 -32099..-32000 "implementation-defined
// server-errors" band, of which -32010 "Runtime health check failed or
// timed out" is the dominant case during runtime cold-start).
const JSONRPC_RETRY_BACKOFFS_MS = [300, 800, 1500, 3000] as const;
const JSONRPC_RETRY_MAX_ATTEMPTS = JSONRPC_RETRY_BACKOFFS_MS.length + 1; // 5
const JSONRPC_RETRY_DEADLINE_MS = 30_000;
const JSONRPC_SERVER_ERROR_MIN = -32099;
const JSONRPC_SERVER_ERROR_MAX = -32000;

export function computeJitteredBackoff(baseMs: number): number {
	if (baseMs <= 0) return 0;
	return Math.round(baseMs * (0.8 + Math.random() * 0.4));
}

function isRetryableJsonRpcCode(code: number | undefined): boolean {
	return code !== undefined && code >= JSONRPC_SERVER_ERROR_MIN && code <= JSONRPC_SERVER_ERROR_MAX;
}
```

- [ ] **Step 4: Run tests and verify**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t computeJitteredBackoff`
Expected: PASS — 3 tests. Total file now 8 passing tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/agentcore-proxy.ts packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
git commit -m "SIO-737: add jittered backoff helper + retry policy constants

Module-scope constants:
- JSONRPC_RETRY_BACKOFFS_MS = [300, 800, 1500, 3000]
- JSONRPC_RETRY_MAX_ATTEMPTS = 5
- JSONRPC_RETRY_DEADLINE_MS = 30_000
- JSONRPC_SERVER_ERROR_MIN/MAX = -32099 / -32000

computeJitteredBackoff applies +-20% jitter to a base delay using
Math.random(). isRetryableJsonRpcCode is the inclusive band check.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Session-scoped AbortController plumbing (no behaviour change yet)

**Files:**
- Modify: `packages/shared/src/agentcore-proxy.ts`

- [ ] **Step 1: Write the failing DELETE-abort test**

Append to `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`:

```typescript
describe("session-scoped abort controller", () => {
	let proxy: AgentCoreProxyHandle;
	let fetchCalls: { url: string; init: RequestInit }[];
	let fetchResponder: (call: number) => Response | Promise<Response>;

	beforeEach(async () => {
		fetchCalls = [];
		fetchResponder = () => new Response("not configured", { status: 500 });
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const callIdx = fetchCalls.length;
			fetchCalls.push({ url: String(input), init: init ?? {} });
			return fetchResponder(callIdx);
		}) as typeof fetch;
		clearCredentialCache();
		proxy = await startAgentCoreProxy();
	});

	afterEach(async () => {
		await proxy.close();
	});

	test("DELETE clears session and resets abort controller", async () => {
		// Initial POST primes the session.
		fetchResponder = () => new Response(`event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream", "mcp-session-id": "session-1" },
		});
		await fetch(`${proxy.url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});

		// DELETE the session.
		const delRes = await fetch(`${proxy.url}/mcp`, { method: "DELETE" });
		expect(delRes.status).toBe(200);

		// Next POST does not forward the previous session id.
		fetchCalls = [];
		await fetch(`${proxy.url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }),
		});
		const sentHeaders = fetchCalls[0]?.init.headers as Record<string, string>;
		expect(sentHeaders["mcp-session-id"]).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run the test and watch it pass (no behaviour change needed yet)**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t "DELETE clears session"`
Expected: PASS — existing DELETE handler already clears `mcpSessionId`. This test pins the existing contract before refactor.

- [ ] **Step 3: Introduce the session AbortController, no behaviour change**

In `packages/shared/src/agentcore-proxy.ts`, at the top of `startAgentCoreProxy`, replace:

```typescript
export async function startAgentCoreProxy(): Promise<AgentCoreProxyHandle> {
	const cfg = readProxyConfig();
	let mcpSessionId: string | undefined;
```

with:

```typescript
export async function startAgentCoreProxy(): Promise<AgentCoreProxyHandle> {
	const cfg = readProxyConfig();
	let mcpSessionId: string | undefined;
	// SIO-737: paired with mcpSessionId. DELETE aborts whatever retry loop
	// is mid-flight for the session being torn down. Lazy-initialised on
	// the first POST so an idle proxy holds no signal.
	let currentSessionAbort: AbortController | undefined;
```

Then in the DELETE handler (currently line 377-380), replace:

```typescript
DELETE: () => {
    mcpSessionId = undefined;
    return new Response(null, { status: 200 });
},
```

with:

```typescript
DELETE: () => {
    currentSessionAbort?.abort(new Error("Session reset via DELETE"));
    currentSessionAbort = new AbortController();
    mcpSessionId = undefined;
    return new Response(null, { status: 200 });
},
```

And at the very top of the POST handler (just after `const body = await req.text();` at line 263), add:

```typescript
if (!currentSessionAbort) currentSessionAbort = new AbortController();
const sessionAbort = currentSessionAbort;
```

`sessionAbort` is unused this task — retained for Task 5's retry loop. Add `// SIO-737: consumed in Task 5` as the only comment to silence "unused" warnings if biome flags it; otherwise leave the comment off.

- [ ] **Step 4: Run all existing tests**

Run: `bun test packages/shared/`
Expected: All previously-passing tests still pass. Roundtrip suite (11 tests, SIO-733) unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/agentcore-proxy.ts packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
git commit -m "SIO-737: thread session-scoped AbortController through proxy

Lazy-init currentSessionAbort on first POST. DELETE now aborts the
controller before clearing mcpSessionId and minting a fresh one for
the next session. POST handler captures the session controller at
entry so a later DELETE can interrupt only that session's retries
(consumed in the retry loop landed in the next commit).

No behaviour change observable to clients yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Abortable sleep helper

**Files:**
- Modify: `packages/shared/src/agentcore-proxy.ts`
- Modify: `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the test file:

```typescript
import { sleepWithAbort } from "../agentcore-proxy.ts";

describe("sleepWithAbort", () => {
	test("resolves after the requested delay when not aborted", async () => {
		const t0 = Date.now();
		await sleepWithAbort(40, new AbortController().signal);
		expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
	});

	test("rejects immediately when signal already aborted", async () => {
		const ac = new AbortController();
		ac.abort(new Error("preempted"));
		await expect(sleepWithAbort(1000, ac.signal)).rejects.toThrow("preempted");
	});

	test("rejects mid-sleep when signal aborts", async () => {
		const ac = new AbortController();
		const t0 = Date.now();
		const p = expect(sleepWithAbort(5000, ac.signal)).rejects.toThrow("midflight");
		setTimeout(() => ac.abort(new Error("midflight")), 20);
		await p;
		expect(Date.now() - t0).toBeLessThan(200);
	});
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t sleepWithAbort`
Expected: FAIL — `Export named 'sleepWithAbort' not found`.

- [ ] **Step 3: Implement `sleepWithAbort`**

In `agentcore-proxy.ts`, add immediately after `computeJitteredBackoff`:

```typescript
export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
	}
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
```

- [ ] **Step 4: Run and verify**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t sleepWithAbort`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/agentcore-proxy.ts packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
git commit -m "SIO-737: add sleepWithAbort helper

Promise wrapper around setTimeout that resolves after the requested
delay or rejects on signal.abort with the signal.reason. Listener is
removed in both paths so no leaks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire the -320xx retry loop into POST /mcp

**Files:**
- Modify: `packages/shared/src/agentcore-proxy.ts` (POST handler, ~line 262-373)

This is the meat of the change. The existing structure is:

```
for attempt in 1..maxAttempts (= 2):
  try:
    fetch + sign + log success/error
    return response
  catch tcp-level error:
    if retryable && attempt < max: continue
    else: return 502 envelope
```

The new structure is:

```
deadline = now + 30_000
jsonRpcAttempt = 1
forever:
  capture tcp-attempt loop response (existing 2-attempt logic, unchanged)
  classify body → jsonRpcCode
  if not retryable JSON-RPC code: return response
  if jsonRpcAttempt >= 5: log "gave up", return response untouched
  nextBackoff = computeJitteredBackoff(JSONRPC_RETRY_BACKOFFS_MS[jsonRpcAttempt - 1])
  if now + nextBackoff >= deadline: log "deadline", return response
  log "retrying"
  sleepWithAbort(nextBackoff, sessionAbort.signal)  // may throw
  jsonRpcAttempt++
```

- [ ] **Step 1: Write the failing end-to-end retry test**

Append to the test file:

```typescript
describe("JSON-RPC -320xx retry", () => {
	let proxy: AgentCoreProxyHandle;
	let fetchCalls: { url: string; init: RequestInit }[];
	let scriptedResponses: Array<Response | (() => Response | Promise<Response>)>;

	beforeEach(async () => {
		fetchCalls = [];
		scriptedResponses = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const idx = fetchCalls.length;
			fetchCalls.push({ url: String(input), init: init ?? {} });
			const entry = scriptedResponses[idx];
			if (!entry) return new Response("scripted-exhausted", { status: 500 });
			return typeof entry === "function" ? entry() : entry.clone();
		}) as typeof fetch;
		clearCredentialCache();
		proxy = await startAgentCoreProxy();
	});

	afterEach(async () => {
		await proxy.close();
	});

	function jsonRpcError(code: number, id = 1): Response {
		return new Response(
			`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: `code ${code}` } })}\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "session-x" } },
		);
	}

	function jsonRpcOk(id = 1): Response {
		return new Response(
			`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } })}\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream", "mcp-session-id": "session-x" } },
		);
	}

	async function callTool(name = "kafka_get_cluster_info", id = 1): Promise<Response> {
		return fetch(`${proxy.url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }),
		});
	}

	test("retries -32010 and recovers on attempt 3", async () => {
		scriptedResponses = [jsonRpcError(-32010), jsonRpcError(-32010), jsonRpcOk()];
		const res = await callTool();
		const body = await res.text();
		expect(res.status).toBe(200);
		expect(body).toContain('"result"');
		expect(fetchCalls.length).toBe(3);
	});

	test("retries -32011 and recovers", async () => {
		scriptedResponses = [jsonRpcError(-32011), jsonRpcOk()];
		const res = await callTool();
		expect(res.status).toBe(200);
		expect(fetchCalls.length).toBe(2);
	});

	test("retries -32099 (lower band edge) and recovers", async () => {
		scriptedResponses = [jsonRpcError(-32099), jsonRpcOk()];
		const res = await callTool();
		expect(res.status).toBe(200);
		expect(fetchCalls.length).toBe(2);
	});

	test("does NOT retry -32603 (tool error)", async () => {
		scriptedResponses = [jsonRpcError(-32603), jsonRpcOk()];
		const res = await callTool();
		const body = await res.text();
		expect(body).toContain('"code":-32603');
		expect(fetchCalls.length).toBe(1);
	});

	test("does NOT retry -32602 (invalid params)", async () => {
		scriptedResponses = [jsonRpcError(-32602), jsonRpcOk()];
		const res = await callTool();
		const body = await res.text();
		expect(body).toContain('"code":-32602');
		expect(fetchCalls.length).toBe(1);
	});

	test("does NOT retry plain ok response", async () => {
		scriptedResponses = [jsonRpcOk()];
		const res = await callTool();
		expect(res.status).toBe(200);
		expect(fetchCalls.length).toBe(1);
	});

	test("gives up after 5 attempts on persistent -32010", async () => {
		scriptedResponses = [
			jsonRpcError(-32010),
			jsonRpcError(-32010),
			jsonRpcError(-32010),
			jsonRpcError(-32010),
			jsonRpcError(-32010),
		];
		const res = await callTool();
		const body = await res.text();
		expect(body).toContain('"code":-32010');
		expect(fetchCalls.length).toBe(5);
	});

	test("preserves mcp-session-id across retried attempts", async () => {
		// First call: initialize, mints session-x
		scriptedResponses = [jsonRpcOk()];
		await fetch(`${proxy.url}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
		});
		fetchCalls = [];
		scriptedResponses = [jsonRpcError(-32010), jsonRpcOk()];
		await callTool();
		const h0 = fetchCalls[0]?.init.headers as Record<string, string>;
		const h1 = fetchCalls[1]?.init.headers as Record<string, string>;
		expect(h0?.["mcp-session-id"]).toBe("session-x");
		expect(h1?.["mcp-session-id"]).toBe("session-x");
	});
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t "JSON-RPC -320xx retry"`
Expected: most fail. `does NOT retry -32603` and `does NOT retry plain ok` and `does NOT retry -32602` will pass because the proxy doesn't retry today either. The 6 positive-retry tests will fail because there's only 1 fetch.

- [ ] **Step 3: Implement the retry loop in the POST handler**

In `packages/shared/src/agentcore-proxy.ts`, replace the entire POST handler body (currently line 262-373) with the version below. The diff is:
- Hoist `deadline` and `jsonRpcAttempt` outside the existing TCP retry loop.
- After the TCP loop returns a response object (success or 502), inspect the cloned body via `extractJsonRpcErrorCode`.
- If retryable and budget allows, sleep with jitter then re-enter the TCP loop.
- Otherwise return the response.

Replace:

```typescript
"/mcp": {
    POST: async (req: Request) => {
        const body = await req.text();
        const maxAttempts = 2;

        // SIO-626: Log tool calls passing through the proxy for observability
        let toolName: string | undefined;
        try {
            const parsed = JSON.parse(body);
            if (parsed.method === "tools/call" && parsed.params?.name) {
                toolName = parsed.params.name;
                logger.info({ tool: toolName, id: parsed.id }, `Proxying tool call: ${toolName}`);
            }
        } catch {
            // Not valid JSON or not a tool call -- continue silently
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                /* ... existing fetch + log + return ... */
            } catch (error) {
                /* ... existing tcp retry / 502 fallback ... */
            }
        }

        // Unreachable, but TypeScript requires a return
        return Response.json(
            { jsonrpc: "2.0", error: { code: -32000, message: "Max retries exceeded" }, id: null },
            { status: 502 },
        );
    },
    /* ... GET, DELETE ... */
},
```

with:

```typescript
"/mcp": {
    POST: async (req: Request) => {
        const body = await req.text();
        const tcpMaxAttempts = 2;
        const deadline = Date.now() + JSONRPC_RETRY_DEADLINE_MS;

        if (!currentSessionAbort) currentSessionAbort = new AbortController();
        const sessionAbort = currentSessionAbort;

        // SIO-626: log tool calls passing through the proxy for observability
        let toolName: string | undefined;
        try {
            const parsed = JSON.parse(body);
            if (parsed.method === "tools/call" && parsed.params?.name) {
                toolName = parsed.params.name;
                logger.info({ tool: toolName, id: parsed.id }, `Proxying tool call: ${toolName}`);
            }
        } catch {
            // Not valid JSON or not a tool call -- continue silently
        }

        // Helper: one TCP-retried fetch attempt. Returns the upstream
        // Response (cloned for body inspection) or a 502 envelope.
        const doFetchWithTcpRetry = async (): Promise<{ res: Response; clonedBody: string }> => {
            for (let attempt = 1; attempt <= tcpMaxAttempts; attempt++) {
                try {
                    const creds = await getCredentials();
                    const targetUrl = new URL(`${cfg.basePath}?${cfg.queryString}`, cfg.baseUrl);
                    const headers = signRequest("POST", targetUrl, body, creds, cfg.region);
                    if (mcpSessionId) headers["mcp-session-id"] = mcpSessionId;

                    const response = await fetch(targetUrl.toString(), {
                        method: "POST",
                        headers,
                        body,
                        signal: AbortSignal.any([AbortSignal.timeout(30_000), sessionAbort.signal]),
                    });

                    const respSessionId = response.headers.get("mcp-session-id");
                    if (respSessionId) mcpSessionId = respSessionId;

                    const clonedBody = await response.clone().text();
                    return { res: response, clonedBody };
                } catch (error) {
                    const isRetryable =
                        error instanceof Error &&
                        (error.name === "TimeoutError" ||
                            error.message.includes("aborted") ||
                            error.message.includes("ECONNRESET"));
                    if (isRetryable && attempt < tcpMaxAttempts) {
                        logger.warn(
                            { attempt, error: error instanceof Error ? error.message : String(error) },
                            "Proxy request failed, retrying",
                        );
                        continue;
                    }
                    logger.error(
                        { err: error instanceof Error ? error : new Error(String(error)), path: "/mcp", attempt },
                        "Proxy request failed",
                    );
                    const envelope = Response.json(
                        {
                            jsonrpc: "2.0",
                            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
                            id: null,
                        },
                        { status: 502 },
                    );
                    return { res: envelope, clonedBody: await envelope.clone().text() };
                }
            }
            const envelope = Response.json(
                { jsonrpc: "2.0", error: { code: -32000, message: "Max retries exceeded" }, id: null },
                { status: 502 },
            );
            return { res: envelope, clonedBody: await envelope.clone().text() };
        };

        // SIO-737: outer JSON-RPC -320xx retry loop. Wraps the inner TCP
        // retry. Bails on success, non-retryable code, attempt budget, or
        // cumulative deadline.
        for (let jsonRpcAttempt = 1; jsonRpcAttempt <= JSONRPC_RETRY_MAX_ATTEMPTS; jsonRpcAttempt++) {
            const { res: response, clonedBody } = await doFetchWithTcpRetry();
            const jsonRpcCode = extractJsonRpcErrorCode(clonedBody);

            // Surface tool-status logging unchanged (SIO-718) -- this is the
            // existing per-call log line, now augmented with retry context.
            if (toolName) {
                const toolStatus = classifyToolStatus(clonedBody);
                const severity = severityForToolStatus(toolStatus);
                const baseLog: Record<string, unknown> = { tool: toolName, status: toolStatus };
                if (response.status >= 300) baseLog.httpStatus = response.status;
                if (jsonRpcCode !== undefined) baseLog.jsonRpcCode = jsonRpcCode;
                if (jsonRpcAttempt > 1) {
                    baseLog.attempt = jsonRpcAttempt;
                    baseLog.maxAttempts = JSONRPC_RETRY_MAX_ATTEMPTS;
                }

                const retryable = isRetryableJsonRpcCode(jsonRpcCode);
                if (retryable && jsonRpcAttempt < JSONRPC_RETRY_MAX_ATTEMPTS) {
                    const base = JSONRPC_RETRY_BACKOFFS_MS[jsonRpcAttempt - 1] ?? 0;
                    const retryAfterMs = computeJitteredBackoff(base);
                    if (Date.now() + retryAfterMs >= deadline) {
                        baseLog.gaveUpDueToDeadline = true;
                        baseLog.totalMs = Date.now() - (deadline - JSONRPC_RETRY_DEADLINE_MS);
                        logger.warn(baseLog, `Tool call proxied: ${toolName} -> ${toolStatus} (deadline)`);
                        return new Response(response.body, {
                            status: response.status,
                            headers: new Headers({
                                "content-type": response.headers.get("content-type") || "application/json",
                                ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {}),
                            }),
                        });
                    }
                    baseLog.retryAfterMs = retryAfterMs;
                    logger.warn(baseLog, `Tool call proxied: ${toolName} -> ${toolStatus} (retrying)`);
                    try {
                        await sleepWithAbort(retryAfterMs, sessionAbort.signal);
                    } catch (abortErr) {
                        logger.warn(
                            { tool: toolName, attempt: jsonRpcAttempt, reason: "session-reset" },
                            `Tool call proxied: ${toolName} -> aborted`,
                        );
                        return Response.json(
                            { jsonrpc: "2.0", error: { code: -32000, message: "Session reset during retry" }, id: null },
                            { status: 502 },
                        );
                    }
                    continue;
                }

                // Terminal log line: either success, non-retryable code, or
                // budget exhausted. Match the existing one-line-per-call
                // pattern from SIO-718.
                if (retryable && jsonRpcAttempt >= JSONRPC_RETRY_MAX_ATTEMPTS) {
                    baseLog.gaveUpAfterMs = Date.now() - (deadline - JSONRPC_RETRY_DEADLINE_MS);
                }
                if (!jsonRpcCode && jsonRpcAttempt > 1) {
                    baseLog.recoveredAfterAttempts = jsonRpcAttempt;
                }
                const httpAbnormal = response.status >= 300;
                const msgSuffix = httpAbnormal ? `${toolStatus} (http ${response.status})` : toolStatus;
                const logFn = severity === "info" ? logger.info.bind(logger) : logger.warn.bind(logger);
                logFn(baseLog, `Tool call proxied: ${toolName} -> ${msgSuffix}`);
            } else if (isRetryableJsonRpcCode(jsonRpcCode) && jsonRpcAttempt < JSONRPC_RETRY_MAX_ATTEMPTS) {
                // Non-tools/call request (e.g. initialize) that returned a
                // retryable code. Same backoff + deadline behaviour, no
                // per-tool log line.
                const base = JSONRPC_RETRY_BACKOFFS_MS[jsonRpcAttempt - 1] ?? 0;
                const retryAfterMs = computeJitteredBackoff(base);
                if (Date.now() + retryAfterMs >= deadline) {
                    return new Response(response.body, {
                        status: response.status,
                        headers: new Headers({
                            "content-type": response.headers.get("content-type") || "application/json",
                            ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {}),
                        }),
                    });
                }
                logger.warn(
                    { jsonRpcCode, attempt: jsonRpcAttempt, retryAfterMs },
                    "AgentCore -320xx response, retrying",
                );
                try {
                    await sleepWithAbort(retryAfterMs, sessionAbort.signal);
                } catch {
                    return Response.json(
                        { jsonrpc: "2.0", error: { code: -32000, message: "Session reset during retry" }, id: null },
                        { status: 502 },
                    );
                }
                continue;
            }

            // Return the response to the caller. New Response so the body
            // stream is consumable by the client (clonedBody used its sibling).
            const respHeaders = new Headers();
            respHeaders.set("content-type", response.headers.get("content-type") || "application/json");
            if (mcpSessionId) respHeaders.set("mcp-session-id", mcpSessionId);
            return new Response(clonedBody, { status: response.status, headers: respHeaders });
        }

        // Unreachable because the loop body always returns on the final
        // iteration. Kept for TypeScript exhaustiveness.
        return Response.json(
            { jsonrpc: "2.0", error: { code: -32000, message: "Max retries exceeded" }, id: null },
            { status: 502 },
        );
    },
```

Note: this replaces the streaming-body pass-through (`new Response(response.body, ...)`) with a buffered string pass-through (`new Response(clonedBody, ...)`) because we already consumed the body for classification. For the AgentCore use case all responses are small JSON-RPC envelopes (≤a few KB) so the buffer cost is negligible.

- [ ] **Step 4: Run the new tests**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t "JSON-RPC -320xx retry"`
Expected: all 8 retry tests pass.

- [ ] **Step 5: Run the existing SIO-733 roundtrip suite to confirm no regressions**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts`
Expected: 11 tests pass.

- [ ] **Step 6: Run the inner-status suite**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-tool-status.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/agentcore-proxy.ts packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
git commit -m "SIO-737: retry AgentCore JSON-RPC -320xx with jittered backoff

Wraps the existing TCP retry loop in an outer JSON-RPC retry loop.
After each fetch, classifies the response body via
extractJsonRpcErrorCode; if the code is in [-32099, -32000] and the
budget allows, sleeps for computeJitteredBackoff(...) with the
session AbortSignal, then retries.

Budget: 5 attempts, 300/800/1500/3000ms backoff +-20% jitter.
Cumulative deadline: 30s wallclock per /mcp call.
Session reset (DELETE) aborts the in-flight sleep cleanly.

Codes outside the band (-32603 tool error, -32602 invalid params,
success) pass through on first attempt -- no behaviour change for
real upstream errors.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Deadline guard test

**Files:**
- Modify: `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`

- [ ] **Step 1: Write the deadline test**

Append inside the `describe("JSON-RPC -320xx retry")` block:

```typescript
test("respects 30s cumulative deadline by short-circuiting backoff", async () => {
    // Spy on Date.now to simulate elapsed time without real sleeps.
    const realDateNow = Date.now;
    let nowOffset = 0;
    Date.now = () => realDateNow() + nowOffset;
    try {
        scriptedResponses = [jsonRpcError(-32010), jsonRpcError(-32010), jsonRpcError(-32010)];
        // Advance time so by the time we attempt the second retry, the
        // deadline (request_start + 30_000) is within reach.
        let callCount = 0;
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            callCount++;
            if (callCount === 2) nowOffset = 29_500; // remaining: 500ms; min backoff 240ms
            if (callCount === 3) nowOffset = 29_900; // remaining: 100ms; min backoff 640ms — should bail
            return origFetch(input, init);
        }) as typeof fetch;

        const res = await callTool();
        const body = await res.text();
        expect(body).toContain('"code":-32010');
        // We expect: attempt 1 fetch, sleep ~300ms, attempt 2 fetch (now at 29_500),
        // backoff 800ms cannot fit -> bail. So only 2 fetches.
        expect(fetchCalls.length).toBeLessThanOrEqual(3);
    } finally {
        Date.now = realDateNow;
    }
});
```

- [ ] **Step 2: Run and verify**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t "30s cumulative deadline"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
git commit -m "SIO-737: test cumulative deadline guard

Time-travel via Date.now spy. Forces remaining budget below the next
backoff before attempt 3; verifies the proxy returns the most recent
upstream error instead of starting a sleep that would overshoot 30s.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: DELETE-during-retry abort test

**Files:**
- Modify: `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`

- [ ] **Step 1: Write the DELETE-abort test**

Append inside the `describe("JSON-RPC -320xx retry")` block:

```typescript
test("DELETE aborts in-flight retry sleep", async () => {
    scriptedResponses = [jsonRpcError(-32010), jsonRpcOk()];
    const callPromise = callTool();
    // Wait long enough for the first fetch to return and the proxy to
    // enter the backoff sleep, but less than the minimum first backoff
    // (240ms).
    await new Promise((r) => setTimeout(r, 80));
    await fetch(`${proxy.url}/mcp`, { method: "DELETE" });

    const res = await callPromise;
    const body = await res.text();
    expect(res.status).toBe(502);
    expect(body).toContain('"Session reset during retry"');
    // Only the first fetch should have happened.
    expect(fetchCalls.length).toBe(1);
});
```

- [ ] **Step 2: Run and verify**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t "DELETE aborts"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
git commit -m "SIO-737: test DELETE aborts in-flight retry sleep

Fires DELETE 80ms after the first -32010 response (inside the 240-360ms
backoff window of the first retry). Expects 502 with 'Session reset
during retry' and exactly one upstream fetch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Parallel-call de-sync test

**Files:**
- Modify: `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`

- [ ] **Step 1: Write the de-sync test**

Append inside the `describe("JSON-RPC -320xx retry")` block:

```typescript
test("parallel calls de-sync after retries (jitter independence)", async () => {
    const N = 5;
    const fetchTimestamps: number[] = [];
    const origFetch = globalThis.fetch;
    let upstreamHits = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchTimestamps.push(Date.now());
        upstreamHits++;
        // First N hits: -32010. Subsequent hits: ok.
        if (upstreamHits <= N) {
            return jsonRpcError(-32010, upstreamHits);
        }
        return jsonRpcOk(upstreamHits);
    }) as typeof fetch;

    const promises = Array.from({ length: N }, (_, i) => callTool("kafka_get_cluster_info", 100 + i));
    const responses = await Promise.all(promises);

    for (const r of responses) expect(r.status).toBe(200);
    // First N timestamps are the initial concurrent fetches (within a
    // few ms of each other). The next N are the retries. The retry
    // timestamps should span at least 100ms because of independent
    // jitter on 300ms backoff (240-360ms range -> 120ms span).
    const retryStamps = fetchTimestamps.slice(N).sort((a, b) => a - b);
    expect(retryStamps.length).toBe(N);
    const spread = (retryStamps[N - 1] ?? 0) - (retryStamps[0] ?? 0);
    expect(spread).toBeGreaterThan(20); // generous lower bound vs the 120ms theoretical
});
```

- [ ] **Step 2: Run and verify**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t "parallel calls de-sync"`
Expected: PASS. If flaky on slow CI, the `> 20` lower bound can be lowered — but on a quiet laptop the spread is typically 80-120ms.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
git commit -m "SIO-737: test parallel calls de-sync via independent jitter

Fires 5 concurrent kafka_get_cluster_info calls, all hit -32010 first
then ok. Asserts the 5 retry-fetch timestamps span >20ms, proving
each callers backoff used an independent Math.random() draw.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: TCP-error retry coexistence test

**Files:**
- Modify: `packages/shared/src/__tests__/agentcore-proxy-retry.test.ts`

- [ ] **Step 1: Write the coexistence test**

Append inside the `describe("JSON-RPC -320xx retry")` block:

```typescript
test("existing TCP-error retry coexists with JSON-RPC retry", async () => {
    let call = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        call++;
        fetchCalls.push({ url: String(input), init: init ?? {} });
        if (call === 1) {
            const err = new Error("socket hang up ECONNRESET");
            err.name = "Error";
            throw err;
        }
        return jsonRpcOk();
    }) as typeof fetch;

    const res = await callTool();
    expect(res.status).toBe(200);
    expect(call).toBe(2);
});
```

- [ ] **Step 2: Run and verify**

Run: `bun test packages/shared/src/__tests__/agentcore-proxy-retry.test.ts -t "TCP-error retry coexists"`
Expected: PASS — first attempt throws ECONNRESET, the inner TCP retry kicks in, second attempt succeeds, outer JSON-RPC loop sees ok and returns.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/__tests__/agentcore-proxy-retry.test.ts
git commit -m "SIO-737: test TCP retry and JSON-RPC retry coexistence

First fetch throws ECONNRESET (inner TCP retry triggers), second
fetch returns ok. Asserts the outer JSON-RPC loop does not double-
retry and the caller sees a single 200 with the success body.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Full test + lint + typecheck verification

**Files:** none (verification only)

- [ ] **Step 1: Run typecheck**

Run: `bun run typecheck`
Expected: zero errors.

- [ ] **Step 2: Run lint**

Run: `bun run lint`
Expected: zero new warnings/errors.

- [ ] **Step 3: Run the full shared-package test suite**

Run: `bun test packages/shared`
Expected: SIO-733 (11 tests), SIO-718 tool-status tests, and the new SIO-737 retry tests (~16 across describe blocks) all pass.

- [ ] **Step 4: Manual smoke against live AgentCore (optional, requires AWS creds)**

```bash
# In one terminal, start the Kafka MCP with the proxy:
bun run --filter @devops-agent/mcp-server-kafka dev

# In another terminal, run the agent and submit:
bun run --filter @devops-agent/web dev
# Submit query: "Can you check my Kafka cluster and also KSQL, Schema Registry, REST Proxy and Connect ?"
```

Expected: no `allToolsFailed: true` warning even if the runtime was idle. If retries fire, you'll see `Tool call proxied: <tool> -> jsonrpc-error (retrying)` warn lines followed by `-> ok (recoveredAfterAttempts: N)` info lines.

- [ ] **Step 5: Final commit if the smoke surfaced any tweaks**

Otherwise nothing to commit. Move to PR.

---

## Task 11: Open the PR

**Files:** none (git only)

- [ ] **Step 1: Push branch**

```bash
git push -u origin HEAD:simonowusupvh/sio-737-sigv4-proxy-retry
```

- [ ] **Step 2: Open PR via gh**

```bash
gh pr create --title "SIO-737: retry AgentCore JSON-RPC -320xx server errors in SigV4 proxy" --body "$(cat <<'EOF'
## Summary

- Retry transient AgentCore runtime errors (codes -32099..-32000) in the local SigV4 proxy with jittered exponential backoff
- 5 attempts, 300/800/1500/3000ms +-20% jitter, cumulative 30s deadline
- Session-scoped AbortController so DELETE cleanly cancels in-flight retries
- Per-attempt warn logging with jsonRpcCode, attempt, retryAfterMs fields
- Codes outside the JSON-RPC server-error band (e.g. -32603 tool error) pass through unchanged

## Background

On 2026-05-12 ~10:25 UTC a routine multi-tool kafka query failed end-to-end because 7 parallel tool calls all hit -32010 ("Runtime health check failed or timed out"). The agent retried 20s later and hit the same error again. Final answer: confidence 0.1, allToolsFailed: true. Sequential probes 3 minutes later all succeeded -- proving the failure was transient AgentCore cold-start, but our proxy gave up too quickly.

Spec: docs/superpowers/specs/2026-05-12-agentcore-proxy-jsonrpc-retry-design.md
Linear: SIO-737

## Test plan

- [x] bun run typecheck passes
- [x] bun run lint passes
- [x] bun test packages/shared passes (SIO-733 11 tests + SIO-737 ~16 new tests)
- [ ] Manual smoke: re-run the failing query against a freshly-idle AgentCore runtime, observe recoveredAfterAttempts log line

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Update Linear with PR link**

(handled out-of-band -- ask the user or post a comment via Linear MCP if desired)

---

## Self-review

**1. Spec coverage** — each design section maps to one or more tasks:
- §3.1 retry decision -> Task 1 (`extractJsonRpcErrorCode`) + Task 5 (wired in POST handler)
- §3.2 retry budget -> Task 2 (constants + `computeJitteredBackoff`) + Task 5
- §3.3 cumulative deadline -> Task 5 + Task 6 test
- §3.4 DELETE abort -> Task 3 (controller plumbing) + Task 4 (sleepWithAbort) + Task 5 + Task 7 test
- §3.5 logging -> Task 5 (baseLog/retryAfterMs/recoveredAfterAttempts fields)
- §3.6 coexistence with TCP retry -> Task 5 (kept verbatim inside `doFetchWithTcpRetry`) + Task 9 test

**2. Placeholder scan** — no TBD/TODO/ellipsis in code blocks. Every code change shows the actual code. Every command shows expected output.

**3. Type consistency** — `extractJsonRpcErrorCode` signature is consistent across Task 1 (definition) and Task 5 (call site). `computeJitteredBackoff` returns `number` consistently. `sleepWithAbort` returns `Promise<void>` and signal is `AbortSignal`. Constants are `as const` arrays / numbers — used identically across tasks.

**4. Spec requirements not covered** — Test row "Applies ±20% jitter to backoff" from spec §4 is covered by Task 2 step 1 (200-iteration assertion). All 12 spec tests are present somewhere in the plan (some grouped per task).

No issues found. Plan is complete.
