// packages/agent/src/correlation/rules.test.ts
// Unit tests for the Phase 5 AWS correlation rules.
import { describe, expect, test } from "bun:test";
import type { AwsCloudWatchAlarm, ToolError } from "@devops-agent/shared";
import { correlationRules } from "./rules.ts";

function findRule(name: string) {
	const rule = correlationRules.find((r) => r.name === name);
	if (!rule) throw new Error(`Rule ${name} not found`);
	return rule;
}

function makeStateWithAwsProse(prose: string, toolErrors: ToolError[] = []) {
	return {
		dataSourceResults: [{ dataSourceId: "aws", status: "success" as const, data: prose, toolErrors }],
	} as never; // partial AgentStateType, sufficient for trigger logic
}

function makeStateWithKafkaProse(prose: string, toolErrors: ToolError[] = []) {
	return {
		dataSourceResults: [{ dataSourceId: "kafka", status: "success" as const, data: prose, toolErrors }],
	} as never;
}

// SIO-842: typed-findings state for the aws-cloudwatch rule. focusServices, when
// provided, populates investigationFocus.services so the rule's incident-scoping
// branch is exercised; omit it to exercise the no-focus (show-all) fallback.
function makeStateWithAwsAlarms(alarms: AwsCloudWatchAlarm[], focusServices?: string[]) {
	return {
		dataSourceResults: [{ dataSourceId: "aws", status: "success" as const, data: "", awsFindings: { alarms } }],
		...(focusServices
			? { investigationFocus: { services: focusServices, datasources: ["aws"], summary: "", establishedAtTurn: 1 } }
			: {}),
	} as never;
}

describe("aws-ecs-degraded-needs-elastic-traces", () => {
	const rule = findRule("aws-ecs-degraded-needs-elastic-traces");

	test("fires on '0 of 3 tasks running' phrasing", () => {
		const state = makeStateWithAwsProse("ECS service my-svc: 0 of 3 tasks running. Last event at 2026-05-16T...");
		expect(rule.trigger(state)).not.toBeNull();
	});

	test("does not fire when desired == running", () => {
		const state = makeStateWithAwsProse("ECS service my-svc: 3 of 3 tasks running. Healthy.");
		expect(rule.trigger(state)).toBeNull();
	});

	test("fires on explicit 'service degraded' phrasing", () => {
		const state = makeStateWithAwsProse("service backend is degraded; investigating.");
		expect(rule.trigger(state)).not.toBeNull();
	});
});

describe("aws-cloudwatch-anomaly-needs-kafka-lag", () => {
	const rule = findRule("aws-cloudwatch-anomaly-needs-kafka-lag");

	// SIO-842: reads typed awsFindings.alarms[] (not prose regex) and scopes to the
	// incident via investigationFocus.services.
	test("fires on a Kafka/MSK ALARM that references a focus service", () => {
		const state = makeStateWithAwsAlarms(
			[{ name: "MSK-ConsumerLag-High-payments", state: "ALARM", namespace: "AWS/Kafka" }],
			["payments"],
		);
		const match = rule.trigger(state);
		expect(match).not.toBeNull();
		// The scoped alarms are surfaced in context, not just a boolean.
		expect((match?.context.alarms as AwsCloudWatchAlarm[]).map((a) => a.name)).toContain(
			"MSK-ConsumerLag-High-payments",
		);
	});

	test("does NOT fire when the Kafka ALARM is out of the investigation focus (the scoping regression)", () => {
		// A Kafka-named ALARM exists, but it references 'billing' while the incident
		// focus is 'payments'. The old prose regex fired here; the scoped rule must not.
		const state = makeStateWithAwsAlarms(
			[{ name: "MSK-ConsumerLag-High-billing", state: "ALARM", namespace: "AWS/Kafka" }],
			["payments"],
		);
		expect(rule.trigger(state)).toBeNull();
	});

	test("does not fire for non-Kafka alarms even when in focus", () => {
		const state = makeStateWithAwsAlarms(
			[{ name: "RDS-CPU-High", state: "ALARM", namespace: "AWS/RDS" }],
			["payments"],
		);
		expect(rule.trigger(state)).toBeNull();
	});

	test("does not fire for a Kafka alarm not in ALARM state", () => {
		const state = makeStateWithAwsAlarms(
			[{ name: "MSK-ConsumerLag-High", state: "OK", namespace: "AWS/Kafka" }],
			["payments"],
		);
		expect(rule.trigger(state)).toBeNull();
	});

	test("with no established focus, falls back to firing on any Kafka/MSK ALARM", () => {
		const state = makeStateWithAwsAlarms([{ name: "MSK-ConsumerLag-High", state: "ALARM", namespace: "AWS/Kafka" }]);
		expect(rule.trigger(state)).not.toBeNull();
	});

	test("does not fire and does not throw on a legacy prose-only result (no awsFindings)", () => {
		const state = makeStateWithAwsProse("Alarm 'MSK-ConsumerLag-High' StateValue: ALARM. Threshold: 10000 messages.");
		expect(rule.trigger(state)).toBeNull();
	});
});

describe("kafka-broker-timeout-needs-aws-metrics", () => {
	const rule = findRule("kafka-broker-timeout-needs-aws-metrics");

	test("fires on prose mentioning broker timeout", () => {
		const state = makeStateWithKafkaProse("broker b-1.msk.amazonaws.com unreachable: connection timeout after 30s");
		expect(rule.trigger(state)).not.toBeNull();
	});

	test("fires on transient ToolError with network-shape message", () => {
		const state = makeStateWithKafkaProse("successful query", [
			{
				toolName: "kafka_list_topics",
				category: "transient",
				message: "ENOTFOUND b-1.msk.amazonaws.com",
				retryable: true,
			} as never,
		]);
		expect(rule.trigger(state)).not.toBeNull();
	});
});
