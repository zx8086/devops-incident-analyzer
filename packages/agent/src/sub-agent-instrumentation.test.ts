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
