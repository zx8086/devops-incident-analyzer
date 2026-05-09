// packages/agent/src/sub-agent-truncate-tool-output.test.ts

import { describe, expect, test } from "bun:test";
import { getSubAgentToolCapBytes, truncateToolOutput } from "./sub-agent-truncate-tool-output.ts";

const CAP = 65_536;

function bigHitsPayload(): string {
	const hits = Array.from({ length: 200 }, (_, i) => ({
		_index: "logs-prod",
		_id: `doc-${i}`,
		_source: { message: "x".repeat(1024), trace_id: `t-${i}`, level: "error" },
	}));
	return JSON.stringify({ took: 12, timed_out: false, hits: { total: { value: 200, relation: "eq" }, hits } });
}

function bigArrayPayload(): string {
	const items = Array.from({ length: 500 }, (_, i) => ({
		id: i,
		filler: "y".repeat(512),
	}));
	return JSON.stringify(items);
}

function bigStringPayload(): string {
	return "z".repeat(200_000);
}

function bigNodesPayload(): string {
	const nodes: Record<string, unknown> = {};
	for (let i = 0; i < 50; i++) {
		nodes[`node-${i}`] = { name: `node-${i}`, attributes: { fill: "p".repeat(2048) } };
	}
	return JSON.stringify({ cluster_name: "prod", nodes, _nodes: { total: 50 } });
}

describe("getSubAgentToolCapBytes", () => {
	test("returns null when env var is missing", () => {
		expect(getSubAgentToolCapBytes({})).toBeNull();
	});

	test("returns null when env var is empty string", () => {
		expect(getSubAgentToolCapBytes({ SUBAGENT_TOOL_RESULT_CAP_BYTES: "" })).toBeNull();
	});

	test("returns null when env var is non-numeric", () => {
		expect(getSubAgentToolCapBytes({ SUBAGENT_TOOL_RESULT_CAP_BYTES: "abc" })).toBeNull();
	});

	test("returns null when env var is zero or negative", () => {
		expect(getSubAgentToolCapBytes({ SUBAGENT_TOOL_RESULT_CAP_BYTES: "0" })).toBeNull();
		expect(getSubAgentToolCapBytes({ SUBAGENT_TOOL_RESULT_CAP_BYTES: "-100" })).toBeNull();
	});

	test("returns floored integer for valid positive value", () => {
		expect(getSubAgentToolCapBytes({ SUBAGENT_TOOL_RESULT_CAP_BYTES: "65536" })).toBe(65_536);
		expect(getSubAgentToolCapBytes({ SUBAGENT_TOOL_RESULT_CAP_BYTES: "65536.9" })).toBe(65_536);
	});
});

describe("truncateToolOutput", () => {
	test("returns content unchanged when within cap", () => {
		const content = "small";
		const result = truncateToolOutput(content, CAP);
		expect(result.content).toBe(content);
		expect(result.strategy).toBe("none");
		expect(result.finalBytes).toBe(result.originalBytes);
	});

	test("reduces hits.hits payload to first 3 with totalHits marker", () => {
		const content = bigHitsPayload();
		const original = Buffer.byteLength(content, "utf8");
		const result = truncateToolOutput(content, CAP);

		expect(result.strategy).toBe("json-hits");
		expect(result.originalBytes).toBe(original);
		expect(result.finalBytes).toBeLessThanOrEqual(CAP);

		const parsed = JSON.parse(result.content) as {
			hits: { hits: unknown[]; _truncated: boolean; _totalHits: number; total: unknown };
		};
		expect(parsed.hits.hits.length).toBe(3);
		expect(parsed.hits._truncated).toBe(true);
		expect(parsed.hits._totalHits).toBe(200);
		expect(parsed.hits.total).toEqual({ value: 200, relation: "eq" });
	});

	test("reduces top-level array to first 20 with totalCount marker", () => {
		const content = bigArrayPayload();
		const result = truncateToolOutput(content, CAP);

		expect(result.strategy).toBe("json-array");
		expect(result.finalBytes).toBeLessThanOrEqual(CAP);

		const parsed = JSON.parse(result.content) as Array<Record<string, unknown>>;
		expect(parsed.length).toBe(21); // 20 items + 1 marker entry
		expect(parsed.at(-1)).toEqual({ _truncated: true, _totalCount: 500 });
	});

	test("reduces nodes object to first 5 with nodeCount marker", () => {
		const content = bigNodesPayload();
		const result = truncateToolOutput(content, CAP);

		expect(result.strategy).toBe("json-nodes");
		expect(result.finalBytes).toBeLessThanOrEqual(CAP);

		const parsed = JSON.parse(result.content) as {
			nodes: Record<string, unknown>;
			_nodeCount: number;
			_truncated: boolean;
		};
		expect(Object.keys(parsed.nodes).length).toBe(5);
		expect(parsed._nodeCount).toBe(50);
		expect(parsed._truncated).toBe(true);
	});

	test("falls back to text truncation for plain strings", () => {
		const content = bigStringPayload();
		const result = truncateToolOutput(content, CAP);

		expect(result.strategy).toBe("text");
		expect(result.finalBytes).toBeLessThanOrEqual(CAP + 64); // marker overhead
		expect(result.content.endsWith(`bytes total]`)).toBe(true);
		expect(result.content).toContain("[truncated,");
	});

	test("falls back to text truncation when JSON shape doesn't match a known reducer", () => {
		const content = JSON.stringify({ unknown_field: "w".repeat(150_000) });
		const result = truncateToolOutput(content, CAP);

		expect(["text", "none"]).toContain(result.strategy);
		expect(result.finalBytes).toBeLessThanOrEqual(CAP + 64);
	});

	test("falls back to text truncation for malformed JSON", () => {
		const content = `{not valid json: ${"q".repeat(200_000)}`;
		const result = truncateToolOutput(content, CAP);

		expect(result.strategy).toBe("text");
		expect(result.finalBytes).toBeLessThanOrEqual(CAP + 64);
	});
});
