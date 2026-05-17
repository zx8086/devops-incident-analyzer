# MCP Lifecycle Unification + Chat Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the bespoke AgentCore proxy branch in `mcp-server-aws` and `mcp-server-kafka` into `createMcpApplication` (new `mode: "proxy"`), and bracket every chat request with `agent.request.start`/`.end`/`.error` Pino logs that share a single `{ threadId, runId, requestId }` correlation envelope propagated via `AsyncLocalStorage`, also surfacing in OTEL span attributes and LangSmith run tags.

**Architecture:** A new `RequestContext` `AsyncLocalStorage` lives in `packages/shared/src/request-context.ts` (same package as the existing pino mixin in `packages/shared/src/logger.ts`, which already injects OTEL `trace.id` and LangSmith `run_id`). The mixin gains three more fields read from that context. The SvelteKit `/api/agent/stream` and `/api/agent/topic-shift` endpoints wrap their work in `runWithRequestContext` and emit explicit lifecycle log lines. `invokeAgent` forwards `runName` + `tags` to `graph.streamEvents`, which LangGraph forwards to the LangSmith root run. The AgentCore SigV4-proxy bootstrap branch in aws/kafka collapses to `createMcpApplication({ mode: "proxy", createTransport: createAgentCoreProxyTransport(prefix) })`, gaining `initTracing`/`initTelemetry`/`uncaughtException`/`unhandledRejection`/structured shutdown plus an OTEL span around `proxy.connect`/`proxy.close`.

**Tech Stack:** TypeScript (strict), Bun, pino, OpenTelemetry, LangSmith, LangGraph, SvelteKit. Tests via `bun test`.

**Spec:** [docs/superpowers/specs/2026-05-17-mcp-lifecycle-and-chat-observability-design.md](../specs/2026-05-17-mcp-lifecycle-and-chat-observability-design.md)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/shared/src/request-context.ts` | CREATE | `RequestContext` interface, `AsyncLocalStorage`, `runWithRequestContext`, `getCurrentRequestContext` |
| `packages/shared/src/__tests__/request-context.test.ts` | CREATE | Unit tests for ALS storage + nested scopes + mixin integration |
| `packages/shared/src/logger.ts` | MODIFY | Extend existing mixin (lines 63-97) to inject `threadId`/`runId`/`requestId` when present |
| `packages/shared/src/index.ts` | MODIFY | Export `RequestContext`, `runWithRequestContext`, `getCurrentRequestContext` |
| `packages/shared/src/bootstrap.ts` | MODIFY | Add `mode?: "server" \| "proxy"`, make `createServerFactory` optional, gate logic on mode |
| `packages/shared/src/__tests__/bootstrap.test.ts` | MODIFY | Add 4 proxy-mode test cases |
| `packages/shared/src/transport/agentcore-proxy.ts` | CREATE | `createAgentCoreProxyTransport(prefix, logger)` with OTEL spans around connect/close |
| `packages/shared/src/transport/__tests__/agentcore-proxy.test.ts` | CREATE | Unit tests for the proxy transport |
| `packages/observability/src/index.ts` | MODIFY | Re-export `RequestContext`, `runWithRequestContext`, `getCurrentRequestContext` |
| `packages/mcp-server-aws/src/index.ts` | MODIFY | Replace bespoke proxy branch (lines 17-37) with `createMcpApplication({ mode: "proxy" })` |
| `packages/mcp-server-kafka/src/index.ts` | MODIFY | Replace bespoke proxy branch (lines 77-96) with `createMcpApplication({ mode: "proxy" })` |
| `apps/web/src/lib/server/langsmith-tags.ts` | CREATE | `buildLangSmithTags` helper |
| `apps/web/src/lib/server/agent.ts` | MODIFY | Accept `runName` + `tags`, forward to `graph.streamEvents` |
| `apps/web/src/routes/api/agent/stream/+server.ts` | MODIFY | Wrap in `runWithRequestContext`, emit start/end/error Pino logs, pass `runName` + `tags` |
| `apps/web/src/routes/api/agent/stream/server.test.ts` | MODIFY | Assert lifecycle logs, tags, AsyncLocalStorage propagation |
| `apps/web/src/routes/api/agent/topic-shift/+server.ts` | MODIFY | Same wrapping pattern with `resumed` tag |
| `apps/web/src/routes/api/agent/topic-shift/+server.test.ts` | CREATE or MODIFY | Resume lifecycle logs |

---

## Task 1: `RequestContext` AsyncLocalStorage primitive

**Files:**
- Create: `packages/shared/src/request-context.ts`
- Create: `packages/shared/src/__tests__/request-context.test.ts`

- [ ] **Step 1: Write failing test for context storage**

Create `packages/shared/src/__tests__/request-context.test.ts`:

```ts
// shared/src/__tests__/request-context.test.ts
import { describe, expect, test } from "bun:test";
import { getCurrentRequestContext, runWithRequestContext } from "../request-context.ts";

describe("RequestContext", () => {
	test("returns undefined outside runWithRequestContext", () => {
		expect(getCurrentRequestContext()).toBeUndefined();
	});

	test("returns the same context object inside the run", async () => {
		const ctx = { threadId: "t1", runId: "r1", requestId: "q1" };
		await runWithRequestContext(ctx, async () => {
			expect(getCurrentRequestContext()).toEqual(ctx);
		});
	});

	test("context survives an await", async () => {
		const ctx = { threadId: "t1", runId: "r1", requestId: "q1" };
		await runWithRequestContext(ctx, async () => {
			await Promise.resolve();
			expect(getCurrentRequestContext()).toEqual(ctx);
		});
	});

	test("nested run shadows outer context", async () => {
		const outer = { threadId: "outer-t", runId: "outer-r", requestId: "outer-q" };
		const inner = { threadId: "inner-t", runId: "inner-r", requestId: "inner-q" };
		await runWithRequestContext(outer, async () => {
			await runWithRequestContext(inner, async () => {
				expect(getCurrentRequestContext()).toEqual(inner);
			});
			expect(getCurrentRequestContext()).toEqual(outer);
		});
		expect(getCurrentRequestContext()).toBeUndefined();
	});

	test("context returned from fn is propagated as the value", async () => {
		const ctx = { threadId: "t1", runId: "r1", requestId: "q1" };
		const result = await runWithRequestContext(ctx, async () => "done");
		expect(result).toBe("done");
	});
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test packages/shared/src/__tests__/request-context.test.ts`

Expected: FAIL with "Cannot find module '../request-context.ts'" (module does not exist yet).

- [ ] **Step 3: Implement `request-context.ts`**

Create `packages/shared/src/request-context.ts`:

```ts
// shared/src/request-context.ts
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

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test packages/shared/src/__tests__/request-context.test.ts`

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/request-context.ts packages/shared/src/__tests__/request-context.test.ts
git commit -m "SIO-XXX: add RequestContext AsyncLocalStorage primitive in shared"
```

---

## Task 2: Export RequestContext from `@devops-agent/shared`

**Files:**
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add exports**

Modify `packages/shared/src/index.ts`. After the `read-only-chokepoint` export block (around line 154), add:

```ts
export {
	getCurrentRequestContext,
	type RequestContext,
	runWithRequestContext,
} from "./request-context.ts";
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run --filter '@devops-agent/shared' typecheck`

Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "SIO-XXX: export RequestContext from @devops-agent/shared"
```

---

## Task 3: Extend pino mixin to inject correlation IDs

**Files:**
- Modify: `packages/shared/src/logger.ts:63-97`
- Modify: `packages/shared/src/__tests__/request-context.test.ts` (add mixin integration test)

- [ ] **Step 1: Add failing mixin integration test**

Append to `packages/shared/src/__tests__/request-context.test.ts`:

```ts
import pino from "pino";
import { buildEcsOptions } from "../logger.ts";

describe("RequestContext + pino mixin", () => {
	function captureLogs() {
		const records: Array<Record<string, unknown>> = [];
		const dest = {
			write(data: string) {
				records.push(JSON.parse(data));
			},
		};
		const opts = buildEcsOptions({ serviceName: "test" });
		const logger = pino({ level: "info", ...opts }, dest).child({ service: "test" });
		return { logger, records };
	}

	test("logs inside runWithRequestContext include threadId/runId/requestId", async () => {
		const { logger, records } = captureLogs();
		await runWithRequestContext(
			{ threadId: "t-1", runId: "r-1", requestId: "q-1" },
			async () => {
				logger.info("inside");
			},
		);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ threadId: "t-1", runId: "r-1", requestId: "q-1" });
	});

	test("logs outside the run do NOT include those fields", () => {
		const { logger, records } = captureLogs();
		logger.info("outside");
		expect(records).toHaveLength(1);
		expect(records[0].threadId).toBeUndefined();
		expect(records[0].runId).toBeUndefined();
		expect(records[0].requestId).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test packages/shared/src/__tests__/request-context.test.ts`

Expected: FAIL — the "inside" record lacks `threadId`/`runId`/`requestId` because the mixin doesn't know about `RequestContext` yet.

- [ ] **Step 3: Extend mixin in `logger.ts`**

Open `packages/shared/src/logger.ts`. At the top of the file, add the import (place it alongside the existing imports near `getCurrentTrace`):

```ts
import { getCurrentRequestContext } from "./request-context.ts";
```

Find the existing `mixin()` function inside `buildEcsOptions` (around lines 63-97). At the end of the function, just before `return fields;`, add:

```ts
		// Chat request correlation (SIO-XXX)
		const reqCtx = getCurrentRequestContext();
		if (reqCtx) {
			fields.threadId = reqCtx.threadId;
			fields.runId = reqCtx.runId;
			fields.requestId = reqCtx.requestId;
		}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test packages/shared/src/__tests__/request-context.test.ts`

Expected: 7 PASS (5 original + 2 new).

- [ ] **Step 5: Run full shared test suite for regression**

Run: `bun run --filter '@devops-agent/shared' test`

Expected: all green. No existing test should break — new fields appear only when `runWithRequestContext` is on the stack.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/logger.ts packages/shared/src/__tests__/request-context.test.ts
git commit -m "SIO-XXX: inject threadId/runId/requestId via pino mixin"
```

---

## Task 4: Re-export RequestContext from `@devops-agent/observability`

**Files:**
- Modify: `packages/observability/src/index.ts`

- [ ] **Step 1: Add re-exports**

Modify `packages/observability/src/index.ts`. Add a new export line:

```ts
export {
	getCurrentRequestContext,
	type RequestContext,
	runWithRequestContext,
} from "@devops-agent/shared";
```

Final file content:

```ts
// observability/src/index.ts
export { getChildLogger, getLogger } from "./logger.ts";
export type { Span } from "./otel.ts";
export { getTracer, initOtel, SpanKind, SpanStatusCode, shutdownOtel, trace, traceSpan } from "./otel.ts";
export {
	getCurrentRequestContext,
	type RequestContext,
	runWithRequestContext,
} from "@devops-agent/shared";
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run --filter '@devops-agent/observability' typecheck`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/observability/src/index.ts
git commit -m "SIO-XXX: re-export RequestContext from observability for ergonomic imports"
```

---

## Task 5: Add `mode: "proxy"` to `createMcpApplication`

**Files:**
- Modify: `packages/shared/src/bootstrap.ts`
- Modify: `packages/shared/src/__tests__/bootstrap.test.ts`

- [ ] **Step 1: Write failing tests for proxy mode**

Append to `packages/shared/src/__tests__/bootstrap.test.ts`:

```ts
describe("createMcpApplication proxy mode", () => {
	test("mode: 'proxy' without createServerFactory does not throw", async () => {
		const { options, logger } = createTestOptions<{ proxy: string }>({
			initDatasource: async () => ({ proxy: "ok" }),
		});
		// Remove createServerFactory; proxy mode shouldn't need it
		const proxyOptions: McpApplicationOptions<{ proxy: string }> = {
			...options,
			mode: "proxy",
			createServerFactory: undefined,
		};
		const app = await createMcpApplication(proxyOptions);
		expect(app.datasource).toEqual({ proxy: "ok" });
		await app.shutdown();
		expect(exitCode).toBe(0);
	});

	test("mode: 'server' (default) without createServerFactory throws", async () => {
		const { options } = createTestOptions<{ x: number }>({
			initDatasource: async () => ({ x: 1 }),
		});
		const bad: McpApplicationOptions<{ x: number }> = {
			...options,
			createServerFactory: undefined,
		};
		// createMcpApplication catches and calls process.exit(1) on fatal error
		await expect(createMcpApplication(bad)).rejects.toThrow(/process\.exit\(1\)/);
	});

	test("mode: 'proxy' runs initTracing, telemetry, initDatasource, createTransport", async () => {
		const initTracing = mock(() => {});
		const initDatasource = mock(async () => ({ proxy: "ok" }));
		const createTransport = mock(async () => ({ closeAll: mock(async () => {}) }));
		const createServerFactory = mock((_ds: { proxy: string }) =>
			mock(() => ({}) as unknown as McpServer),
		);
		const { options } = createTestOptions<{ proxy: string }>({
			initDatasource,
		});
		await createMcpApplication({
			...options,
			mode: "proxy",
			initTracing,
			initDatasource,
			createTransport,
			createServerFactory, // should NOT be called in proxy mode
		});
		expect(initTracing).toHaveBeenCalledTimes(1);
		expect(initDatasource).toHaveBeenCalledTimes(1);
		expect(createTransport).toHaveBeenCalledTimes(1);
		expect(createServerFactory).not.toHaveBeenCalled();
	});

	test("mode: 'proxy' registers SIGINT/SIGTERM/uncaughtException/unhandledRejection handlers", async () => {
		const before = {
			sigint: process.listenerCount("SIGINT"),
			sigterm: process.listenerCount("SIGTERM"),
			uncaught: process.listenerCount("uncaughtException"),
			unhandled: process.listenerCount("unhandledRejection"),
		};
		const { options } = createTestOptions<{ proxy: string }>({
			initDatasource: async () => ({ proxy: "ok" }),
		});
		await createMcpApplication({ ...options, mode: "proxy", createServerFactory: undefined });
		expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
		expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
		expect(process.listenerCount("uncaughtException")).toBe(before.uncaught + 1);
		expect(process.listenerCount("unhandledRejection")).toBe(before.unhandled + 1);
	});
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test packages/shared/src/__tests__/bootstrap.test.ts`

Expected: 4 new tests FAIL — `mode` option doesn't exist yet and `createServerFactory` is still required.

- [ ] **Step 3: Modify `bootstrap.ts`**

Edit `packages/shared/src/bootstrap.ts`:

Change `McpApplicationOptions<T>` interface (lines 30-44):

```ts
export interface McpApplicationOptions<T> {
	name: string;
	logger: BootstrapLogger;
	initTracing: () => void;
	telemetry: TelemetryConfig;
	initDatasource: () => Promise<T>;
	mode?: "server" | "proxy";
	createServerFactory?: (datasource: T) => () => McpServer;
	createTransport: (
		serverFactory: (() => McpServer) | undefined,
		datasource: T,
	) => Promise<BootstrapTransportResult>;
	cleanupDatasource?: (datasource: T) => Promise<void>;
	onStarted?: (datasource: T) => void;
	readOnly?: ReadOnlyMiddlewareConfig;
}
```

In `createMcpApplication`, replace Step 4 (lines 67-75) with mode-aware logic:

```ts
		// Step 4: Create server factory (skipped in proxy mode)
		const mode = options.mode ?? "server";
		if (mode !== "proxy" && !options.createServerFactory) {
			throw new Error("createServerFactory is required when mode != 'proxy'");
		}
		const innerFactory =
			mode === "proxy" || !options.createServerFactory
				? undefined
				: options.createServerFactory(datasource);
		const readOnlyConfig = options.readOnly;
		const serverFactory: (() => McpServer) | undefined =
			innerFactory && readOnlyConfig
				? () => {
						const server = innerFactory();
						installReadOnlyChokepoint(server, readOnlyConfig.manager);
						return server;
					}
				: innerFactory;

		// Step 5: Start transport (serverFactory may be undefined in proxy mode)
		const transport = await options.createTransport(serverFactory, datasource);
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test packages/shared/src/__tests__/bootstrap.test.ts`

Expected: all original + 4 new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/bootstrap.ts packages/shared/src/__tests__/bootstrap.test.ts
git commit -m "SIO-XXX: add mode: 'proxy' option to createMcpApplication"
```

---

## Task 6: `createAgentCoreProxyTransport` helper

**Files:**
- Create: `packages/shared/src/transport/agentcore-proxy.ts`
- Create: `packages/shared/src/transport/__tests__/agentcore-proxy.test.ts`
- Modify: `packages/shared/src/index.ts` (re-export)

- [ ] **Step 1: Write failing tests**

Create `packages/shared/src/transport/__tests__/agentcore-proxy.test.ts`:

```ts
// shared/src/transport/__tests__/agentcore-proxy.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const startProxyMock = mock(async () => ({
	port: 3001,
	url: "http://localhost:3001/mcp",
	close: mock(async () => {}),
}));
const loadConfigMock = mock(() => ({
	runtimeArn: "arn:aws:bedrock-agentcore:eu-west-1:111111111111:runtime/test-rt-AAAA",
	region: "eu-west-1",
	port: 3001,
}));

mock.module("../../agentcore-proxy.ts", () => ({
	startAgentCoreProxy: startProxyMock,
	loadProxyConfigFromEnv: loadConfigMock,
}));

const spanCalls: Array<{ name: string; attrs?: Record<string, string | number>; ok?: boolean; err?: string }> = [];
mock.module("../../telemetry/telemetry.ts", () => ({
	traceSpan: async (
		_tracer: string,
		name: string,
		fn: () => Promise<unknown>,
		attrs?: Record<string, string | number>,
	) => {
		const call: { name: string; attrs?: Record<string, string | number>; ok?: boolean; err?: string } = {
			name,
			attrs,
		};
		spanCalls.push(call);
		try {
			const r = await fn();
			call.ok = true;
			return r;
		} catch (e) {
			call.ok = false;
			call.err = e instanceof Error ? e.message : String(e);
			throw e;
		}
	},
}));

const { createAgentCoreProxyTransport } = await import("../agentcore-proxy.ts");

function captureLogger() {
	const records: Array<{ level: string; msg: string; meta?: unknown }> = [];
	return {
		records,
		logger: {
			info: (msg: string, meta?: Record<string, unknown>) => records.push({ level: "info", msg, meta }),
			error: (msg: string, meta?: Record<string, unknown>) => records.push({ level: "error", msg, meta }),
			warn: (msg: string, meta?: Record<string, unknown>) => records.push({ level: "warn", msg, meta }),
		},
	};
}

describe("createAgentCoreProxyTransport", () => {
	beforeEach(() => {
		spanCalls.length = 0;
		startProxyMock.mockClear();
		loadConfigMock.mockClear();
	});

	test("loads config for the prefix and starts the proxy", async () => {
		const { logger } = captureLogger();
		await createAgentCoreProxyTransport("AWS", logger);
		expect(loadConfigMock).toHaveBeenCalledWith("AWS");
		expect(startProxyMock).toHaveBeenCalledTimes(1);
	});

	test("wraps connect in proxy.connect span with prefix attribute", async () => {
		const { logger } = captureLogger();
		await createAgentCoreProxyTransport("KAFKA", logger);
		const connect = spanCalls.find((c) => c.name === "proxy.connect");
		expect(connect).toBeDefined();
		expect(connect?.attrs).toMatchObject({ "proxy.prefix": "KAFKA" });
		expect(connect?.ok).toBe(true);
	});

	test("emits 'AgentCore proxy ready' log on connect", async () => {
		const { logger, records } = captureLogger();
		await createAgentCoreProxyTransport("AWS", logger);
		const ready = records.find((r) => r.msg === "AgentCore proxy ready");
		expect(ready).toBeDefined();
		expect(ready?.meta).toMatchObject({ prefix: "AWS", port: 3001 });
	});

	test("closeAll wraps proxy.close in proxy.close span and logs", async () => {
		const { logger, records } = captureLogger();
		const transport = await createAgentCoreProxyTransport("AWS", logger);
		await transport.closeAll();
		const close = spanCalls.find((c) => c.name === "proxy.close");
		expect(close).toBeDefined();
		expect(close?.attrs).toMatchObject({ "proxy.prefix": "AWS" });
		expect(close?.ok).toBe(true);
		const closedLog = records.find((r) => r.msg === "AgentCore proxy closed");
		expect(closedLog).toBeDefined();
	});

	test("propagates startProxy failure with error span", async () => {
		startProxyMock.mockImplementationOnce(async () => {
			throw new Error("boom");
		});
		const { logger } = captureLogger();
		await expect(createAgentCoreProxyTransport("AWS", logger)).rejects.toThrow("boom");
		const connect = spanCalls.find((c) => c.name === "proxy.connect");
		expect(connect?.ok).toBe(false);
		expect(connect?.err).toBe("boom");
	});
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test packages/shared/src/transport/__tests__/agentcore-proxy.test.ts`

Expected: FAIL with "Cannot find module '../agentcore-proxy.ts'".

- [ ] **Step 3: Implement `agentcore-proxy.ts` transport**

Create `packages/shared/src/transport/agentcore-proxy.ts`:

```ts
// shared/src/transport/agentcore-proxy.ts
import { loadProxyConfigFromEnv, startAgentCoreProxy } from "../agentcore-proxy.ts";
import type { BootstrapLogger, BootstrapTransportResult } from "../bootstrap.ts";
import { traceSpan } from "../telemetry/telemetry.ts";

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

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test packages/shared/src/transport/__tests__/agentcore-proxy.test.ts`

Expected: 5 PASS.

- [ ] **Step 5: Re-export from shared package**

Modify `packages/shared/src/index.ts`. Find the existing `transport/agentcore.ts` export block (around line 188) and add a sibling export below it:

```ts
export { createAgentCoreProxyTransport } from "./transport/agentcore-proxy.ts";
```

- [ ] **Step 6: Verify typecheck**

Run: `bun run --filter '@devops-agent/shared' typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/transport/agentcore-proxy.ts \
        packages/shared/src/transport/__tests__/agentcore-proxy.test.ts \
        packages/shared/src/index.ts
git commit -m "SIO-XXX: add createAgentCoreProxyTransport helper with OTEL spans"
```

---

## Task 7: Collapse AWS MCP proxy branch into `createMcpApplication`

**Files:**
- Modify: `packages/mcp-server-aws/src/index.ts`

- [ ] **Step 1: Read current file**

Open `packages/mcp-server-aws/src/index.ts`. The current proxy branch is at lines 17-37.

- [ ] **Step 2: Replace proxy branch**

Replace lines 17-37 of `packages/mcp-server-aws/src/index.ts` (the entire `if (process.env.AWS_AGENTCORE_RUNTIME_ARN) { … }` block) with:

```ts
	if (process.env.AWS_AGENTCORE_RUNTIME_ARN) {
		const { createAgentCoreProxyTransport, loadProxyConfigFromEnv } = await import("@devops-agent/shared");
		type AwsProxyDatasource = { config: ReturnType<typeof loadProxyConfigFromEnv> };

		createMcpApplication<AwsProxyDatasource>({
			name: "aws-mcp-server",
			logger: createBootstrapAdapter(logger),
			initTracing: () => initializeTracing(),
			telemetry: buildTelemetryConfig("aws-mcp-server"),
			mode: "proxy",
			initDatasource: async () => {
				const config = loadProxyConfigFromEnv("AWS");
				logger.info(
					{ arn: config.runtimeArn, transport: "agentcore-proxy" },
					"Starting AWS MCP Server",
				);
				return { config };
			},
			createTransport: async () =>
				createAgentCoreProxyTransport("AWS", createBootstrapAdapter(logger)),
			onStarted: (ds) => {
				logger.info(
					{ arn: ds.config.runtimeArn, transport: "agentcore-proxy" },
					"AWS MCP server ready",
				);
			},
		});
	} else {
```

(The `else` branch — existing server-mode `createMcpApplication` block — stays unchanged.)

- [ ] **Step 3: Run typecheck**

Run: `bun run --filter '@devops-agent/mcp-server-aws' typecheck`

Expected: PASS.

- [ ] **Step 4: Run aws MCP test suite**

Run: `bun run --filter '@devops-agent/mcp-server-aws' test`

Expected: PASS. No existing test covers the proxy branch, so no regression possible.

- [ ] **Step 5: Manual smoke test (proxy mode startup logs)**

In one shell:

```bash
AWS_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-west-1:352896877281:runtime/test-rt-AAAA \
AWS_ACCESS_KEY_ID=dummy AWS_SECRET_ACCESS_KEY=dummy \
  bun run --filter '@devops-agent/mcp-server-aws' start &
PID=$!
sleep 3
kill -INT $PID
wait $PID 2>/dev/null
```

Expected log sequence (order matters):
- `Initializing datasource for aws-mcp-server`
- `Starting AWS MCP Server` (with `arn` field)
- `AgentCore proxy ready` (with `prefix=AWS, port, url`)
- `AWS MCP server ready`
- `aws-mcp-server started successfully`
- (on SIGINT) `Shutting down aws-mcp-server...`
- `AgentCore proxy closed` (with `prefix=AWS`)
- `aws-mcp-server shutdown completed`

If the proxy fails to connect because the runtime ARN is fake, that's fine — confirm the failure path runs through the same bootstrap catch (`Fatal error starting aws-mcp-server`) instead of the old bespoke branch.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server-aws/src/index.ts
git commit -m "SIO-XXX: collapse AWS MCP proxy branch into createMcpApplication"
```

---

## Task 8: Collapse Kafka MCP proxy branch into `createMcpApplication`

**Files:**
- Modify: `packages/mcp-server-kafka/src/index.ts`

- [ ] **Step 1: Read current file**

Open `packages/mcp-server-kafka/src/index.ts`. The current proxy branch is at lines 77-96.

- [ ] **Step 2: Replace proxy branch**

Replace lines 77-96 of `packages/mcp-server-kafka/src/index.ts` (the entire `if (process.env.KAFKA_AGENTCORE_RUNTIME_ARN) { … }` block) with:

```ts
	if (process.env.KAFKA_AGENTCORE_RUNTIME_ARN) {
		const { createAgentCoreProxyTransport, loadProxyConfigFromEnv } = await import("@devops-agent/shared");
		type KafkaProxyDatasource = { config: ReturnType<typeof loadProxyConfigFromEnv> };

		createMcpApplication<KafkaProxyDatasource>({
			name: "kafka-mcp-server",
			logger: createBootstrapAdapter(logger),
			initTracing: () => initializeTracing(),
			telemetry: buildTelemetryConfig("kafka-mcp-server"),
			mode: "proxy",
			initDatasource: async () => {
				const config = loadProxyConfigFromEnv("KAFKA");
				logger.info(
					{ arn: config.runtimeArn, transport: "agentcore-proxy" },
					"Starting Kafka MCP Server",
				);
				return { config };
			},
			createTransport: async () =>
				createAgentCoreProxyTransport("KAFKA", createBootstrapAdapter(logger)),
			onStarted: (ds) => {
				logger.info(
					{ arn: ds.config.runtimeArn, transport: "agentcore-proxy" },
					"Kafka MCP server ready",
				);
			},
		});
	} else {
```

(The `else` branch — existing server-mode `createMcpApplication` block — stays unchanged.)

- [ ] **Step 3: Run typecheck**

Run: `bun run --filter '@devops-agent/mcp-server-kafka' typecheck`

Expected: PASS.

- [ ] **Step 4: Run kafka MCP test suite**

Run: `bun run --filter '@devops-agent/mcp-server-kafka' test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server-kafka/src/index.ts
git commit -m "SIO-XXX: collapse Kafka MCP proxy branch into createMcpApplication"
```

---

## Task 9: `buildLangSmithTags` helper

**Files:**
- Create: `apps/web/src/lib/server/langsmith-tags.ts`
- Create: `apps/web/src/lib/server/langsmith-tags.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/web/src/lib/server/langsmith-tags.test.ts`:

```ts
// apps/web/src/lib/server/langsmith-tags.test.ts
import { describe, expect, test } from "bun:test";
import { buildLangSmithTags } from "./langsmith-tags.ts";

describe("buildLangSmithTags", () => {
	test("emits chat + thread tag with no datasources", () => {
		const tags = buildLangSmithTags({ threadId: "abc" });
		expect(tags).toEqual(["chat", "thread:abc", "datasources:auto"]);
	});

	test("includes sorted datasources tag", () => {
		const tags = buildLangSmithTags({ threadId: "abc", dataSources: ["kafka", "elastic"] });
		expect(tags).toContain("datasources:elastic,kafka");
	});

	test("appends follow-up tag when isFollowUp is true", () => {
		const tags = buildLangSmithTags({ threadId: "abc", isFollowUp: true });
		expect(tags).toContain("follow-up");
	});

	test("appends resumed tag when resumed is true", () => {
		const tags = buildLangSmithTags({ threadId: "abc", resumed: true });
		expect(tags).toContain("resumed");
	});
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun test apps/web/src/lib/server/langsmith-tags.test.ts`

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement helper**

Create `apps/web/src/lib/server/langsmith-tags.ts`:

```ts
// apps/web/src/lib/server/langsmith-tags.ts
export interface LangSmithTagOptions {
	threadId: string;
	dataSources?: string[];
	isFollowUp?: boolean;
	resumed?: boolean;
}

export function buildLangSmithTags(opts: LangSmithTagOptions): string[] {
	const tags = ["chat", `thread:${opts.threadId}`];
	tags.push(
		opts.dataSources && opts.dataSources.length > 0
			? `datasources:${[...opts.dataSources].sort().join(",")}`
			: "datasources:auto",
	);
	if (opts.isFollowUp) tags.push("follow-up");
	if (opts.resumed) tags.push("resumed");
	return tags;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test apps/web/src/lib/server/langsmith-tags.test.ts`

Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/langsmith-tags.ts apps/web/src/lib/server/langsmith-tags.test.ts
git commit -m "SIO-XXX: add buildLangSmithTags helper for chat run tagging"
```

---

## Task 10: Forward `runName` + `tags` from `invokeAgent` to LangGraph

**Files:**
- Modify: `apps/web/src/lib/server/agent.ts`

- [ ] **Step 1: Add `runName` + `tags` to options**

Open `apps/web/src/lib/server/agent.ts`. Find the `invokeAgent` options type (lines 69-83). Add two fields:

```ts
		runName?: string;
		tags?: string[];
```

The full options type becomes:

```ts
export async function invokeAgent(
	messages: Array<{ role: string; content: string }>,
	options: {
		threadId: string;
		runId?: string;
		dataSources?: string[];
		targetDeployments?: string[];
		isFollowUp?: boolean;
		dataSourceContext?: DataSourceContext;
		attachmentContentBlocks?: MessageContentComplex[];
		attachmentMeta?: AttachmentMeta[];
		metadata?: Record<string, unknown>;
		runName?: string;
		tags?: string[];
	},
) {
```

- [ ] **Step 2: Forward to `graph.streamEvents`**

Find the `graph.streamEvents` call (line 105+). Add `runName` and `tags` to the second-argument config object:

```ts
	return graph.streamEvents(
		{
			messages: langchainMessages,
			targetDataSources: options.dataSources ?? [],
			targetDeployments: options.targetDeployments ?? [],
			isFollowUp: options.isFollowUp ?? false,
			requestId,
			attachmentMeta: options.attachmentMeta ?? [],
			...(options.dataSourceContext && { dataSourceContext: options.dataSourceContext }),
		},
		{
			configurable: {
				thread_id: options.threadId,
				...(options.runId && { run_id: options.runId }),
			},
			version: "v2",
			recursionLimit: getGraphRecursionLimit(),
			signal: AbortSignal.timeout(getGraphTimeoutMs()),
			...(options.runName && { runName: options.runName }),
			...(options.tags && { tags: options.tags }),
			metadata: {
				...complianceToMetadata(getAgent().manifest.compliance),
				...options.metadata,
			},
		},
	);
```

Apply the same `runName` + `tags` pass-through pattern to `resumeAgent` (lines 134+) using `options.runName` / `options.tags` (also add those fields to its options type).

- [ ] **Step 3: Verify typecheck**

Run: `bun run --filter '@devops-agent/web' typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/server/agent.ts
git commit -m "SIO-XXX: forward runName + tags from invokeAgent to LangGraph streamEvents"
```

---

## Task 11: Wrap `/api/agent/stream` with `runWithRequestContext` + lifecycle logs

**Files:**
- Modify: `apps/web/src/routes/api/agent/stream/+server.ts`

- [ ] **Step 1: Update imports**

At the top of `apps/web/src/routes/api/agent/stream/+server.ts`, modify imports to include `runWithRequestContext`, `getLogger`, and `buildLangSmithTags`:

```ts
import { AttachmentError, flushLangSmithCallbacks, processAttachments } from "@devops-agent/agent";
import { getLogger, runWithRequestContext, traceSpan } from "@devops-agent/observability";
import { AttachmentBlockSchema, DataSourceContextSchema } from "@devops-agent/shared";
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getPendingInterrupt, invokeAgent } from "$lib/server/agent";
import { buildLangSmithTags } from "$lib/server/langsmith-tags";
import { emitTopicShiftPrompt, pumpEventStream } from "$lib/server/sse-pump";
import type { RequestHandler } from "./$types";

const log = getLogger("api.agent.stream");
```

- [ ] **Step 2: Wrap inside POST handler**

Find the `controller.start` body (lines 50-130) and wrap the entire `traceSpan` call inside `runWithRequestContext`. Inside, add the three lifecycle log lines.

Replace the existing `try { await traceSpan(...) } catch ...` block with:

```ts
				await runWithRequestContext({ threadId, runId, requestId }, async () => {
					log.info("agent.request.start");
					try {
						await traceSpan(
							"agent",
							"agent.request",
							async () => {
								const startTime = Date.now();

								// Send run_id immediately so client can submit feedback before graph output
								send({ type: "run_id", runId });

								// Send attachment warnings if any
								if (processedAttachments?.warnings.length) {
									send({ type: "attachment_warnings", warnings: processedAttachments.warnings });
								}

								const eventStream = await invokeAgent(body.messages, {
									threadId,
									runId,
									dataSources: body.dataSources,
									targetDeployments: body.targetDeployments,
									isFollowUp: body.isFollowUp,
									dataSourceContext: body.dataSourceContext,
									attachmentContentBlocks: processedAttachments?.contentBlocks,
									attachmentMeta: processedAttachments?.metadata,
									runName: "agent.request",
									tags: buildLangSmithTags({
										threadId,
										dataSources: body.dataSources,
										isFollowUp: body.isFollowUp,
									}),
									metadata: {
										request_id: requestId,
										session_id: threadId,
									},
								});

								const { toolsUsed } = await pumpEventStream(eventStream, send);

								await flushLangSmithCallbacks();

								const pendingInterrupt = await getPendingInterrupt(threadId);
								if (pendingInterrupt) {
									const surfaced = emitTopicShiftPrompt(send, threadId, pendingInterrupt.value);
									if (surfaced) {
										log.info(
											{ responseTime: Date.now() - startTime, interrupted: true },
											"agent.request.end",
										);
										return;
									}
								}

								const queriedDataSources = body.dataSources ?? [];
								const dataSourceContext =
									body.dataSourceContext ??
									(queriedDataSources.length > 0
										? {
												type: "EXPLICIT" as const,
												dataSources: queriedDataSources,
												scope: "all" as const,
											}
										: undefined);

								const responseTime = Date.now() - startTime;
								log.info(
									{ responseTime, toolsUsed: toolsUsed.length, toolNames: toolsUsed },
									"agent.request.end",
								);
								send({
									type: "done",
									threadId,
									requestId,
									runId,
									responseTime,
									toolsUsed,
									dataSourceContext,
								});
							},
							{ "request.id": requestId, "thread.id": threadId, "run.id": runId },
						);
					} catch (error) {
						log.error(
							{
								err:
									error instanceof Error
										? { message: error.message, stack: error.stack }
										: { message: String(error) },
							},
							"agent.request.error",
						);
						send({ type: "error", message: error instanceof Error ? error.message : "Unknown error" });
					}
				});
```

The outer `controller.close()` in the `finally` stays unchanged.

- [ ] **Step 3: Run typecheck**

Run: `bun run --filter '@devops-agent/web' typecheck`

Expected: PASS.

- [ ] **Step 4: Run lint**

Run: `bun run --filter '@devops-agent/web' lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/api/agent/stream/+server.ts
git commit -m "SIO-XXX: bracket /api/agent/stream with runWithRequestContext + lifecycle logs"
```

---

## Task 12: Tests for `/api/agent/stream` lifecycle logging

**Files:**
- Modify: `apps/web/src/routes/api/agent/stream/server.test.ts`

- [ ] **Step 1: Inspect existing test scaffolding**

Run: `bun test apps/web/src/routes/api/agent/stream/server.test.ts`

Expected: existing tests PASS. Note the mock setup pattern (mocks for `invokeAgent`, `pumpEventStream`, etc.) before adding new cases.

- [ ] **Step 2: Add lifecycle log capture + assertions**

Append the following describe block to `apps/web/src/routes/api/agent/stream/server.test.ts`. Reuse the existing test scaffolding (POST helper, mocks) — match the file's existing style:

```ts
import { runWithRequestContext, getCurrentRequestContext } from "@devops-agent/shared";

describe("/api/agent/stream lifecycle logging", () => {
	let logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>;
	let originalStdoutWrite: typeof process.stdout.write;

	beforeEach(() => {
		logs = [];
		originalStdoutWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
			try {
				const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
				for (const line of text.split("\n")) {
					if (!line.trim()) continue;
					try {
						const parsed = JSON.parse(line);
						if (parsed.msg) {
							logs.push({ level: parsed.level, msg: parsed.msg, meta: parsed });
						}
					} catch {
						// non-JSON line; ignore
					}
				}
			} catch {
				// ignore decoding errors
			}
			return originalStdoutWrite(chunk as string, ...(rest as []));
		}) as typeof process.stdout.write;
	});

	afterEach(() => {
		process.stdout.write = originalStdoutWrite;
	});

	test("emits agent.request.start with correlation IDs", async () => {
		// Issue a POST to the handler (reuse the helper the existing tests use)
		await postStream({ messages: [{ role: "user", content: "hello" }] });
		const start = logs.find((l) => l.msg === "agent.request.start");
		expect(start).toBeDefined();
		expect(start?.meta?.threadId).toBeTruthy();
		expect(start?.meta?.runId).toBeTruthy();
		expect(start?.meta?.requestId).toBeTruthy();
	});

	test("emits agent.request.end with responseTime and toolsUsed", async () => {
		await postStream({ messages: [{ role: "user", content: "hello" }] });
		const end = logs.find((l) => l.msg === "agent.request.end");
		expect(end).toBeDefined();
		expect(typeof end?.meta?.responseTime).toBe("number");
		expect(typeof end?.meta?.toolsUsed).toBe("number");
	});

	test("emits agent.request.error when invokeAgent throws", async () => {
		// Use the existing mocking mechanism to force invokeAgent to reject
		mockInvokeAgentToReject(new Error("boom"));
		await postStream({ messages: [{ role: "user", content: "hello" }] });
		const err = logs.find((l) => l.msg === "agent.request.error");
		expect(err).toBeDefined();
		expect(err?.level).toBe("error");
		expect((err?.meta?.err as { message?: string })?.message).toBe("boom");
	});

	test("invokeAgent receives runName 'agent.request' and chat tags", async () => {
		const invokeArgs = await captureInvokeAgentArgs(() =>
			postStream({
				messages: [{ role: "user", content: "hello" }],
				dataSources: ["elastic", "kafka"],
				isFollowUp: true,
			}),
		);
		expect(invokeArgs.runName).toBe("agent.request");
		expect(invokeArgs.tags).toContain("chat");
		expect(invokeArgs.tags).toContain(`thread:${invokeArgs.threadId}`);
		expect(invokeArgs.tags).toContain("datasources:elastic,kafka");
		expect(invokeArgs.tags).toContain("follow-up");
	});

	test("downstream code inside the handler sees the request context", async () => {
		let observed: ReturnType<typeof getCurrentRequestContext>;
		mockInvokeAgentImplementation(() => {
			observed = getCurrentRequestContext();
			return makeEmptyEventStream();
		});
		await postStream({ messages: [{ role: "user", content: "hello" }] });
		expect(observed).toBeDefined();
		expect(observed?.threadId).toBeTruthy();
		expect(observed?.runId).toBeTruthy();
		expect(observed?.requestId).toBeTruthy();
	});
});
```

> **Note for the implementer:** the helpers `postStream`, `mockInvokeAgentToReject`, `captureInvokeAgentArgs`, `mockInvokeAgentImplementation`, `makeEmptyEventStream` should already exist in the existing test file or be straightforward to add by following the file's existing pattern. If a helper is missing, add a minimal version that calls `POST` on the handler module directly with a mock Request.

- [ ] **Step 3: Run tests, verify pass**

Run: `bun test apps/web/src/routes/api/agent/stream/server.test.ts`

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/api/agent/stream/server.test.ts
git commit -m "SIO-XXX: test agent.request lifecycle logs + LangSmith tags + ALS propagation"
```

---

## Task 13: Wrap `/api/agent/topic-shift` with the same pattern

**Files:**
- Modify: `apps/web/src/routes/api/agent/topic-shift/+server.ts`

- [ ] **Step 1: Read current file**

Read `apps/web/src/routes/api/agent/topic-shift/+server.ts` to understand the current resume handler structure.

- [ ] **Step 2: Add imports**

At the top of the file, add (or extend existing imports):

```ts
import { getLogger, runWithRequestContext } from "@devops-agent/observability";
import { buildLangSmithTags } from "$lib/server/langsmith-tags";

const log = getLogger("api.agent.topic-shift");
```

- [ ] **Step 3: Mint correlation IDs and wrap**

Inside the POST handler, after parsing the body and obtaining `threadId` (it comes from the request body for resume):

```ts
const runId = crypto.randomUUID();
const requestId = crypto.randomUUID();

await runWithRequestContext({ threadId, runId, requestId }, async () => {
	log.info("agent.request.resume.start");
	const startTime = Date.now();
	try {
		// ... existing resume logic, but pass runName + tags through to resumeAgent ...
		await resumeAgent({
			threadId,
			resumeValue: body.resume,
			runName: "agent.request",
			tags: buildLangSmithTags({ threadId, resumed: true }),
			metadata: { request_id: requestId, session_id: threadId },
		});
		log.info({ responseTime: Date.now() - startTime }, "agent.request.resume.end");
	} catch (error) {
		log.error(
			{
				err:
					error instanceof Error
						? { message: error.message, stack: error.stack }
						: { message: String(error) },
			},
			"agent.request.resume.error",
		);
		throw error;
	}
});
```

> **Implementer note:** the exact structure depends on whether `/api/agent/topic-shift` returns a streaming response (SSE) or a one-shot JSON. If it streams, mirror the `runWithRequestContext` placement from Task 11. If it's one-shot, the wrap above is sufficient.

- [ ] **Step 4: Run typecheck**

Run: `bun run --filter '@devops-agent/web' typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/api/agent/topic-shift/+server.ts
git commit -m "SIO-XXX: bracket /api/agent/topic-shift resume with runWithRequestContext + logs"
```

---

## Task 14: Test for `/api/agent/topic-shift` resume lifecycle

**Files:**
- Create or Modify: `apps/web/src/routes/api/agent/topic-shift/+server.test.ts`

- [ ] **Step 1: Check whether a test file already exists**

Run: `ls apps/web/src/routes/api/agent/topic-shift/`

If a test file does not exist, create `apps/web/src/routes/api/agent/topic-shift/+server.test.ts` using the same scaffolding pattern as `apps/web/src/routes/api/agent/stream/server.test.ts`.

- [ ] **Step 2: Add resume lifecycle assertion**

```ts
describe("/api/agent/topic-shift lifecycle logging", () => {
	let logs: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>;
	let originalStdoutWrite: typeof process.stdout.write;

	beforeEach(() => {
		logs = [];
		// (reuse the stdout-capture pattern from Task 12)
	});

	afterEach(() => {
		process.stdout.write = originalStdoutWrite;
	});

	test("emits agent.request.resume.start and .resume.end", async () => {
		await postTopicShift({ threadId: "t-1", resume: { decision: "continue" } });
		const start = logs.find((l) => l.msg === "agent.request.resume.start");
		const end = logs.find((l) => l.msg === "agent.request.resume.end");
		expect(start).toBeDefined();
		expect(end).toBeDefined();
		expect(start?.meta?.threadId).toBe("t-1");
		expect(end?.meta?.responseTime).toBeGreaterThanOrEqual(0);
	});

	test("resumeAgent receives runName + resumed tag", async () => {
		const args = await captureResumeAgentArgs(() =>
			postTopicShift({ threadId: "t-1", resume: { decision: "continue" } }),
		);
		expect(args.runName).toBe("agent.request");
		expect(args.tags).toContain("chat");
		expect(args.tags).toContain("thread:t-1");
		expect(args.tags).toContain("resumed");
	});
});
```

- [ ] **Step 3: Run tests, verify pass**

Run: `bun test apps/web/src/routes/api/agent/topic-shift/+server.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/api/agent/topic-shift/+server.test.ts
git commit -m "SIO-XXX: test /api/agent/topic-shift resume lifecycle logs + resumed tag"
```

---

## Task 15: Full repo verification + manual probes

**Files:** (none)

- [ ] **Step 1: Run typecheck across the whole monorepo**

Run: `bun run typecheck`

Expected: PASS for all packages.

- [ ] **Step 2: Run lint**

Run: `bun run lint`

Expected: PASS (or only pre-existing warnings).

- [ ] **Step 3: Run full test suite**

Run: `bun run test`

Expected: all PASS.

- [ ] **Step 4: Manual probe — chat lifecycle visible in Pino + LangSmith**

In one shell:

```bash
lsof -i :5173 && kill -INT $(lsof -t -i :5173) 2>/dev/null; sleep 1
bun run --filter '@devops-agent/web' dev > /tmp/web.log 2>&1 &
WEB=$!
sleep 5
curl -N -X POST http://localhost:5173/api/agent/stream \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hello"}]}' &
CURL=$!
sleep 8
kill $CURL $WEB 2>/dev/null
```

Then:

```bash
grep -E "agent.request.(start|end|error)" /tmp/web.log
```

Expected: at least one `agent.request.start` and one `agent.request.end`, each carrying `threadId`, `runId`, `requestId` fields.

Verify in LangSmith:

```bash
LANGSMITH_API_KEY=$(grep "^LANGSMITH_API_KEY=" .env | cut -d= -f2) \
LANGSMITH_PROJECT=$(grep "^LANGSMITH_PROJECT=" .env | cut -d= -f2) \
  langsmith-fetch traces /tmp/traces --limit 1 --include-metadata
```

Expected: most recent run has name `agent.request` and tags including `chat`, `thread:<id>`, `datasources:auto`.

- [ ] **Step 5: Manual probe — AWS MCP proxy lifecycle**

```bash
AWS_AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:eu-west-1:352896877281:runtime/test-rt-AAAA \
AWS_ACCESS_KEY_ID=dummy AWS_SECRET_ACCESS_KEY=dummy \
  bun run --filter '@devops-agent/mcp-server-aws' start > /tmp/aws-mcp.log 2>&1 &
PID=$!
sleep 3
kill -INT $PID
wait $PID 2>/dev/null
grep -E "Initializing datasource|AgentCore proxy ready|AgentCore proxy closed|started successfully|shutdown completed" /tmp/aws-mcp.log
```

Expected: log lines appear in order:
- `Initializing datasource for aws-mcp-server`
- (if config valid) `AgentCore proxy ready`
- `aws-mcp-server started successfully`
- `Shutting down aws-mcp-server...`
- `AgentCore proxy closed`
- `aws-mcp-server shutdown completed`

If the fake ARN fails connect: expect `Fatal error starting aws-mcp-server` instead — the bootstrap catch path. Both outcomes confirm the unified lifecycle.

- [ ] **Step 6: Manual probe — Kafka MCP proxy lifecycle**

Same as Step 5 but with `KAFKA_AGENTCORE_RUNTIME_ARN` and `mcp-server-kafka`.

- [ ] **Step 7: Confirm port cleanup**

```bash
lsof -i :3001
```

Expected: no output (proxy port released after SIGINT).

- [ ] **Step 8: No commit needed** — verification only.

---

## Task 16: Update Linear issue with implementation summary

**Files:** (none)

- [ ] **Step 1: Append implementation summary**

The Linear issue created from this spec gets a comment summarizing the changes:

- Added `RequestContext` AsyncLocalStorage in `@devops-agent/shared`; pino mixin auto-stamps `threadId`/`runId`/`requestId` on every log record inside `runWithRequestContext`.
- Added `mode: "proxy"` to `createMcpApplication`; AWS and Kafka MCP servers' bespoke proxy branches collapsed into it, gaining `initTracing`, OTEL telemetry, `uncaughtException`/`unhandledRejection`, and structured shutdown.
- Added `createAgentCoreProxyTransport(prefix, logger)` with OTEL spans around `proxy.connect` / `proxy.close`.
- `/api/agent/stream` and `/api/agent/topic-shift` bracket each request with `agent.request.start` / `.end` (or `.resume.start` / `.resume.end`) / `.error` Pino logs, all carrying the same correlation envelope.
- `invokeAgent` and `resumeAgent` forward `runName: "agent.request"` and tags (`chat`, `thread:<id>`, `datasources:<list>`, `follow-up?`, `resumed?`) to the LangSmith root run.

- [ ] **Step 2: Update Linear status to "In Review"**

(After PR is opened.)

---

## Self-review (post-write)

**1. Spec coverage:**
- Step 1 (RequestContext ALS in shared) → Task 1, Task 2
- Step 2 (extend mixin) → Task 3
- Step 3 (mode: "proxy" in bootstrap) → Task 5
- Step 4 (createAgentCoreProxyTransport) → Task 6
- Step 5 (collapse AWS + Kafka branches) → Tasks 7, 8
- Step 6 (wrap /api/agent/stream + tags) → Tasks 9, 10, 11, 12
- Step 7 (forward runName + tags) → Task 10 (combined with bracketing prep)
- Step 8 (resume endpoint wrapping) → Tasks 13, 14

Spec testing strategy → Tasks 1, 3, 5, 6, 9, 12, 14. All five test files in the spec table are covered. Re-export from observability → Task 4.

**2. Placeholder scan:** No "TBD", "implement later", "add validation", or "similar to Task N" patterns. The two implementer-notes in Tasks 12 and 13 are explicit hand-offs to existing test scaffolding (not vague instructions), and they describe what to add if a helper is missing.

**3. Type consistency:**
- `RequestContext` has fields `threadId`, `runId`, `requestId` everywhere (Task 1, 3, 11, 13).
- `mode` value is `"server" | "proxy"` in bootstrap (Task 5) and used as literal `"proxy"` in Tasks 7, 8.
- `createAgentCoreProxyTransport` signature `(prefix: "AWS" | "KAFKA", logger: BootstrapLogger)` consistent in Tasks 6, 7, 8.
- `buildLangSmithTags(opts)` signature matches across Tasks 9, 11, 13.
- `runName: "agent.request"` value consistent in Tasks 10, 11, 13, 14.

No drift detected.
