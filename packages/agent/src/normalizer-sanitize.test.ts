// agent/src/normalizer-sanitize.test.ts
import { describe, expect, test } from "bun:test";
import { sanitizeJsonControlChars } from "./normalizer.ts";

describe("sanitizeJsonControlChars (SIO-1220)", () => {
	// Regression: Claude Sonnet 5 echoed a pasted multi-line incident query verbatim into
	// a JSON string value without escaping the embedded newlines, producing malformed JSON
	// that JSON.parse rejects ("Bad control character in string literal" / "Unterminated
	// string"). Observed live: normalizeIncident failed, normalizedIncident stayed
	// undefined, and the downstream runbook selector then threw RunbookSelectionFallbackError
	// because severity was missing.
	test("escapes a raw newline embedded inside a JSON string value", () => {
		const malformed = `{"severity": "high", "extractedMetrics": [{"name": "error", "value": "Couldn't fetch seasons\nI/O error on GET request"}]}`;
		const sanitized = sanitizeJsonControlChars(malformed);
		const parsed = JSON.parse(sanitized);
		expect(parsed.extractedMetrics[0].value).toBe("Couldn't fetch seasons\nI/O error on GET request");
	});

	test("escapes raw carriage return and tab inside a string value", () => {
		const malformed = `{"a": "line1\r\nline2\ttabbed"}`;
		const parsed = JSON.parse(sanitizeJsonControlChars(malformed));
		expect(parsed.a).toBe("line1\r\nline2\ttabbed");
	});

	test("leaves already-valid JSON with escaped newlines unchanged in meaning", () => {
		const valid = `{"a": "line1\\nline2"}`;
		const parsed = JSON.parse(sanitizeJsonControlChars(valid));
		expect(parsed.a).toBe("line1\nline2");
	});

	test("does not touch whitespace outside string literals (formatting-only newlines)", () => {
		const pretty = `{\n  "severity": "high",\n  "affectedServices": []\n}`;
		const parsed = JSON.parse(sanitizeJsonControlChars(pretty));
		expect(parsed.severity).toBe("high");
	});

	test("preserves existing backslash-escapes (e.g. escaped quotes) without double-escaping", () => {
		const withEscape = `{"a": "she said \\"hi\\"\nthen left"}`;
		const parsed = JSON.parse(sanitizeJsonControlChars(withEscape));
		expect(parsed.a).toBe('she said "hi"\nthen left');
	});

	test("handles multiple string values each with embedded control characters", () => {
		const malformed = `{"a": "one\ntwo", "b": "three\rfour"}`;
		const parsed = JSON.parse(sanitizeJsonControlChars(malformed));
		expect(parsed.a).toBe("one\ntwo");
		expect(parsed.b).toBe("three\rfour");
	});
});
