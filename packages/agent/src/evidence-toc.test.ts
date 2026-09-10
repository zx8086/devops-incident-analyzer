// agent/src/evidence-toc.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { buildEvidenceToc, isEvidenceTocEnabled } from "./evidence-toc.ts";

function result(over: Partial<DataSourceResult> = {}): DataSourceResult {
	return {
		dataSourceId: "elastic",
		data: {},
		status: "success",
		toolOutputs: [{ toolName: "elasticsearch_search", rawJson: { hits: { total: 12 } } }],
		...over,
	} as DataSourceResult;
}

describe("isEvidenceTocEnabled", () => {
	test("defaults ON and is disabled only by an explicit kill-switch value", () => {
		expect(isEvidenceTocEnabled({})).toBe(true);
		expect(isEvidenceTocEnabled({ EVIDENCE_TOC_ENABLED: "true" })).toBe(true);
		expect(isEvidenceTocEnabled({ EVIDENCE_TOC_ENABLED: "" })).toBe(true);
		expect(isEvidenceTocEnabled({ EVIDENCE_TOC_ENABLED: "false" })).toBe(false);
		expect(isEvidenceTocEnabled({ EVIDENCE_TOC_ENABLED: "0" })).toBe(false);
	});
});

describe("buildEvidenceToc", () => {
	test("returns undefined when there is nothing to describe", () => {
		expect(buildEvidenceToc(undefined)).toBeUndefined();
		expect(buildEvidenceToc([])).toBeUndefined();
	});

	test("names the datasource, its tools and the byte volume", () => {
		const toc = buildEvidenceToc([result()]);
		expect(toc).toContain("Evidence fetched on the previous turn");
		expect(toc).toContain("elastic");
		expect(toc).toContain("elasticsearch_search");
		expect(toc).toContain("1 tool call(s)");
	});

	// The whole point of the TOC: a follow-up turn must not read pruned evidence
	// as absent evidence.
	test("states that the datasources were queried", () => {
		const toc = buildEvidenceToc([result()]) ?? "";
		expect(toc).toContain("WERE queried");
		expect(toc).toContain("do not report them as unqueried");
	});

	test("carries provenance, never the evidence itself", () => {
		const toc = buildEvidenceToc([
			result({ toolOutputs: [{ toolName: "aws_logs_filter", rawJson: { secretPayload: "TOP-SECRET-VALUE" } }] }),
		]);
		expect(toc).not.toContain("TOP-SECRET-VALUE");
		expect(toc).toContain("aws_logs_filter");
	});

	test("qualifies a deployment-scoped result by deployment id", () => {
		const toc = buildEvidenceToc([result({ deploymentId: "prod" })]);
		expect(toc).toContain("elastic/prod");
	});

	test("reports a failed datasource as failed, with its reason", () => {
		const toc = buildEvidenceToc([result({ status: "error", error: "connect ETIMEDOUT", toolOutputs: undefined })]);
		expect(toc).toContain("FAILED");
		expect(toc).toContain("connect ETIMEDOUT");
	});

	test("distinguishes no-tool-output from failure", () => {
		const toc = buildEvidenceToc([result({ toolOutputs: [] })]);
		expect(toc).toContain("no tool output");
		expect(toc).not.toContain("FAILED");
	});

	test("summarizes tool errors by category, not by message", () => {
		const toc = buildEvidenceToc([
			result({
				toolErrors: [
					{ toolName: "t1", category: "auth", message: "403 forbidden for user hunter2", retryable: false },
					{ toolName: "t2", category: "auth", message: "another auth failure", retryable: false },
					{ toolName: "t3", category: "transient", message: "socket hang up", retryable: true },
				],
			} as Partial<DataSourceResult>),
		]);
		expect(toc).toContain("3 tool error(s)");
		expect(toc).toContain("auth");
		expect(toc).toContain("transient");
		// Upstream message text is unbounded and may carry credentials.
		expect(toc).not.toContain("hunter2");
	});

	test("dedupes repeated tool names and counts the overflow", () => {
		const many = Array.from({ length: 9 }, (_, i) => ({ toolName: `tool_${i}`, rawJson: {} }));
		const toc = buildEvidenceToc([result({ toolOutputs: [...many, { toolName: "tool_0", rawJson: {} }] })]);
		expect(toc).toContain("and 3 more");
		expect(toc).toContain("10 tool call(s)");
	});

	test("stays bounded under a pathological fan-out", () => {
		const results = Array.from({ length: 200 }, (_, i) =>
			result({ dataSourceId: `aws`, deploymentId: `estate-with-a-long-name-${i}` }),
		);
		const toc = buildEvidenceToc(results) ?? "";
		expect(toc.length).toBeLessThanOrEqual(2_000);
		expect(toc).toContain("more datasource(s) omitted");
	});

	test("survives a non-serializable payload instead of throwing", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => buildEvidenceToc([result({ toolOutputs: [{ toolName: "t", rawJson: circular }] })])).not.toThrow();
	});
});
