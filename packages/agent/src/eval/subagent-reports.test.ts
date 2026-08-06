// packages/agent/src/eval/subagent-reports.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { buildSubagentReports } from "./subagent-reports.ts";

function result(overrides: Partial<DataSourceResult>): DataSourceResult {
	return { dataSourceId: "elastic", status: "success", data: undefined, ...overrides };
}

describe("buildSubagentReports (SIO-1374)", () => {
	test("empty results produce an empty map", () => {
		expect(buildSubagentReports([])).toEqual({});
	});

	test("a result with no narrative and no *Findings field produces no entry for that datasource", () => {
		const map = buildSubagentReports([result({ dataSourceId: "gitlab" })]);
		expect(map.gitlab).toBeUndefined();
	});

	// CodeRabbit (PR #591), updated for SIO-1405: FINDINGS_FIELD_BY_DATASOURCE still deliberately
	// excludes datasources with no *Findings field (e.g. konnect, orbit) from the TYPED supplement
	// -- findings under an unrelated key never leak in. (Narrative `data` is a different matter:
	// see the SIO-1405 tests below.)
	test("an unsupported dataSourceId with no narrative is skipped even when it carries findings under an unrelated key", () => {
		const map = buildSubagentReports([result({ dataSourceId: "konnect", gitlabFindings: { d: 4 } as never })]);
		expect(map).toEqual({});
	});

	test("serializes elasticFindings under the elastic key with the typed-findings label", () => {
		const map = buildSubagentReports([
			result({ dataSourceId: "elastic", elasticFindings: { errorRate: 0.42 } as never }),
		]);
		expect(map.elastic).toBe(`Typed findings: ${JSON.stringify({ errorRate: 0.42 })}`);
	});

	test("serializes each of the six datasource Findings fields under its own key", () => {
		const results: DataSourceResult[] = [
			result({ dataSourceId: "elastic", elasticFindings: { a: 1 } as never }),
			result({ dataSourceId: "kafka", kafkaFindings: { b: 2 } as never }),
			result({ dataSourceId: "couchbase", couchbaseFindings: { c: 3 } as never }),
			result({ dataSourceId: "gitlab", gitlabFindings: { d: 4 } as never }),
			result({ dataSourceId: "aws", awsFindings: { e: 5 } as never }),
			result({ dataSourceId: "atlassian", atlassianFindings: { f: 6 } as never }),
		];
		const map = buildSubagentReports(results);
		expect(map.elastic).toBe(`Typed findings: ${JSON.stringify({ a: 1 })}`);
		expect(map.kafka).toBe(`Typed findings: ${JSON.stringify({ b: 2 })}`);
		expect(map.couchbase).toBe(`Typed findings: ${JSON.stringify({ c: 3 })}`);
		expect(map.gitlab).toBe(`Typed findings: ${JSON.stringify({ d: 4 })}`);
		expect(map.aws).toBe(`Typed findings: ${JSON.stringify({ e: 5 })}`);
		expect(map.atlassian).toBe(`Typed findings: ${JSON.stringify({ f: 6 })}`);
	});

	test("multiple deployments of the same datasource (e.g. elastic across estates) merge into one entry keyed by dataSourceId", () => {
		const results: DataSourceResult[] = [
			result({ dataSourceId: "elastic", deploymentId: "eu-b2b", elasticFindings: { a: 1 } as never }),
			result({ dataSourceId: "elastic", deploymentId: "us-cld", elasticFindings: { a: 2 } as never }),
		];
		const map = buildSubagentReports(results);
		// Both deployments' findings appear -- concatenated, not overwritten -- so the judge sees
		// evidence from every deployment this sub-agent's model was responsible for.
		expect(map.elastic).toContain(JSON.stringify({ a: 1 }));
		expect(map.elastic).toContain(JSON.stringify({ a: 2 }));
	});
});

// SIO-1405: the sub-agent's narrative report (`data`, a string at runtime) is the primary
// evidence surface -- typed findings alone serialized {} for most real elastic investigations
// (DEVOPS-1376: ground truth present 50x in recorded tool results, judge handed {}).
describe("buildSubagentReports narrative data (SIO-1405)", () => {
	test("a narrative-only result is serialized under its datasource key", () => {
		const map = buildSubagentReports([
			result({ dataSourceId: "elastic", data: "1,256 Connection threshold events over 30 days" }),
		]);
		expect(map.elastic).toBe("1,256 Connection threshold events over 30 days");
	});

	test("narrative comes first, typed findings follow as a labeled supplement", () => {
		const map = buildSubagentReports([
			result({
				dataSourceId: "kafka",
				data: "DLQ accumulation confirms SSL handshake failures",
				kafkaFindings: { dlqDepth: 3000000 } as never,
			}),
		]);
		expect(map.kafka).toBe(
			`DLQ accumulation confirms SSL handshake failures\nTyped findings: ${JSON.stringify({ dlqDepth: 3000000 })}`,
		);
	});

	test("non-string data (the no-tools null path) is ignored, not stringified", () => {
		const map = buildSubagentReports([result({ dataSourceId: "elastic", data: null })]);
		expect(map).toEqual({});
	});

	test("whitespace-only data yields an absent key, not a blank report", () => {
		const map = buildSubagentReports([result({ dataSourceId: "elastic", data: "  \n\t " })]);
		expect(map).toEqual({});
	});

	test("an error-status result's narrative is still serialized -- it is what the sub-agent produced", () => {
		const map = buildSubagentReports([
			result({ dataSourceId: "aws", status: "error", data: "partial evidence before the failure", error: "boom" }),
		]);
		expect(map.aws).toBe("partial evidence before the failure");
	});

	test("a datasource without a typed-findings mapping (konnect) still serializes its narrative", () => {
		const map = buildSubagentReports([result({ dataSourceId: "konnect", data: "control plane healthy" })]);
		expect(map.konnect).toBe("control plane healthy");
	});
});
