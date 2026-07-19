// tests/lib/filter.test.ts
import { describe, expect, test } from "bun:test";
import { compileFilterOrThrow, InvalidFilterError } from "../../src/lib/filter.ts";

describe("compileFilterOrThrow (SIO-1105)", () => {
	test("compiles a valid regex pattern", () => {
		const re = compileFilterOrThrow("^T_dlq_");
		expect(re).toBeInstanceOf(RegExp);
		expect(re.test("T_dlq_0001")).toBe(true);
		expect(re.test("other")).toBe(false);
	});

	test("throws InvalidFilterError on a metacharacter-bearing bad pattern", () => {
		// This is the exact fragment from the SIO-1105 live incident: `(?` throws
		// SyntaxError "Invalid regular expression: unrecognized character after (?".
		expect(() => compileFilterOrThrow("foo(?bar")).toThrow(InvalidFilterError);
	});

	test("InvalidFilterError carries the offending filter and a reason", () => {
		try {
			compileFilterOrThrow("foo(?bar");
			throw new Error("expected InvalidFilterError to be thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidFilterError);
			const e = err as InvalidFilterError;
			expect(e.filter).toBe("foo(?bar");
			expect(e.reason).toContain("Invalid regular expression");
		}
	});

	test("an unbalanced bracket also throws InvalidFilterError, not a raw SyntaxError", () => {
		expect(() => compileFilterOrThrow("foo[bar")).toThrow(InvalidFilterError);
	});

	// SIO-1105: a compile-VALID but pathological pattern (nested quantifier) causes
	// catastrophic backtracking -- ReDoS. new RegExp() accepts it, so the SyntaxError
	// catch alone does not cover it. compileFilterOrThrow must reject the shape up front.
	test("rejects a catastrophic-backtracking (ReDoS) pattern", () => {
		expect(() => compileFilterOrThrow("^(a+)+$")).toThrow(InvalidFilterError);
	});

	test("rejects other nested-quantifier ReDoS shapes", () => {
		expect(() => compileFilterOrThrow("(a*)*")).toThrow(InvalidFilterError);
		expect(() => compileFilterOrThrow("(x+)*")).toThrow(InvalidFilterError);
		expect(() => compileFilterOrThrow("([ab]+)+")).toThrow(InvalidFilterError);
	});

	// SIO-1105: a quantified ALTERNATION group with overlapping branches (e.g. `(a|aa)+`) is also
	// exponential but has no inner quantifier, so the nested-quantifier check alone misses it
	// (CodeRabbit follow-up). Reject a quantified group that contains `|`.
	test("rejects quantified-alternation ReDoS shapes", () => {
		expect(() => compileFilterOrThrow("^(a|aa)+$")).toThrow(InvalidFilterError);
		expect(() => compileFilterOrThrow("^(a|a?)+$")).toThrow(InvalidFilterError);
		expect(() => compileFilterOrThrow("(a|b|ab)*")).toThrow(InvalidFilterError);
	});

	test("does NOT reject UNquantified alternation groups (common, safe)", () => {
		// (prod|staging)-payments etc. -- alternation is fine unless the GROUP is quantified.
		expect(compileFilterOrThrow("(prod|staging)-payments")).toBeInstanceOf(RegExp);
		expect(compileFilterOrThrow("^T_(dlq|retry)_[a-z]+$")).toBeInstanceOf(RegExp);
		expect(compileFilterOrThrow("(a|b){2}")).toBeInstanceOf(RegExp);
		expect(compileFilterOrThrow("payments|orders")).toBeInstanceOf(RegExp);
	});

	test("ReDoS rejection carries a reason mentioning the risk", () => {
		try {
			compileFilterOrThrow("^(a+)+$");
			throw new Error("expected InvalidFilterError to be thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidFilterError);
			expect((err as InvalidFilterError).reason).toContain("backtracking");
		}
	});

	test("rejects an over-long filter (longer than any Kafka name can be)", () => {
		expect(() => compileFilterOrThrow("a".repeat(300))).toThrow(InvalidFilterError);
	});

	test("does NOT false-positive on normal filters with a single quantifier per group", () => {
		// Common, safe patterns must still compile.
		expect(compileFilterOrThrow("^orders-.*")).toBeInstanceOf(RegExp);
		expect(compileFilterOrThrow("(prod|staging)-payments")).toBeInstanceOf(RegExp);
		expect(compileFilterOrThrow("service-[0-9]+")).toBeInstanceOf(RegExp);
		expect(compileFilterOrThrow("^T_(dlq|retry)_[a-z]+$")).toBeInstanceOf(RegExp);
	});
});

// SIO-1159: LLM callers habitually emit the PCRE inline flag "(?i)pattern", which JS
// RegExp rejects. Run 270378e0 lost an iteration to "(?i)localcore|assignment|...".
// A leading (?i) is stripped and compiled with the "i" flag instead of erroring.
describe("compileFilterOrThrow (?i) leniency (SIO-1159)", () => {
	test("accepts a leading (?i) and compiles case-insensitively", () => {
		const re = compileFilterOrThrow("(?i)localcore|assignment|soldto|sold.to");
		expect(re.flags).toContain("i");
		expect(re.test("LOCALCORE-service")).toBe(true);
		expect(re.test("customer-Assignments")).toBe(true);
		expect(re.test("unrelated")).toBe(false);
	});

	test("plain patterns remain case-sensitive", () => {
		const re = compileFilterOrThrow("localcore");
		expect(re.flags).not.toContain("i");
		expect(re.test("LOCALCORE")).toBe(false);
	});

	test("a NON-leading (?i) still throws the typed error", () => {
		expect(() => compileFilterOrThrow("orders(?i)-dlq")).toThrow(InvalidFilterError);
	});

	test("ReDoS guard still applies to the stripped pattern", () => {
		expect(() => compileFilterOrThrow("(?i)^(a+)+$")).toThrow(InvalidFilterError);
	});
});
