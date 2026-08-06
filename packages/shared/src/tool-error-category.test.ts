// src/tool-error-category.test.ts

import { describe, expect, test } from "bun:test";
import {
	countsTowardDegradedRate,
	isDegradingCategory,
	isRetryableCategory,
	TOOL_ERROR_KIND_TO_CATEGORY,
	type ToolError,
	ToolErrorKindSchema,
} from "./agent-state.ts";

function toolError(over: Partial<ToolError> & Pick<ToolError, "category">): ToolError {
	return { toolName: "t", message: "m", retryable: false, ...over };
}

describe("SIO-1399: bad-input is caller-fixable, not a degraded datasource", () => {
	test("bad-input maps to bad-query, not the unknown catch-all", () => {
		expect(TOOL_ERROR_KIND_TO_CATEGORY["bad-input"]).toBe("bad-query");
	});

	// The defect: a malformed call the LLM could fix by re-issuing counted toward the >15%
	// degraded-subagent cap exactly like a malfunctioning datasource, dragging the answer's
	// confidence down. countsTowardDegradedRate is what the aggregator gates on.
	test("an unrecovered malformed call no longer counts toward the degraded rate", () => {
		const malformed = toolError({ category: TOOL_ERROR_KIND_TO_CATEGORY["bad-input"], kind: "bad-input" });
		expect(countsTowardDegradedRate(malformed)).toBe(false);
	});

	// The remap alone was NOT sufficient: bad-query was itself a degrading category, so a
	// malformed call still dragged confidence down. Both halves are required.
	test("a malformed QUERY (the pre-existing bad-query kind) also stops degrading", () => {
		expect(isDegradingCategory("bad-query")).toBe(false);
		expect(countsTowardDegradedRate(toolError({ category: "bad-query", kind: "bad-query" }))).toBe(false);
	});

	// SIO-1087's original exclusions must survive untouched.
	test("SIO-1087 no-data / not-found exclusions are preserved", () => {
		expect(isDegradingCategory("no-data")).toBe(false);
		expect(isDegradingCategory("not-found")).toBe(false);
	});

	// Genuine malfunctions must still degrade -- this is the blast radius of widening the set.
	test("real datasource malfunctions still degrade", () => {
		for (const category of ["auth", "session", "transient", "server-error", "unknown"] as const) {
			expect(isDegradingCategory(category)).toBe(true);
		}
	});

	// Regression pin: a genuine unknown failure is NOT what SIO-1399 excused. If a future edit
	// widens the exclusion to the whole "unknown" bucket, this fails.
	test("a genuine unknown-category failure still degrades", () => {
		expect(countsTowardDegradedRate(toolError({ category: "unknown", kind: "unknown" }))).toBe(true);
		expect(isDegradingCategory("unknown")).toBe(true);
	});

	// SIO-1164: `recovered` is an independent axis -- the remap must not disturb it.
	test("recovered still suppresses an otherwise-degrading error", () => {
		expect(countsTowardDegradedRate(toolError({ category: "auth", recovered: true }))).toBe(false);
		expect(countsTowardDegradedRate(toolError({ category: "auth" }))).toBe(true);
	});

	// bad-query was already non-retryable ("fix the query, do not blind-retry"). Inheriting that
	// semantics for bad-input is the whole point of choosing this category over a new one.
	test("bad-input stays non-retryable via its category", () => {
		expect(isRetryableCategory(TOOL_ERROR_KIND_TO_CATEGORY["bad-input"])).toBe(false);
	});

	test("every declared kind maps to a category", () => {
		for (const kind of ToolErrorKindSchema.options) {
			expect(TOOL_ERROR_KIND_TO_CATEGORY[kind]).toBeDefined();
		}
	});
});
