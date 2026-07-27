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
	// CodeRabbit, PR #494: extractFindings copies the merged findings onto EVERY row of a
	// dataSourceId group, including rows whose sub-agent ERRORED. Plain array order could then
	// hand back an error row that happens to carry findings, and every caller in rules.ts hits
	// its `status !== "success"` guard and returns {} -- discarding findings that were present.
	// A multi-estate turn where one estate fails is precisely when this bites.
	test("prefers a SUCCESSFUL enriched row over a later errored one carrying the same findings", () => {
		const findings = { alarms: [{ name: "prana-order-service-CPU", state: "ALARM" }] };
		const results = [
			row({ deploymentId: "estate:ok", status: "success", awsFindings: findings }),
			row({ deploymentId: "estate:failed", status: "error", awsFindings: findings }),
		];
		const picked = selectResultWithFindings(results, "aws", "awsFindings");
		expect(picked?.deploymentId).toBe("estate:ok");
		expect(picked?.status).toBe("success");
	});

	test("still returns an errored enriched row when no successful one exists", () => {
		const results = [row({ deploymentId: "estate:failed", status: "error", awsFindings: { alarms: [] } })];
		// The caller's own status guard decides what to do -- the selector must not hide the row.
		expect(selectResultWithFindings(results, "aws", "awsFindings")?.deploymentId).toBe("estate:failed");
	});
});
