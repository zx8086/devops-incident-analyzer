// packages/shared/src/__tests__/agent-state.tool-error-recovery.test.ts
// SIO-1164: ToolErrorSchema.recovered + countsTowardDegradedRate.
import { describe, expect, test } from "bun:test";
import { countsTowardDegradedRate, ToolErrorSchema } from "../agent-state.ts";

describe("ToolErrorSchema recovered field", () => {
	test("accepts a ToolError without recovered (backward-compat)", () => {
		const parsed = ToolErrorSchema.safeParse({
			toolName: "capella_run_sql_plus_plus_query",
			category: "bad-query",
			message: "no queryable index",
			retryable: false,
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts recovered: true", () => {
		const parsed = ToolErrorSchema.safeParse({
			toolName: "capella_run_sql_plus_plus_query",
			category: "bad-query",
			message: "no queryable index",
			retryable: false,
			recovered: true,
		});
		expect(parsed.success).toBe(true);
		expect(parsed.data?.recovered).toBe(true);
	});
});

describe("countsTowardDegradedRate", () => {
	test("degrading category, not recovered -> counts", () => {
		expect(countsTowardDegradedRate({ category: "bad-query", recovered: false })).toBe(true);
	});

	test("degrading category, recovered -> does not count", () => {
		expect(countsTowardDegradedRate({ category: "bad-query", recovered: true })).toBe(false);
	});

	test("degrading category, recovered undefined -> counts (default unrecovered)", () => {
		expect(countsTowardDegradedRate({ category: "transient", recovered: undefined })).toBe(true);
	});

	test("non-degrading category (no-data), recovered false -> still does not count", () => {
		expect(countsTowardDegradedRate({ category: "no-data", recovered: false })).toBe(false);
	});

	test("non-degrading category (not-found), regardless of recovered -> does not count", () => {
		expect(countsTowardDegradedRate({ category: "not-found", recovered: true })).toBe(false);
		expect(countsTowardDegradedRate({ category: "not-found", recovered: false })).toBe(false);
	});
});
