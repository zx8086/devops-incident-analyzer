// packages/agent/src/eval/single-agent-probe.test.ts
// SIO-1441 tier 2: isolated single-agent probe harness. Only the pure state-construction piece
// is unit-tested here -- the live createMcpClient/queryDataSource calls are integration boundary,
// verified by a real manual run, same split as SIO-1440's spec-contradiction-judge.ts.
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { AgentState } from "../state.ts";
import { buildOrchestratorProbeState, buildProbeState } from "./single-agent-probe.ts";

describe("buildProbeState", () => {
	test("sets currentDataSource and a single human message from the scenario text", () => {
		const state = buildProbeState("gitlab", "Investigate a spike in pipeline failures for project X.");
		expect(state.currentDataSource).toBe("gitlab");
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.content).toBe("Investigate a spike in pipeline failures for project X.");
	});

	test("every other AgentState field is present with its declared default (no missing keys)", () => {
		const state = buildProbeState("gitlab", "scenario text");
		const expectedKeys = Object.keys(AgentState.spec);
		for (const key of expectedKeys) {
			expect(state).toHaveProperty(key);
		}
	});

	test("dataSourceResults, alignmentHints, awsTargetEstates, targetDeployments all start empty (no retry/fan-out signaled)", () => {
		const state = buildProbeState("elastic", "scenario text");
		expect(state.dataSourceResults).toEqual([]);
		expect(state.alignmentHints).toEqual([]);
		expect(state.awsTargetEstates).toEqual([]);
		expect(state.targetDeployments).toEqual([]);
	});

	test("extractedEntities has an empty toolActions map so action-driven tool selection falls back to keyword matching, not a crash", () => {
		const state = buildProbeState("gitlab", "scenario text");
		expect(state.extractedEntities.dataSources).toEqual([]);
		expect(state.extractedEntities.toolActions).toBeUndefined();
	});
});

describe("buildOrchestratorProbeState", () => {
	const results: DataSourceResult[] = [{ dataSourceId: "gitlab", data: "pipeline failures found", status: "success" }];

	test("sets dataSourceResults and targetDataSources from the given probe results", () => {
		const state = buildOrchestratorProbeState(results, "Investigate pipeline failures.");
		expect(state.dataSourceResults).toEqual(results);
		expect(state.targetDataSources).toEqual(["gitlab"]);
	});

	test("dedups targetDataSources when multiple results share a datasource (e.g. elastic fan-out)", () => {
		const fanOut: DataSourceResult[] = [
			{ dataSourceId: "elastic", deploymentId: "eu-cld", data: "a", status: "success" },
			{ dataSourceId: "elastic", deploymentId: "us-cld", data: "b", status: "success" },
		];
		const state = buildOrchestratorProbeState(fanOut, "scenario");
		expect(state.targetDataSources).toEqual(["elastic"]);
	});

	test("carries the scenario text as the sole human message, same as buildProbeState", () => {
		const state = buildOrchestratorProbeState(results, "Investigate pipeline failures.");
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.content).toBe("Investigate pipeline failures.");
	});
});
