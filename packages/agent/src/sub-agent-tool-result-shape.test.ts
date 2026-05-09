// packages/agent/src/sub-agent-tool-result-shape.test.ts

import { describe, expect, test } from "bun:test";
import { describeToolResult } from "./sub-agent-tool-result-shape.ts";

describe("describeToolResult", () => {
	test("classifies empty content", () => {
		const r = describeToolResult("");
		expect(r.bytes).toBe(0);
		expect(r.shape.contentType).toBe("empty");
	});

	test("classifies plain string", () => {
		const r = describeToolResult("hello world");
		expect(r.bytes).toBe(11);
		expect(r.shape.contentType).toBe("string");
	});

	test("classifies hits.hits object and reports hitsLen", () => {
		const payload = JSON.stringify({ hits: { total: 7, hits: [1, 2, 3, 4, 5, 6, 7] } });
		const r = describeToolResult(payload);
		expect(r.shape.contentType).toBe("object");
		expect(r.shape.hitsLen).toBe(7);
		expect(r.shape.topLevelKeys).toEqual(["hits"]);
	});

	test("classifies nodes object and reports nodesCount", () => {
		const payload = JSON.stringify({ nodes: { a: {}, b: {}, c: {} } });
		const r = describeToolResult(payload);
		expect(r.shape.contentType).toBe("object");
		expect(r.shape.nodesCount).toBe(3);
	});

	test("classifies top-level array and reports topLevelArrayLen", () => {
		const payload = JSON.stringify([1, 2, 3, 4]);
		const r = describeToolResult(payload);
		expect(r.shape.contentType).toBe("array");
		expect(r.shape.topLevelArrayLen).toBe(4);
	});

	test("falls back to string for malformed JSON without throwing", () => {
		const r = describeToolResult("{not json");
		expect(r.shape.contentType).toBe("string");
		expect(r.bytes).toBe("{not json".length);
	});

	test("stringifies non-string input safely", () => {
		const r = describeToolResult({ hits: { hits: [1, 2] } });
		expect(r.shape.contentType).toBe("object");
		expect(r.shape.hitsLen).toBe(2);
	});

	test("handles null and undefined", () => {
		expect(describeToolResult(null).shape.contentType).toBe("empty");
		expect(describeToolResult(undefined).shape.contentType).toBe("empty");
	});
});
