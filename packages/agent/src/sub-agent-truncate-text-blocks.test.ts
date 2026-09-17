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

	test("returns null only for content that is not all text blocks", () => {
		expect(truncateTextBlocks("plain string", CAP)).toBeNull();
		expect(truncateTextBlocks([], CAP)).toBeNull();
		expect(truncateTextBlocks([{ type: "image_url", image_url: "x" }, blocks[1]], CAP)).toBeNull();
	});

	// Live, SIO-1775 arm C: a 26.6 KB hits result reached the model as 138 bytes under a 24576 cap.
	// search.ts renders one text block per hit, newline- and quote-heavy, so JSON escaping pushed
	// the SERIALIZED array over the cap while the texts fit. Nothing needed cutting.
	test("texts that fit are returned whole even when their serialized form is over the cap", () => {
		const cap = 24576;
		const hit = `Document ID: abc\nScore: 1\n\n${Array.from({ length: 400 }, (_, i) => `field_${i}: {\n  "k": "v${i}",\n  "msg": "line \\"quoted\\""\n}`).join("\n")}`;
		const hits = [
			{ type: "text", text: "Total results: 1, showing 1 from position 0" },
			{ type: "text", text: hit },
		];
		expect(Buffer.byteLength(JSON.stringify(hits), "utf8")).toBeGreaterThan(cap);
		expect(truncateToolOutput(JSON.stringify(hits), cap).finalBytes).toBeLessThan(200);

		const r = truncateTextBlocks(hits, cap);
		expect(r?.strategy).toBe("text-blocks");
		expect(r?.content).toContain("field_399");
		expect(r?.finalBytes).toBe(r?.originalBytes);
	});

	test("several oversize blocks keep a head of real content instead of nothing", () => {
		const twoHuge = [
			{ type: "text", text: `first-hit ${"a".repeat(CAP)}` },
			{ type: "text", text: `second-hit ${"b".repeat(CAP)}` },
		];
		const r = truncateTextBlocks(twoHuge, CAP);
		expect(r?.content).toContain("first-hit");
		expect(r?.finalBytes).toBeLessThanOrEqual(CAP);
		expect(r?.finalBytes).toBeGreaterThan(CAP / 4);
	});

	// Greptile, PR #814: at a cap small enough that the key list itself is trimmed, the entry was
	// rebuilt from _keys/_bucketCount alone and the scalars were lost again.
	test("scalar siblings survive when the key list has to be trimmed to fit", () => {
		const r = truncateToolOutput(aggregationPayload(), 4096);
		expect(r.strategy).toBe("json-agg-keys");
		expect(r.finalBytes).toBeLessThanOrEqual(4096);
		expect(r.content).toContain("_keptKeys");
		expect(r.content).toContain("6674009748");
	});
});
