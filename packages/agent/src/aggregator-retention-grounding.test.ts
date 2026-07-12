// packages/agent/src/aggregator-retention-grounding.test.ts
//
// SIO-1079: the aggregator hallucinated "CloudWatch logs are expired (80-day retention
// exceeded)" from a MalformedQueryException, which is a QUERY-WINDOW error, not evidence of
// expiry. Live A/B proved the logs existed. These tests lock a retention/expiry grounding
// guard: a "logs expired / retention exceeded" claim not backed by an observed expiry is
// rewritten to the neutral truth.

import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { detectUngroundedExpiry, rewriteUngroundedExpiry } from "./aggregator.ts";

function result(over: Partial<DataSourceResult>): DataSourceResult {
	return { dataSourceId: "aws", data: {}, status: "success", ...over };
}

const REPORT_WITH_EXPIRY_GAP = `## Gaps

- CloudWatch application logs are expired for this incident date (80-day retention exceeded), preventing log-level drill-down from the AWS side.
- No Jira incident was raised for localcore-service.

Confidence: 0.62`;

describe("detectUngroundedExpiry (SIO-1079)", () => {
	test("flags a 'logs expired / retention exceeded' gap when only a query-window error was observed", () => {
		const results = [
			result({
				toolErrors: [
					{
						toolName: "aws_logs_start_query",
						category: "unknown",
						message:
							"Query's end date and time is either before the log groups creation time or exceeds the log groups log retention settings ([0,79])",
						retryable: false,
					},
				],
			}),
		];
		const { ungrounded } = detectUngroundedExpiry(REPORT_WITH_EXPIRY_GAP, results);
		expect(ungrounded).toHaveLength(1);
		expect(ungrounded[0]).toContain("expired");
	});

	test("does NOT flag the non-expiry bullet (Jira)", () => {
		const results = [result({ toolErrors: [] })];
		const { ungrounded } = detectUngroundedExpiry(REPORT_WITH_EXPIRY_GAP, results);
		expect(ungrounded.every((l) => !l.includes("Jira"))).toBe(true);
	});

	test("does NOT flag when an actual expiry/absence was observed (e.g. describe returned zero groups)", () => {
		// If a describe-log-groups genuinely reported the group absent, an "expired/absent"
		// claim is grounded. We model that as an observed-absence signal in the result data.
		const results = [
			result({
				data: "aws_logs_describe_log_groups returned logGroups: [] (no such log group)",
				toolErrors: [],
			}),
		];
		const { ungrounded } = detectUngroundedExpiry(REPORT_WITH_EXPIRY_GAP, results);
		expect(ungrounded).toHaveLength(0);
	});

	test("rewrite replaces the flagged expiry bullet with the neutral truth, preserves the rest", () => {
		const results = [
			result({
				toolErrors: [
					{
						toolName: "aws_logs_start_query",
						category: "unknown",
						message: "... log retention settings ([0,79])",
						retryable: false,
					},
				],
			}),
		];
		const { ungrounded } = detectUngroundedExpiry(REPORT_WITH_EXPIRY_GAP, results);
		const rewritten = rewriteUngroundedExpiry(REPORT_WITH_EXPIRY_GAP, ungrounded);
		expect(rewritten).not.toContain("are expired for this incident date");
		expect(rewritten.toLowerCase()).toContain("window error");
		expect(rewritten.toLowerCase()).toContain("does not confirm the logs are expired");
		// Untouched bullets survive.
		expect(rewritten).toContain("No Jira incident was raised");
		expect(rewritten).toContain("Confidence: 0.62");
	});

	test("no expiry claim in the report => nothing flagged", () => {
		const clean = "## Gaps\n\n- No Jira incident was raised.\n\nConfidence: 0.7";
		const results = [
			result({
				toolErrors: [{ toolName: "aws_logs_start_query", category: "unknown", message: "([0,79])", retryable: false }],
			}),
		];
		expect(detectUngroundedExpiry(clean, results).ungrounded).toHaveLength(0);
	});
});
