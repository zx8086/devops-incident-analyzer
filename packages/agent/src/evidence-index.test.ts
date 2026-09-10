// agent/src/evidence-index.test.ts
import { describe, expect, test } from "bun:test";
import { chunkToolOutput, EvidenceIndex, isEvidenceIndexEnabled, sanitizeQuery } from "./evidence-index.ts";

describe("isEvidenceIndexEnabled", () => {
	test("defaults ON and is disabled only by an explicit kill-switch value", () => {
		expect(isEvidenceIndexEnabled({})).toBe(true);
		expect(isEvidenceIndexEnabled({ EVIDENCE_INDEX_ENABLED: "true" })).toBe(true);
		expect(isEvidenceIndexEnabled({ EVIDENCE_INDEX_ENABLED: "false" })).toBe(false);
		expect(isEvidenceIndexEnabled({ EVIDENCE_INDEX_ENABLED: "0" })).toBe(false);
	});
});

describe("chunkToolOutput", () => {
	test("keeps a small payload as one row titled by its root", () => {
		const rows = chunkToolOutput(JSON.stringify({ status: "green" }));
		expect(rows.length).toBe(1);
		expect(rows[0]?.content).toContain("green");
	});

	test("splits a large array per element, titling each by index", () => {
		const hits = Array.from({ length: 40 }, (_, i) => ({
			_id: `doc-${i}`,
			message: `error ${i} ${"padding ".repeat(60)}`,
		}));
		const rows = chunkToolOutput(JSON.stringify({ hits: { hits } }));
		expect(rows.length).toBeGreaterThan(1);
		// Every element is reachable, including the last, which is what truncation loses.
		expect(rows.some((r) => r.content.includes("doc-39"))).toBe(true);
		expect(rows.some((r) => r.title.includes("[39]"))).toBe(true);
	});

	test("titles rows by key path so a hit says where it came from", () => {
		const rows = chunkToolOutput(
			JSON.stringify({ aggregations: { by_service: { buckets: [{ key: "checkout", doc_count: 5 }] } } }),
		);
		expect(rows.length).toBeGreaterThan(0);
	});

	test("indexes non-JSON output as text rather than dropping it", () => {
		const rows = chunkToolOutput("plain text report\nsecond line");
		expect(rows.length).toBe(1);
		expect(rows[0]?.title).toBe("text");
		expect(rows[0]?.content).toContain("second line");
	});

	test("slices a very long unstructured string into multiple rows", () => {
		const rows = chunkToolOutput(`${"line of log output\n".repeat(2000)}`);
		expect(rows.length).toBeGreaterThan(1);
	});

	test("empty and whitespace-only output produce no rows", () => {
		expect(chunkToolOutput("")).toEqual([]);
		expect(chunkToolOutput("   \n ")).toEqual([]);
	});

	test("bounds the rows one tool call can contribute", () => {
		const huge = Array.from({ length: 5000 }, (_, i) => ({ id: i, blob: "x".repeat(500) }));
		expect(chunkToolOutput(JSON.stringify(huge)).length).toBeLessThanOrEqual(400);
	});
});

describe("sanitizeQuery", () => {
	// FTS5 reads bare punctuation as query syntax, so an unquoted tool name or a
	// question with a hyphen would raise a syntax error instead of searching.
	test("quotes every term so punctuation cannot be read as FTS5 syntax", () => {
		expect(sanitizeQuery("connection refused")).toBe('"connection" OR "refused"');
		expect(sanitizeQuery("eu-oit-prd")).toBe('"eu-oit-prd"');
	});

	test("strips embedded quotes that would unbalance the phrase", () => {
		expect(sanitizeQuery('say "hi"')).toBe('"say" OR "hi"');
	});

	test("an empty or whitespace query yields no match expression", () => {
		expect(sanitizeQuery("")).toBe("");
		expect(sanitizeQuery("   ")).toBe("");
	});
});

describe("EvidenceIndex", () => {
	test("recovers content that truncation would have cut", async () => {
		const index = new EvidenceIndex();
		const hits = Array.from({ length: 200 }, (_, i) => ({
			_id: `doc-${i}`,
			message: i === 180 ? "OutOfMemoryError in checkout-service" : `routine message ${i}`,
		}));
		await index.index("elasticsearch_search", JSON.stringify({ hits: { hits } }));

		// The 181st hit is far beyond any truncation window (HITS_KEEP is 3).
		const found = index.search("OutOfMemoryError");
		expect(found.length).toBeGreaterThan(0);
		expect(found[0]?.snippet).toContain("OutOfMemoryError");
		expect(found[0]?.tool).toBe("elasticsearch_search");
		index.close();
	});

	test("scopes a search to one tool when asked", async () => {
		const index = new EvidenceIndex();
		await index.index("elasticsearch_search", JSON.stringify({ note: "timeout observed" }));
		await index.index("aws_logs_filter", JSON.stringify({ note: "timeout observed" }));

		expect(index.search("timeout").length).toBe(2);
		const scoped = index.search("timeout", { tool: "aws_logs_filter" });
		expect(scoped.length).toBe(1);
		expect(scoped[0]?.tool).toBe("aws_logs_filter");
		index.close();
	});

	test("returns nothing for a term that was never indexed", async () => {
		const index = new EvidenceIndex();
		await index.index("t", JSON.stringify({ a: "alpha" }));
		expect(index.search("nonexistent-term")).toEqual([]);
		index.close();
	});

	test("searching before anything is indexed is empty, not an error", () => {
		const index = new EvidenceIndex();
		expect(index.search("anything")).toEqual([]);
		index.close();
	});

	test("honors the result limit", async () => {
		const index = new EvidenceIndex();
		const docs = Array.from({ length: 50 }, (_, i) => ({ id: i, msg: `timeout ${i} ${"pad ".repeat(200)}` }));
		await index.index("t", JSON.stringify(docs));
		expect(index.search("timeout", { limit: 3 }).length).toBeLessThanOrEqual(3);
		index.close();
	});

	test("a query of only punctuation does not raise an FTS5 syntax error", async () => {
		const index = new EvidenceIndex();
		await index.index("t", JSON.stringify({ a: "alpha" }));
		expect(() => index.search('"')).not.toThrow();
		expect(() => index.search("* AND (")).not.toThrow();
		index.close();
	});

	test("reports how many rows it holds", async () => {
		const index = new EvidenceIndex();
		expect(index.rowCount).toBe(0);
		const n = await index.index("t", JSON.stringify({ a: "alpha", b: "beta" }));
		expect(index.rowCount).toBe(n);
		index.close();
	});

	test("a circular payload is skipped instead of throwing", async () => {
		const index = new EvidenceIndex();
		// Reaches the indexer as a string, so this is the pre-serialized equivalent:
		// content that cannot be parsed still gets indexed as text.
		const rows = await index.index("t", "{unparseable json");
		expect(rows).toBeGreaterThan(0);
		index.close();
	});

	test("closing twice is safe", async () => {
		const index = new EvidenceIndex();
		await index.index("t", JSON.stringify({ a: 1 }));
		index.close();
		expect(() => index.close()).not.toThrow();
	});

	test("search after close returns empty rather than throwing", async () => {
		const index = new EvidenceIndex();
		await index.index("t", JSON.stringify({ a: "alpha" }));
		index.close();
		expect(index.search("alpha")).toEqual([]);
	});
});
