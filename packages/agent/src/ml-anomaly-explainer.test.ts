// agent/src/ml-anomaly-explainer.test.ts
// SIO-1215: fixtures mirror the elasticsearch_ml_get_anomaly_records structured
// JSON envelope (count/lookback/minScoreApplied/jobsSummary/summaries).
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { buildMlAnomalyExplainer, MAX_RECORDS, summarizeMlAnomalyExplainerForPrompt } from "./ml-anomaly-explainer.ts";

function elasticResult(rawJson: unknown): DataSourceResult {
	return {
		dataSourceId: "elastic",
		data: {},
		status: "success",
		toolOutputs: [{ toolName: "elasticsearch_ml_get_anomaly_records", rawJson }],
	};
}

const RECORD_1 = {
	jobId: "k8s-pod-memory-high-by-namespace",
	recordScore: 97.66,
	fieldName: "kubernetes.pod.memory.usage.bytes",
	functionName: "high_mean",
	entity: "mithena-db-5",
	deviationPercent: 938,
	actual: [7018553617],
	typical: [676061024],
	timestamp: "2026-07-16T00:00:00.000Z",
};

const RECORD_2 = {
	jobId: "mendix-error-rate-by-app",
	recordScore: 99.33,
	fieldName: undefined,
	functionName: "high_non_zero_count",
	entity: "chargeb",
	deviationPercent: 104,
	actual: [3963],
	typical: [3.76],
	timestamp: "2026-07-17T00:00:00.000Z",
};

describe("buildMlAnomalyExplainer", () => {
	test("returns undefined when no anomaly-records tool output is present", () => {
		expect(buildMlAnomalyExplainer([])).toBeUndefined();
		expect(
			buildMlAnomalyExplainer([{ dataSourceId: "elastic", data: {}, status: "success", toolOutputs: [] }]),
		).toBeUndefined();
	});

	test("returns undefined on a malformed envelope instead of throwing", () => {
		expect(buildMlAnomalyExplainer([elasticResult({ notSummaries: [] })])).toBeUndefined();
	});

	test("parses records, jobsSummary, lookback, and minScoreApplied from the structured envelope", () => {
		const explainer = buildMlAnomalyExplainer([
			elasticResult({
				count: 2,
				lookback: "now-24h",
				minScoreApplied: 75,
				jobsSummary: [
					{ jobId: "k8s-pod-memory-high-by-namespace", count: 1 },
					{ jobId: "mendix-error-rate-by-app", count: 1 },
				],
				summaries: [RECORD_1, RECORD_2],
			}),
		]);
		expect(explainer).toBeDefined();
		if (!explainer) return;
		expect(explainer.lookback).toBe("now-24h");
		expect(explainer.minScoreApplied).toBe(75);
		expect(explainer.records).toHaveLength(2);
		expect(explainer.jobsSummary).toHaveLength(2);
	});

	test("minScoreApplied stays undefined when the caller queried without a score filter", () => {
		const explainer = buildMlAnomalyExplainer([
			elasticResult({ count: 1, lookback: "now-24h", jobsSummary: [], summaries: [RECORD_1] }),
		]);
		expect(explainer).toBeDefined();
		expect(explainer?.minScoreApplied).toBeUndefined();
	});

	test("mode is detail for a small, focused result set", () => {
		const explainer = buildMlAnomalyExplainer([
			elasticResult({ count: 1, lookback: "now-24h", jobsSummary: [], summaries: [RECORD_1] }),
		]);
		expect(explainer?.mode).toBe("detail");
	});

	test("mode is overview for a larger result set", () => {
		const many = Array.from({ length: 5 }, (_, i) => ({ ...RECORD_1, jobId: `job-${i}` }));
		const explainer = buildMlAnomalyExplainer([
			elasticResult({ count: many.length, lookback: "now-24h", jobsSummary: [], summaries: many }),
		]);
		expect(explainer?.mode).toBe("overview");
	});

	test("caps records at MAX_RECORDS and sets truncated", () => {
		const many = Array.from({ length: MAX_RECORDS + 10 }, (_, i) => ({ ...RECORD_1, jobId: `job-${i}` }));
		const explainer = buildMlAnomalyExplainer([
			elasticResult({ count: many.length, lookback: "now-24h", jobsSummary: [], summaries: many }),
		]);
		expect(explainer?.records).toHaveLength(MAX_RECORDS);
		expect(explainer?.truncated).toBe(true);
	});

	test("empty summaries array is a valid, non-undefined explainer (count: 0 is an answer, not an absence)", () => {
		const explainer = buildMlAnomalyExplainer([
			elasticResult({ count: 0, lookback: "now-24h", minScoreApplied: 99.99, jobsSummary: [], summaries: [] }),
		]);
		expect(explainer).toBeDefined();
		expect(explainer?.records).toHaveLength(0);
	});
});

describe("summarizeMlAnomalyExplainerForPrompt", () => {
	test("reports 'none returned' for an empty explainer", () => {
		const explainer = buildMlAnomalyExplainer([
			elasticResult({ count: 0, lookback: "now-24h", jobsSummary: [], summaries: [] }),
		]);
		if (!explainer) throw new Error("expected explainer");
		expect(summarizeMlAnomalyExplainerForPrompt(explainer)).toMatch(/none returned/);
	});

	test("includes per-job counts when jobsSummary is non-empty", () => {
		const explainer = buildMlAnomalyExplainer([
			elasticResult({
				count: 1,
				lookback: "now-24h",
				jobsSummary: [{ jobId: "k8s-pod-memory-high-by-namespace", count: 1 }],
				summaries: [RECORD_1],
			}),
		]);
		if (!explainer) throw new Error("expected explainer");
		expect(summarizeMlAnomalyExplainerForPrompt(explainer)).toContain("k8s-pod-memory-high-by-namespace=1");
	});
});
