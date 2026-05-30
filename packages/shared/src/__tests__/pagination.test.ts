// shared/src/__tests__/pagination.test.ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_TOOL_RESULT_CAP_BYTES, ListTruncationMarkerSchema, sliceArray } from "../pagination.ts";

const items = Array.from({ length: 10 }, (_, i) => i);

describe("sliceArray", () => {
	test("returns the first page and flags more remaining", () => {
		expect(sliceArray(items, { limit: 3, offset: 0 })).toEqual({
			items: [0, 1, 2],
			total: 10,
			shown: 3,
			truncated: true,
		});
	});

	test("a page that reaches the end is not truncated", () => {
		expect(sliceArray(items, { limit: 5, offset: 8 })).toEqual({
			items: [8, 9],
			total: 10,
			shown: 2,
			truncated: false,
		});
	});

	test("offset past the end yields an empty page, not truncated", () => {
		expect(sliceArray(items, { limit: 5, offset: 20 })).toEqual({
			items: [],
			total: 10,
			shown: 0,
			truncated: false,
		});
	});

	test("limit larger than total returns everything untruncated", () => {
		const r = sliceArray(items, { limit: 100, offset: 0 });
		expect(r.items).toHaveLength(10);
		expect(r.truncated).toBe(false);
	});

	test("empty input is total 0, shown 0, not truncated", () => {
		expect(sliceArray<number>([], { limit: 10, offset: 0 })).toEqual({
			items: [],
			total: 0,
			shown: 0,
			truncated: false,
		});
	});
});

describe("ListTruncationMarkerSchema", () => {
	test("accepts a marker with an optional cursor", () => {
		expect(ListTruncationMarkerSchema.parse({ shown: 28, total: 50, advice: "narrow it", cursor: "tok" })).toEqual({
			shown: 28,
			total: 50,
			advice: "narrow it",
			cursor: "tok",
		});
	});

	test("rejects a marker missing required fields", () => {
		expect(ListTruncationMarkerSchema.safeParse({ shown: 1 }).success).toBe(false);
	});
});

describe("DEFAULT_TOOL_RESULT_CAP_BYTES", () => {
	test("is the shared 128KB cap", () => {
		expect(DEFAULT_TOOL_RESULT_CAP_BYTES).toBe(131_072);
	});
});
