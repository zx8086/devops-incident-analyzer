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

// SIO-1155: the log-gap recovery rule -- Gaps-bullet parsing, service-token
// extraction, elastic-coverage suppression, and the targeted fetch directive.
// Fixtures are the real bullets from the 2026-07-19 localcore replay.
import { LOG_GAP_RULE_NAME, parseLogRetrievalGaps } from "./rules.ts";

describe("cloudwatch-log-gap-needs-elastic (SIO-1155)", () => {
	const rule = findRule(LOG_GAP_RULE_NAME);

	const REPLAY_GAPS_ANSWER = `# Incident Report

## Findings
- strong evidence.

## Gaps

- \`stock-service\` internal logs at 03:09-03:20 UTC on failure nights were not retrieved; the exact internal error causing the HTTP 500 is unconfirmed
- \`prices-producer-v2-service\` logs were identified in the log stream list but not queried; the mechanism is unconfirmed
- GitLab Orbit knowledge graph was unavailable for all three \`gitlab_blast_radius\` calls; cross-project import edges were not derived
- \`aws_logs_start_query\` returned authorization errors for \`bindplane-log-group\` in eu-shared-services-prd; access state is confirmed denied

Confidence: 0.87`;

	function stateWith(finalAnswer: string, elasticData?: string) {
		return {
			finalAnswer,
			dataSourceResults: elasticData
				? [{ dataSourceId: "elastic", status: "success" as const, data: elasticData }]
				: [],
		} as never;
	}

	test("parses service-scoped log-retrieval bullets from the replay Gaps section", () => {
		const hits = parseLogRetrievalGaps(REPLAY_GAPS_ANSWER);
		expect(hits.map((h) => h.service)).toEqual(["stock-service", "prices-producer-v2-service"]);
		expect(hits[0]?.bullet).toContain("were not retrieved");
		expect(hits[1]?.bullet).toContain("not queried");
	});

	test("excludes log-group names, estate ids, and snake_case tool tokens", () => {
		const hits = parseLogRetrievalGaps(
			"## Gaps\n- `bindplane-log-group` and `eu-shared-services-prd` logs were not retrieved via `aws_logs_start_query`.",
		);
		expect(hits).toHaveLength(0);
	});

	test("non-log gap bullets never match", () => {
		const hits = parseLogRetrievalGaps(
			"## Gaps\n- `stock-service` deployment manifest was not retrieved from the registry.",
		);
		expect(hits).toHaveLength(0);
	});

	test("trigger fires with uncovered services and carries bullets in context", () => {
		const match = rule.trigger(stateWith(REPLAY_GAPS_ANSWER));
		expect(match).not.toBeNull();
		expect(match?.context.services).toEqual(["stock-service", "prices-producer-v2-service"]);
		expect(Array.isArray(match?.context.bullets)).toBe(true);
		expect((match?.context.bullets as string[]).length).toBe(2);
	});

	test("trigger is null when an elastic result already covers every gap service", () => {
		const covered = stateWith(
			REPLAY_GAPS_ANSWER,
			"Targeted fetch: stock-service 4,812 error hits; prices-producer-v2-service 0 hits in logs-*.",
		);
		expect(rule.trigger(covered)).toBeNull();
	});

	test("trigger is null with no finalAnswer or no Gaps section", () => {
		expect(rule.trigger(stateWith(""))).toBeNull();
		expect(rule.trigger(stateWith("# Report\n\n## Findings\n- fine\n\nConfidence: 0.9"))).toBeNull();
	});

	test("caps the fan at three services", () => {
		const many = `## Gaps
- \`svc-a\` logs were not retrieved
- \`svc-b\` logs were not retrieved
- \`svc-c\` logs were not retrieved
- \`svc-d\` logs were not retrieved`;
		const match = rule.trigger(stateWith(many));
		expect((match?.context.services as string[]).length).toBe(3);
	});

	// CodeRabbit (PR #419): the candidate set is fixed BEFORE coverage filtering, so a
	// satisfied fetch converges instead of rotating in the fourth service and degrading.
	test("converges after the fetch covers the capped candidates, even with a fourth gap service", () => {
		const many = `## Gaps
- \`svc-a\` logs were not retrieved
- \`svc-b\` logs were not retrieved
- \`svc-c\` logs were not retrieved
- \`svc-d\` logs were not retrieved`;
		const covered = stateWith(many, "Targeted fetch: svc-a, svc-b, svc-c error hits reported.");
		expect(rule.trigger(covered)).toBeNull();
	});

	test("fetchDirective names the gap services and forbids re-investigating the focus", () => {
		const directive = rule.fetchDirective?.({ services: ["stock-service"], bullets: [] }) ?? "";
		expect(directive).toContain("CORRELATION FETCH (SIO-1155)");
		expect(directive).toContain("stock-service");
		expect(directive).toContain("do NOT re-investigate the focus service");
	});
});
