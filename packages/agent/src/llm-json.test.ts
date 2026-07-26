// agent/src/llm-json.test.ts

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { extractJsonBlock, parseLlmJson, sanitizeJsonControlChars, withKeyAliases } from "./llm-json.ts";

describe("sanitizeJsonControlChars", () => {
	test("escapes a raw newline inside a string literal", () => {
		const raw = '{"value":"line one\nline two"}';
		expect(() => JSON.parse(raw)).toThrow();
		expect(JSON.parse(sanitizeJsonControlChars(raw)).value).toBe("line one\nline two");
	});

	test("escapes raw carriage return and tab inside a string literal", () => {
		const raw = '{"value":"a\rb\tc"}';
		expect(() => JSON.parse(raw)).toThrow();
		expect(JSON.parse(sanitizeJsonControlChars(raw)).value).toBe("a\rb\tc");
	});

	// SIO-1221: the pre-existing sanitizer handled only \n, \r and \t. JSON forbids every
	// C0 control character unescaped, and pasted terminal output carries the rest.
	test.each([
		["backspace", "\b"],
		["form feed", "\f"],
		["bell U+0007", "\u0007"],
		["escape U+001B", "\u001b"],
		["NUL U+0000", "\u0000"],
		["unit separator U+001F", "\u001f"],
	])("escapes %s inside a string literal", (_label, ch) => {
		const raw = `{"value":"before${ch}after"}`;
		expect(() => JSON.parse(raw)).toThrow();
		expect(JSON.parse(sanitizeJsonControlChars(raw)).value).toBe(`before${ch}after`);
	});

	test("leaves already-escaped sequences untouched", () => {
		const raw = '{"value":"line one\\nline two","path":"C:\\\\tmp"}';
		const parsed = JSON.parse(sanitizeJsonControlChars(raw));
		expect(parsed.value).toBe("line one\nline two");
		expect(parsed.path).toBe("C:\\tmp");
	});

	// An escaped quote must not flip the in-string state, or every control character
	// after it would be classified as "outside a string" and left unescaped.
	test("tracks quote state across an escaped quote", () => {
		const raw = '{"value":"he said \\"hi\\" then\nnewline"}';
		expect(JSON.parse(sanitizeJsonControlChars(raw)).value).toBe('he said "hi" then\nnewline');
	});

	test("preserves structural whitespace outside string literals", () => {
		const raw = '{\n\t"a": 1,\n\t"b": 2\n}';
		expect(sanitizeJsonControlChars(raw)).toBe(raw);
		expect(JSON.parse(sanitizeJsonControlChars(raw))).toEqual({ a: 1, b: 2 });
	});

	test("is a no-op on already-valid JSON", () => {
		const raw = '{"a":"plain","b":[1,2,3],"c":null}';
		expect(sanitizeJsonControlChars(raw)).toBe(raw);
	});

	// The literal shape from the SIO-1219 production log: a multi-line pasted error
	// message echoed verbatim into a string value.
	test("recovers the real SIO-1219 failure shape", () => {
		const raw = `{"severity":"high","extractedMetrics":[{"name":"timeout","value":"I/O error on GET request for \\"https://gateway/v3/seasons\\":
Timeout deadline: 180000 MILLISECONDS, actual: 180000 MILLISECONDS"}]}`;
		expect(() => JSON.parse(raw)).toThrow();
		const parsed = JSON.parse(sanitizeJsonControlChars(raw));
		expect(parsed.severity).toBe("high");
		expect(parsed.extractedMetrics[0].value).toContain("Timeout deadline");
	});
});

describe("extractJsonBlock", () => {
	test("pulls an object out of surrounding prose", () => {
		expect(extractJsonBlock('Here you go: {"a":1} -- hope that helps')).toBe('{"a":1}');
	});

	test("pulls an object out of a fenced code block", () => {
		expect(extractJsonBlock('```json\n{"a":1}\n```')).toBe('{"a":1}');
	});

	test("pulls an array when the array shape is requested", () => {
		expect(extractJsonBlock('Suggestions: ["one","two"]', "array")).toBe('["one","two"]');
	});

	test("returns null when the requested shape is absent", () => {
		expect(extractJsonBlock("no json here")).toBeNull();
		expect(extractJsonBlock('{"a":1}', "array")).toBeNull();
	});
});

describe("parseLlmJson", () => {
	const schema = z.object({ severity: z.string(), count: z.number() });

	test("returns validated data on the happy path", () => {
		const result = parseLlmJson('{"severity":"high","count":2}', schema);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toEqual({ severity: "high", count: 2 });
	});

	test("sanitizes control chars before parsing", () => {
		const result = parseLlmJson('{"severity":"hi\ngh","count":1}', schema);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.severity).toBe("hi\ngh");
	});

	test("reports no-json when no object is present", () => {
		const result = parseLlmJson("I cannot help with that", schema);
		expect(result).toMatchObject({ ok: false, reason: "no-json" });
	});

	test("reports malformed-json when sanitization cannot rescue it", () => {
		const result = parseLlmJson('{"severity":"high",,}', schema);
		expect(result).toMatchObject({ ok: false, reason: "malformed-json" });
	});

	test("reports schema-mismatch with a field-level message", () => {
		const result = parseLlmJson('{"severity":"high","count":"two"}', schema);
		expect(result).toMatchObject({ ok: false, reason: "schema-mismatch" });
		if (!result.ok) expect(result.message).toContain("count");
	});

	test("never throws for any of the failure modes", () => {
		for (const input of ["", "{", '{"a":', "null", "[]", '{"severity":null,"count":null}']) {
			expect(() => parseLlmJson(input, schema)).not.toThrow();
		}
	});

	test("supports the array shape for list-valued responses", () => {
		const result = parseLlmJson('Here: ["a","b"]', z.array(z.string()), { shape: "array" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toEqual(["a", "b"]);
	});

	test("applies schema transforms", () => {
		const coercing = z.object({ n: z.union([z.string(), z.number()]).transform(String) });
		const result = parseLlmJson('{"n":42}', coercing);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.n).toBe("42");
	});

	test("passes raw data through an unknown schema for callers that validate themselves", () => {
		const result = parseLlmJson('{"verdicts":[{"index":0,"keep":true}]}', z.unknown());
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toEqual({ verdicts: [{ index: 0, keep: true }] });
	});
});

// SIO-1233: envelope drift. The model returns valid JSON whose payload sits under a container
// key it invented. Every assertion here is on the FAILING path only -- a parse that already
// succeeds must be untouched, at all 13 call sites.
describe("parseLlmJson single-key envelope unwrap", () => {
	const schema = z.object({ dataSources: z.array(z.string()) });

	test("unwraps a single-key object wrapper and validates the inner payload", () => {
		const result = parseLlmJson('{"entities":{"dataSources":["kafka"]}}', schema);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.dataSources).toEqual(["kafka"]);
	});

	test("unwraps a single-key wrapper around an array payload", () => {
		const result = parseLlmJson('{"result":["a","b"]}', z.array(z.string()));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toEqual(["a", "b"]);
	});

	test("does NOT unwrap a two-key object", () => {
		const result = parseLlmJson('{"entities":{"dataSources":["kafka"]},"note":"hi"}', schema);
		expect(result.ok).toBe(false);
	});

	test("does NOT unwrap a single key whose value is a scalar", () => {
		const result = parseLlmJson('{"answer":"yes"}', schema);
		expect(result.ok).toBe(false);
	});

	// Depth 1 only: unbounded unwrapping would eventually validate a legitimate nested sub-object.
	test("does NOT unwrap two levels of nesting", () => {
		const result = parseLlmJson('{"outer":{"inner":{"dataSources":["kafka"]}}}', schema);
		expect(result.ok).toBe(false);
	});

	// Reporting the unwrap's error would describe a shape the model never sent.
	test("preserves the ORIGINAL schema error when the unwrap also fails", () => {
		const result = parseLlmJson('{"wrapper":{"somethingElse":1}}', schema);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("dataSources");
	});

	test("a payload that already validates is returned unchanged", () => {
		const single = z.object({ only: z.object({ a: z.number() }) });
		const result = parseLlmJson('{"only":{"a":1}}', single);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toEqual({ only: { a: 1 } });
	});
});

describe("parseLlmJson observedKeys", () => {
	const schema = z.object({ dataSources: z.array(z.string()) });

	test("reports the top-level key names the model actually sent", () => {
		const result = parseLlmJson('{"data_sources":[],"severity":"high"}', schema);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.observedKeys).toEqual(["data_sources", "severity"]);
	});

	test("caps at 10 keys", () => {
		const body = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
		const result = parseLlmJson(JSON.stringify(body), schema);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.observedKeys).toHaveLength(10);
	});

	test("truncates an absurdly long key name", () => {
		const result = parseLlmJson(JSON.stringify({ [`x`.repeat(200)]: 1 }), schema);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.observedKeys?.[0]).toHaveLength(43); // 40 chars + "..."
			expect(result.observedKeys?.[0]).toEndWith("...");
		}
	});

	test("is absent for a non-object root", () => {
		const result = parseLlmJson('["a"]', z.object({ a: z.string() }), { shape: "array" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.observedKeys).toBeUndefined();
	});

	// Key NAMES are model-authored schema vocabulary; values can carry user hostnames/IPs/emails.
	test("never includes values", () => {
		const result = parseLlmJson('{"host":"prod-db-01.internal","user":"a@b.com"}', schema);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.observedKeys).toEqual(["host", "user"]);
			expect(JSON.stringify(result.observedKeys)).not.toContain("prod-db-01");
			expect(JSON.stringify(result.observedKeys)).not.toContain("a@b.com");
		}
	});
});

describe("withKeyAliases", () => {
	const schema = withKeyAliases(z.object({ dataSources: z.array(z.string()) }), {
		data_sources: "dataSources",
		sources: "dataSources",
	});

	test("maps a snake_case alias onto the canonical key", () => {
		const result = parseLlmJson('{"data_sources":["kafka"]}', schema);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.dataSources).toEqual(["kafka"]);
	});

	test("the canonical key WINS when the model sends both", () => {
		const result = parseLlmJson('{"dataSources":["right"],"data_sources":["wrong"]}', schema);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.dataSources).toEqual(["right"]);
	});

	test("leaves a payload with no alias keys untouched", () => {
		const result = parseLlmJson('{"dataSources":["kafka"]}', schema);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.dataSources).toEqual(["kafka"]);
	});

	test("passes a non-object through to the schema unchanged", () => {
		const result = parseLlmJson('["a"]', withKeyAliases(z.array(z.string()), { a: "b" }), { shape: "array" });
		expect(result.ok).toBe(true);
	});

	// An alias whose canonical is present-but-null must not be clobbered into existence either
	// way round; null is a value the model chose to send.
	test("treats an explicit null canonical as present", () => {
		const nullable = withKeyAliases(z.object({ timeFrom: z.string().nullish() }), { time_from: "timeFrom" });
		const result = parseLlmJson('{"timeFrom":null,"time_from":"2026-01-01"}', nullable);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data.timeFrom).toBeNull();
	});
});
