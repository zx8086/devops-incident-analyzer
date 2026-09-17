// src/sub-agent-truncate-text-blocks.test.ts
import { describe, expect, test } from "bun:test";
import { truncateTextBlocks } from "./sub-agent-instrumentation.ts";
import { truncateToolOutput } from "./sub-agent-truncate-tool-output.ts";

const CAP = 131072;
const HEADER = "Search results with aggregations (10000 total hits, 900ms):";

function aggregationPayload(): string {
	const buckets = Array.from({ length: 1000 }, (_, i) => ({
		key: `service-${i}`,
		doc_count: i * 7,
		by_level: { buckets: Array.from({ length: 8 }, (_, j) => ({ key: `lvl${j}`, doc_count: j, pad: "x".repeat(60) })) },
	}));
	// The REAL shape: search.ts emits JSON.stringify(result.aggregations), a bare aggregation map.
	return JSON.stringify({ services: { sum_other_doc_count: 6674009748, buckets } }, null, 2);
}

describe("SIO-1782: multi-block text results are truncated by their texts", () => {
	const blocks = [
		{ type: "text", text: HEADER },
		{ type: "text", text: aggregationPayload() },
	];

	test("the serialized block array loses the payload whole (the defect)", () => {
		const r = truncateToolOutput(JSON.stringify(blocks), CAP);
		expect(r.strategy).toBe("json-array");
		expect(r.content).not.toContain("service-999");
	});

	test("the payload block is reduced by the aggregation reducer and the header survives", () => {
		const r = truncateTextBlocks(blocks, CAP);
		expect(r).not.toBeNull();
		expect(r?.strategy).toBe("json-agg-keys");
		expect(r?.content.startsWith(HEADER)).toBe(true);
		expect(r?.content).toContain("service-0");
		expect(r?.content).toContain("service-999");
		expect(r?.content).toContain("6674009748");
		expect(r?.content).not.toContain('"aggregations"');
		expect(r?.finalBytes).toBeLessThanOrEqual(CAP);
		expect(r?.finalBytes).toBe(Buffer.byteLength(r?.content ?? "", "utf8"));
	});

	test("the largest block is the one reduced, wherever it sits", () => {
		const r = truncateTextBlocks([blocks[1], blocks[0]], CAP);
		expect(r?.content.endsWith(HEADER)).toBe(true);
		expect(r?.content).toContain("service-999");
	});

	test("falls back (null) for non-text blocks, non-arrays, and blocks that cannot fit", () => {
		expect(truncateTextBlocks("plain string", CAP)).toBeNull();
		expect(truncateTextBlocks([], CAP)).toBeNull();
		expect(truncateTextBlocks([{ type: "image_url", image_url: "x" }, blocks[1]], CAP)).toBeNull();
		const twoHuge = [{ type: "text", text: "a".repeat(CAP) }, blocks[1]];
		expect(truncateTextBlocks(twoHuge, CAP)).toBeNull();
	});
});
