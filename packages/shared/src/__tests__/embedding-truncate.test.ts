// shared/src/__tests__/embedding-truncate.test.ts
import { describe, expect, test } from "bun:test";
import { embeddingMaxChars, truncateForEmbedding } from "../embedding-truncate.ts";

describe("embeddingMaxChars", () => {
	test("defaults to 30000 when unset", () => {
		expect(embeddingMaxChars({})).toBe(30_000);
	});

	test("defaults to 30000 when empty", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "" })).toBe(30_000);
	});

	test("reads a valid override", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "12000" })).toBe(12_000);
	});

	test("floors a fractional override", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "12000.9" })).toBe(12_000);
	});

	test('"0" disables the cap (null)', () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "0" })).toBeNull();
	});

	test("negative falls back to default", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "-5" })).toBe(30_000);
	});

	test("non-numeric falls back to default", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "lots" })).toBe(30_000);
	});
});

describe("truncateForEmbedding", () => {
	test("passes through text under the cap", () => {
		const text = "a".repeat(100);
		expect(truncateForEmbedding(text, 30_000)).toBe(text);
	});

	test("passes through text exactly at the cap", () => {
		const text = "a".repeat(30_000);
		expect(truncateForEmbedding(text, 30_000)).toBe(text);
	});

	test("head-truncates text over the cap", () => {
		const text = "a".repeat(40_000);
		const result = truncateForEmbedding(text, 30_000);
		expect(result.length).toBe(30_000);
		expect(result).toBe(text.slice(0, 30_000));
	});

	test("keeps the front (leading frames carry the signal)", () => {
		const text = `EXCEPTION_HEAD${"x".repeat(40_000)}`;
		expect(truncateForEmbedding(text, 100).startsWith("EXCEPTION_HEAD")).toBe(true);
	});

	test("null cap disables truncation", () => {
		const text = "a".repeat(40_000);
		expect(truncateForEmbedding(text, null)).toBe(text);
	});

	test("uses embeddingMaxChars() default when maxChars omitted", () => {
		const text = "a".repeat(40_000);
		// default cap 30000 (no EMBEDDINGS_MAX_CHARS set in the test env)
		expect(truncateForEmbedding(text).length).toBe(30_000);
	});
});
