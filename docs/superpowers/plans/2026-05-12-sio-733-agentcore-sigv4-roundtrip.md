# SIO-733: AgentCore SigV4 Round-Trip Integration Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an offline, deterministic integration test that exercises the full AgentCore SigV4 proxy path (sign + invoke + parse + retry + session-id) for `packages/shared/src/agentcore-proxy.ts`.

**Architecture:** Spin up `startAgentCoreProxy()` on an ephemeral port, swap `globalThis.fetch` with a programmable fake that captures outbound requests and returns canned `Response` objects (or throws Errors to simulate transport failures), then POST JSON-RPC payloads to the proxy's `/mcp` endpoint and assert on (a) outbound SigV4 headers and (b) inbound response shape. One additive production seam (`clearCredentialCache`) lets the suite reset the module-level credential cache between proxy restarts.

**Tech Stack:** Bun test runner, `bun:test` API, native `fetch`, native `Response`, no new dependencies. Existing `agentcore-proxy.ts` is the code under test.

**Spec:** `docs/superpowers/specs/2026-05-12-sio-733-agentcore-sigv4-roundtrip-design.md`

**Linear:** [SIO-733](https://linear.app/siobytes/issue/SIO-733) (In Progress)

**Branch:** `sio-733-agentcore-sigv4-roundtrip-test` (already cut from `main` at `fcde1c2`; design spec committed at `86b3bea`)

---

## File Structure

**Production (additive only):**
- Modify: `packages/shared/src/agentcore-proxy.ts` — add a single exported `clearCredentialCache()` function (5 LOC including a 2-line comment marking it as a test seam).

**Tests (new file):**
- Create: `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts` (~290 LOC):
  - Module-level env/fetch snapshot + restore.
  - Test helpers: `seedResponses`, `sseFrame`, `sseOk`, `sseInnerError`, `jsonRpcError`, `toolCall`, `callProxy`, `assertSigV4`.
  - Three `describe` blocks: happy paths (4 tests), inner-error paths (3 tests), transport-error paths (4 tests). 11 tests total.

**No package.json changes. No new deps.**

---

## Task 1: Add `clearCredentialCache` production seam

**Files:**
- Modify: `packages/shared/src/agentcore-proxy.ts:40-41` (where `cachedCreds` and `credsExpiresAt` are declared; the new function goes after this block, before `getCredentials`).

- [ ] **Step 1.1: Add the exported function**

Open `packages/shared/src/agentcore-proxy.ts`. Find the existing module-level declarations:

```typescript
let cachedCreds: AwsCreds | null = null;
let credsExpiresAt = 0;
```

Insert immediately after them (before `async function getCredentials`):

```typescript
// SIO-733: test seam. Lets the round-trip suite reset the cache between
// proxy restarts when credential env vars change mid-suite. Not used by
// production code.
export function clearCredentialCache(): void {
	cachedCreds = null;
	credsExpiresAt = 0;
}
```

Note: the project uses **tab indentation** (verified in the existing file). Match that exactly.

- [ ] **Step 1.2: Typecheck the shared package**

Run from repo root:

```bash
bun run --filter '@devops-agent/shared' typecheck
```

Expected: exit 0, no errors.

- [ ] **Step 1.3: Run existing shared tests to confirm no regression**

```bash
bun run --filter '@devops-agent/shared' test
```

Expected: all existing tests pass (the SIO-718 inner-status suite, bootstrap, immutable-log, kill-switch, logger-ecs, oauth, pii-redactor, read-only-chokepoint, retention).

- [ ] **Step 1.4: Commit**

```bash
git add packages/shared/src/agentcore-proxy.ts
git commit -m "$(cat <<'EOF'
SIO-733: add clearCredentialCache test seam to agentcore-proxy

Pure additive export, not called by production code. Enables the upcoming
round-trip test suite to reset the module-level credential cache between
proxy restarts (needed for the "omit x-amz-security-token when sessionToken
is unset" test, which mutates env between calls).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Scaffold the test file with imports, env setup, and lifecycle hooks

**Files:**
- Create: `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts`

- [ ] **Step 2.1: Create the file with imports + module-level snapshot**

Create `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts` with the following content (this is the file's complete state after Step 2.1):

```typescript
// packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
//
// SIO-733: end-to-end round-trip coverage for the AgentCore SigV4 proxy.
// Spins up startAgentCoreProxy() on an ephemeral port, intercepts the
// outbound fetch with a programmable fake, and asserts on signed headers,
// session-id propagation, retry behaviour, and response pass-through.
// Companion to the SIO-718 inner-status unit tests in
// ./agentcore-proxy-tool-status.test.ts.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	type AgentCoreProxyHandle,
	clearCredentialCache,
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
	process.env.MCP_SERVER_NAME = "mcp-server-roundtrip-test";
});

afterAll(() => {
	process.env = ORIG_ENV;
	globalThis.fetch = ORIG_FETCH;
});

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
	globalThis.fetch = ORIG_FETCH;
});
```

Notes:
- The file uses **tab indentation** to match the project convention.
- The `fetchResponder` signature returns `Response | Promise<Response>`. Errors are thrown synchronously inside the closure (see helper in Task 3); this signature is intentional and complete.
- `clearCredentialCache` is imported from the seam added in Task 1.

- [ ] **Step 2.2: Add a placeholder smoke test so the file isn't empty**

Append to the file:

```typescript
describe("agentcore-proxy round trip — scaffold", () => {
	test("proxy starts on an ephemeral port", () => {
		expect(proxy.port).toBeGreaterThan(0);
		expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	});
});
```

- [ ] **Step 2.3: Run the scaffold test**

```bash
bun run --filter '@devops-agent/shared' test --test-name-pattern "scaffold"
```

Expected: 1 test passes. Confirms the env-var setup, proxy startup, and fetch-swap teardown all work end-to-end before we layer on real assertions.

- [ ] **Step 2.4: Typecheck the shared package**

```bash
bun run --filter '@devops-agent/shared' typecheck
```

Expected: exit 0.

- [ ] **Step 2.5: Commit**

```bash
git add packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
git commit -m "$(cat <<'EOF'
SIO-733: scaffold round-trip test file with env setup + fetch swap

Module-level env snapshot/restore, per-test fetch-swap with call capture,
proxy lifecycle in beforeEach/afterEach. Placeholder scaffold test
confirms the harness boots cleanly. Real assertions added in subsequent
commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add response builders, payload factory, and seed/assert helpers

**Files:**
- Modify: `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts` (insert helpers after the `afterEach` block, before the scaffold `describe`).

- [ ] **Step 3.1: Insert response builders and seed helper**

Insert this block between the `afterEach(...)` closing brace and the `describe("agentcore-proxy round trip — scaffold")` block:

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

function jsonRpcErrorResponse(id: number, code: number, message: string): Response {
	return new Response(
		sseFrame({ jsonrpc: "2.0", id, error: { code, message } }),
		{ status: 200, headers: SSE_HEADERS },
	);
}

function toolCall(id: number, name: string, args: object = {}): object {
	return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

function seedResponses(...responses: (Response | Error)[]) {
	fetchResponder = (call) => {
		const r = responses[call];
		if (r === undefined) {
			throw new Error(
				`fake fetch: no response seeded for call ${call} (seeded ${responses.length})`,
			);
		}
		if (r instanceof Error) throw r;
		return r;
	};
}

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

const SIGV4_AUTH_RE =
	/^AWS4-HMAC-SHA256 Credential=AKIA[A-Z0-9]+\/\d{8}\/eu-central-1\/bedrock-agentcore\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=[0-9a-f]{64}$/;
const AMZ_DATE_RE = /^\d{8}T\d{6}Z$/;

function assertSigV4(call: { url: string; init: RequestInit }) {
	const expectedUrl =
		`https://bedrock-agentcore.${TEST_REGION}.amazonaws.com` +
		`/runtimes/${encodeURIComponent(TEST_ARN)}/invocations?qualifier=DEFAULT`;
	expect(call.url).toBe(expectedUrl);

	const headers = call.init.headers as Record<string, string>;
	const authMatch = headers.authorization?.match(SIGV4_AUTH_RE);
	expect(authMatch).not.toBeNull();

	const signedHeaders = authMatch?.[1]?.split(";") ?? [];
	expect(signedHeaders).toEqual(
		expect.arrayContaining(["accept", "content-type", "host", "x-amz-date", "x-amz-security-token"]),
	);

	expect(headers["x-amz-date"]).toMatch(AMZ_DATE_RE);
	expect(headers["x-amz-security-token"]).toBe("test-session-token");
	expect(headers["content-type"]).toBe("application/json");
	expect(headers.accept).toBe("application/json, text/event-stream");
	expect(headers.host).toBe(`bedrock-agentcore.${TEST_REGION}.amazonaws.com`);
}
```

Notes:
- Renamed `jsonRpcError` -> `jsonRpcErrorResponse` to avoid shadowing the conceptual term used in test names.
- `JSON_HEADERS` is exported here for use in Task 4 Test 2; if Biome flags it as unused later, we'll revisit.
- `callProxy` uses `ORIG_FETCH`, not the swapped global, so the test client itself never hits the fake.

- [ ] **Step 3.2: Run scaffold test to confirm helpers don't break the harness**

```bash
bun run --filter '@devops-agent/shared' test --test-name-pattern "scaffold"
```

Expected: still 1 test passes.

- [ ] **Step 3.3: Typecheck**

```bash
bun run --filter '@devops-agent/shared' typecheck
```

Expected: exit 0. If the test runner complains about unused `JSON_HEADERS`, Bun's `tsc`-like checker via TypeScript will allow it because module-level `const`s aren't unused-vars by default.

- [ ] **Step 3.4: Commit**

```bash
git add packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
git commit -m "$(cat <<'EOF'
SIO-733: add test helpers for response shaping and SigV4 assertions

Adds sseFrame/sseOk/sseInnerError/jsonRpcErrorResponse response builders,
toolCall payload factory, seedResponses for canned fetch sequences,
callProxy that uses the original (unswapped) fetch, and assertSigV4
helper with structural regex checks. No new tests yet -- helpers consumed
by upcoming Task 4 commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Implement happy-path tests (4 tests)

**Files:**
- Modify: `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts` (replace the scaffold `describe` with a proper happy-path `describe`).

- [ ] **Step 4.1: Replace the scaffold describe with the happy-paths describe**

Delete the entire `describe("agentcore-proxy round trip — scaffold", ...)` block and replace with:

```typescript
describe("agentcore-proxy round trip — happy paths", () => {
	test("200 + SSE-framed result passes through with SigV4 well-formed", async () => {
		seedResponses(sseOk(1, { content: [{ type: "text", text: "version=7.2.1" }] }));

		const { response, body } = await callProxy(toolCall(1, "kafka_get_cluster_info"));

		expect(response.status).toBe(200);
		expect(body).toContain("version=7.2.1");
		expect(fetchCalls).toHaveLength(1);
		assertSigV4(fetchCalls[0]!);
	});

	test("200 + raw JSON (no SSE framing) preserves content-type", async () => {
		const rawBody = JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			result: { content: [{ type: "text", text: "ok" }] },
		});
		seedResponses(new Response(rawBody, { status: 200, headers: JSON_HEADERS }));

		const { response, body } = await callProxy(toolCall(2, "noop"));

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(body).toBe(rawBody);
		expect(fetchCalls).toHaveLength(1);
	});

	test("mcp-session-id is captured from upstream and replayed on subsequent calls", async () => {
		seedResponses(
			sseOk(3, { content: [{ type: "text", text: "first" }] }, { "mcp-session-id": "sess-abc-123" }),
			sseOk(4, { content: [{ type: "text", text: "second" }] }),
		);

		const r1 = await callProxy(toolCall(3, "step1"));
		const r2 = await callProxy(toolCall(4, "step2"));

		expect(r1.response.status).toBe(200);
		expect(r2.response.status).toBe(200);
		expect(fetchCalls).toHaveLength(2);

		const call1Headers = fetchCalls[0]!.init.headers as Record<string, string>;
		const call2Headers = fetchCalls[1]!.init.headers as Record<string, string>;

		expect(call1Headers["mcp-session-id"]).toBeUndefined();
		expect(call2Headers["mcp-session-id"]).toBe("sess-abc-123");
	});

	test("omits x-amz-security-token when sessionToken is unset", async () => {
		// Sequence: close current proxy, mutate env, clear creds cache, restart.
		const savedToken = process.env.AGENTCORE_AWS_SESSION_TOKEN;
		await proxy.close();
		delete process.env.AGENTCORE_AWS_SESSION_TOKEN;
		clearCredentialCache();
		proxy = await startAgentCoreProxy();

		try {
			seedResponses(sseOk(5, { content: [{ type: "text", text: "ok" }] }));
			await callProxy(toolCall(5, "noop"));

			const headers = fetchCalls[0]!.init.headers as Record<string, string>;
			expect(headers["x-amz-security-token"]).toBeUndefined();

			const signedHeaders =
				headers.authorization?.match(SIGV4_AUTH_RE)?.[1]?.split(";") ?? [];
			expect(signedHeaders).not.toContain("x-amz-security-token");
		} finally {
			if (savedToken) process.env.AGENTCORE_AWS_SESSION_TOKEN = savedToken;
		}
	});
});
```

- [ ] **Step 4.2: Run the happy-path tests**

```bash
bun run --filter '@devops-agent/shared' test --test-name-pattern "happy paths"
```

Expected: 4 tests pass.

- [ ] **Step 4.3: If any fail, debug before moving on**

Most likely failure modes and what they mean:
- **"200 + SSE-framed result..."** fails on `assertSigV4` -> the `SIGV4_AUTH_RE` regex is too strict; print `headers.authorization` and tune the regex.
- **"mcp-session-id..."** fails on call 2 header check -> the proxy's `mcpSessionId` closure variable isn't updating; verify `respSessionId = response.headers.get("mcp-session-id")` is firing in `agentcore-proxy.ts:288`.
- **"omits x-amz-security-token..."** fails because the test inherits a cached cred -> confirm `clearCredentialCache()` is being called AFTER the env delete.

- [ ] **Step 4.4: Typecheck**

```bash
bun run --filter '@devops-agent/shared' typecheck
```

Expected: exit 0.

- [ ] **Step 4.5: Commit**

```bash
git add packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
git commit -m "$(cat <<'EOF'
SIO-733: add happy-path round-trip tests (SigV4, session-id, no-token)

Four tests cover: SigV4 contract (URL, Authorization scope, signed-header
set, x-amz-date format, host); raw-JSON content-type pass-through;
mcp-session-id capture and replay across two sequential calls; omission
of x-amz-security-token when no session token is configured.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Implement inner-error path tests (3 tests)

**Files:**
- Modify: `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts` (append after the happy-paths describe).

- [ ] **Step 5.1: Append the inner-error describe**

Append to the file:

```typescript
describe("agentcore-proxy round trip — inner-error paths", () => {
	test("inner isError ksqlDB 503 still returns HTTP 200 to the client", async () => {
		seedResponses(
			sseInnerError(
				6,
				"MCP error -32603: ksqlDB error 503: <html><body>503 Service Temporarily Unavailable</body></html>",
			),
		);

		const { response, body } = await callProxy(toolCall(6, "ksql_list_streams"));

		expect(response.status).toBe(200);
		expect(body).toContain('"isError":true');
		expect(body).toContain("ksqlDB error 503");
		expect(fetchCalls).toHaveLength(1);
	});

	test("jsonrpc-error envelope (top-level error, no result) passes through with 200", async () => {
		seedResponses(jsonRpcErrorResponse(7, -32600, "Invalid Request"));

		const { response, body } = await callProxy(toolCall(7, "kafka_bad_call"));

		expect(response.status).toBe(200);
		// SSE-framed; parse the data: line
		const dataLine = body.split("\n").find((l) => l.startsWith("data: "));
		expect(dataLine).toBeDefined();
		const parsed = JSON.parse(dataLine!.slice(6));
		expect(parsed.error).toEqual({ code: -32600, message: "Invalid Request" });
		expect(parsed.result).toBeUndefined();
	});

	test("unparseable response body passes through verbatim", async () => {
		seedResponses(
			new Response("totally not json", { status: 200, headers: SSE_HEADERS }),
		);

		const { response, body } = await callProxy(toolCall(8, "weird_tool"));

		expect(response.status).toBe(200);
		expect(body).toBe("totally not json");
		expect(fetchCalls).toHaveLength(1);
	});
});
```

- [ ] **Step 5.2: Run the inner-error tests**

```bash
bun run --filter '@devops-agent/shared' test --test-name-pattern "inner-error paths"
```

Expected: 3 tests pass.

- [ ] **Step 5.3: Typecheck**

```bash
bun run --filter '@devops-agent/shared' typecheck
```

Expected: exit 0.

- [ ] **Step 5.4: Commit**

```bash
git add packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
git commit -m "$(cat <<'EOF'
SIO-733: add inner-error round-trip tests (isError, jsonrpc-error, unparseable)

Three tests confirm the proxy is transparent to inner JSON-RPC semantics:
isError tool results return HTTP 200 (envelope vs inner), top-level
jsonrpc errors pass through unchanged, and unparseable bodies are
forwarded verbatim. These pin the contract that the proxy never rewrites
inner payloads.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Implement transport-error path tests (4 tests)

**Files:**
- Modify: `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts` (append after the inner-error describe).

- [ ] **Step 6.1: Append the transport-error describe**

Append to the file:

```typescript
describe("agentcore-proxy round trip — transport-error paths", () => {
	test("retryable ECONNRESET on attempt 1, success on attempt 2", async () => {
		seedResponses(
			new TypeError("fetch failed: ECONNRESET reading from upstream"),
			sseOk(9, { content: [{ type: "text", text: "recovered" }] }),
		);

		const { response, body } = await callProxy(toolCall(9, "kafka_list_topics"));

		expect(response.status).toBe(200);
		expect(body).toContain("recovered");
		expect(fetchCalls).toHaveLength(2);
	});

	test("retryable error twice -- 502 with JSON-RPC error envelope", async () => {
		seedResponses(
			new TypeError("fetch failed: ECONNRESET"),
			new TypeError("fetch failed: ECONNRESET"),
		);

		const { response, body } = await callProxy(toolCall(10, "kafka_list_topics"));

		expect(response.status).toBe(502);
		const parsed = JSON.parse(body);
		expect(parsed.jsonrpc).toBe("2.0");
		expect(parsed.error.code).toBe(-32000);
		expect(parsed.error.message).toMatch(/ECONNRESET/);
		expect(parsed.id).toBeNull();
		expect(fetchCalls).toHaveLength(2);
	});

	test("TimeoutError (AbortSignal.timeout shape) is treated as retryable", async () => {
		const timeoutErr = Object.assign(new Error("The operation was aborted"), {
			name: "TimeoutError",
		});
		seedResponses(timeoutErr, sseOk(11, { content: [{ type: "text", text: "ok" }] }));

		const { response, body } = await callProxy(toolCall(11, "kafka_describe_topic"));

		expect(response.status).toBe(200);
		expect(body).toContain("ok");
		expect(fetchCalls).toHaveLength(2);
	});

	test("non-retryable fetch failure -- 502 after a single attempt", async () => {
		seedResponses(new TypeError("DNS lookup failed for bedrock-agentcore"));

		const { response, body } = await callProxy(toolCall(12, "kafka_describe_topic"));

		expect(response.status).toBe(502);
		const parsed = JSON.parse(body);
		expect(parsed.error.message).toContain("DNS lookup failed");
		expect(fetchCalls).toHaveLength(1);
	});
});
```

Notes:
- The retry branch at `agentcore-proxy.ts:331-335` is triggered by `error.name === "TimeoutError"` OR `error.message.includes("aborted")` OR `error.message.includes("ECONNRESET")`. The retry-then-success test uses ECONNRESET; the TimeoutError test uses the `name` branch. Non-retryable uses "DNS lookup failed" which matches none of them.
- `Response.json(...)` in the proxy emits `application/json`, not SSE, for the 502 envelope, so `JSON.parse(body)` works directly.

- [ ] **Step 6.2: Run the transport-error tests**

```bash
bun run --filter '@devops-agent/shared' test --test-name-pattern "transport-error paths"
```

Expected: 4 tests pass.

- [ ] **Step 6.3: Typecheck**

```bash
bun run --filter '@devops-agent/shared' typecheck
```

Expected: exit 0.

- [ ] **Step 6.4: Commit**

```bash
git add packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts
git commit -m "$(cat <<'EOF'
SIO-733: add transport-error round-trip tests (retry, exhaustion, timeout)

Four tests pin retry semantics: ECONNRESET retries once and recovers,
two failures exhaust to a 502 with JSON-RPC error envelope, TimeoutError
is treated as retryable via the error.name branch, and non-retryable
failures return 502 after a single attempt (no retry storm). Closes the
last uncovered branch in agentcore-proxy.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Final verification across the repo

**Files:** (no edits, verification only)

- [ ] **Step 7.1: Full shared package test run**

```bash
bun run --filter '@devops-agent/shared' test
```

Expected: all existing tests plus the 11 new round-trip tests pass. No skips, no failures.

- [ ] **Step 7.2: Confirm kafka package still passes (cross-impact check)**

```bash
bun run --filter '@devops-agent/mcp-server-kafka' test
```

Expected: 283 tests pass (same as `main` baseline; the kafka package imports from `@devops-agent/shared` but our change is additive-only).

- [ ] **Step 7.3: Full repo typecheck**

```bash
bun run typecheck
```

Expected: exit 0 across all 12 packages.

- [ ] **Step 7.4: Full repo lint**

```bash
bun run lint
```

Expected: exits 1, but with only the **pre-existing** couchbase issue at `packages/mcp-server-couchbase/src/types/mcp.d.ts:36` (carried from `main`). No new failures from this PR. If `bun run lint:fix` auto-fixed the couchbase line, revert it — out of scope.

- [ ] **Step 7.5: Confirm no real AWS network calls happened**

This is structurally guaranteed by design: env creds short-circuit the `Bun.spawn(["aws", "configure", ...])` fallback at `agentcore-proxy.ts:54-58`, and every outbound `fetch` is intercepted by the swap. To verify there's no escape hatch, grep the test output for any `aws` CLI invocation or real `bedrock-agentcore` hostname resolution:

```bash
bun run --filter '@devops-agent/shared' test 2>&1 | grep -E "(aws configure|bedrock-agentcore\.eu-central-1\.amazonaws\.com)" || echo "OK: no real AWS calls observed"
```

Expected: `OK: no real AWS calls observed`. (The hostname appears only inside captured assertions, not outbound traffic; if the test harness somehow let a real fetch through, you'd see a DNS error or 403.)

- [ ] **Step 7.6: Test-count diff**

```bash
git log --oneline main..HEAD
```

Expected: 6 commits on the branch (1 spec, 1 prod seam, 1 scaffold, 1 helpers, 3 test commits). Wait — Tasks 4/5/6 are three separate commits; the spec was already on the branch before this plan. So the count from `main`:
1. Spec
2. Task 1 (prod seam)
3. Task 2 (scaffold)
4. Task 3 (helpers)
5. Task 4 (happy paths)
6. Task 5 (inner errors)
7. Task 6 (transport errors)

= **7 commits total** on the branch.

- [ ] **Step 7.7: Push the branch**

```bash
git push -u origin sio-733-agentcore-sigv4-roundtrip-test
```

- [ ] **Step 7.8: Open the PR**

Use `gh pr create` with a body that:
- Summarizes the change (1-2 bullets per Task).
- Calls out the **path deviation** from the Linear ticket (`packages/shared/` vs `packages/mcp-server-kafka/`).
- Calls out the **stale SDK reference** in the Linear ticket (raw `fetch`, not `BedrockAgentRuntimeClient`).
- Includes the verification command outputs (test counts, typecheck, lint).
- Links to the spec at `docs/superpowers/specs/2026-05-12-sio-733-agentcore-sigv4-roundtrip-design.md`.

Suggested title: `SIO-733: end-to-end AgentCore SigV4 round-trip test (11 tests)`

---

## Acceptance Criteria Map

From the spec:

| # | Criterion | Implemented in |
|---|---|---|
| 1 | Test file exists at `packages/shared/src/__tests__/agentcore-proxy-roundtrip.test.ts` | Task 2 |
| 2 | `bun run --filter '@devops-agent/shared' test` exits 0 with 11 new tests green | Task 7 Step 7.1 |
| 3 | Kafka package still passes (283) | Task 7 Step 7.2 |
| 4 | Full repo typecheck clean | Task 7 Step 7.3 |
| 5 | Lint no new failures | Task 7 Step 7.4 |
| 6 | No real AWS network calls | Task 7 Step 7.5 |
| 7 | SigV4 contract pinned | Task 4 Test 1 (`assertSigV4`) |
| 8 | Four SIO-718 states end-to-end | Task 4 Test 1 (ok), Task 5 Tests 1, 2, 3 |
| 9 | Retry semantics pinned | Task 6 (all 4 tests) |
| 10 | Session-id propagation pinned | Task 4 Test 3 |
| 11 | Production seam contained (only `clearCredentialCache`) | Task 1 |

---

## Out of Scope (do not touch in this PR)

- AgentCore redeploy (operational item, carried forward).
- Pre-existing couchbase lint error at `packages/mcp-server-couchbase/src/types/mcp.d.ts:36`.
- `KAFKA_TOOL_TIMEOUT_MS` missing from `packages/mcp-server-kafka/src/config/loader.ts` numberPaths.
- DELETE `/mcp` session reset tests, `/health` and `/ping` route tests.
- Refactoring `agentcore-proxy.ts` to inject `fetch` (test-only seam is the chosen approach).

---

## Common Pitfalls (read before starting)

1. **`process.exit(1)` on missing `AGENTCORE_RUNTIME_ARN`** — if you forget to set it in `beforeAll`, the test process dies before any test runs. Symptom: Bun reports "0 tests, exit code 1". Fix: confirm Step 2.1's `beforeAll` block.
2. **Module-level credential cache** — without `clearCredentialCache()` in `beforeEach`, the "no session token" test inherits a stale cached cred and fails non-deterministically based on test ordering. The seam exists for this reason.
3. **`globalThis.fetch` type cast** — Bun's `fetch` type is stricter than a hand-rolled async function. The `as typeof fetch` cast in Step 2.1 is required; without it, TypeScript complains about parameter overload mismatches.
4. **Tab indentation** — `agentcore-proxy.ts` and the SIO-718 test file both use tabs. Match exactly or Biome will flag it.
5. **Two-frame SSE responses** — the proxy reads `response.clone().text()` for tool-status logging (`agentcore-proxy.ts:303-305`). Our fakes are single-frame `Response`s, which is fine — `.clone()` works on any `Response`.
6. **`Response.json(error)` content-type** — the proxy's 502 error envelope is JSON, not SSE. The transport-error tests parse `body` directly with `JSON.parse`. The 200 success/inner-error tests have to strip the `data: ` prefix.

---

## Self-Review Notes

Spec coverage: every goal/criterion in the spec maps to a Task and Step (see Acceptance Criteria Map above). No gaps.

Placeholder scan: searched for TBD/TODO/implement-later — none present. All steps have concrete code or commands.

Type consistency: `AgentCoreProxyHandle` (Task 2), `clearCredentialCache` (Task 1 + Task 2 import), `fetchResponder` signature (Task 2 + Task 3 mutation), `sseFrame/sseOk/sseInnerError/jsonRpcErrorResponse/toolCall/seedResponses/callProxy/assertSigV4` (Task 3 definitions, Tasks 4-6 consumers) all match.

One ambiguity flagged and resolved inline: `jsonRpcError` in the spec was renamed to `jsonRpcErrorResponse` here to avoid shadowing the conceptual term used in describe blocks ("jsonrpc-error envelope"). Same behaviour, clearer name. Spec doesn't need updating because the spec body uses the term descriptively, not as a literal identifier.
