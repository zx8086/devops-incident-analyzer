// packages/agent/src/correlation/rules.test.ts
// Unit tests for the Phase 5 AWS correlation rules.
import { describe, expect, test } from "bun:test";
import type { AwsCloudWatchAlarm, ToolError } from "@devops-agent/shared";
import type { AgentStateType } from "../state.ts";
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

	// SIO-1030: alarmReferencesFocus now delegates to the shared matchesFocus, so the
	// focus can be referenced by any of name / metricName / namespace (not just name).
	// These pin those paths so the alarm-scoping match can't silently drift.
	test("fires when the focus is named only by the alarm metricName (not the name)", () => {
		const state = makeStateWithAwsAlarms(
			[{ name: "MSK-ConsumerLag-High", metricName: "payments-service-lag", state: "ALARM", namespace: "AWS/Kafka" }],
			["payments-service"],
		);
		expect(rule.trigger(state)).not.toBeNull();
	});

	test("fires when the focus is named only by the alarm namespace (not the name)", () => {
		const state = makeStateWithAwsAlarms(
			[{ name: "Kafka-ConsumerLag-High", state: "ALARM", namespace: "Custom/payments-service/Kafka" }],
			["payments-service"],
		);
		expect(rule.trigger(state)).not.toBeNull();
	});

	test("fires on a normalized (plural/suffix) name match between focus and alarm", () => {
		// alarm names the plural `notifications-service`; focus is singular
		// `notification-service`. matchesFocus normalizes both to `notification`.
		const state = makeStateWithAwsAlarms(
			[{ name: "MSK-ConsumerLag-High-notifications-service", state: "ALARM", namespace: "AWS/Kafka" }],
			["notification-service"],
		);
		expect(rule.trigger(state)).not.toBeNull();
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

// SIO-1103: shared-infra blast-radius rule.
describe("shared-infra-blast-radius", () => {
	const rule = findRule("shared-infra-blast-radius");

	// elastic error present so the "real incident" guard passes.
	const elasticError = {
		dataSourceId: "elastic",
		status: "success" as const,
		data: "",
		elasticFindings: { apmServices: [{ serviceName: "orders", errorRate: 0.2 }] },
	};

	function stateWith(
		blast: Array<{ service: string; neighbour: string; via: string; sharedResource: string }>,
		withError = true,
		focusServices?: string[],
	) {
		return {
			dataSourceResults: withError ? [elasticError] : [],
			graphBlastRadius: blast,
			...(focusServices
				? { investigationFocus: { services: focusServices, datasources: [], summary: "", establishedAtTurn: 1 } }
				: {}),
		} as never;
	}

	test("fires when a shared kafka-topic/telemetry neighbour exists AND the incident is erroring", () => {
		const match = rule.trigger(
			stateWith([{ service: "orders", neighbour: "refunds", via: "kafka-topic", sharedResource: "events" }]),
		);
		expect(match).not.toBeNull();
		expect(match?.context.services as string[]).toContain("refunds");
		expect(rule.requiredAgent).toBe("elastic-agent");
	});

	test("does NOT fire without a runtime error (don't blast-radius a clean turn)", () => {
		expect(
			rule.trigger(
				stateWith([{ service: "orders", neighbour: "refunds", via: "kafka-topic", sharedResource: "events" }], false),
			),
		).toBeNull();
	});

	test("does NOT fire on a bare depends-on hop (weaker signal, no clear owning agent)", () => {
		expect(
			rule.trigger(stateWith([{ service: "orders", neighbour: "payments", via: "depends-on", sharedResource: "" }])),
		).toBeNull();
	});

	test("does NOT fire with no blast radius", () => {
		expect(rule.trigger(stateWith([]))).toBeNull();
	});

	// SIO-1103 CodeRabbit: a neighbour already in the incident is not re-dispatched.
	test("excludes neighbours that are already incident-focus services", () => {
		// refunds is a graph neighbour AND already a focus service -> dropped; audit is new.
		const match = rule.trigger(
			stateWith(
				[
					{ service: "orders", neighbour: "refunds", via: "kafka-topic", sharedResource: "events" },
					{ service: "orders", neighbour: "audit", via: "telemetry-source", sharedResource: "aws:logGroup:/x" },
				],
				true,
				["orders", "refunds"],
			),
		);
		expect(match).not.toBeNull();
		const services = match?.context.services as string[];
		expect(services).toContain("audit");
		expect(services).not.toContain("refunds");
	});

	test("does NOT fire when every neighbour is already an incident-focus service", () => {
		expect(
			rule.trigger(
				stateWith([{ service: "orders", neighbour: "refunds", via: "kafka-topic", sharedResource: "events" }], true, [
					"orders",
					"refunds",
				]),
			),
		).toBeNull();
	});

	// SIO-1104 (5a): shared-AwsResource hits from the topology sweep's RUNS_ON edges.
	test("fires on a shared aws-resource neighbour with the same semantics", () => {
		const arn = "arn:aws:ecs:eu-west-1:1:service/prod/shared";
		const match = rule.trigger(
			stateWith([{ service: "orders", neighbour: "billing", via: "aws-resource", sharedResource: arn }]),
		);
		expect(match).not.toBeNull();
		expect(match?.context.services as string[]).toContain("billing");
		expect(match?.context.sharedResources as string[]).toContain(`aws-resource:${arn}`);
	});
});

// SIO-1138: unscoped-fallback couchbase rows are display-only -- the datastore
// contradiction rule must never correlate them against MRs.
describe("gitlab-deploy-vs-datastore-runtime (SIO-1138 unscoped guard)", () => {
	const rule = findRule("gitlab-deploy-vs-datastore-runtime");
	const mergedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	const observedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();

	function makeState(unscoped: boolean): AgentStateType {
		const partial: Partial<AgentStateType> = {
			dataSourceResults: [
				{
					dataSourceId: "gitlab",
					status: "success",
					data: "",
					gitlabFindings: {
						mergedRequests: [{ id: 42, title: "fix pricelist paging", merged_at: mergedAt }],
					},
				},
				{
					dataSourceId: "couchbase",
					status: "success",
					data: "",
					couchbaseFindings: {
						slowQueries: [
							{ statement: "SELECT * FROM pricelist WHERE k = $1 OFFSET 100000", lastExecutionTime: observedAt },
						],
						...(unscoped ? { unscoped: true } : {}),
					},
				},
			],
		};
		return partial as unknown as AgentStateType;
	}

	test("fires for scoped couchbase slow queries post-merge", () => {
		expect(rule.trigger(makeState(false))).not.toBeNull();
	});

	test("does not fire when couchbase findings are the unscoped fallback", () => {
		expect(rule.trigger(makeState(true))).toBeNull();
	});
});
