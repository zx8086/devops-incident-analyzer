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
});
