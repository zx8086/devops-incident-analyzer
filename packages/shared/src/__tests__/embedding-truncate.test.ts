// shared/src/__tests__/embedding-truncate.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { embeddingMaxChars, truncateForEmbedding } from "../embedding-truncate.ts";

const DEFAULT = 24_000;

describe("embeddingMaxChars", () => {
	test("defaults when unset", () => {
		expect(embeddingMaxChars({})).toBe(DEFAULT);
	});

	test("defaults when empty", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "" })).toBe(DEFAULT);
	});

	test("defaults when whitespace-only (Number(' ') is 0, must NOT disable)", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "   " })).toBe(DEFAULT);
	});

	test("reads a valid override", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "12000" })).toBe(12_000);
	});

	test("trims surrounding whitespace on a valid override", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "  12000  " })).toBe(12_000);
	});

	test("floors a fractional override >= 1", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "12000.9" })).toBe(12_000);
	});

	test('"0" disables the cap (null)', () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "0" })).toBeNull();
	});

	test('a sub-1 fraction like "0.5" falls back to default (would zero-length input)', () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "0.5" })).toBe(DEFAULT);
	});

	test("negative falls back to default", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "-5" })).toBe(DEFAULT);
	});

	test("non-numeric falls back to default", () => {
		expect(embeddingMaxChars({ EMBEDDINGS_MAX_CHARS: "lots" })).toBe(DEFAULT);
	});
});

describe("truncateForEmbedding", () => {
	test("passes through text under the cap", () => {
		const text = "a".repeat(100);
		expect(truncateForEmbedding(text, 24_000)).toBe(text);
	});

	test("passes through text exactly at the cap", () => {
		const text = "a".repeat(24_000);
		expect(truncateForEmbedding(text, 24_000)).toBe(text);
	});

	test("head-truncates text over the cap", () => {
		const text = "a".repeat(40_000);
		const result = truncateForEmbedding(text, 24_000);
		expect(result.length).toBe(24_000);
		expect(result).toBe(text.slice(0, 24_000));
	});

	test("keeps the front (leading frames carry the signal)", () => {
		const text = `EXCEPTION_HEAD${"x".repeat(40_000)}`;
		expect(truncateForEmbedding(text, 100).startsWith("EXCEPTION_HEAD")).toBe(true);
	});

	test("null cap disables truncation", () => {
		const text = "a".repeat(40_000);
		expect(truncateForEmbedding(text, null)).toBe(text);
	});

	test("a non-finite explicit cap (NaN) is treated as no-cap, not zero-length", () => {
		const text = "abc";
		expect(truncateForEmbedding(text, Number.NaN)).toBe(text);
	});

	test("a negative explicit cap is treated as no-cap, not zero-length", () => {
		const text = "abc";
		expect(truncateForEmbedding(text, -1)).toBe(text);
	});

	describe("default from env", () => {
		const prev = process.env.EMBEDDINGS_MAX_CHARS;
		afterEach(() => {
			if (prev === undefined) delete process.env.EMBEDDINGS_MAX_CHARS;
			else process.env.EMBEDDINGS_MAX_CHARS = prev;
		});

		test("uses embeddingMaxChars() default when maxChars omitted", () => {
			// Isolate the env so a developer/CI override cannot invalidate the assertion.
			delete process.env.EMBEDDINGS_MAX_CHARS;
			const text = "a".repeat(40_000);
			expect(truncateForEmbedding(text).length).toBe(DEFAULT);
		});
	});
});
