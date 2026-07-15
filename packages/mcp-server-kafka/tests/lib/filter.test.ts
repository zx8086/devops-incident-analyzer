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
});
