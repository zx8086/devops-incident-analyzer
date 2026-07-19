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

	test("prefers _summary (complete) over byte-truncated MetricAlarms (SIO-833)", () => {
		const findings = extractAwsFindings([
			{
				toolName: "aws_cloudwatch_describe_alarms",
				rawJson: {
					// Server truncated the heavy list to one item...
					MetricAlarms: [{ AlarmName: "shown-1", StateValue: "ALARM" }],
					_truncated: { shown: 1, total: 3, advice: "truncated" },
					// ...but attached the complete projected set as _summary.
					_summary: [
						{ AlarmName: "shown-1", StateValue: "ALARM" },
						{ AlarmName: "dropped-2", StateValue: "OK" },
						{ AlarmName: "dropped-3", StateValue: "INSUFFICIENT_DATA" },
					],
				},
			},
		]);
		expect(findings.alarms?.map((a) => a.name)).toEqual(["shown-1", "dropped-2", "dropped-3"]);
	});
});

describe("extractAwsFindings focus scoping (SIO-1030)", () => {
	const alarms = (rows: Array<Record<string, unknown>>): ToolOutput => ({
		toolName: "aws_cloudwatch_describe_alarms",
		rawJson: { MetricAlarms: rows },
	});
	const FOCUS = ["prices-api-v2-service"];

	test("empty focus keeps every alarm (show-all, back-compat)", () => {
		const out = extractAwsFindings(
			[
				alarms([
					{ AlarmName: "prices-api-v2-service-CPU", StateValue: "ALARM" },
					{ AlarmName: "bitly-service-Memory", StateValue: "OK" },
				]),
			],
			[],
		);
		expect(out.alarms).toHaveLength(2);
	});

	test("drops off-focus alarms, keeps focus-named (matched on name)", () => {
		const out = extractAwsFindings(
			[
				alarms([
					{ AlarmName: "prices-api-v2-service-CPU-Utilization-High", StateValue: "ALARM" },
					{ AlarmName: "authentication-service-CPU-Utilization", StateValue: "ALARM" },
					{ AlarmName: "bitly-service-Memory-Utilization", StateValue: "ALARM" },
				]),
			],
			FOCUS,
		);
		expect(out.alarms?.map((a) => a.name)).toEqual(["prices-api-v2-service-CPU-Utilization-High"]);
	});

	test("NO silent pass-through: an off-focus ALARM-state alarm only surfaces flagged unscoped", () => {
		// SIO-1030 product decision preserved: no off-focus alarm masquerades as a
		// scoped finding. SIO-1159 adds an EXPLICIT fallback instead -- rows return
		// flagged unscoped:true and rule-engine consumers skip them (rules.ts guard).
		const out = extractAwsFindings([alarms([{ AlarmName: "storytelling-service-CPU", StateValue: "ALARM" }])], FOCUS);
		expect(out.unscoped).toBe(true);
		expect(out.alarms).toHaveLength(1);
	});

	test("matches on namespace, not only alarm name", () => {
		const out = extractAwsFindings(
			[alarms([{ AlarmName: "generic-alarm", StateValue: "ALARM", Namespace: "prices-api-v2-service" }])],
			FOCUS,
		);
		expect(out.alarms).toHaveLength(1);
	});
});

// SIO-1159: unscoped top-N fallback (mirrors couchbase SIO-1138). Run 270378e0:
// the companion-service estate's 35 alarms were all focus-dropped and the card
// shipped blank; now they return as an explicit estate-wide fallback.
describe("extractAwsFindings unscoped fallback (SIO-1159)", () => {
	const alarms = (rows: Array<Record<string, unknown>>): ToolOutput => ({
		toolName: "aws_cloudwatch_describe_alarms",
		rawJson: { MetricAlarms: rows },
	});
	const FOCUS = ["localcore-service"];

	test("droppedAll with focus returns top-5 flagged unscoped, firing alarms first", () => {
		const rows = [
			{ AlarmName: "companion-a-CPU-Low", StateValue: "OK" },
			{ AlarmName: "companion-b-Memory-Low", StateValue: "OK" },
			{ AlarmName: "companion-c-Errors-High", StateValue: "ALARM" },
			{ AlarmName: "companion-d-Depth", StateValue: "INSUFFICIENT_DATA" },
			{ AlarmName: "companion-e-CPU", StateValue: "OK" },
			{ AlarmName: "companion-f-Latency", StateValue: "ALARM" },
			{ AlarmName: "companion-g-Disk", StateValue: "OK" },
		];
		const out = extractAwsFindings([alarms(rows)], FOCUS);
		expect(out.unscoped).toBe(true);
		expect(out.alarms).toHaveLength(5);
		expect(out.alarms?.[0]?.state).toBe("ALARM");
		expect(out.alarms?.[1]?.state).toBe("ALARM");
		expect(out.alarms?.[2]?.state).toBe("INSUFFICIENT_DATA");
	});

	test("scoped hits suppress the fallback and carry no unscoped flag", () => {
		const out = extractAwsFindings(
			[
				alarms([
					{ AlarmName: "localcore-service-CPU-Low", StateValue: "OK" },
					{ AlarmName: "companion-c-Errors-High", StateValue: "ALARM" },
				]),
			],
			FOCUS,
		);
		expect(out.unscoped).toBeUndefined();
		expect(out.alarms?.map((a) => a.name)).toEqual(["localcore-service-CPU-Low"]);
	});

	test("empty focus never engages the fallback (show-all has no unscoped flag)", () => {
		const out = extractAwsFindings([alarms([{ AlarmName: "anything", StateValue: "OK" }])], []);
		expect(out.unscoped).toBeUndefined();
		expect(out.alarms).toHaveLength(1);
	});

	test("no alarms at all stays empty even with focus", () => {
		expect(extractAwsFindings([alarms([])], FOCUS)).toEqual({});
	});
});
