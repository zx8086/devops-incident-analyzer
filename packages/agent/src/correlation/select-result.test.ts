// agent/src/correlation/select-result.test.ts

import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { AgentState } from "../state.ts";
import { selectResultWithFindings } from "./select-result.ts";

function row(over: Partial<DataSourceResult>): DataSourceResult {
	return { dataSourceId: "aws", status: "success", duration: 1, data: "prose", ...over } as DataSourceResult;
}

// The real channel reducer, so this pins behaviour against the actual state definition
// rather than a hand-rolled imitation of it.
type AppendReducer = (prev: DataSourceResult[], next: DataSourceResult[]) => DataSourceResult[];
const appendReducer = (
	AgentState as unknown as {
		spec: Record<string, { operator: AppendReducer } | undefined>;
	}
).spec.dataSourceResults?.operator as AppendReducer;

describe("selectResultWithFindings (SIO-1245)", () => {
	// The defect: dataSourceResults uses an APPEND reducer, and extractFindings returns the
	// FULL mapped array -- so its update is appended, not substituted. Post-extraction the
	// channel holds every row twice with the findings-LESS copies first, and the previous
	// `.find()` in rules.ts/engine.ts matched one of those. Every SIO-764/SIO-842 typed-finding
	// rule therefore read `{}`.
	test("reproduces the append duplication with the real reducer", () => {
		const pre = [row({ deploymentId: "estate:A" }), row({ deploymentId: "estate:B" })];
		const post = pre.map(
			(r) => ({ ...r, awsFindings: { alarms: [{ name: "a", state: "ALARM" }] } }) as DataSourceResult,
		);
		const merged = appendReducer(pre, post);

		expect(merged).toHaveLength(4);
		// The old behaviour, pinned so the regression is unmistakable:
		expect(merged.find((r) => r.dataSourceId === "aws")?.awsFindings).toBeUndefined();
		// The new behaviour:
		expect(selectResultWithFindings(merged, "aws", "awsFindings")?.awsFindings).toBeDefined();
	});

	test("prefers the enriched row over an earlier findings-less one", () => {
		const results = [row({ deploymentId: "A" }), row({ deploymentId: "A", awsFindings: { alarms: [] } })];
		expect(selectResultWithFindings(results, "aws", "awsFindings")?.awsFindings).toEqual({ alarms: [] });
	});

	// correlationFetch rows are appended AFTER extractFindings and carry no findings of their
	// own; a plain last-wins would let one of them shadow the enriched row.
	test("a later findings-less row does not shadow the enriched one", () => {
		const results = [
			row({ deploymentId: "A", awsFindings: { alarms: [{ name: "keep", state: "ALARM" }] } }),
			row({ deploymentId: "A" }),
		];
		expect(selectResultWithFindings(results, "aws", "awsFindings")?.awsFindings?.alarms?.[0]?.name).toBe("keep");
	});

	test("falls back to the last matching row when nothing was enriched", () => {
		const results = [row({ deploymentId: "A" }), row({ deploymentId: "B" })];
		expect(selectResultWithFindings(results, "aws", "awsFindings")?.deploymentId).toBe("B");
	});

	test("ignores other datasources and returns undefined when absent", () => {
		const results = [row({ dataSourceId: "kafka", kafkaFindings: { consumerGroups: [] } })];
		expect(selectResultWithFindings(results, "aws", "awsFindings")).toBeUndefined();
		expect(selectResultWithFindings(results, "kafka", "kafkaFindings")?.kafkaFindings).toBeDefined();
	});

	test("selects per findings key independently on one row set", () => {
		const results = [row({ dataSourceId: "gitlab" }), row({ dataSourceId: "gitlab", orbitFindings: {} })];
		// gitlabFindings was never populated -> last-match fallback; orbitFindings was -> enriched.
		expect(selectResultWithFindings(results, "gitlab", "orbitFindings")?.orbitFindings).toBeDefined();
		expect(selectResultWithFindings(results, "gitlab", "gitlabFindings")?.gitlabFindings).toBeUndefined();
	});
});
