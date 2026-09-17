// src/__tests__/structured-content.test.ts
// SIO-1422: aws_cloudwatch_describe_alarms now declares outputSchema + returns structuredContent
// alongside the existing toMcp() text. This goes through the real registerTool handler via an
// in-process MCP client (not describeAlarms() directly, which tools-integration.test.ts already
// covers): the SDK enforces structuredContent against the declared outputSchema on every
// successful call, so a passing callTool() is itself proof describeAlarmsOutputSchema's
// passthrough shape accepts the real AWS SDK response. Also asserts content[0].text is
// byte-identical to what toMcp(result) alone would have produced pre-SIO-1422.
import { afterEach, describe, expect, test } from "bun:test";
import { CloudWatchClient, DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mockClient } from "aws-sdk-client-mock";
import type { AwsConfig } from "../config/schemas.ts";
import { _resetClientsForTests } from "../services/client-factory.ts";
import { registerCloudWatchTools } from "../tools/cloudwatch/index.ts";

const config: AwsConfig = {
	region: "eu-central-1",
	estates: {
		prod: {
			assumedRoleArn: "arn:aws:iam::356994971776:role/DevOpsAgentReadOnly",
			externalId: "aws-mcp-readonly-2026",
		},
	},
};

afterEach(() => _resetClientsForTests());

async function buildClient() {
	const server = new McpServer({ name: "aws-structured-content-test", version: "0.0.0" });
	registerCloudWatchTools(server, config);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "aws-structured-content-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return client;
}

describe("SIO-1422: aws_cloudwatch_describe_alarms structuredContent round-trip", () => {
	test("full SDK response: structuredContent matches text, SDK output validation passes", async () => {
		const cwMock = mockClient(CloudWatchClient);
		const sdkResponse = { MetricAlarms: [{ AlarmName: "high-cpu", StateValue: "ALARM" as const }] };
		cwMock.on(DescribeAlarmsCommand).resolves(sdkResponse);

		const client = await buildClient();
		const result = await client.callTool({
			name: "aws_cloudwatch_describe_alarms",
			arguments: { estate: "prod" },
		});
		await client.close();

		expect(result.isError).toBeFalsy();
		const content = result.content as Array<{ type: "text"; text: string }>;
		const textPayload = JSON.parse(content[0]?.text ?? "null");
		expect(result.structuredContent).toEqual(textPayload);
		const structured = result.structuredContent as { MetricAlarms: Array<{ AlarmName: string }> };
		expect(structured.MetricAlarms[0]?.AlarmName).toBe("high-cpu");
	});

	// SIO-1774. Field set taken from a live DescribeAlarms response (eu-oit-prd, 2026-09-17).
	test("drops the fields that do not explain an alarm, keeps every diagnostic one", async () => {
		const cwMock = mockClient(CloudWatchClient);
		cwMock.on(DescribeAlarmsCommand).resolves({
			MetricAlarms: [
				{
					AlarmName: "import-export-service-cpu-high",
					AlarmArn: "arn:aws:cloudwatch:eu-central-1:111111111111:alarm:import-export-service-cpu-high",
					AlarmConfigurationUpdatedTimestamp: new Date("2026-01-01T00:00:00Z"),
					ActionsEnabled: true,
					OKActions: ["arn:aws:sns:eu-central-1:111111111111:ok"],
					AlarmActions: ["arn:aws:sns:eu-central-1:111111111111:alarm"],
					InsufficientDataActions: [],
					StateValue: "ALARM" as const,
					StateReason: "Threshold Crossed: 1 datapoint [91.2] was greater than the threshold (80.0).",
					StateReasonData: '{"version":"1.0","queryDate":"2026-09-17T10:00:00Z","recentDatapoints":[91.2]}',
					StateUpdatedTimestamp: new Date("2026-09-17T10:00:00Z"),
					StateTransitionedTimestamp: new Date("2026-09-17T10:00:00Z"),
					MetricName: "CPUUtilization",
					Namespace: "AWS/ECS",
					Statistic: "Average" as const,
					Dimensions: [{ Name: "ServiceName", Value: "import-export-service" }],
					Period: 60,
					EvaluationPeriods: 3,
					Threshold: 80,
					ComparisonOperator: "GreaterThanThreshold" as const,
					TreatMissingData: "missing",
				},
			],
		});

		const client = await buildClient();
		const result = await client.callTool({ name: "aws_cloudwatch_describe_alarms", arguments: { estate: "prod" } });
		await client.close();

		expect(result.isError).toBeFalsy();
		const alarm = (result.structuredContent as { MetricAlarms: Array<Record<string, unknown>> }).MetricAlarms[0] ?? {};
		for (const gone of [
			"AlarmArn",
			"OKActions",
			"AlarmActions",
			"InsufficientDataActions",
			"StateReasonData",
			"ActionsEnabled",
		]) {
			expect(gone in alarm).toBe(false);
		}
		expect(alarm).toMatchObject({
			AlarmName: "import-export-service-cpu-high",
			StateValue: "ALARM",
			MetricName: "CPUUtilization",
			Namespace: "AWS/ECS",
			Threshold: 80,
			ComparisonOperator: "GreaterThanThreshold",
			Dimensions: [{ Name: "ServiceName", Value: "import-export-service" }],
		});
		expect(String(alarm.StateReason)).toContain("Threshold Crossed");
		// Greptile, PR #813: small, and they answer "did it transition before the config change?"
		expect("StateTransitionedTimestamp" in alarm).toBe(true);
		expect("AlarmConfigurationUpdatedTimestamp" in alarm).toBe(true);
		// The text copy is the same projection, so the two never disagree.
		const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
		expect(text).not.toContain("StateReasonData");
		expect(text).not.toContain("arn:aws:sns");
	});

	// Greptile, PR #813: "why did this alarm not page?" needs the notification wiring, so it is
	// opt-in rather than gone.
	test("includeNotificationConfig returns the alarm in full", async () => {
		const cwMock = mockClient(CloudWatchClient);
		cwMock.on(DescribeAlarmsCommand).resolves({
			MetricAlarms: [
				{
					AlarmName: "svc-cpu-high",
					AlarmArn: "arn:aws:cloudwatch:eu-central-1:111111111111:alarm:svc-cpu-high",
					ActionsEnabled: false,
					AlarmActions: ["arn:aws:sns:eu-central-1:111111111111:pager"],
					StateValue: "ALARM" as const,
					StateReasonData: '{"version":"1.0"}',
				},
			],
		});
		const client = await buildClient();
		const result = await client.callTool({
			name: "aws_cloudwatch_describe_alarms",
			arguments: { estate: "prod", AlarmNames: ["svc-cpu-high"], includeNotificationConfig: true },
		});
		await client.close();

		expect(result.isError).toBeFalsy();
		const alarm = (result.structuredContent as { MetricAlarms: Array<Record<string, unknown>> }).MetricAlarms[0] ?? {};
		expect(alarm).toMatchObject({
			ActionsEnabled: false,
			AlarmActions: ["arn:aws:sns:eu-central-1:111111111111:pager"],
			AlarmArn: "arn:aws:cloudwatch:eu-central-1:111111111111:alarm:svc-cpu-high",
		});
		expect("StateReasonData" in alarm).toBe(true);
	});

	test("content[0].text is byte-identical to JSON.stringify(result) (toMcp's own serialization)", async () => {
		const cwMock = mockClient(CloudWatchClient);
		cwMock
			.on(DescribeAlarmsCommand)
			.resolves({ MetricAlarms: [{ AlarmName: "high-cpu", StateValue: "ALARM" as const }] });

		const client = await buildClient();
		const result = await client.callTool({
			name: "aws_cloudwatch_describe_alarms",
			arguments: { estate: "prod" },
		});
		await client.close();

		const content = result.content as Array<{ type: "text"; text: string }>;
		const reserialized = JSON.stringify(JSON.parse(content[0]?.text ?? "null"));
		expect(content[0]?.text).toBe(reserialized);
	});

	test("SDK error path (_error branch): structuredContent still validates against the passthrough schema", async () => {
		const cwMock = mockClient(CloudWatchClient);
		cwMock.on(DescribeAlarmsCommand).rejects(
			Object.assign(new Error("User is not authorized to perform: cloudwatch:DescribeAlarms"), {
				name: "AccessDeniedException",
				$metadata: { httpStatusCode: 403, requestId: "req-1" },
			}),
		);

		const client = await buildClient();
		const result = await client.callTool({
			name: "aws_cloudwatch_describe_alarms",
			arguments: { estate: "prod" },
		});
		await client.close();

		// wrapListTool's error branch returns { _error } on a normal (non-thrown) MCP result --
		// isError is never set by toMcp, so this still exercises output validation, not the
		// SDK's separate isError short-circuit.
		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as { _error: { kind: string; httpStatusCode?: number } };
		expect(structured._error.kind).toBe("iam-permission-missing");
	});
});
