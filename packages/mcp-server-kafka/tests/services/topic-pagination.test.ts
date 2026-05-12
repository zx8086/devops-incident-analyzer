// tests/services/topic-pagination.test.ts
import { describe, expect, test } from "bun:test";
import { sliceTopics } from "../../src/services/topic-pagination.ts";

function topicSeries(count: number, prefix = "topic-"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);
}

describe("sliceTopics (SIO-735)", () => {
	test("sorts ascii and slices to limit", () => {
		const shuffled = [...topicSeries(20)].sort(() => Math.random() - 0.5);
		const r = sliceTopics(shuffled, { limit: 10, offset: 0 });
		expect(r.topics).toEqual(topicSeries(10));
		expect(r.total).toBe(20);
		expect(r.truncated).toBe(true);
		expect(r.hint).toContain("prefix");
	});

	test("prefix filter applied before regex filter", () => {
		const all = [...topicSeries(50, "T_dlq_"), ...topicSeries(50, "T_norm_"), ...topicSeries(100, "z-other-")];
		const r = sliceTopics(all, { prefix: "T_", filter: "^T_dlq_", limit: 100, offset: 0 });
		expect(r.total).toBe(50);
		expect(r.topics.every((t) => t.startsWith("T_dlq_"))).toBe(true);
	});

	test("offset past the end produces past-the-end hint", () => {
		const r = sliceTopics(topicSeries(10), { limit: 50, offset: 100 });
		expect(r.topics).toEqual([]);
		expect(r.total).toBe(10);
		expect(r.truncated).toBe(false);
		expect(r.hint).toContain("past the end");
		expect(r.hint).toContain("10");
	});

	test("empty input returns clean zero shape, no hint", () => {
		const r = sliceTopics([], { limit: 100, offset: 0 });
		expect(r).toEqual({ topics: [], total: 0, truncated: false });
	});

	test("partial tail not truncated", () => {
		const r = sliceTopics(topicSeries(100), { limit: 50, offset: 80 });
		expect(r.topics.length).toBe(20);
		expect(r.truncated).toBe(false);
		expect(r.hint).toBeUndefined();
	});
});
