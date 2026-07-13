// packages/agent/src/sub-agent-instrumentation.test.ts

import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { instrumentTools } from "./sub-agent-instrumentation.ts";

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

// SIO-1084: the AWS start_query guard stops re-issuing an identical retention-window
// rejection and forces an intervening describe_log_groups re-anchor.
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

	function buildDescribeTool() {
		let calls = 0;
		const t = tool(
			async () => {
				calls += 1;
				return JSON.stringify({ logGroups: [{ logGroupName: "/ecs/x", retentionInDays: 60 }] });
			},
			{
				name: "aws_logs_describe_log_groups",
				description: "Test fixture describe.",
				schema: z.object({ logGroupNamePattern: z.string().optional() }).passthrough(),
			},
		);
		return { tool: t, getCalls: () => calls };
	}

	test("blocks a second start_query after a retention rejection until describe runs", async () => {
		const { entries, logger } = makeLog();
		const { tool: sq, getCalls: sqCalls } = buildStartQueryTool(RETENTION_ERROR);
		const { tool: dlg } = buildDescribeTool();
		const [wrappedSq, wrappedDlg] = instrumentTools([sq, dlg], { dataSourceId: "aws", log: logger });
		if (!wrappedSq || !wrappedDlg) throw new Error("instrumentTools returned empty array");

		// first start_query -> retention rejection, arms the re-anchor gate
		await wrappedSq.invoke({
			id: "s1",
			name: "aws_logs_start_query",
			args: { logGroupName: "/ecs/x", startTime: 1, endTime: 2 },
			type: "tool_call",
		});
		// second start_query (different window) -> short-circuited
		const blocked = await wrappedSq.invoke({
			id: "s2",
			name: "aws_logs_start_query",
			args: { logGroupName: "/ecs/x", startTime: 3, endTime: 4 },
			type: "tool_call",
		});
		expect(sqCalls()).toBe(1); // underlying tool ran once
		const stopText = blocked instanceof ToolMessage ? String(blocked.content) : String(blocked);
		expect(stopText).toContain("re-anchor");
		expect(entries.find((e) => e.event === "subagent.loop_guard_stop")).toBeDefined();

		// describe clears the gate; the next start_query runs
		await wrappedDlg.invoke({
			id: "d1",
			name: "aws_logs_describe_log_groups",
			args: { logGroupNamePattern: "order" },
			type: "tool_call",
		});
		await wrappedSq.invoke({
			id: "s3",
			name: "aws_logs_start_query",
			args: { logGroupName: "/ecs/x", startTime: 5, endTime: 6 },
			type: "tool_call",
		});
		expect(sqCalls()).toBe(2); // ran again after re-anchor
	});
});
