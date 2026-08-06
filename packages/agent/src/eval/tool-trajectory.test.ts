// packages/agent/src/eval/tool-trajectory.test.ts

import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import {
	buildToolTrajectory,
	callIdentity,
	checkResponseHealth,
	extractHallucinatedToolName,
	isBadArgumentCall,
	isEmptyPayload,
	isExpiryField,
	isHallucinatedCall,
	type ToolCallRecord,
} from "./tool-trajectory.ts";

function result(partial: Partial<DataSourceResult> & { dataSourceId: string }): DataSourceResult {
	return { data: undefined, status: "success", ...partial };
}

describe("buildToolTrajectory", () => {
	test("projects successes from toolOutputs and errors from toolErrors", () => {
		const trajectory = buildToolTrajectory([
			result({
				dataSourceId: "elastic",
				toolOutputs: [
					{ toolName: "elasticsearch_search", rawJson: { hits: { hits: [{ _id: "1" }] } } },
					{ toolName: "elasticsearch_list_indices", rawJson: [{ index: "logs" }] },
				],
				toolErrors: [
					{ toolName: "elasticsearch_esql_query", category: "bad-query", message: "parsing failed", retryable: false },
				],
			}),
		]);

		expect(trajectory.totalCalls).toBe(3);
		expect(trajectory.byDataSource.elastic).toEqual({ total: 3, errors: 1 });
		expect(trajectory.calls.filter((c) => c.outcome === "success")).toHaveLength(2);
	});

	test("carries neither args nor rawJson onto any record (privacy invariant)", () => {
		const trajectory = buildToolTrajectory([
			result({
				dataSourceId: "aws",
				toolOutputs: [{ toolName: "aws_logs_query", rawJson: { accountId: "399987695868", ip: "10.0.0.61" } }],
			}),
		]);

		const serialized = JSON.stringify(trajectory);
		expect(serialized).not.toContain("399987695868");
		expect(serialized).not.toContain("10.0.0.61");
		expect(serialized).not.toContain("rawJson");
		expect(serialized).not.toContain("args");
	});

	test("keeps deploymentId so the same tool on two deployments is not one identity", () => {
		const trajectory = buildToolTrajectory([
			result({ dataSourceId: "elastic", deploymentId: "eu-b2b", toolOutputs: [{ toolName: "s", rawJson: [1] }] }),
			result({ dataSourceId: "elastic", deploymentId: "us-cld", toolOutputs: [{ toolName: "s", rawJson: [1] }] }),
		]);

		const identities = new Set(trajectory.calls.map(callIdentity));
		expect(identities.size).toBe(2);
	});

	test("marks alignment-retry calls so the efficiency metric can exclude them", () => {
		const trajectory = buildToolTrajectory([
			result({ dataSourceId: "kafka", toolOutputs: [{ toolName: "kafka_list_topics", rawJson: [1] }] }),
			result({
				dataSourceId: "kafka",
				isAlignmentRetry: true,
				toolOutputs: [{ toolName: "kafka_list_topics", rawJson: [1] }],
			}),
		]);

		expect(trajectory.calls.map((c) => c.isAlignmentRetry)).toEqual([false, true]);
	});

	test("empty results produce an empty trajectory rather than throwing", () => {
		expect(buildToolTrajectory([])).toEqual({ calls: [], byDataSource: {}, totalCalls: 0 });
		expect(buildToolTrajectory([result({ dataSourceId: "gitlab" })]).totalCalls).toBe(0);
	});
});

describe("hallucinated tool names", () => {
	test("extracts the invented name from both LangGraph phrasings", () => {
		expect(extractHallucinatedToolName('Tool "aws_ecs_list_tasks" not found.\n Please fix your mistakes.')).toBe(
			"aws_ecs_list_tasks",
		);
		expect(extractHallucinatedToolName("tool `kafka_made_up` not found")).toBe("kafka_made_up");
	});

	test("does not fire on a genuine missing resource sharing category not-found", () => {
		expect(extractHallucinatedToolName("log group /aws/lambda/missing does not exist")).toBeUndefined();
		expect(extractHallucinatedToolName("index not found")).toBeUndefined();
	});

	test("splits an invented tool from an absent resource inside the same category", () => {
		const trajectory = buildToolTrajectory([
			result({
				dataSourceId: "aws",
				toolErrors: [
					{
						toolName: "aws_ecs_list_tasks",
						category: "not-found",
						message: 'Tool "aws_ecs_list_tasks" not found.',
						retryable: false,
					},
					{ toolName: "aws_logs_query", category: "not-found", message: "log group does not exist", retryable: false },
				],
			}),
		]);

		expect(trajectory.calls).toHaveLength(2);
		const [invented, absent] = trajectory.calls as [ToolCallRecord, ToolCallRecord];
		expect(isHallucinatedCall(invented)).toBe(true);
		expect(invented.hallucinatedName).toBe("aws_ecs_list_tasks");
		expect(isHallucinatedCall(absent)).toBe(false);
		// Both still carry the production category -- the eval splits them, production does not.
		expect(absent.category).toBe("not-found");
	});
});

describe("isBadArgumentCall", () => {
	test("catches bad-query by category and bad-input by kind", () => {
		const trajectory = buildToolTrajectory([
			result({
				dataSourceId: "kafka",
				toolErrors: [
					{ toolName: "a", category: "bad-query", message: "malformed DSL", retryable: false },
					// bad-input collapses to category "unknown" (SIO-1399) -- reading only the
					// category would miss every -32602 the model caused.
					{ toolName: "b", category: "unknown", kind: "bad-input", message: "invalid params", retryable: false },
					{ toolName: "c", category: "transient", message: "timeout", retryable: true },
				],
			}),
		]);

		expect(trajectory.calls.filter(isBadArgumentCall).map((c) => c.toolName)).toEqual(["a", "b"]);
	});

	test("never flags a successful call", () => {
		const trajectory = buildToolTrajectory([
			result({ dataSourceId: "elastic", toolOutputs: [{ toolName: "ok", rawJson: [1] }] }),
		]);
		expect(trajectory.calls.filter(isBadArgumentCall)).toHaveLength(0);
	});
});

describe("isEmptyPayload", () => {
	test.each([
		[null, true],
		[undefined, true],
		[[], true],
		[{}, true],
		[{ rows: [] }, true],
		[{ hits: { hits: [] } }, true],
		[{ results: [], total: 0 }, true],
		[[{ id: 1 }], false],
		[{ rows: [{ id: 1 }] }, false],
		[{ hits: { hits: [{ _id: "x" }] } }, false],
		[{ status: "green" }, false],
		// CodeRabbit (PR #599): a populated collection with an EMPTY SIBLING array must not read
		// as empty -- `.some` made it do so, emitting a false empty-anchor finding.
		[{ hits: { hits: [{ _id: "1" }], failed_shards: [] } }, false],
		[{ hits: { hits: [], failed_shards: [] } }, true],
	])("isEmptyPayload(%p) === %p", (input, expected) => {
		expect(isEmptyPayload(input)).toBe(expected);
	});
});

describe("checkResponseHealth", () => {
	test("flags a declared anchor that returned no rows", () => {
		const findings = checkResponseHealth(
			[result({ dataSourceId: "kafka", toolOutputs: [{ toolName: "kafka_list_topics", rawJson: { rows: [] } }] })],
			new Set(["kafka_list_topics"]),
		);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.rule).toBe("empty-anchor");
	});

	test("does not flag an empty result from a tool that was never a declared anchor", () => {
		const findings = checkResponseHealth([
			result({ dataSourceId: "kafka", toolOutputs: [{ toolName: "kafka_list_dlq_topics", rawJson: [] }] }),
		]);
		expect(findings.filter((f) => f.rule === "empty-anchor")).toHaveLength(0);
	});

	test("flags a degrading error that carried no structured kind", () => {
		const findings = checkResponseHealth([
			result({
				dataSourceId: "couchbase",
				toolErrors: [{ toolName: "capella_ping", category: "unknown", message: "something broke", retryable: false }],
			}),
		]);

		expect(findings.map((f) => f.rule)).toContain("prose-only-error");
	});

	test("does not flag routine no-data/not-found outcomes as prose-only errors", () => {
		const findings = checkResponseHealth([
			result({
				dataSourceId: "couchbase",
				toolErrors: [
					{ toolName: "a", category: "no-data", message: "no index", retryable: false },
					{ toolName: "b", category: "not-found", message: "absent", retryable: false },
				],
			}),
		]);

		expect(findings.filter((f) => f.rule === "prose-only-error")).toHaveLength(0);
	});

	test("catches the latency_us nanoseconds-as-microseconds regression", () => {
		const findings = checkResponseHealth([
			result({
				dataSourceId: "couchbase",
				// 90s in ns reported under a _us name -- the 1000x overstatement bug.
				toolOutputs: [
					{ toolName: "capella_get_completed_requests", rawJson: { rows: [{ latency_us: 90_000_000_000 }] } },
				],
			}),
		]);

		expect(findings.map((f) => f.rule)).toContain("latency-unit-confusion");
	});

	test("accepts a plausible latency_us without flagging", () => {
		const findings = checkResponseHealth([
			result({
				dataSourceId: "couchbase",
				toolOutputs: [{ toolName: "capella_get_completed_requests", rawJson: { rows: [{ latency_us: 12_500 }] } }],
			}),
		]);

		expect(findings.filter((f) => f.rule === "latency-unit-confusion")).toHaveLength(0);
	});

	test("catches a future-dated timestamp (the AWS year-shift defect)", () => {
		const year = new Date().getUTCFullYear() + 2;
		const findings = checkResponseHealth([
			result({
				dataSourceId: "aws",
				toolOutputs: [{ toolName: "aws_logs_query", rawJson: { rows: [{ timestamp: `${year}-01-01T00:00:00Z` }] } }],
			}),
		]);

		expect(findings.map((f) => f.rule)).toContain("future-dated-window");
	});

	test("does not flag a certificate expiry, which is legitimately in the future", () => {
		// Live regression: aws_rds_describe_db_instances returns ValidTill per instance (CA cert
		// expiry). The first full run flagged this 16 times as a year-shift defect. A future
		// expiry is healthy infrastructure, not a year-shifted observation.
		const findings = checkResponseHealth([
			result({
				dataSourceId: "aws",
				toolOutputs: [
					{
						toolName: "aws_rds_describe_db_instances",
						rawJson: { rows: [{ CertificateDetails: { ValidTill: "2027-03-05T02:29:03.000Z" } }] },
					},
				],
			}),
		]);

		expect(findings.filter((f) => f.rule === "future-dated-window")).toHaveLength(0);
	});

	test.each([["ValidTill"], ["validUntil"], ["expiresAt"], ["NotAfter"], ["renewalDate"], ["scheduledAt"]])(
		"treats %s as an expiry field",
		(key) => {
			expect(isExpiryField(key)).toBe(true);
		},
	);

	test.each([["timestamp"], ["@timestamp"], ["createdAt"], ["StartTime"], ["lastSeen"]])(
		"treats %s as an observed-moment field, still year-shift checked",
		(key) => {
			expect(isExpiryField(key)).toBe(false);
		},
	);

	test("does not flag present-day timestamps", () => {
		const findings = checkResponseHealth([
			result({
				dataSourceId: "aws",
				toolOutputs: [{ toolName: "aws_logs_query", rawJson: { rows: [{ timestamp: "2026-01-01T00:00:00Z" }] } }],
			}),
		]);

		expect(findings.filter((f) => f.rule === "future-dated-window")).toHaveLength(0);
	});

	test("terminates on a cyclic payload instead of hanging", () => {
		const cyclic: Record<string, unknown> = { name: "root" };
		cyclic.self = cyclic;

		expect(() =>
			checkResponseHealth([result({ dataSourceId: "gitlab", toolOutputs: [{ toolName: "t", rawJson: cyclic }] })]),
		).not.toThrow();
	});
});
