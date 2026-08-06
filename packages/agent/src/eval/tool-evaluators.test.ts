// packages/agent/src/eval/tool-evaluators.test.ts
// SIO-1398: the tool-correctness evaluators. Pure (run, example) functions, so these run with
// no MCP server, no Bedrock, and no LangSmith.

import { describe, expect, test } from "bun:test";
import type { Example, Run } from "langsmith/schemas";
import {
	expectedToolsFired,
	toolArgValidity,
	toolEfficiency,
	toolNameValidity,
	toolResponseHealth,
} from "./evaluators.ts";
import type { ToolCallRecord } from "./tool-trajectory.ts";

function call(partial: Partial<ToolCallRecord> & { toolName: string }): ToolCallRecord {
	return { dataSourceId: "elastic", outcome: "success", isAlignmentRetry: false, ...partial };
}

function runWith(calls: ToolCallRecord[], responseHealth: unknown[] = []): Run {
	const byDataSource: Record<string, { total: number; errors: number }> = {};
	for (const c of calls) {
		const bucket = byDataSource[c.dataSourceId] ?? { total: 0, errors: 0 };
		bucket.total++;
		if (c.outcome === "error") bucket.errors++;
		byDataSource[c.dataSourceId] = bucket;
	}
	return {
		outputs: { output: { toolTrajectory: { calls, byDataSource, totalCalls: calls.length }, responseHealth } },
	} as unknown as Run;
}

function exampleWith(expectedToolUse: unknown): Example {
	return { outputs: { expectedToolUse } } as unknown as Example;
}

describe("no-calls guard (applies to every tool evaluator)", () => {
	const empty = runWith([]);

	test("emits NO feedback rather than a perfect score when nothing was called", () => {
		// The failure mode this guards: a run where every sub-agent was skipped would otherwise
		// score 1.0 on every key -- rewarding the failure as success.
		expect(toolArgValidity(empty)).toEqual([]);
		expect(toolNameValidity(empty)).toEqual([]);
		expect(toolEfficiency(empty)).toEqual([]);
		expect(toolResponseHealth(empty)).toEqual([]);
	});

	test("emits no feedback when the run has no trajectory at all (pre-SIO-1398 output)", () => {
		const legacy = { outputs: { output: { response: "old" } } } as unknown as Run;
		expect(toolArgValidity(legacy)).toEqual([]);
		expect(toolNameValidity(legacy)).toEqual([]);
	});
});

describe("toolArgValidity", () => {
	test("scores 1.0 when every call had valid arguments", () => {
		const [feedback] = toolArgValidity(runWith([call({ toolName: "a" }), call({ toolName: "b" })]));
		expect(feedback?.score).toBe(1);
	});

	test("emits 1 - rate so higher is better, and names the offender", () => {
		const [feedback] = toolArgValidity(
			runWith([
				call({ toolName: "ok" }),
				call({ toolName: "bad_dsl", outcome: "error", category: "bad-query" }),
				call({ toolName: "bad_params", outcome: "error", category: "unknown", kind: "bad-input" }),
				call({ toolName: "ok2" }),
			]),
		);

		expect(feedback?.score).toBe(0.5);
		expect(feedback?.comment).toContain("bad_dsl");
		expect(feedback?.comment).toContain("bad_params");
	});

	test("a transient failure is not an argument problem", () => {
		const [feedback] = toolArgValidity(runWith([call({ toolName: "t", outcome: "error", category: "transient" })]));
		expect(feedback?.score).toBe(1);
	});
});

describe("toolNameValidity", () => {
	test("names the invented tool, not the wrapper tool name", () => {
		const [feedback] = toolNameValidity(
			runWith([
				call({ toolName: "ok" }),
				call({
					toolName: "aws_ecs_list_tasks",
					outcome: "error",
					category: "not-found",
					hallucinatedName: "aws_ecs_list_tasks",
				}),
			]),
		);

		expect(feedback?.score).toBe(0.5);
		expect(feedback?.comment).toContain("aws_ecs_list_tasks");
	});

	test("a genuine not-found resource does not count as a hallucination", () => {
		const [feedback] = toolNameValidity(
			runWith([call({ toolName: "aws_logs_query", outcome: "error", category: "not-found" })]),
		);
		expect(feedback?.score).toBe(1);
	});
});

describe("expectedToolsFired", () => {
	const expected = {
		requiredToolGroups: [
			{
				dataSource: "elastic",
				anyOf: ["elasticsearch_get_cluster_health", "elasticsearch_diagnostics"],
				why: "health",
			},
			{ dataSource: "elastic", anyOf: ["elasticsearch_list_indices"], why: "inventory" },
		],
		forbiddenTools: ["elasticsearch_delete_index"],
	};

	test("any member of a group satisfies it (disjunction is the anti-brittleness property)", () => {
		// The SECOND alternative fires, not the first -- a literal-name expectation would fail here.
		const [feedback] = expectedToolsFired(
			runWith([call({ toolName: "elasticsearch_diagnostics" }), call({ toolName: "elasticsearch_list_indices" })]),
			exampleWith(expected),
		);
		expect(feedback?.score).toBe(1);
	});

	test("gives partial credit rather than all-or-nothing", () => {
		const [feedback] = expectedToolsFired(
			runWith([call({ toolName: "elasticsearch_list_indices" })]),
			exampleWith(expected),
		);
		expect(feedback?.score).toBe(0.5);
		expect(feedback?.comment).toContain("health");
	});

	test("a forbidden call zeroes the key even when every group fired", () => {
		const [feedback] = expectedToolsFired(
			runWith([
				call({ toolName: "elasticsearch_get_cluster_health" }),
				call({ toolName: "elasticsearch_list_indices" }),
				call({ toolName: "elasticsearch_delete_index" }),
			]),
			exampleWith(expected),
		);
		expect(feedback?.score).toBe(0);
		expect(feedback?.comment).toContain("FORBIDDEN");
	});

	test("emits no feedback for an example carrying no ground truth (partial rollout)", () => {
		expect(expectedToolsFired(runWith([call({ toolName: "x" })]), exampleWith(undefined))).toEqual([]);
		expect(expectedToolsFired(runWith([call({ toolName: "x" })]))).toEqual([]);
	});
});

describe("toolResponseHealth", () => {
	test("scores 1.0 with no findings", () => {
		const [feedback] = toolResponseHealth(runWith([call({ toolName: "a" })], []));
		expect(feedback?.score).toBe(1);
	});

	test("one finding fails the key and surfaces the rule and detail", () => {
		const [feedback] = toolResponseHealth(
			runWith(
				[call({ toolName: "kafka_list_topics" })],
				[
					{
						rule: "empty-anchor",
						dataSourceId: "kafka",
						toolName: "kafka_list_topics",
						detail: "declared known-good anchor returned no rows",
					},
				],
			),
		);

		expect(feedback?.score).toBe(0);
		expect(feedback?.comment).toContain("empty-anchor");
		expect(feedback?.comment).toContain("kafka_list_topics");
	});
});

describe("toolEfficiency", () => {
	test("scores 1.0 when every graded call is distinct", () => {
		const [feedback] = toolEfficiency(runWith([call({ toolName: "a" }), call({ toolName: "b" })]));
		expect(feedback?.score).toBe(1);
	});

	test("counts a genuine repeat", () => {
		const [feedback] = toolEfficiency(runWith([call({ toolName: "a" }), call({ toolName: "a" })]));
		expect(feedback?.score).toBe(0.5);
	});

	test("the same tool against two deployments is not a repeat", () => {
		const [feedback] = toolEfficiency(
			runWith([
				call({ toolName: "elasticsearch_search", deploymentId: "eu-b2b" }),
				call({ toolName: "elasticsearch_search", deploymentId: "us-cld" }),
			]),
		);
		expect(feedback?.score).toBe(1);
	});

	test("excludes alignment retries -- the supervisor re-dispatching is not model repetition", () => {
		const [feedback] = toolEfficiency(
			runWith([call({ toolName: "a" }), call({ toolName: "a", isAlignmentRetry: true })]),
		);
		expect(feedback?.score).toBe(1);
	});

	test("excludes a retry after a retryable-category failure (correct behavior)", () => {
		// `throttled` is a KIND; its category is `transient` (agent-state.ts:73), and the
		// exclusion keys on category because that is what isRetryableCategory consumes.
		const [feedback] = toolEfficiency(
			runWith([
				call({ toolName: "a", outcome: "error", category: "transient", kind: "throttled" }),
				call({ toolName: "a" }),
			]),
		);
		// The throttled call is excluded, leaving one graded call -- no repeat.
		expect(feedback?.score).toBe(1);
	});

	test("a repeat after a NON-retryable failure still counts (blind re-issue)", () => {
		// bad-query never succeeds on a blind retry, so re-issuing the same call is exactly the
		// waste this metric is meant to surface.
		const [feedback] = toolEfficiency(
			runWith([call({ toolName: "a", outcome: "error", category: "bad-query" }), call({ toolName: "a" })]),
		);
		expect(feedback?.score).toBe(0.5);
	});
});
