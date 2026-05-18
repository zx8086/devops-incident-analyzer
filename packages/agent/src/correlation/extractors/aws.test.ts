// packages/agent/src/correlation/extractors/aws.test.ts
// SIO-785 Phase 2: AWS CloudWatch alarm extractor.
import { describe, expect, test } from "bun:test";
import type { ToolOutput } from "@devops-agent/shared";
import { extractAwsFindings } from "./aws.ts";

describe("extractAwsFindings", () => {
	test("returns empty findings when no relevant tool outputs are present", () => {
		const outputs: ToolOutput[] = [{ toolName: "aws_ec2_describe_instances", rawJson: { Reservations: [] } }];
		expect(extractAwsFindings(outputs)).toEqual({});
	});

	test("maps MetricAlarms PascalCase fields to camelCase findings", () => {
		const findings = extractAwsFindings([
			{
				toolName: "aws_cloudwatch_describe_alarms",
				rawJson: {
					MetricAlarms: [
						{
							AlarmName: "msk-broker-cpu-high",
							StateValue: "ALARM",
							StateReason: "Threshold > 80%",
							MetricName: "CPUUtilization",
							Namespace: "AWS/Kafka",
							StateUpdatedTimestamp: "2026-05-18T10:00:00.000Z",
						},
						{ AlarmName: "rds-ok", StateValue: "OK" },
					],
				},
			},
		]);
		expect(findings.alarms).toHaveLength(2);
		expect(findings.alarms?.[0]?.name).toBe("msk-broker-cpu-high");
		expect(findings.alarms?.[0]?.state).toBe("ALARM");
		expect(findings.alarms?.[0]?.reason).toContain("Threshold");
		expect(findings.alarms?.[0]?.namespace).toBe("AWS/Kafka");
		expect(findings.alarms?.[0]?.stateUpdatedAt).toBe("2026-05-18T10:00:00.000Z");
	});

	test("returns empty when MetricAlarms is missing or empty", () => {
		expect(extractAwsFindings([{ toolName: "aws_cloudwatch_describe_alarms", rawJson: { MetricAlarms: [] } }])).toEqual(
			{},
		);
		expect(
			extractAwsFindings([
				{ toolName: "aws_cloudwatch_describe_alarms", rawJson: { $metadata: { httpStatusCode: 200 } } },
			]),
		).toEqual({});
	});

	test("ignores malformed alarms but keeps valid siblings", () => {
		const findings = extractAwsFindings([
			{
				toolName: "aws_cloudwatch_describe_alarms",
				rawJson: {
					MetricAlarms: [
						{ AlarmName: "valid", StateValue: "OK" },
						{ foo: "bar" }, // no AlarmName, no StateValue
					],
				},
			},
		]);
		expect(findings.alarms).toHaveLength(1);
		expect(findings.alarms?.[0]?.name).toBe("valid");
	});

	test("ignores non-object rawJson (defensive)", () => {
		expect(
			extractAwsFindings([{ toolName: "aws_cloudwatch_describe_alarms", rawJson: "upstream returned text" }]),
		).toEqual({});
		expect(extractAwsFindings([{ toolName: "aws_cloudwatch_describe_alarms", rawJson: null }])).toEqual({});
	});

	test("merges alarms across multiple tool calls (e.g. paginated)", () => {
		const findings = extractAwsFindings([
			{
				toolName: "aws_cloudwatch_describe_alarms",
				rawJson: { MetricAlarms: [{ AlarmName: "a", StateValue: "OK" }] },
			},
			{
				toolName: "aws_cloudwatch_describe_alarms",
				rawJson: { MetricAlarms: [{ AlarmName: "b", StateValue: "ALARM" }] },
			},
		]);
		expect(findings.alarms?.map((a) => a.name)).toEqual(["a", "b"]);
	});
});
