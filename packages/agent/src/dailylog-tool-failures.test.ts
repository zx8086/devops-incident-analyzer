// agent/src/dailylog-tool-failures.test.ts
// SIO-1687: the daily-log breadcrumb records WHICH datasources hit tool failures
// and of what category, so a later session can see "capella has failed auth
// before" without the daily log becoming a log sink.
import { describe, expect, test } from "bun:test";
import { collectToolFailures, isDailyLogToolFailuresEnabled } from "./follow-up-generator.ts";
import type { AgentStateType } from "./state.ts";

function stateWith(results: unknown[]): AgentStateType {
	return { dataSourceResults: results } as unknown as AgentStateType;
}

describe("isDailyLogToolFailuresEnabled", () => {
	test("defaults ON and is disabled only by an explicit kill-switch value", () => {
		expect(isDailyLogToolFailuresEnabled({})).toBe(true);
		expect(isDailyLogToolFailuresEnabled({ DAILYLOG_TOOL_FAILURES_ENABLED: "true" })).toBe(true);
		expect(isDailyLogToolFailuresEnabled({ DAILYLOG_TOOL_FAILURES_ENABLED: "false" })).toBe(false);
		expect(isDailyLogToolFailuresEnabled({ DAILYLOG_TOOL_FAILURES_ENABLED: "0" })).toBe(false);
	});
});

describe("collectToolFailures", () => {
	test("a clean turn produces no tags", () => {
		expect(collectToolFailures(stateWith([{ dataSourceId: "elastic", status: "success" }]))).toEqual([]);
	});

	test("tags each failure as datasource:category", () => {
		const tags = collectToolFailures(
			stateWith([
				{
					dataSourceId: "capella",
					toolErrors: [{ toolName: "q", category: "auth", message: "403", retryable: false }],
				},
			]),
		);
		expect(tags).toEqual(["capella:auth"]);
	});

	test("dedupes repeats of the same datasource and category", () => {
		const tags = collectToolFailures(
			stateWith([
				{
					dataSourceId: "aws",
					toolErrors: [
						{ toolName: "a", category: "auth", message: "x", retryable: false },
						{ toolName: "b", category: "auth", message: "y", retryable: false },
						{ toolName: "c", category: "transient", message: "z", retryable: true },
					],
				},
			]),
		);
		expect(tags).toEqual(["aws:auth", "aws:transient"]);
	});

	test("keeps datasources distinct", () => {
		const tags = collectToolFailures(
			stateWith([
				{ dataSourceId: "kafka", toolErrors: [{ toolName: "a", category: "auth", message: "x", retryable: false }] },
				{ dataSourceId: "elastic", toolErrors: [{ toolName: "b", category: "auth", message: "y", retryable: false }] },
			]),
		);
		expect(tags).toEqual(["elastic:auth", "kafka:auth"]);
	});

	// Upstream messages are unbounded text and can carry credentials or PII; the
	// category enum is the whole point of recording categories instead.
	test("records categories only, never upstream message text", () => {
		const tags = collectToolFailures(
			stateWith([
				{
					dataSourceId: "gitlab",
					toolErrors: [{ toolName: "t", category: "auth", message: "token ghp_SECRET rejected", retryable: false }],
				},
			]),
		);
		expect(tags.join(" ")).not.toContain("ghp_SECRET");
		expect(tags).toEqual(["gitlab:auth"]);
	});

	test("bounds the tag list so one flapping turn cannot dominate the line", () => {
		const results = Array.from({ length: 30 }, (_, i) => ({
			dataSourceId: `ds${i}`,
			toolErrors: [{ toolName: "t", category: "transient", message: "x", retryable: true }],
		}));
		expect(collectToolFailures(stateWith(results)).length).toBe(12);
	});

	test("ignores results with no toolErrors field", () => {
		expect(
			collectToolFailures(stateWith([{ dataSourceId: "elastic" }, { dataSourceId: "aws", toolErrors: [] }])),
		).toEqual([]);
	});
});
