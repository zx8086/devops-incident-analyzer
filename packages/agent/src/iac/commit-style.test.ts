// agent/src/iac/commit-style.test.ts

import { describe, expect, test } from "bun:test";
import { COMMIT_SUBJECT_MAX, formatCommitSubject } from "./commit-style.ts";

describe("formatCommitSubject (SIO-1185)", () => {
	test("passes short house-style subjects through untouched", () => {
		const s = "eu-b2b: resize hot tier (4g)";
		expect(formatCommitSubject(s)).toBe(s);
	});

	test("caps at 72 characters on a word boundary with ASCII ellipsis", () => {
		const long = `us-cld: cluster-defaults ${"logs-template-".repeat(8)} (number_of_replicas)`;
		const out = formatCommitSubject(long);
		expect(out.length).toBeLessThanOrEqual(COMMIT_SUBJECT_MAX);
		expect(out.endsWith("...")).toBe(true);
		expect(out.startsWith("us-cld: cluster-defaults")).toBe(true);
	});

	test("keeps only the first line of a multi-line message", () => {
		expect(formatCommitSubject("eu-b2b: bind template\n\nbody text here")).toBe("eu-b2b: bind template");
	});

	test("tiny max still honors the cap (hard slice, no ellipsis room)", () => {
		expect(formatCommitSubject("abcdef", 3)).toBe("abc");
		expect(formatCommitSubject("abcdef", 2).length).toBeLessThanOrEqual(2);
	});

	test("exact-72 subject is not truncated", () => {
		const s = "x".repeat(COMMIT_SUBJECT_MAX);
		expect(formatCommitSubject(s)).toBe(s);
	});
});
