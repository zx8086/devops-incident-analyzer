// src/tools/wrap.test.ts
//
// SIO-1078: mapAwsError must classify a CloudWatch Logs retention-window rejection
// (MalformedQueryException) as bad-input with a retention-specific advice string, so the
// sub-agent stops looping an unrecoverable query window.

import { describe, expect, test } from "bun:test";
import { mapAwsError } from "./wrap.ts";

const RETENTION_MSG =
	"Query's end date and time is either before the log groups creation time or exceeds the log groups log retention settings ([0,79])";

describe("mapAwsError retention-window handling (SIO-1078)", () => {
	test("MalformedQueryException -> bad-input with retention advice", () => {
		const err = Object.assign(new Error(RETENTION_MSG), { name: "MalformedQueryException" });
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("bad-input");
		expect(mapped.advice).toBeDefined();
		expect(mapped.advice).toContain("retention");
		expect(mapped.advice).toContain("aws_logs_describe_log_groups");
	});

	test("regex fallback: retention message under a generic error name -> bad-input + advice", () => {
		const err = Object.assign(new Error(RETENTION_MSG), { name: "SomeUnexpectedException" });
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("bad-input");
		expect(mapped.advice).toContain("retention");
	});

	// SIO-1085: a MalformedQueryException can be a query-SYNTAX error, not a window
	// problem. It must get syntax advice (fix the queryString), NOT retention/re-anchor
	// advice -- the latter made the agent loop re-anchoring a window that was never wrong.
	test("MalformedQueryException with a SYNTAX message -> syntax advice, not retention", () => {
		const syntaxMsg =
			"Invalid syntax while using query definition snippets: unexpected symbol found fields at line 1 and position 0";
		const err = Object.assign(new Error(syntaxMsg), { name: "MalformedQueryException" });
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("bad-input");
		expect(mapped.advice).toBeDefined();
		expect(mapped.advice).toContain("SYNTAX");
		expect(mapped.advice).toContain("fields @timestamp");
		// must NOT steer to re-anchoring the window
		expect(mapped.advice).not.toContain("aws_logs_describe_log_groups");
		expect(mapped.advice).not.toContain("retention window");
	});

	test("a retention-message MalformedQueryException still gets retention advice (unchanged)", () => {
		const err = Object.assign(new Error(RETENTION_MSG), { name: "MalformedQueryException" });
		const mapped = mapAwsError(err);
		expect(mapped.advice).toContain("retention");
		expect(mapped.advice).toContain("aws_logs_describe_log_groups");
	});

	// SIO-1085 (CodeRabbit): the syntax branch is gated on the exact error NAME, so a
	// generic ValidationException whose message happens to contain syntax-like phrasing
	// ("unexpected token") must NOT be told to rewrite queryString -- it keeps its own
	// remediation (no advice here).
	test("a ValidationException with syntax-like text does NOT get queryString-rewrite advice", () => {
		const err = Object.assign(new Error("unexpected token near 'FOO' in parameter value"), {
			name: "ValidationException",
		});
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("bad-input");
		expect(mapped.advice).toBeUndefined();
	});

	test("a plain ValidationException stays bad-input WITHOUT retention advice", () => {
		const err = Object.assign(new Error("The value 'x' is not valid"), { name: "ValidationException" });
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("bad-input");
		expect(mapped.advice).toBeUndefined();
	});

	test("an unrelated unknown error stays aws-unknown", () => {
		const err = Object.assign(new Error("something else entirely"), { name: "WeirdException" });
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("aws-unknown");
	});

	// SIO-1141: an AMBIGUOUS MalformedQueryException -- message matches NEITHER the syntax nor
	// the retention pattern -- must get advice naming BOTH failure modes (relative-window retry
	// AND syntax simplification), not the pure re-anchor advice that looped the eu-oit-prd query.
	test("ambiguous MalformedQueryException -> advice names both window and syntax recovery", () => {
		const err = Object.assign(new Error("MalformedQueryException: the query could not be executed"), {
			name: "MalformedQueryException",
		});
		const mapped = mapAwsError(err);
		expect(mapped.kind).toBe("bad-input");
		expect(mapped.advice).toBeDefined();
		// names the drift-proof relative-window recovery...
		expect(mapped.advice).toContain('startRelative:"now-30d"');
		// ...AND the syntax fallback so a syntax error is not looped as a window error.
		expect(mapped.advice).toContain("SYNTAX");
		expect(mapped.advice).toContain("fields @timestamp");
	});

	// A generic ValidationException (NOT MalformedQueryException) must NOT get the dual-mode
	// CloudWatch-Logs advice -- it keeps its own (absent) remediation.
	test("a generic ValidationException does NOT get the dual-mode query advice", () => {
		const err = Object.assign(new Error("some other bad input"), { name: "ValidationException" });
		const mapped = mapAwsError(err);
		expect(mapped.advice).toBeUndefined();
	});
});
