// packages/agent/src/eval/run-function.test.ts
import { describe, expect, test } from "bun:test";
import { buildEvalMcpConfig, FrozenOutputSchema } from "./run-function.ts";

// SIO-1375 follow-up: run-function.ts's ensureMcpConnected() builds the McpClientConfig passed to
// createMcpClient. Every AWS eval run in the SIO-1374/SIO-1375 A/B legs (both before AND after the
// aggregator/validator/gitlab fixes) reported "No MCP tools available, skipping" for aws, 100% of
// runs -- confirmed via a live curl against the AWS MCP server (HTTP 200, 49 tools returned) that
// the server itself was healthy the whole time. The gap was that createMcpClient's config object
// never included awsUrl, unlike every other datasource and unlike production's
// apps/web/src/lib/server/agent.ts:224 (`awsUrl: process.env.AWS_MCP_URL`).
//
// buildEvalMcpConfig is a pure env-var -> config mapping, split out specifically so this is
// testable with a plain object instead of process.env and with NO mock.module at all -- an
// earlier version of this test mocked mcp-bridge.ts to capture the config object passed to
// createMcpClient, which replaced that module's entire namespace for every OTHER test file
// loaded afterward in the same bun process and broke an unrelated test in
// __tests__/mcp-bridge.boot-strict-integration.test.ts (a real bun mock.module cross-file leak,
// deterministic in CI's test ordering, never reproduced locally). Testing the pure mapping
// directly removes the whole class of risk instead of just patching that one leak.
describe("buildEvalMcpConfig (SIO-1375/SIO-1376)", () => {
	test("maps every datasource env var to its McpClientConfig field, including awsUrl", () => {
		const config = buildEvalMcpConfig({
			ELASTIC_MCP_URL: "http://localhost:9080",
			KAFKA_MCP_URL: "http://localhost:9081",
			COUCHBASE_MCP_URL: "http://localhost:9082",
			KONNECT_MCP_URL: "http://localhost:9083",
			GITLAB_MCP_URL: "http://localhost:9084",
			ATLASSIAN_MCP_URL: "http://localhost:9085",
			AWS_MCP_URL: "http://localhost:3001",
		});
		expect(config).toEqual({
			elasticUrl: "http://localhost:9080",
			kafkaUrl: "http://localhost:9081",
			capellaUrl: "http://localhost:9082",
			konnectUrl: "http://localhost:9083",
			gitlabUrl: "http://localhost:9084",
			atlassianUrl: "http://localhost:9085",
			awsUrl: "http://localhost:3001",
		});
	});

	test("an unset env var maps to undefined rather than being omitted or defaulted", () => {
		const config = buildEvalMcpConfig({});
		expect(config.awsUrl).toBeUndefined();
		expect(config.elasticUrl).toBeUndefined();
		expect("awsUrl" in config).toBe(true);
	});
});

// SIO-1398: FrozenOutputSchema.parse is STRICT and runs on every replay-outputs example. The
// toolTrajectory member therefore carries a default -- without it, every leg recorded before
// this field existed would fail to parse and the offline judge-iteration mode would break on
// its first example. These tests pin that contract in both directions.
describe("FrozenOutputSchema toolTrajectory backward compatibility (SIO-1398)", () => {
	const legacyFixture = {
		response: "a report recorded before toolTrajectory existed",
		targetDataSources: ["elastic"],
		firstAttempts: [],
		subagentReports: {},
	};

	test("a fixture recorded before toolTrajectory existed still parses", () => {
		const parsed = FrozenOutputSchema.parse(legacyFixture);
		expect(parsed.toolTrajectory).toEqual({ calls: [], byDataSource: {}, totalCalls: 0 });
	});

	test("a recorded trajectory round-trips intact", () => {
		const parsed = FrozenOutputSchema.parse({
			...legacyFixture,
			toolTrajectory: {
				calls: [
					{
						dataSourceId: "elastic",
						deploymentId: "eu-b2b",
						toolName: "elasticsearch_search",
						outcome: "error",
						category: "bad-query",
						kind: "bad-query",
						isAlignmentRetry: false,
					},
				],
				byDataSource: { elastic: { total: 1, errors: 1 } },
				totalCalls: 1,
			},
		});

		expect(parsed.toolTrajectory.totalCalls).toBe(1);
		expect(parsed.toolTrajectory.calls[0]?.toolName).toBe("elasticsearch_search");
		expect(parsed.toolTrajectory.calls[0]?.deploymentId).toBe("eu-b2b");
	});

	test("a malformed trajectory fails loudly rather than being waved through", () => {
		expect(() =>
			FrozenOutputSchema.parse({
				...legacyFixture,
				toolTrajectory: { calls: [{ dataSourceId: "elastic" }], byDataSource: {}, totalCalls: 1 },
			}),
		).toThrow();
	});
});
