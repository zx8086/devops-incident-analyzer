// src/tools/cloudwatch/metrics-insights-query.test.ts

import { describe, expect, test } from "bun:test";
import {
	metricsInsightsQuerySchema,
	resolveInsightsWindow,
	summarizeMetricsInsights,
} from "./metrics-insights-query.ts";

// SIO-1161: schema and pure-helper tests for the Metrics Insights SQL tool. No live SDK calls --
// the handler is exercised end-to-end by the wrap tests and the live MCP probe.
const NOW = 1_760_000_000;

describe("metricsInsightsQuerySchema", () => {
	test("accepts a bare SQL query", () => {
		expect(
			metricsInsightsQuerySchema.safeParse({
				query:
					'SELECT MAX(CPUUtilization) FROM SCHEMA("AWS/EC2", InstanceId) GROUP BY InstanceId ORDER BY MAX() DESC LIMIT 10',
			}).success,
		).toBe(true);
	});

	test("accepts the full window + period form", () => {
		expect(
			metricsInsightsQuerySchema.safeParse({
				query:
					'SELECT SUM(Errors) FROM SCHEMA("AWS/Lambda", FunctionName) GROUP BY FunctionName ORDER BY SUM() DESC LIMIT 10',
				period: 60,
				startRelative: "now-14d",
				endRelative: "now",
			}).success,
		).toBe(true);
	});

	test("rejects an empty query", () => {
		expect(metricsInsightsQuerySchema.safeParse({ query: "" }).success).toBe(false);
	});

	test("rejects a whitespace-only query", () => {
		expect(metricsInsightsQuerySchema.safeParse({ query: "   " }).success).toBe(false);
	});

	test("rejects a query over the 2048-character Expression cap", () => {
		expect(metricsInsightsQuerySchema.safeParse({ query: `SELECT AVG(x) FROM y${"!".repeat(2_048)}` }).success).toBe(
			false,
		);
	});

	test("rejects a malformed startRelative token at the schema layer", () => {
		expect(
			metricsInsightsQuerySchema.safeParse({ query: "SELECT AVG(x) FROM y", startRelative: "yesterday" }).success,
		).toBe(false);
		expect(metricsInsightsQuerySchema.safeParse({ query: "SELECT AVG(x) FROM y", endRelative: "3h-ago" }).success).toBe(
			false,
		);
	});

	test("rejects a period below the 60s Metrics Insights floor", () => {
		expect(metricsInsightsQuerySchema.safeParse({ query: "SELECT AVG(x) FROM y", period: 30 }).success).toBe(false);
	});

	test("rejects a non-integer period", () => {
		expect(metricsInsightsQuerySchema.safeParse({ query: "SELECT AVG(x) FROM y", period: 90.5 }).success).toBe(false);
	});
});

describe("resolveInsightsWindow", () => {
	test("defaults to now-3h..now", () => {
		expect(resolveInsightsWindow({}, NOW)).toEqual({ start: NOW - 3 * 3_600, end: NOW });
	});

	test("honors explicit relative tokens", () => {
		expect(resolveInsightsWindow({ startRelative: "now-14d", endRelative: "now-1h" }, NOW)).toEqual({
			start: NOW - 14 * 86_400,
			end: NOW - 3_600,
		});
	});

	// Malformed tokens are rejected at the schema layer (see above); the ?? fallback inside
	// resolveInsightsWindow is defensive only and deliberately mirrors the 3h default.
});

describe("summarizeMetricsInsights", () => {
	test("projects max/latest per series from newest-first Values", () => {
		const ts = [new Date((NOW - 60) * 1000), new Date((NOW - 120) * 1000)];
		const summary = summarizeMetricsInsights({
			$metadata: {},
			MetricDataResults: [
				{ Id: "q1", Label: "orders-service", StatusCode: "Complete", Values: [40, 90], Timestamps: ts },
			],
		});
		expect(summary).toEqual([
			{
				Id: "q1",
				Label: "orders-service",
				StatusCode: "Complete",
				maxValue: 90,
				latestValue: 40,
				latestTimestamp: ts[0],
			},
		]);
	});

	test("empty Values -> maxValue and latestValue undefined", () => {
		const summary = summarizeMetricsInsights({
			$metadata: {},
			MetricDataResults: [{ Id: "q1", Label: "idle", StatusCode: "Complete", Values: [], Timestamps: [] }],
		});
		expect(summary[0]?.maxValue).toBeUndefined();
		expect(summary[0]?.latestValue).toBeUndefined();
	});

	test("missing MetricDataResults -> empty array", () => {
		expect(summarizeMetricsInsights({ $metadata: {} })).toEqual([]);
	});
});
