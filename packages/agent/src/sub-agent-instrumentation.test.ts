// packages/agent/src/sub-agent-instrumentation.test.ts

import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { type RunnableConfig, RunnableLambda } from "@langchain/core/runnables";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { z } from "zod";
import { type InstrumentContext, instrumentTools } from "./sub-agent-instrumentation.ts";

interface CapturedLog {
	event: string;
	bytes?: number;
	originalBytes?: number;
	finalBytes?: number;
	strategy?: string;
	[k: string]: unknown;
}

function makeLog(): {
	entries: CapturedLog[];
	logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
} {
	const entries: CapturedLog[] = [];
	return {
		entries,
		logger: {
			info: (payload: unknown) => {
				if (payload && typeof payload === "object") {
					entries.push(payload as CapturedLog);
				}
			},
			warn: () => {},
		},
	};
}

function bigHitsPayload(count = 200): string {
	const hits = Array.from({ length: count }, (_, i) => ({
		_index: "logs-prod",
		_id: `doc-${i}`,
		_source: { message: "x".repeat(1024) },
	}));
	return JSON.stringify({ hits: { total: { value: count, relation: "eq" }, hits } });
}

function buildFakeTool(payload: string) {
	return tool(async () => payload, {
		name: "fake_search",
		description: "Returns a fixed payload for tests.",
		schema: z.object({ q: z.string() }),
	});
}

function wrapOne(payload: string, ctx: Parameters<typeof instrumentTools>[1]) {
	const fake = buildFakeTool(payload);
	const wrapped = instrumentTools([fake], ctx)[0];
	if (!wrapped) throw new Error("instrumentTools returned empty array");
	return wrapped;
}

describe("instrumentTools", () => {
	test("emits subagent.tool_result with bytes and shape on every invocation", async () => {
		const { entries, logger } = makeLog();
		const wrapped = wrapOne(bigHitsPayload(5), { dataSourceId: "elastic", log: logger });

		const out = await wrapped.invoke({ q: "errors" });
		expect(out).toBeDefined();

		const observed = entries.find((e) => e.event === "subagent.tool_result");
		expect(observed).toBeDefined();
		expect(observed?.bytes).toBeGreaterThan(0);
		expect(observed?.contentType).toBe("object");
		expect(observed?.toolName).toBe("fake_search");
		expect(observed?.iteration).toBe(1);
	});

	test("does not truncate when capBytes is null", async () => {
		const { entries, logger } = makeLog();
		const payload = bigHitsPayload(200);
		const wrapped = wrapOne(payload, { dataSourceId: "elastic", log: logger, capBytes: null });

		const result = (await wrapped.invoke({ q: "errors" })) as ToolMessage | string;
		const text = typeof result === "string" ? result : String(result.content);
		expect(text.length).toBe(payload.length);
		expect(entries.find((e) => e.event === "subagent.tool_result_truncated")).toBeUndefined();
	});

	test("truncates oversized hits payload to first 3 hits when capBytes set", async () => {
		const { entries, logger } = makeLog();
		const payload = bigHitsPayload(200);
		const cap = 65_536;
		const wrapped = wrapOne(payload, { dataSourceId: "elastic", log: logger, capBytes: cap });

		// invoke with a tool_call so the underlying tool() returns a ToolMessage
		const result = await wrapped.invoke({
			id: "call_1",
			name: "fake_search",
			args: { q: "errors" },
			type: "tool_call",
		});

		const truncationLog = entries.find((e) => e.event === "subagent.tool_result_truncated");
		expect(truncationLog).toBeDefined();
		expect(truncationLog?.strategy).toBe("json-hits");
		expect(truncationLog?.originalBytes).toBeGreaterThan(cap);
		expect(truncationLog?.finalBytes).toBeLessThanOrEqual(cap);

		// Result should be a ToolMessage with truncated content
		expect(result).toBeInstanceOf(ToolMessage);
		const tm = result as ToolMessage;
		const finalText = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content);
		expect(Buffer.byteLength(finalText, "utf8")).toBeLessThanOrEqual(cap);

		const parsed = JSON.parse(finalText) as { hits: { hits: unknown[]; _truncated: boolean; _totalHits: number } };
		expect(parsed.hits.hits.length).toBe(3);
		expect(parsed.hits._truncated).toBe(true);
		expect(parsed.hits._totalHits).toBe(200);
	});

	test("preserves tool name and schema after wrapping", () => {
		const { logger } = makeLog();
		const wrapped = wrapOne("ok", { dataSourceId: "elastic", log: logger });
		expect(wrapped.name).toBe("fake_search");
		expect(wrapped.description).toBe("Returns a fixed payload for tests.");
		expect(wrapped.schema).toBeDefined();
	});

	// SIO-785 follow-up (2026-05-18): typed-finding tools must NOT be truncated
	// because the byte-boundary truncator breaks JSON and the downstream extractor
	// emits empty findings. Test name matches the allowlist in
	// sub-agent-instrumentation.ts:TYPED_FINDING_TOOLS.
	test("does NOT truncate connect_list_connectors even when oversized", async () => {
		const { entries, logger } = makeLog();
		// Build a connectors response that exceeds the cap.
		const connectors: Record<string, unknown> = {};
		const longKey = "x".repeat(50);
		const longVal = "y".repeat(500);
		for (let i = 0; i < 100; i++) {
			connectors[`C_SINK_${i}`] = {
				status: { connector: { state: "RUNNING" }, tasks: [{ id: 0, state: "RUNNING" }], type: "sink" },
				info: { config: { [longKey]: longVal } },
			};
		}
		const payload = JSON.stringify({ connectors, count: 100 });
		const fake = tool(async () => payload, {
			name: "connect_list_connectors",
			description: "Test fixture",
			schema: z.object({}),
		});
		const wrapped = instrumentTools([fake], { dataSourceId: "kafka", log: logger, capBytes: 32_768 })[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		const result = await wrapped.invoke({
			id: "call_1",
			name: "connect_list_connectors",
			args: {},
			type: "tool_call",
		});

		// No truncation log
		expect(entries.find((e) => e.event === "subagent.tool_result_truncated")).toBeUndefined();
		// New skip log present
		const skipLog = entries.find((e) => e.event === "subagent.tool_result_truncation_skipped");
		expect(skipLog).toBeDefined();
		expect(skipLog?.toolName).toBe("connect_list_connectors");
		expect(skipLog?.reason).toBe("typed-finding tool");

		// Result content preserved at full length
		const tm = result as ToolMessage;
		const finalText = typeof tm.content === "string" ? tm.content : JSON.stringify(tm.content);
		expect(finalText.length).toBe(payload.length);
		// Parseable as JSON
		const parsed = JSON.parse(finalText) as { connectors: Record<string, unknown>; count: number };
		expect(parsed.count).toBe(100);
		expect(Object.keys(parsed.connectors)).toHaveLength(100);
	});

	test("does NOT truncate kafka_list_consumer_groups, ksql_list_queries, kafka_list_dlq_topics, aws_cloudwatch_describe_alarms, findLinkedIncidents", async () => {
		// SIO-785 Phase 2 (2026-05-18): aws + atlassian extractors added to the
		// typed-finding allowlist alongside the existing kafka core tools.
		const cases = [
			"kafka_list_consumer_groups",
			"ksql_list_queries",
			"kafka_list_dlq_topics",
			"aws_cloudwatch_describe_alarms",
			"findLinkedIncidents",
		];
		for (const name of cases) {
			const { entries, logger } = makeLog();
			const payload = bigHitsPayload(200); // 200KB+ payload, oversized
			const fake = tool(async () => payload, { name, description: "x", schema: z.object({}) });
			const wrapped = instrumentTools([fake], { dataSourceId: "kafka", log: logger, capBytes: 32_768 })[0];
			if (!wrapped) throw new Error("instrumentTools returned empty array");
			await wrapped.invoke({ id: "c", name, args: {}, type: "tool_call" });
			expect(entries.find((e) => e.event === "subagent.tool_result_truncated")).toBeUndefined();
			expect(entries.find((e) => e.event === "subagent.tool_result_truncation_skipped")?.toolName).toBe(name);
		}
	});

	test("still truncates non-allowlisted tools (regression guard for the skip path)", async () => {
		const { entries, logger } = makeLog();
		const payload = bigHitsPayload(200);
		const fake = tool(async () => payload, {
			name: "kafka_consume_messages", // NOT in allowlist
			description: "x",
			schema: z.object({}),
		});
		const wrapped = instrumentTools([fake], { dataSourceId: "kafka", log: logger, capBytes: 32_768 })[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");
		await wrapped.invoke({ id: "c", name: "kafka_consume_messages", args: {}, type: "tool_call" });
		// Truncation log present
		expect(entries.find((e) => e.event === "subagent.tool_result_truncated")).toBeDefined();
		// Skip log absent
		expect(entries.find((e) => e.event === "subagent.tool_result_truncation_skipped")).toBeUndefined();
	});

	test("increments iteration counter across multiple invocations", async () => {
		const { entries, logger } = makeLog();
		const wrapped = wrapOne("small", { dataSourceId: "elastic", log: logger });

		await wrapped.invoke({ q: "a" });
		await wrapped.invoke({ q: "b" });
		await wrapped.invoke({ q: "c" });

		const observed = entries.filter((e) => e.event === "subagent.tool_result");
		expect(observed.map((e) => e.iteration)).toEqual([1, 2, 3]);
	});
});

// SIO-1029: the loop guard short-circuits repeated/unproductive elasticsearch_search
// calls so the elastic sub-agent stops looping on empty results before it blows the
// recursion limit.
describe("SIO-1029: elasticsearch_search loop guard", () => {
	const EMPTY_SEARCH = "Total results: 0, showing 0 from position 0";

	function buildCountingSearchTool(payload: string) {
		let calls = 0;
		const t = tool(
			async () => {
				calls += 1;
				return payload;
			},
			{
				name: "elasticsearch_search",
				description: "Test fixture that counts underlying invocations.",
				schema: z.object({ index: z.string(), q: z.string() }),
			},
		);
		return { tool: t, getCalls: () => calls };
	}

	function buildDiscoverySearchTool() {
		// A discovery agg needs a service.name terms aggregation with size:0.
		let calls = 0;
		const t = tool(
			async () => {
				calls += 1;
				return EMPTY_SEARCH;
			},
			{
				name: "elasticsearch_search",
				description: "Test fixture with an open schema so discovery aggs pass validation.",
				schema: z
					.object({
						index: z.string().optional(),
						q: z.string().optional(),
						size: z.number().optional(),
						aggs: z.unknown().optional(),
					})
					.passthrough(),
			},
		);
		return { tool: t, getCalls: () => calls };
	}

	// SIO-1084: discovery-aware guard. Two literal-name empties must NOT stop the
	// agent before the service.name discovery aggregation runs.
	test("does NOT short-circuit two literal empties before discovery has run", async () => {
		const { logger } = makeLog();
		const { tool: fake, getCalls } = buildDiscoverySearchTool();
		const wrapped = instrumentTools([fake], { dataSourceId: "elastic", log: logger })[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		await wrapped.invoke({
			id: "c1",
			name: "elasticsearch_search",
			args: { index: "logs-*", q: "a" },
			type: "tool_call",
		});
		await wrapped.invoke({
			id: "c2",
			name: "elasticsearch_search",
			args: { index: "logs-apm.*", q: "b" },
			type: "tool_call",
		});
		// The discovery agg is allowed through even though two empties preceded it.
		await wrapped.invoke({
			id: "c3",
			name: "elasticsearch_search",
			args: { size: 0, aggs: { by_service: { terms: { field: "service.name", size: 50 } } } },
			type: "tool_call",
		});

		expect(getCalls()).toBe(3); // none short-circuited
	});

	// SIO-1090: the discovery-aware soft stop (budget of 2) is gone. The only elastic
	// termination guarantees now are exact-duplicate detection and the hard cap of 5
	// TOTAL unproductive searches -- so a discovery empty + one more distinct empty
	// (2 total) must NOT stop the third distinct call.
	test("does not short-circuit distinct calls before the hard cap, even after discovery", async () => {
		const { logger } = makeLog();
		const { tool: fake, getCalls } = buildDiscoverySearchTool();
		const wrapped = instrumentTools([fake], { dataSourceId: "elastic", log: logger })[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		// discovery empty (counts as 1) ...
		await wrapped.invoke({
			id: "c1",
			name: "elasticsearch_search",
			args: { size: 0, aggs: { by_service: { terms: { field: "service.name" } } } },
			type: "tool_call",
		});
		// ... one more distinct empty (counts as 2, still below the hard cap of 5) ...
		await wrapped.invoke({
			id: "c2",
			name: "elasticsearch_search",
			args: { index: "logs-*", q: "b" },
			type: "tool_call",
		});
		// ... the third distinct call still runs.
		await wrapped.invoke({
			id: "c3",
			name: "elasticsearch_search",
			args: { index: "metrics-*", q: "c" },
			type: "tool_call",
		});

		expect(getCalls()).toBe(3);
	});

	test("short-circuits once the hard cap of unproductive searches is exhausted", async () => {
		const { entries, logger } = makeLog();
		const { tool: fake, getCalls } = buildDiscoverySearchTool();
		const wrapped = instrumentTools([fake], { dataSourceId: "elastic", log: logger })[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		// discovery empty (1) + 4 more distinct empties = 5 total, exhausting MAX_UNPRODUCTIVE_SEARCHES.
		await wrapped.invoke({
			id: "c1",
			name: "elasticsearch_search",
			args: { size: 0, aggs: { by_service: { terms: { field: "service.name" } } } },
			type: "tool_call",
		});
		for (let i = 0; i < 4; i++) {
			await wrapped.invoke({
				id: `c${i + 2}`,
				name: "elasticsearch_search",
				args: { index: "logs-*", q: `perm-${i}` },
				type: "tool_call",
			});
		}
		// The 6th distinct call is short-circuited by the hard cap.
		const sixth = await wrapped.invoke({
			id: "c6",
			name: "elasticsearch_search",
			args: { index: "metrics-*", q: "final" },
			type: "tool_call",
		});

		expect(getCalls()).toBe(5);
		const stopText = sixth instanceof ToolMessage ? String(sixth.content) : String(sixth);
		expect(stopText).toContain("Stop searching");
		expect(entries.find((e) => e.event === "subagent.loop_guard_stop")).toBeDefined();
	});

	test("does not short-circuit when searches return real results", async () => {
		const { logger } = makeLog();
		const { tool: fake, getCalls } = buildCountingSearchTool('[{"_source":{"message":"boom"}}]');
		const wrapped = instrumentTools([fake], { dataSourceId: "elastic", log: logger })[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		await wrapped.invoke({
			id: "c1",
			name: "elasticsearch_search",
			args: { index: "logs-*", q: "a" },
			type: "tool_call",
		});
		await wrapped.invoke({
			id: "c2",
			name: "elasticsearch_search",
			args: { index: "traces-*", q: "b" },
			type: "tool_call",
		});
		await wrapped.invoke({
			id: "c3",
			name: "elasticsearch_search",
			args: { index: "metrics-*", q: "c" },
			type: "tool_call",
		});

		expect(getCalls()).toBe(3);
	});
});

// SIO-1084/SIO-1141: the AWS start_query guard stops re-issuing an IDENTICAL retention-window
// rejection, but SIO-1141 now ALLOWS a distinct (re-anchored) window to retry so the agent can
// correct its query. A total-attempt backstop still guarantees termination.
describe("SIO-1084: aws_logs_start_query loop guard", () => {
	const RETENTION_ERROR = JSON.stringify({ _error: { kind: "bad-input", advice: "outside retention" } });

	function buildStartQueryTool(payload: string) {
		let calls = 0;
		const t = tool(
			async () => {
				calls += 1;
				return payload;
			},
			{
				name: "aws_logs_start_query",
				description: "Test fixture that counts underlying start_query invocations.",
				schema: z
					.object({
						logGroupName: z.string().optional(),
						startTime: z.number().optional(),
						endTime: z.number().optional(),
					})
					.passthrough(),
			},
		);
		return { tool: t, getCalls: () => calls };
	}

	// SIO-1141: a distinct (re-anchored) window is ALLOWED to retry after a rejection -- the
	// agent must be able to correct its window. Only the exact-duplicate window is blocked.
	test("allows a re-anchored (distinct-window) start_query after a retention rejection", async () => {
		const { logger } = makeLog();
		const { tool: sq, getCalls: sqCalls } = buildStartQueryTool(RETENTION_ERROR);
		const [wrappedSq] = instrumentTools([sq], { dataSourceId: "aws", log: logger });
		if (!wrappedSq) throw new Error("instrumentTools returned empty array");

		// first start_query -> retention rejection
		await wrappedSq.invoke({
			id: "s1",
			name: "aws_logs_start_query",
			args: { logGroupName: "/ecs/x", startTime: 1, endTime: 2 },
			type: "tool_call",
		});
		// second start_query with a DIFFERENT window -> allowed (a genuine re-anchor)
		await wrappedSq.invoke({
			id: "s2",
			name: "aws_logs_start_query",
			args: { logGroupName: "/ecs/x", startTime: 3, endTime: 4 },
			type: "tool_call",
		});
		expect(sqCalls()).toBe(2); // both distinct windows ran

		// re-issuing the IDENTICAL first window is still short-circuited
		const blocked = await wrappedSq.invoke({
			id: "s3",
			name: "aws_logs_start_query",
			args: { logGroupName: "/ecs/x", startTime: 1, endTime: 2 },
			type: "tool_call",
		});
		expect(sqCalls()).toBe(2); // duplicate did NOT run
		const stopText = blocked instanceof ToolMessage ? String(blocked.content) : String(blocked);
		expect(stopText).toContain("re-anchor");
	});

	// SIO-1141: a permuter that keeps landing outside retention with ALL-distinct windows
	// still terminates at the total-attempt backstop.
	test("stops a distinct-window permuter at the unproductive-attempt cap", async () => {
		const { entries, logger } = makeLog();
		const { tool: sq, getCalls: sqCalls } = buildStartQueryTool(RETENTION_ERROR);
		const [wrappedSq] = instrumentTools([sq], { dataSourceId: "aws", log: logger });
		if (!wrappedSq) throw new Error("instrumentTools returned empty array");

		for (let i = 0; i < 10; i++) {
			await wrappedSq.invoke({
				id: `s${i}`,
				name: "aws_logs_start_query",
				args: { logGroupName: "/ecs/x", startTime: i, endTime: i + 1 },
				type: "tool_call",
			});
		}
		// The backstop capped underlying invocations well under the 10 attempts.
		expect(sqCalls()).toBeLessThan(10);
		expect(entries.find((e) => e.event === "subagent.loop_guard_stop")).toBeDefined();
	});
});

describe("SIO-1162: aws_logs_get_query_results invalid-queryId advice injection", () => {
	const INVALID_ID_RESULT = JSON.stringify({
		_error: { kind: "bad-input", category: "unknown", message: "The provided queryId = 8f33ec7e-... is invalid" },
	});

	function buildGetResultsTool(payload: string) {
		return tool(async () => payload, {
			name: "aws_logs_get_query_results",
			description: "Test fixture returning a fixed get_query_results payload.",
			schema: z.object({ queryId: z.string() }).passthrough(),
		});
	}

	test("appends re-anchor advice to the result and preserves tool_call_id", async () => {
		const { entries, logger } = makeLog();
		const [wrapped] = instrumentTools([buildGetResultsTool(INVALID_ID_RESULT)], { dataSourceId: "aws", log: logger });
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		const result = await wrapped.invoke({
			id: "g1",
			name: "aws_logs_get_query_results",
			args: { queryId: "8f33ec7e-...", estate: "eu-mendix-platform-prd" },
			type: "tool_call",
		});

		const content = result instanceof ToolMessage ? String(result.content) : String(result);
		expect(content).toContain("Re-issue aws_logs_start_query");
		expect(content).toContain("estate/region-scoped");
		// the ToolMessage/AIMessage pairing Bedrock requires must survive rebuildResult
		if (result instanceof ToolMessage) {
			expect(result.tool_call_id).toBe("g1");
		}
		expect(entries.find((e) => e.event === "subagent.aws_invalid_query_id_advice")).toBeDefined();
	});
});

// SIO-1247: the live "N calls across M tools" row is fed by these ticks. Two invariants:
// every invocation ATTEMPT emits exactly one tick (so the count never jumps past a
// short-circuited or throwing call), and distinctToolCount counts unique tool names.
describe("SIO-1247: subagent_progress ticks", () => {
	// dispatchCustomEvent only reaches handlers from INSIDE a runnable run -- a bare
	// { callbacks: [handler] } config silently no-ops -- so drive the wrapped tools from
	// within a RunnableLambda and thread its config in, the same wiring sub-agent.ts uses.
	async function captureTicks(
		tools: StructuredToolInterface[],
		ctx: Omit<InstrumentContext, "config">,
		run: (wrapped: StructuredToolInterface[]) => Promise<void>,
	): Promise<Array<{ toolCallCount?: number; distinctToolCount?: number; dataSourceId?: string }>> {
		const ticks: Array<{ toolCallCount?: number; distinctToolCount?: number; dataSourceId?: string }> = [];
		const handler = {
			handleCustomEvent(eventName: string, data: { toolCallCount?: number; distinctToolCount?: number }) {
				if (eventName === "subagent_progress") ticks.push(data);
			},
		};
		const lambda = RunnableLambda.from(async (_input: unknown, config?: RunnableConfig) => {
			await run(instrumentTools(tools, { ...ctx, config }));
		});
		await lambda.invoke({}, { callbacks: [handler] });
		return ticks;
	}

	test("counts calls and distinct tools separately", async () => {
		const { logger } = makeLog();
		const alpha = tool(async () => "ok", {
			name: "alpha_tool",
			description: "x",
			schema: z.object({ q: z.string() }),
		});
		const beta = tool(async () => "ok", { name: "beta_tool", description: "x", schema: z.object({ q: z.string() }) });

		const ticks = await captureTicks([alpha, beta], { dataSourceId: "kafka", log: logger }, async (wrapped) => {
			const [a, b] = wrapped;
			if (!a || !b) throw new Error("instrumentTools returned too few tools");
			await a.invoke({ q: "1" });
			await a.invoke({ q: "2" });
			await b.invoke({ q: "3" });
		});

		// 3 calls, but only 2 distinct tools -- the distinction the UI label now makes.
		expect(ticks.map((t) => t.toolCallCount)).toEqual([1, 2, 3]);
		expect(ticks.map((t) => t.distinctToolCount)).toEqual([1, 1, 2]);
		expect(ticks.at(-1)?.dataSourceId).toBe("kafka");
	});

	test("still ticks for a call the loop guard short-circuits (no gap in the count)", async () => {
		const { entries, logger } = makeLog();
		const search = tool(async () => "Total results: 0, showing 0 from position 0", {
			name: "elasticsearch_search",
			description: "x",
			schema: z.object({ index: z.string().optional(), q: z.string().optional() }).passthrough(),
		});

		const ticks = await captureTicks([search], { dataSourceId: "elastic", log: logger }, async (wrapped) => {
			const [s] = wrapped;
			if (!s) throw new Error("instrumentTools returned empty array");
			// 5 distinct empties exhaust MAX_UNPRODUCTIVE_SEARCHES; the 6th is short-circuited.
			for (let i = 0; i < 6; i++) {
				await s.invoke({ id: `c${i}`, name: "elasticsearch_search", args: { index: "logs-*", q: `q${i}` } });
			}
		});

		// Guard must actually have fired, or this test proves nothing about that path.
		expect(entries.find((e) => e.event === "subagent.loop_guard_stop")?.iteration).toBe(6);
		// The short-circuited 6th attempt emits its tick too, so the UI never sees 5 -> 7.
		expect(ticks.map((t) => t.toolCallCount)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(ticks.at(-1)?.distinctToolCount).toBe(1);
	});

	test("still ticks when the tool throws", async () => {
		const { logger } = makeLog();
		const boom = tool(
			async () => {
				throw new Error("MCP unreachable");
			},
			{ name: "boom_tool", description: "x", schema: z.object({ q: z.string() }) },
		);

		const ticks = await captureTicks([boom], { dataSourceId: "aws", log: logger }, async (wrapped) => {
			const [b] = wrapped;
			if (!b) throw new Error("instrumentTools returned empty array");
			await b.invoke({ q: "1" }).catch(() => undefined);
		});

		expect(ticks).toHaveLength(1);
		expect(ticks[0]).toMatchObject({ toolCallCount: 1, distinctToolCount: 1 });
	});

	// CodeRabbit (PR #489): createReactAgent's ToolNode runs the tool calls of one
	// AIMessage CONCURRENTLY (see the reserveSignature comment). Emitting the per-call
	// snapshot meant a slower earlier call ticked after a faster later one, so the
	// reducer -- which stores the latest tick as-is -- showed the count going backwards.
	test("never emits a count that goes backwards when calls finish out of order", async () => {
		const { logger } = makeLog();
		let releaseSlow: (() => void) | undefined;
		const slowDone = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const slow = tool(
			async () => {
				await slowDone;
				return "slow";
			},
			{ name: "slow_tool", description: "x", schema: z.object({ q: z.string() }) },
		);
		const fast = tool(async () => "fast", {
			name: "fast_tool",
			description: "x",
			schema: z.object({ q: z.string() }),
		});

		const ticks = await captureTicks([slow, fast], { dataSourceId: "aws", log: logger }, async (wrapped) => {
			const [s, f] = wrapped;
			if (!s || !f) throw new Error("instrumentTools returned too few tools");
			const slowCall = s.invoke({ q: "1" }); // starts first (iteration 1), finishes last
			await f.invoke({ q: "2" }); // starts second (iteration 2), finishes first
			releaseSlow?.();
			await slowCall;
		});

		const counts = ticks.map((t) => t.toolCallCount ?? 0);
		expect(counts).toHaveLength(2);
		// Monotonic: the late-finishing first call must not report a lower count than
		// the tick already delivered, or the live row regresses 2 -> 1.
		expect(counts).toEqual([...counts].sort((a, b) => a - b));
		expect(counts.at(-1)).toBe(2);
	});
});

// SIO-1246: SIO-1232 shipped a correct, fully unit-tested generic guard that was UNREACHABLE in
// production -- the call site gated shouldShortCircuit on isGuardedTool(), true for only the two
// bespoke tools. Run 43796e9f: gitlab_search returned empty at iterations 1/17/20/25 and nothing
// stopped it; the sub-agent burned its recursion budget and returned 49 chars. These tests are
// end-to-end through instrumentTools -- sub-agent-loop-guard.test.ts calls the policy directly and
// so passed throughout, which is exactly why the gap survived.
describe("SIO-1246: generic loop guard is enforced for non-bespoke tools", () => {
	const EMPTY_ARRAY = "[]";

	function buildCountingTool(name: string, payload: string, argKeys: string[] = ["search"]) {
		let calls = 0;
		const shape: Record<string, z.ZodTypeAny> = {};
		for (const k of argKeys) shape[k] = z.string().optional();
		const t = tool(
			async () => {
				calls += 1;
				return payload;
			},
			{
				name,
				description: "Test fixture that counts underlying invocations.",
				schema: z.object(shape).passthrough(),
			},
		);
		return { tool: t, getCalls: () => calls };
	}

	test("stops gitlab_search once the per-tool unproductive cap is exhausted", async () => {
		const { entries, logger } = makeLog();
		const { tool: fake, getCalls } = buildCountingTool("gitlab_search", EMPTY_ARRAY);
		const wrapped = instrumentTools([fake], { dataSourceId: "gitlab", log: logger })[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		// MAX_UNPRODUCTIVE_PER_TOOL = 3, so three distinct empties are allowed through...
		for (let i = 0; i < 3; i++) {
			await wrapped.invoke({ id: `c${i}`, name: "gitlab_search", args: { search: `attempt-${i}` }, type: "tool_call" });
		}
		// ...and the 4th distinct attempt is refused before it reaches MCP.
		const fourth = await wrapped.invoke({
			id: "c4",
			name: "gitlab_search",
			args: { search: "attempt-3" },
			type: "tool_call",
		});

		expect(getCalls()).toBe(3);
		const stopText = fourth instanceof ToolMessage ? String(fourth.content) : String(fourth);
		expect(stopText).toContain("returned nothing useful");
		expect(entries.find((e) => e.event === "subagent.loop_guard_stop")).toBeDefined();
	});

	// The elastic-specific stop message talks about indices and the service.name discovery agg;
	// handing it to a gitlab tool would be nonsense advice.
	test("uses the generic stop message, not the elastic one", async () => {
		const { logger } = makeLog();
		const { tool: fake } = buildCountingTool("gitlab_search", EMPTY_ARRAY);
		const wrapped = instrumentTools([fake], { dataSourceId: "gitlab", log: logger })[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		for (let i = 0; i < 3; i++) {
			await wrapped.invoke({ id: `c${i}`, name: "gitlab_search", args: { search: `a-${i}` }, type: "tool_call" });
		}
		const stopped = await wrapped.invoke({
			id: "c4",
			name: "gitlab_search",
			args: { search: "a-3" },
			type: "tool_call",
		});
		const stopText = stopped instanceof ToolMessage ? String(stopped.content) : String(stopped);
		expect(stopText).not.toContain("Stop searching");
		expect(stopText).toContain("Synthesize your findings");
	});

	test("an exact-duplicate non-bespoke call is refused", async () => {
		const { logger } = makeLog();
		const { tool: fake, getCalls } = buildCountingTool("gitlab_list_commits", '[{"id":"abc"}]');
		const wrapped = instrumentTools([fake], { dataSourceId: "gitlab", log: logger })[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		const args = { search: "same" };
		await wrapped.invoke({ id: "d1", name: "gitlab_list_commits", args, type: "tool_call" });
		await wrapped.invoke({ id: "d2", name: "gitlab_list_commits", args, type: "tool_call" });

		// SIO-1246: previously `signature` was "" for every non-bespoke tool, so the duplicate
		// rule had no data even in principle.
		expect(getCalls()).toBe(1);
	});

	test("productive calls are never stopped", async () => {
		const { logger } = makeLog();
		const { tool: fake, getCalls } = buildCountingTool("gitlab_search", '[{"path":"a.ts"}]');
		const wrapped = instrumentTools([fake], { dataSourceId: "gitlab", log: logger })[0];
		if (!wrapped) throw new Error("instrumentTools returned empty array");

		for (let i = 0; i < 6; i++) {
			await wrapped.invoke({ id: `p${i}`, name: "gitlab_search", args: { search: `q-${i}` }, type: "tool_call" });
		}
		expect(getCalls()).toBe(6);
	});

	// The CloudWatch Insights poll re-issues the SAME get_query_results call while a query is
	// Running, and describe_log_groups is the AWS re-anchor recovery path. Enforcing the generic
	// guard must not strand either (CodeRabbit, PR #482). GENERIC_GUARD_EXEMPT_TOOLS is checked
	// FIRST inside shouldShortCircuit's generic branch, which is what preserves this.
	test("exempt polling tools are never short-circuited, even on repeated identical calls", async () => {
		const { logger } = makeLog();
		const empty = JSON.stringify({ results: [], status: "Complete" });
		for (const name of ["aws_logs_get_query_results", "aws_logs_describe_log_groups"]) {
			const { tool: fake, getCalls } = buildCountingTool(name, empty, ["queryId"]);
			const wrapped = instrumentTools([fake], { dataSourceId: "aws", log: logger })[0];
			if (!wrapped) throw new Error("instrumentTools returned empty array");

			const args = { queryId: "q-1" };
			for (let i = 0; i < 12; i++) {
				await wrapped.invoke({ id: `${name}-${i}`, name, args, type: "tool_call" });
			}
			expect(getCalls()).toBe(12);
		}
	});
});
