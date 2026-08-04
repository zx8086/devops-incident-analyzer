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

	test("a result with no *Findings field produces no entry for that datasource", () => {
		const map = buildSubagentReports([result({ dataSourceId: "gitlab" })]);
		expect(map.gitlab).toBeUndefined();
	});

	// CodeRabbit (PR #591): subagent-reports.ts's FINDINGS_FIELD_BY_DATASOURCE deliberately
	// excludes datasources with no *Findings field (e.g. konnect, orbit) -- this pins that
	// deliberate omission so a future edit to the map can't silently regress it unnoticed.
	test("an unsupported dataSourceId is skipped even when it carries findings under an unrelated key", () => {
		const map = buildSubagentReports([result({ dataSourceId: "konnect", gitlabFindings: { d: 4 } as never })]);
		expect(map).toEqual({});
	});

	test("serializes elasticFindings under the elastic key", () => {
		const map = buildSubagentReports([
			result({ dataSourceId: "elastic", elasticFindings: { errorRate: 0.42 } as never }),
		]);
		expect(map.elastic).toBe(JSON.stringify({ errorRate: 0.42 }));
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
		expect(map.elastic).toBe(JSON.stringify({ a: 1 }));
		expect(map.kafka).toBe(JSON.stringify({ b: 2 }));
		expect(map.couchbase).toBe(JSON.stringify({ c: 3 }));
		expect(map.gitlab).toBe(JSON.stringify({ d: 4 }));
		expect(map.aws).toBe(JSON.stringify({ e: 5 }));
		expect(map.atlassian).toBe(JSON.stringify({ f: 6 }));
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
