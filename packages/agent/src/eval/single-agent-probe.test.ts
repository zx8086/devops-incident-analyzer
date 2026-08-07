// packages/agent/src/eval/single-agent-probe.test.ts
// SIO-1441 tier 2: isolated single-agent probe harness. Only the pure state-construction piece
// is unit-tested here -- the live createMcpClient/queryDataSource calls are integration boundary,
// verified by a real manual run, same split as SIO-1440's spec-contradiction-judge.ts.
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import { AgentState } from "../state.ts";
import { buildOrchestratorProbeState, buildProbeState, parseProbeEnv } from "./single-agent-probe.ts";

describe("buildProbeState", () => {
	test("sets currentDataSource and a single human message from the scenario text", () => {
		const state = buildProbeState("gitlab", "Investigate a spike in pipeline failures for project X.");
		expect(state.currentDataSource).toBe("gitlab");
		expect(state.messages).toHaveLength(1);
		expect(state.messages[0]?.content).toBe("Investigate a spike in pipeline failures for project X.");
	});

	// CodeRabbit (PR #632): buildProbeState/probeSubAgent are exported and callable directly by
	// any caller, bypassing parseProbeEnv's validation entirely -- an unknown dataSourceId would
	// reach queryDataSource, which falls back to elastic-agent silently (sub-agent.ts:2021,
	// AGENT_NAMES[dataSourceId] ?? "elastic-agent"). Same bug class as the CLI's env-var
	// validation gap, at a different call boundary. dataSourceId is now typed DataSourceId (a
	// TypeScript caller can't even compile a bad literal); this test proves the runtime Zod
	// parse also rejects it for a caller that bypasses the type check (JS, an `as` cast, etc.).
	test("rejects an unknown datasource id at runtime, not just at the type level", () => {
		expect(() => buildProbeState("not-a-datasource" as never, "x")).toThrow();
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

// CodeRabbit (PR #632): env vars were read with manual checks + an unchecked JSON.parse type
// assertion -- an unknown PROBE_DATASOURCE silently fell back to elastic-agent inside
// queryDataSource, and malformed/null PROBE_REFERENCE_FINDINGS threw an unhandled exception
// instead of a clean CLI error. Verified live: DATA_SOURCE_IDS-unknown ids fall through
// AGENT_NAMES[id] ?? "elastic-agent" (sub-agent.ts:2021), and JSON.parse("not json") /
// JSON.parse("null") both throw or produce a non-object that crashes downstream.
describe("parseProbeEnv", () => {
	test("accepts a known datasource id and a non-empty scenario", () => {
		const result = parseProbeEnv({ PROBE_DATASOURCE: "gitlab", PROBE_SCENARIO: "Investigate X." });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.dataSourceId).toBe("gitlab");
			expect(result.data.scenario).toBe("Investigate X.");
			expect(result.data.runOrchestrator).toBe(false);
			expect(result.data.referenceFindings).toBeUndefined();
		}
	});

	test("rejects an unknown datasource id instead of silently falling back", () => {
		const result = parseProbeEnv({ PROBE_DATASOURCE: "not-a-datasource", PROBE_SCENARIO: "x" });
		expect(result.success).toBe(false);
	});

	test("rejects a missing PROBE_SCENARIO", () => {
		const result = parseProbeEnv({ PROBE_DATASOURCE: "gitlab" });
		expect(result.success).toBe(false);
	});

	test("rejects an empty-string PROBE_SCENARIO", () => {
		const result = parseProbeEnv({ PROBE_DATASOURCE: "gitlab", PROBE_SCENARIO: "" });
		expect(result.success).toBe(false);
	});

	test('PROBE_RUN_ORCHESTRATOR only true for the literal string "true"', () => {
		const truthy = parseProbeEnv({ PROBE_DATASOURCE: "gitlab", PROBE_SCENARIO: "x", PROBE_RUN_ORCHESTRATOR: "true" });
		expect(truthy.success && truthy.data.runOrchestrator).toBe(true);

		const other = parseProbeEnv({ PROBE_DATASOURCE: "gitlab", PROBE_SCENARIO: "x", PROBE_RUN_ORCHESTRATOR: "yes" });
		expect(other.success).toBe(false);
	});

	test("parses well-formed PROBE_REFERENCE_FINDINGS as a string-to-string record", () => {
		const result = parseProbeEnv({
			PROBE_DATASOURCE: "gitlab",
			PROBE_SCENARIO: "x",
			PROBE_REFERENCE_FINDINGS: '{"gitlab":"pipeline failed"}',
		});
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.referenceFindings).toEqual({ gitlab: "pipeline failed" });
	});

	test("rejects malformed JSON in PROBE_REFERENCE_FINDINGS instead of throwing", () => {
		const result = parseProbeEnv({
			PROBE_DATASOURCE: "gitlab",
			PROBE_SCENARIO: "x",
			PROBE_REFERENCE_FINDINGS: "not json",
		});
		expect(result.success).toBe(false);
	});

	test('rejects the literal string "null" in PROBE_REFERENCE_FINDINGS instead of crashing downstream', () => {
		const result = parseProbeEnv({ PROBE_DATASOURCE: "gitlab", PROBE_SCENARIO: "x", PROBE_REFERENCE_FINDINGS: "null" });
		expect(result.success).toBe(false);
	});

	test("rejects PROBE_REFERENCE_FINDINGS with a non-string value", () => {
		const result = parseProbeEnv({
			PROBE_DATASOURCE: "gitlab",
			PROBE_SCENARIO: "x",
			PROBE_REFERENCE_FINDINGS: '{"gitlab":123}',
		});
		expect(result.success).toBe(false);
	});
});
