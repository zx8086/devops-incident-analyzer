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
	test("returns default 65536 when env var is missing", () => {
		expect(getSubAgentToolCapBytes({})).toBe(65_536);
	});

	test("returns default 65536 when env var is empty string", () => {
		expect(getSubAgentToolCapBytes({ SUBAGENT_TOOL_RESULT_CAP_BYTES: "" })).toBe(65_536);
	});

	test("returns default 65536 when env var is non-numeric", () => {
		expect(getSubAgentToolCapBytes({ SUBAGENT_TOOL_RESULT_CAP_BYTES: "abc" })).toBe(65_536);
	});

	test("returns null when env var is explicitly 0 (disabled)", () => {
		expect(getSubAgentToolCapBytes({ SUBAGENT_TOOL_RESULT_CAP_BYTES: "0" })).toBeNull();
	});

	test("returns default when env var is negative", () => {
		expect(getSubAgentToolCapBytes({ SUBAGENT_TOOL_RESULT_CAP_BYTES: "-100" })).toBe(65_536);
	});

	test("returns floored integer for valid positive override", () => {
		expect(getSubAgentToolCapBytes({ SUBAGENT_TOOL_RESULT_CAP_BYTES: "32768" })).toBe(32_768);
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
		expect(parsed.at(-1)).toEqual({ _truncated: true, _totalCount: 500, _keptCount: 20 });
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

	test("reduces markdown-wrapped JSON (couchbase queryAnalysis shape)", () => {
		const rows = Array.from({ length: 100 }, (_, i) => ({
			statement: `SELECT * FROM bucket WHERE id=${i}`,
			elapsedTime: `${i * 1000}us`,
			payload: "p".repeat(2048),
		}));
		const content = `# Most Expensive Queries (100 results)\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n\n## Query Execution Details\n\n- Status: success\n- Result Count: 100\n`;

		const result = truncateToolOutput(content, CAP);

		expect(result.strategy).toBe("markdown-json");
		expect(result.finalBytes).toBeLessThanOrEqual(CAP);
		expect(result.content).toContain("# Most Expensive Queries (100 results)"); // frame preserved
		expect(result.content).toContain("## Query Execution Details"); // exec details preserved
		expect(result.content).toContain("_truncated"); // marker present in inner JSON
		expect(result.content).toContain("_totalCount");
	});

	test("reduces array of huge items to first 3 (not 20) so cap is met", () => {
		// 50 items of ~12KB each = 600KB total, way over cap.
		// New reducer should pick keep=3 (LARGE_ITEM_BYTES threshold).
		const items = Array.from({ length: 50 }, (_, i) => ({
			id: i,
			huge: "h".repeat(12_000),
		}));
		const content = JSON.stringify(items);
		const result = truncateToolOutput(content, CAP);

		expect(["json-array", "text"]).toContain(result.strategy);
		expect(result.finalBytes).toBeLessThanOrEqual(CAP);
		if (result.strategy === "json-array") {
			const parsed = JSON.parse(result.content) as Array<Record<string, unknown>>;
			expect(parsed.length).toBeLessThanOrEqual(4); // 3 items + 1 marker
			const marker = parsed.at(-1) as Record<string, unknown>;
			expect(marker._truncated).toBe(true);
			expect(marker._totalCount).toBe(50);
		}
	});

	test("reduces {columns, rows} shape (elasticsearch_execute_sql_query)", () => {
		const rows = Array.from({ length: 200 }, (_, i) => [`val-${i}`, i, `payload-${"x".repeat(500)}`]);
		const content = JSON.stringify({
			columns: [
				{ name: "label", type: "keyword" },
				{ name: "count", type: "long" },
				{ name: "data", type: "text" },
			],
			rows,
			cursor: "abc123",
		});
		const result = truncateToolOutput(content, CAP);

		expect(result.strategy).toBe("json-rows");
		expect(result.finalBytes).toBeLessThanOrEqual(CAP);

		const parsed = JSON.parse(result.content) as {
			columns: unknown[];
			rows: unknown[];
			cursor: string;
			_truncated: boolean;
			_totalRows: number;
		};
		expect(parsed.columns.length).toBe(3); // columns preserved
		expect(parsed.rows.length).toBe(20); // rows reduced to ROWS_KEEP
		expect(parsed.cursor).toBe("abc123"); // other fields preserved
		expect(parsed._truncated).toBe(true);
		expect(parsed._totalRows).toBe(200);
	});

	test("reduces unknown shape via largest-array fallback", () => {
		const items = Array.from({ length: 100 }, (_, i) => ({ id: i, payload: "z".repeat(2048) }));
		const content = JSON.stringify({
			meta: { runId: "abc", elapsed: 1234 },
			results: items,
			summary: "ok",
		});
		const result = truncateToolOutput(content, CAP);

		expect(result.strategy).toBe("json-largest-array");
		expect(result.finalBytes).toBeLessThanOrEqual(CAP);

		const parsed = JSON.parse(result.content) as {
			meta: unknown;
			results: unknown[];
			summary: string;
			_truncated: boolean;
			_truncatedField: string;
		};
		expect(parsed.meta).toEqual({ runId: "abc", elapsed: 1234 }); // meta preserved
		expect(parsed.summary).toBe("ok"); // summary preserved
		expect(parsed._truncatedField).toBe("results");
		expect(parsed.results.length).toBeLessThanOrEqual(21); // 20 items + 1 marker (small items)
	});

	// SIO-688 Gap 1: capella_get_completed_requests returns markdown content
	// where the leading-marker pattern doesn't match (no `# heading` first).
	test("reduces markdown-json without leading heading", () => {
		const rows = Array.from({ length: 100 }, (_, i) => ({
			statement: `SELECT * FROM bucket WHERE id=${i}`,
			elapsedTime: `${i * 1000}us`,
			payload: "p".repeat(2048),
		}));
		// Note: starts with whitespace + plain prose, not `# heading`.
		const content = `   \nCompleted requests for the last hour:\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n\nQuery context: production cluster.\n`;

		const result = truncateToolOutput(content, CAP);

		expect(result.strategy).toBe("markdown-json");
		expect(result.finalBytes).toBeLessThanOrEqual(CAP);
		expect(result.content).toContain("Completed requests for the last hour:"); // frame preserved
		expect(result.content).toContain("Query context: production cluster."); // trailing prose preserved
		expect(result.content).toContain("_truncated"); // marker present in inner JSON
	});

	// SIO-688 Gap 2: atlassian_searchJiraIssuesUsingJql returns ~12 issues each
	// several KB. Length under threshold but bytes over budget.
	test("reduces small-length array of huge items via byte-budget (Atlassian shape)", () => {
		const issues = Array.from({ length: 12 }, (_, i) => ({
			id: `ISSUE-${i}`,
			fields: {
				summary: "x".repeat(1_000),
				description: "y".repeat(2_000),
				comments: Array.from({ length: 5 }, (__, j) => ({ id: j, body: "z".repeat(500) })),
			},
		}));
		const content = JSON.stringify({ issues, isLast: true, total: 12 });
		const original = Buffer.byteLength(content, "utf8");
		expect(original).toBeGreaterThan(CAP / 4); // sanity: must trip byte-budget

		const result = truncateToolOutput(content, CAP);

		expect(result.strategy).toBe("json-largest-array");
		expect(result.finalBytes).toBeLessThanOrEqual(CAP);

		const parsed = JSON.parse(result.content) as {
			issues: unknown[];
			isLast: boolean;
			total: number;
			_truncated: boolean;
			_truncatedField: string;
		};
		expect(parsed._truncatedField).toBe("issues");
		expect(parsed.issues.length).toBeLessThanOrEqual(12); // n kept items + 1 marker, n < 12
		const marker = parsed.issues.at(-1) as Record<string, unknown>;
		expect(marker).toMatchObject({ _truncated: true, _totalCount: 12 });
		expect(marker._keptCount).toBeLessThan(12); // at least one issue was dropped
		expect(parsed.isLast).toBe(true); // sibling field preserved
		expect(parsed.total).toBe(12);
	});

	// SIO-688 Gap 3: elasticsearch_search 21-item arrays where item[0] is small
	// but later items are huge. Single-item sampling miscalculates `keep`.
	test("reduces mixed-size array via multi-sample averaging", () => {
		const items: Array<Record<string, unknown>> = [
			...Array.from({ length: 3 }, (_, i) => ({ id: i })), // tiny head
			...Array.from({ length: 18 }, (_, i) => ({ id: i + 3, huge: "x".repeat(18_000) })), // huge tail
		];
		const content = JSON.stringify(items);
		const original = Buffer.byteLength(content, "utf8");
		expect(original).toBeGreaterThan(CAP); // sanity: payload must overflow cap

		const result = truncateToolOutput(content, CAP);

		expect(result.strategy).toBe("json-array");
		expect(result.finalBytes).toBeLessThanOrEqual(CAP);

		const parsed = JSON.parse(result.content) as Array<Record<string, unknown>>;
		// avg of first 5 items = (3 tiny + 2 huge) / 5 ≈ 7,200 bytes — under LARGE threshold,
		// but byteBoundedKeep = floor((CAP-256)/7200) ≈ 9, so finalKeep ≤ 9.
		// Asserting <= 11 (10 items + marker) gives slack for serialization variance.
		expect(parsed.length).toBeLessThanOrEqual(11);
		const marker = parsed.at(-1) as Record<string, unknown>;
		expect(marker._truncated).toBe(true);
		expect(marker._totalCount).toBe(21);
	});
});
