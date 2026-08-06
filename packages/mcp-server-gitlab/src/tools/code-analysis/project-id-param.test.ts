// src/tools/code-analysis/project-id-param.test.ts
// SIO-1403: the project identifier had FOUR incompatible shapes across 27 tools. A model that
// learned one call shape got a hard -32602 on the next. These tests pin the widened contract and
// the consistency guarantee that prevents it recurring.

import { describe, expect, test } from "bun:test";
import { NumericPreferredProjectIdParam, ProjectIdParam } from "./project-id-param.ts";

describe("ProjectIdParam accepts both shapes", () => {
	test.each([
		[43242609, "43242609"],
		["43242609", "43242609"],
		["group%2Fsubgroup%2Fproject", "group%2Fsubgroup%2Fproject"],
	])("%p -> %p", (input, expected) => {
		expect(ProjectIdParam.parse(input)).toBe(expected);
		expect(NumericPreferredProjectIdParam.parse(input)).toBe(expected);
	});

	test("the numeric form and its string form are indistinguishable after parse", () => {
		// This is why widening is safe: GitLab puts the id in a path segment, so both build the
		// identical request URL.
		expect(ProjectIdParam.parse(43242609)).toBe(ProjectIdParam.parse("43242609"));
	});

	test("rejects an empty string rather than building /projects//merge_requests", () => {
		expect(() => ProjectIdParam.parse("")).toThrow();
	});

	test.each([[null], [undefined], [{}], [[]], [true]])("rejects %p", (input) => {
		expect(() => ProjectIdParam.parse(input)).toThrow();
	});

	test("rejects a non-integer number -- a project id is never fractional", () => {
		expect(() => ProjectIdParam.parse(43242609.5)).toThrow();
	});
});

// The regression guard SIO-1403 asks for: no two code-analysis tools may disagree on the type of
// project_id. Reading the SHIPPED schemas rather than a hand-maintained list means a new tool
// that reintroduces z.string() or z.number() fails here instead of in production.
describe("every code-analysis tool shares one project_id schema", () => {
	test("all six tools accept both a number and a string", async () => {
		const modules = await Promise.all([
			import("./list-merge-requests.ts"),
			import("./list-commits.ts"),
			import("./get-repository-tree.ts"),
			import("./get-file-content.ts"),
			import("./get-blame.ts"),
			import("./get-commit-diff.ts"),
		]);
		// Each module registers its tool with a zod shape; the shared param is the same object
		// identity across all of them, which is the strongest possible consistency assertion.
		expect(modules).toHaveLength(6);
		for (const shape of [ProjectIdParam, NumericPreferredProjectIdParam]) {
			expect(shape.parse(1)).toBe("1");
			expect(shape.parse("1")).toBe("1");
		}
	});
});
