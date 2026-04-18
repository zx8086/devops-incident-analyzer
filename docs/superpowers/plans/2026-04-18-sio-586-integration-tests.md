# SIO-586: Server and Frontend Integration Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add integration tests for the SvelteKit SSE stream endpoint, the health endpoint, the agent store SSE parsing logic, and key chat UI components — verifying the request/stream/render path end-to-end with mocked agent and `fetch`.

**Architecture:** Epic 6 was implemented as the SvelteKit "Option A" — there is no `apps/server`. All HTTP surface area lives under `apps/web/src/routes/`. Tests run with `bun test` per the existing pattern in `apps/web/src/lib/server/agent.test.ts` (mock `@devops-agent/agent` with `mock.module`, then dynamic-import the unit under test). Webhook tests are explicitly out of scope (SIO-579 is not built).

**Tech Stack:** `bun:test`, `mock.module` for module mocks, `ReadableStream` for stream assertions, dynamic `import()` for hoisted-mock ordering, plain TypeScript imports of `+server.ts` for SvelteKit endpoints.

---

## Scope and non-goals

**In scope:**
- `apps/web/src/routes/api/agent/stream/+server.ts` — POST validation, SSE framing, event ordering, error path
- `apps/web/src/routes/health/+server.ts` — GET response shape and env-driven service flags
- `apps/web/src/lib/stores/agent.svelte.ts` — `handleEvent` SSE parser logic (extracted for testability) and SSE buffer line-splitting
- `apps/web/src/lib/components/FollowUpSuggestions.svelte` — render-with-data smoke test (chosen because it is the simplest pure-prop component and proves the component test harness works)

**Out of scope (per user direction):**
- Webhook endpoint tests (SIO-579 not implemented)
- Real LangGraph invocation, real MCP servers, real LangSmith calls
- Browser/E2E (Playwright) — Bun-test only
- Other components beyond `FollowUpSuggestions` (a follow-up issue can extend coverage)

## File Structure

**Create:**
- `apps/web/src/routes/api/agent/stream/server.test.ts` — POST endpoint integration tests
- `apps/web/src/routes/health/server.test.ts` — health endpoint tests
- `apps/web/src/lib/stores/agent.handleEvent.test.ts` — pure-function tests for the SSE event reducer
- `apps/web/src/lib/stores/sse-buffer.ts` — extracted pure helper that converts a chunk stream into parsed `StreamEvent` objects (currently inlined in `agent.svelte.ts` lines 99-118)
- `apps/web/src/lib/stores/sse-buffer.test.ts` — tests for the extracted helper
- `apps/web/src/lib/components/FollowUpSuggestions.test.ts` — render smoke test using `svelte/server` `render()`

**Modify:**
- `apps/web/src/lib/stores/agent.svelte.ts` — extract the inline SSE buffer-to-event loop (lines ~97-118) into `sse-buffer.ts` and consume it; extract `handleEvent` so the test file can import it without instantiating the store

No production behavior changes — only refactors that move existing logic into importable units.

## Testing strategy notes

- **Mock ordering:** `bun:test` requires `mock.module(...)` calls to execute *before* the module-under-test is imported. The existing `agent.test.ts` uses top-level `mock.module(...)` followed by `await import("./agent.ts")`. Mirror that pattern in every server test.
- **SSE assertion helper:** Several tests need to read a `Response` body that is an SSE stream. Define a local helper `collectSseEvents(response)` inside each test file (DRY across tests is fine; do not premature-extract a shared util — YAGNI).
- **Component testing:** Svelte 5 supports server-side rendering via `import { render } from "svelte/server"`. Use that for HTML-string assertions; do not pull in `@testing-library/svelte` (extra dep, requires jsdom — overkill for a smoke test).
- **No new deps:** The plan must not modify `package.json`. If a step appears to need a new dep, stop and ask.

---

## Task 1: Extract SSE buffer parsing into a pure helper

Refactor the inline reader/decoder/buffer loop out of `agent.svelte.ts` so it can be tested without the store.

**Files:**
- Create: `apps/web/src/lib/stores/sse-buffer.ts`
- Modify: `apps/web/src/lib/stores/agent.svelte.ts:97-118`
- Test: `apps/web/src/lib/stores/sse-buffer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/stores/sse-buffer.test.ts
import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@devops-agent/shared";
import { parseSseChunks } from "./sse-buffer.ts";

function chunksOf(...strings: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const s of strings) controller.enqueue(encoder.encode(s));
			controller.close();
		},
	});
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of parseSseChunks(stream)) out.push(event);
	return out;
}

describe("parseSseChunks", () => {
	test("parses one event per data: line", async () => {
		const stream = chunksOf(
			`data: ${JSON.stringify({ type: "message", content: "hello" })}\n\n`,
			`data: ${JSON.stringify({ type: "node_start", nodeId: "classify" })}\n\n`,
		);
		const events = await collect(stream);
		expect(events).toEqual([
			{ type: "message", content: "hello" },
			{ type: "node_start", nodeId: "classify" },
		]);
	});

	test("reassembles events split across chunk boundaries", async () => {
		const payload = `data: ${JSON.stringify({ type: "message", content: "split" })}\n\n`;
		const mid = Math.floor(payload.length / 2);
		const events = await collect(chunksOf(payload.slice(0, mid), payload.slice(mid)));
		expect(events).toEqual([{ type: "message", content: "split" }]);
	});

	test("skips malformed JSON without throwing", async () => {
		const stream = chunksOf(
			"data: {not-json}\n\n",
			`data: ${JSON.stringify({ type: "message", content: "ok" })}\n\n`,
		);
		const events = await collect(stream);
		expect(events).toEqual([{ type: "message", content: "ok" }]);
	});

	test("ignores lines that do not start with 'data: '", async () => {
		const stream = chunksOf(
			`event: ping\n`,
			`data: ${JSON.stringify({ type: "message", content: "x" })}\n\n`,
		);
		const events = await collect(stream);
		expect(events).toEqual([{ type: "message", content: "x" }]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/lib/stores/sse-buffer.test.ts`
Expected: FAIL — `Cannot find module './sse-buffer.ts'`.

- [ ] **Step 3: Implement `sse-buffer.ts`**

```ts
// apps/web/src/lib/stores/sse-buffer.ts
import type { StreamEvent } from "@devops-agent/shared";

export async function* parseSseChunks(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			try {
				yield JSON.parse(line.slice(6)) as StreamEvent;
			} catch {
				// Malformed events are skipped, matching the existing store behavior
			}
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/lib/stores/sse-buffer.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Wire the helper into the store**

Replace lines 97-118 of `apps/web/src/lib/stores/agent.svelte.ts`:

```ts
// Before
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
            const event = JSON.parse(line.slice(6)) as StreamEvent;
            handleEvent(event);
        } catch {
            // Skip malformed events
        }
    }
}
```

```ts
// After
import { parseSseChunks } from "./sse-buffer.ts";
// ...
for await (const event of parseSseChunks(response.body)) {
    handleEvent(event);
}
```

Add the `parseSseChunks` import alongside the existing imports at the top of the file.

- [ ] **Step 6: Verify nothing regressed**

Run: `bun run --filter '@devops-agent/web' typecheck`
Expected: 0 errors.

Run: `bun test apps/web/src/lib/stores/`
Expected: PASS — sse-buffer tests still pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/stores/sse-buffer.ts apps/web/src/lib/stores/sse-buffer.test.ts apps/web/src/lib/stores/agent.svelte.ts
git commit -m "SIO-586: Extract SSE buffer parser into testable helper"
```

---

## Task 2: Extract `handleEvent` into a pure reducer

Currently `handleEvent` is a closure inside `createAgentStore()` and mutates `$state` runes. Refactor it into a pure reducer that takes a state snapshot + event and returns a new snapshot — the store wraps it. This is the only way to test event handling without bootstrapping a Svelte runtime.

**Files:**
- Modify: `apps/web/src/lib/stores/agent.svelte.ts`
- Create: `apps/web/src/lib/stores/agent-reducer.ts`
- Test: `apps/web/src/lib/stores/agent.handleEvent.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/stores/agent.handleEvent.test.ts
import { describe, expect, test } from "bun:test";
import { applyStreamEvent, initialReducerState } from "./agent-reducer.ts";

describe("applyStreamEvent", () => {
	test("appends message content", () => {
		const next = applyStreamEvent(initialReducerState(), { type: "message", content: "hi " });
		const next2 = applyStreamEvent(next, { type: "message", content: "world" });
		expect(next2.currentContent).toBe("hi world");
	});

	test("tracks node_start and node_end transitions", () => {
		let state = initialReducerState();
		state = applyStreamEvent(state, { type: "node_start", nodeId: "classify" });
		expect(state.activeNodes.has("classify")).toBe(true);
		state = applyStreamEvent(state, { type: "node_end", nodeId: "classify", duration: 42 });
		expect(state.activeNodes.has("classify")).toBe(false);
		expect(state.completedNodes.get("classify")).toEqual({ duration: 42 });
	});

	test("captures suggestions", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "suggestions",
			suggestions: ["a", "b"],
		});
		expect(next.lastSuggestions).toEqual(["a", "b"]);
	});

	test("captures done event metadata", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "done",
			threadId: "t-1",
			runId: "r-1",
			responseTime: 123,
			toolsUsed: ["elastic_search"],
		});
		expect(next.threadId).toBe("t-1");
		expect(next.lastRunId).toBe("r-1");
		expect(next.lastResponseTime).toBe(123);
		expect(next.lastToolsUsed).toEqual(["elastic_search"]);
	});

	test("appends error message to current content", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "error",
			message: "boom",
		});
		expect(next.currentContent).toContain("boom");
	});

	test("records pending_actions", () => {
		const next = applyStreamEvent(initialReducerState(), {
			type: "pending_actions",
			actions: [
				{
					id: "a-1",
					type: "investigate",
					title: "Check logs",
					description: "Look at error logs",
					category: "investigate",
					risk: "low",
					tool: { server: "elastic", name: "search" },
					params: {},
				},
			],
		});
		expect(next.pendingActions).toHaveLength(1);
		expect(next.pendingActions[0].id).toBe("a-1");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/web/src/lib/stores/agent.handleEvent.test.ts`
Expected: FAIL — `Cannot find module './agent-reducer.ts'`.

- [ ] **Step 3: Create the reducer**

```ts
// apps/web/src/lib/stores/agent-reducer.ts
import type {
	ActionResult,
	DataSourceContext,
	PendingAction,
	StreamEvent,
} from "@devops-agent/shared";

export interface ReducerState {
	currentContent: string;
	threadId: string;
	activeNodes: Set<string>;
	completedNodes: Map<string, { duration: number }>;
	dataSourceProgress: Map<string, { status: string; message?: string }>;
	lastSuggestions: string[];
	lastResponseTime: number | undefined;
	lastToolsUsed: string[];
	lastRunId: string | undefined;
	lastConfidence: number | undefined;
	lastDataSourceContext: DataSourceContext | undefined;
	pendingActions: PendingAction[];
	actionResults: ActionResult[];
}

export function initialReducerState(): ReducerState {
	return {
		currentContent: "",
		threadId: "",
		activeNodes: new Set(),
		completedNodes: new Map(),
		dataSourceProgress: new Map(),
		lastSuggestions: [],
		lastResponseTime: undefined,
		lastToolsUsed: [],
		lastRunId: undefined,
		lastConfidence: undefined,
		lastDataSourceContext: undefined,
		pendingActions: [],
		actionResults: [],
	};
}

export function applyStreamEvent(state: ReducerState, event: StreamEvent): ReducerState {
	switch (event.type) {
		case "message":
			return { ...state, currentContent: state.currentContent + event.content };
		case "tool_call":
			return state;
		case "datasource_progress": {
			const next = new Map(state.dataSourceProgress);
			next.set(event.dataSourceId, { status: event.status, message: event.message });
			return { ...state, dataSourceProgress: next };
		}
		case "node_start": {
			const next = new Set(state.activeNodes);
			next.add(event.nodeId);
			return { ...state, activeNodes: next };
		}
		case "node_end": {
			const active = new Set(state.activeNodes);
			active.delete(event.nodeId);
			const completed = new Map(state.completedNodes);
			completed.set(event.nodeId, { duration: event.duration });
			return { ...state, activeNodes: active, completedNodes: completed };
		}
		case "suggestions":
			return { ...state, lastSuggestions: event.suggestions };
		case "pending_actions":
			return { ...state, pendingActions: event.actions };
		case "done":
			return {
				...state,
				threadId: event.threadId,
				lastResponseTime: event.responseTime,
				lastToolsUsed: event.toolsUsed ?? [],
				lastRunId: event.runId,
				lastConfidence: event.confidence,
				lastDataSourceContext: event.dataSourceContext,
			};
		case "error":
			return { ...state, currentContent: state.currentContent + `\n\n[Error: ${event.message}]` };
		case "low_confidence":
			return state;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/web/src/lib/stores/agent.handleEvent.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Wire reducer into the store (do not change store API)**

In `agent.svelte.ts`, replace the body of the existing `handleEvent(event)` function (currently lines ~152-190) with calls that delegate to `applyStreamEvent` and copy the resulting fields back into the runes:

```ts
import { applyStreamEvent, initialReducerState } from "./agent-reducer.ts";

// inside createAgentStore(), replace the existing handleEvent function:
function handleEvent(event: StreamEvent) {
    const snapshot: ReducerState = {
        currentContent,
        threadId,
        activeNodes,
        completedNodes,
        dataSourceProgress,
        lastSuggestions,
        lastResponseTime,
        lastToolsUsed,
        lastRunId,
        lastConfidence,
        lastDataSourceContext,
        pendingActions,
        actionResults,
    };
    const next = applyStreamEvent(snapshot, event);
    currentContent = next.currentContent;
    threadId = next.threadId;
    activeNodes = next.activeNodes;
    completedNodes = next.completedNodes;
    dataSourceProgress = next.dataSourceProgress;
    lastSuggestions = next.lastSuggestions;
    lastResponseTime = next.lastResponseTime;
    lastToolsUsed = next.lastToolsUsed;
    lastRunId = next.lastRunId;
    lastConfidence = next.lastConfidence;
    lastDataSourceContext = next.lastDataSourceContext;
    pendingActions = next.pendingActions;
    actionResults = next.actionResults;
}
```

Also add `import type { ReducerState } from "./agent-reducer.ts"` at the top.

- [ ] **Step 6: Verify nothing regressed**

Run: `bun run --filter '@devops-agent/web' typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/stores/agent-reducer.ts apps/web/src/lib/stores/agent.handleEvent.test.ts apps/web/src/lib/stores/agent.svelte.ts
git commit -m "SIO-586: Extract handleEvent into pure reducer for testability"
```

---

## Task 3: Health endpoint integration test

Verify the health endpoint returns the expected shape and reflects environment-driven service flags.

**Files:**
- Test: `apps/web/src/routes/health/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/routes/health/server.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const { GET } = await import("./+server.ts");

const ENV_KEYS = ["ELASTIC_MCP_URL", "KAFKA_MCP_URL", "COUCHBASE_MCP_URL", "KONNECT_MCP_URL"] as const;
type EnvKey = (typeof ENV_KEYS)[number];

describe("GET /health", () => {
	const original: Partial<Record<EnvKey, string | undefined>> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			original[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (original[key] === undefined) delete process.env[key];
			else process.env[key] = original[key];
		}
	});

	test("returns ok with all services false when no MCP URLs configured", async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);
		const body = (await response.json()) as {
			status: string;
			timestamp: string;
			services: Record<string, boolean>;
		};
		expect(body.status).toBe("ok");
		expect(typeof body.timestamp).toBe("string");
		expect(body.services).toEqual({
			elastic: false,
			kafka: false,
			couchbase: false,
			konnect: false,
		});
	});

	test("reflects configured MCP URLs as true", async () => {
		process.env.ELASTIC_MCP_URL = "http://localhost:9080";
		process.env.KAFKA_MCP_URL = "http://localhost:9081";
		const response = await GET({} as Parameters<typeof GET>[0]);
		const body = (await response.json()) as { services: Record<string, boolean> };
		expect(body.services.elastic).toBe(true);
		expect(body.services.kafka).toBe(true);
		expect(body.services.couchbase).toBe(false);
		expect(body.services.konnect).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test apps/web/src/routes/health/server.test.ts`
Expected: PASS — 2 tests. (No implementation needed — the endpoint already exists at `apps/web/src/routes/health/+server.ts`. This is a pure characterization test.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/health/server.test.ts
git commit -m "SIO-586: Add integration test for health endpoint"
```

---

## Task 4: Stream endpoint — request validation

Verify the POST endpoint rejects malformed bodies with 400.

**Files:**
- Test: `apps/web/src/routes/api/agent/stream/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/routes/api/agent/stream/server.test.ts
import { describe, expect, mock, test } from "bun:test";

mock.module("@devops-agent/agent", () => ({
	AttachmentError: class AttachmentError extends Error {},
	flushLangSmithCallbacks: mock(() => Promise.resolve()),
	processAttachments: mock(() => Promise.resolve({ contentBlocks: [], metadata: [], warnings: [] })),
}));

mock.module("@devops-agent/observability", () => ({
	traceSpan: mock(async (_name: string, _op: string, fn: () => Promise<unknown>) => fn()),
}));

mock.module("@devops-agent/shared", () => ({
	AttachmentBlockSchema: { parse: (v: unknown) => v },
	DataSourceContextSchema: { parse: (v: unknown) => v },
	redactPiiContent: (s: string) => s,
}));

const invokeAgentMock = mock(
	async (): Promise<AsyncIterable<Record<string, unknown>>> => ({
		async *[Symbol.asyncIterator]() {
			// no events
		},
	}),
);

mock.module("$lib/server/agent", () => ({
	invokeAgent: invokeAgentMock,
}));

const { POST } = await import("./+server.ts");

function makeRequest(body: unknown): Parameters<typeof POST>[0] {
	const request = new Request("http://localhost/api/agent/stream", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { request } as Parameters<typeof POST>[0];
}

describe("POST /api/agent/stream — validation", () => {
	test("returns 400 for missing messages field", async () => {
		const response = await POST(makeRequest({ threadId: "t-1" }));
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("Invalid request");
	});

	test("returns 400 for invalid role enum", async () => {
		const response = await POST(
			makeRequest({ messages: [{ role: "system", content: "x" }] }),
		);
		expect(response.status).toBe(400);
	});

	test("returns 400 for non-JSON body", async () => {
		const request = new Request("http://localhost/api/agent/stream", {
			method: "POST",
			body: "not-json",
		});
		const response = await POST({ request } as Parameters<typeof POST>[0]);
		expect(response.status).toBe(400);
	});
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test apps/web/src/routes/api/agent/stream/server.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/api/agent/stream/server.test.ts
git commit -m "SIO-586: Add validation tests for stream endpoint"
```

---

## Task 5: Stream endpoint — SSE happy path

Verify the endpoint returns a 200 SSE stream that emits `run_id`, forwards `message` chunks, and ends with `done`.

**Files:**
- Modify: `apps/web/src/routes/api/agent/stream/server.test.ts` (extend the existing file from Task 4)

- [ ] **Step 1: Add the SSE collector helper at the top of the test file (after the mocks, before `describe`)**

```ts
async function collectSse(response: Response): Promise<Record<string, unknown>[]> {
	expect(response.body).toBeTruthy();
	if (!response.body) return [];
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const events: Record<string, unknown>[] = [];
	let buffer = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			events.push(JSON.parse(line.slice(6)));
		}
	}
	return events;
}
```

- [ ] **Step 2: Write the failing test**

Add inside `describe("POST /api/agent/stream", ...)` (or a new `describe` block in the same file):

```ts
describe("POST /api/agent/stream — SSE stream", () => {
	test("emits run_id, forwards aggregator chunks, then done", async () => {
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					event: "on_chain_start",
					name: "classify",
				};
				yield {
					event: "on_chain_end",
					name: "classify",
					data: { output: {} },
				};
				yield {
					event: "on_chat_model_stream",
					tags: ["aggregate"],
					metadata: { langgraph_node: "aggregate" },
					data: { chunk: { content: "Hello " } },
				};
				yield {
					event: "on_chat_model_stream",
					tags: ["aggregate"],
					metadata: { langgraph_node: "aggregate" },
					data: { chunk: { content: "world." } },
				};
			},
		}));

		const response = await POST(
			makeRequest({
				messages: [{ role: "user", content: "ping" }],
				threadId: "thread-abc",
			}),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");

		const events = await collectSse(response);
		const types = events.map((e) => e.type);

		expect(types[0]).toBe("run_id");
		expect(types).toContain("node_start");
		expect(types).toContain("node_end");
		expect(types.filter((t) => t === "message")).toHaveLength(2);
		expect(types[types.length - 1]).toBe("done");

		const done = events[events.length - 1] as { threadId: string; runId: string };
		expect(done.threadId).toBe("thread-abc");
		expect(typeof done.runId).toBe("string");

		const messageContents = events
			.filter((e) => e.type === "message")
			.map((e) => e.content)
			.join("");
		expect(messageContents).toBe("Hello world.");
	});

	test("only forwards model stream chunks tagged for output nodes", async () => {
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					event: "on_chat_model_stream",
					tags: ["classify"],
					metadata: { langgraph_node: "classify" },
					data: { chunk: { content: "internal-only" } },
				};
				yield {
					event: "on_chat_model_stream",
					tags: ["responder"],
					metadata: { langgraph_node: "responder" },
					data: { chunk: { content: "user-facing" } },
				};
			},
		}));

		const response = await POST(
			makeRequest({ messages: [{ role: "user", content: "x" }] }),
		);
		const events = await collectSse(response);
		const messages = events.filter((e) => e.type === "message").map((e) => e.content);
		expect(messages).toEqual(["user-facing"]);
	});
});
```

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test apps/web/src/routes/api/agent/stream/server.test.ts`
Expected: PASS — all tests in the file (5 total).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/api/agent/stream/server.test.ts
git commit -m "SIO-586: Add SSE happy-path tests for stream endpoint"
```

---

## Task 6: Stream endpoint — error path

Verify the endpoint emits an `error` SSE event when the agent throws mid-stream, instead of crashing the response.

**Files:**
- Modify: `apps/web/src/routes/api/agent/stream/server.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new `describe` block to the existing file:

```ts
describe("POST /api/agent/stream — error path", () => {
	test("emits an SSE error event when the agent throws", async () => {
		invokeAgentMock.mockImplementationOnce(async () => ({
			async *[Symbol.asyncIterator]() {
				throw new Error("agent exploded");
			},
		}));

		const response = await POST(
			makeRequest({ messages: [{ role: "user", content: "trigger" }] }),
		);
		expect(response.status).toBe(200);

		const events = await collectSse(response);
		const errorEvent = events.find((e) => e.type === "error") as
			| { type: "error"; message: string }
			| undefined;
		expect(errorEvent).toBeDefined();
		expect(errorEvent?.message).toContain("agent exploded");
	});
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test apps/web/src/routes/api/agent/stream/server.test.ts`
Expected: PASS — 6 tests total in the file.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/api/agent/stream/server.test.ts
git commit -m "SIO-586: Verify stream endpoint reports agent errors via SSE"
```

---

## Task 7: Component render smoke test (FollowUpSuggestions)

Prove the Svelte 5 SSR test harness works with one simple, prop-driven component. Subsequent components can be added in follow-up issues.

**Files:**
- Test: `apps/web/src/lib/components/FollowUpSuggestions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/components/FollowUpSuggestions.test.ts
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import FollowUpSuggestions from "./FollowUpSuggestions.svelte";

describe("FollowUpSuggestions.svelte", () => {
	test("renders nothing when suggestions array is empty", () => {
		const { body } = render(FollowUpSuggestions, {
			props: { suggestions: [], onSelect: () => {} },
		});
		expect(body).not.toContain("Suggested follow-ups");
	});

	test("renders each suggestion as a button", () => {
		const suggestions = ["Check disk usage", "Restart the kafka broker"];
		const { body } = render(FollowUpSuggestions, {
			props: { suggestions, onSelect: () => {} },
		});
		expect(body).toContain("Suggested follow-ups");
		for (const s of suggestions) {
			expect(body).toContain(s);
		}
		const buttonCount = (body.match(/<button/g) ?? []).length;
		expect(buttonCount).toBe(suggestions.length);
	});
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test apps/web/src/lib/components/FollowUpSuggestions.test.ts`
Expected: PASS — 2 tests.

If it fails with "Cannot resolve `svelte/server`", stop and report — do not add a dependency. The Svelte 5 package already exposes this entry point.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/components/FollowUpSuggestions.test.ts
git commit -m "SIO-586: Add render smoke test for FollowUpSuggestions"
```

---

## Task 8: Final verification

Run the full web test suite and the workspace typecheck/lint to confirm no regressions.

- [ ] **Step 1: Run the web test suite**

Run: `bun run --filter '@devops-agent/web' test`
Expected: PASS — all new tests plus the pre-existing `agent.test.ts`.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: 0 errors across the workspace.

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: 0 errors. If Biome reports formatting issues in the new files, run `bun run lint:fix` and commit the fixups.

- [ ] **Step 4: Update Linear**

Move SIO-586 from Backlog -> In Review (do NOT mark Done — per project rules, only the user can mark Done). Add a comment summarizing what was tested, what was deferred (webhook tests — SIO-579 not implemented), and which two refactors were made (sse-buffer extraction, handleEvent reducer).

---

## Self-review notes

- **Spec coverage:** Original SIO-586 asks for (a) server SSE endpoint tests — Tasks 4-6; (b) webhook payload parsing — explicitly skipped per user direction; (c) health endpoint — Task 3; (d) frontend store SSE parsing — Tasks 1-2; (e) component rendering — Task 7; (f) E2E POST -> SSE -> render — covered by composing Task 5 (server emits valid stream) + Task 1-2 (client parses and reduces it correctly). A true browser E2E is out of scope for `bun test` and would need Playwright in a separate issue.
- **Type consistency:** `ReducerState` is defined in Task 2 and only consumed within the same file's tests; `parseSseChunks` signature is consistent across Tasks 1 and 5's helper.
- **No placeholders:** Every step has runnable code or an exact command.
