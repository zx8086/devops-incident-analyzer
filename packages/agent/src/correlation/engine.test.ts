// packages/agent/src/correlation/engine.test.ts
import { describe, expect, test } from "bun:test";
import type { AgentStateType } from "../state.ts";
import { agentToDataSourceId, evaluate } from "./engine.ts";
import type { CorrelationRule } from "./rules.ts";

describe("agentToDataSourceId", () => {
	test("elastic-agent maps to elastic", () => {
		expect(agentToDataSourceId("elastic-agent")).toBe("elastic");
	});

	test("kafka-agent maps to kafka", () => {
		expect(agentToDataSourceId("kafka-agent")).toBe("kafka");
	});

	// SIO-763: the bug we're fixing — capella-agent's datasource id is "couchbase", not "capella"
	test("capella-agent maps to couchbase", () => {
		expect(agentToDataSourceId("capella-agent")).toBe("couchbase");
	});

	test("konnect-agent maps to konnect", () => {
		expect(agentToDataSourceId("konnect-agent")).toBe("konnect");
	});

	test("gitlab-agent maps to gitlab", () => {
		expect(agentToDataSourceId("gitlab-agent")).toBe("gitlab");
	});

	test("atlassian-agent maps to atlassian", () => {
		expect(agentToDataSourceId("atlassian-agent")).toBe("atlassian");
	});

	test("aws-agent maps to aws", () => {
		expect(agentToDataSourceId("aws-agent")).toBe("aws");
	});

	test("unknown agent falls back to -agent suffix strip", () => {
		expect(agentToDataSourceId("future-agent")).toBe("future");
	});
});

// SIO-1076: the idempotency check must read context.services[] (the entity shape
// Orbit regular-dispatch rules emit). Without it, a covered rule re-fans every
// pass. Exercised through evaluate() with a synthetic rule + elastic findings.
describe("extractEntityNames reads context.services[] (via evaluate idempotency)", () => {
	function serviceRule(): CorrelationRule {
		return {
			name: "test-service-context",
			description: "test",
			trigger: () => ({ context: { services: ["checkout"] } }),
			requiredAgent: "elastic-agent",
			retry: { attempts: 1, timeoutMs: 1000 },
		};
	}

	test("satisfied when elastic already covers a service in context.services[]", () => {
		const state = {
			dataSourceResults: [{ dataSourceId: "elastic", status: "success", data: { services: [{ name: "checkout" }] } }],
		} as unknown as AgentStateType;
		const [decision] = evaluate(state, [serviceRule()]);
		expect(decision?.status).toBe("satisfied");
		expect(decision?.reason).toContain("already covered");
	});

	test("needs-invocation when elastic does not cover the service", () => {
		const state = {
			dataSourceResults: [{ dataSourceId: "elastic", status: "success", data: { services: [{ name: "payments" }] } }],
		} as unknown as AgentStateType;
		const [decision] = evaluate(state, [serviceRule()]);
		expect(decision?.status).toBe("needs-invocation");
	});
});

// SIO-1237: the synthetic cross-check rule keys its context on `hostnames`, which
// extractEntityNames does not read. That dropped it into the "no entity granularity
// available; presence of findings counts as covered" branch, so ANY successful elastic
// result -- including one that never touched synthetics-* -- marked the rule satisfied and
// the cross-check never dispatched. Coverage is now decided by the synthetic monitors
// actually retrieved.
describe("hostname-keyed coverage reads elasticFindings.syntheticMonitors (SIO-1237)", () => {
	const HOST = "ksql.prd.shared-services.eu.pvh.cloud";

	function hostnameRule(): CorrelationRule {
		return {
			name: "test-hostname-context",
			description: "test",
			trigger: () => ({ context: { hostnames: [HOST], signal: "confluent-5xx-needs-synthetic-crosscheck" } }),
			requiredAgent: "elastic-agent",
			retry: { attempts: 1, timeoutMs: 1000 },
		};
	}

	function elasticState(result: Record<string, unknown>): AgentStateType {
		return {
			dataSourceResults: [{ dataSourceId: "elastic", status: "success", ...result }],
		} as unknown as AgentStateType;
	}

	// The regression itself. A successful elastic result with no findings at all used to
	// short-circuit to "satisfied", silently cancelling the fetch.
	test("needs-invocation when elastic succeeded but retrieved no synthetic monitors", () => {
		const state = elasticState({ data: "elastic ran and found nothing about synthetics" });
		const [decision] = evaluate(state, [hostnameRule()]);
		expect(decision?.status).toBe("needs-invocation");
	});

	test("needs-invocation when elastic returned unrelated findings only", () => {
		const state = elasticState({
			data: "APM summary for checkout",
			elasticFindings: { apmServices: [{ serviceName: "checkout" }] },
		});
		const [decision] = evaluate(state, [hostnameRule()]);
		expect(decision?.status).toBe("needs-invocation");
	});

	test("needs-invocation when a synthetic monitor was retrieved for a DIFFERENT host", () => {
		const state = elasticState({
			data: "synthetics",
			elasticFindings: {
				syntheticMonitors: [
					{
						name: "DS - Kafka Server - prd | Connect",
						status: "up",
						url: "https://connect.prd.shared-services.eu.pvh.cloud/healthcheck",
					},
				],
			},
		});
		const [decision] = evaluate(state, [hostnameRule()]);
		expect(decision?.status).toBe("needs-invocation");
	});

	// url.full is a full URL, never equal to the bare hostname -- hence substring matching.
	test("satisfied when a synthetic monitor URL contains the triggered hostname", () => {
		const state = elasticState({
			data: "synthetics",
			elasticFindings: {
				syntheticMonitors: [
					{ name: "DS - Kafka Server - prd | KSQL Db", status: "up", url: `https://${HOST}/healthcheck` },
				],
			},
		});
		const [decision] = evaluate(state, [hostnameRule()]);
		expect(decision?.status).toBe("satisfied");
		expect(decision?.reason).toContain("already covered");
	});

	// A monitor can be named for its endpoint with url absent from the parsed document.
	test("satisfied when the monitor NAME carries the hostname and url is absent", () => {
		const state = elasticState({
			data: "synthetics",
			elasticFindings: { syntheticMonitors: [{ name: `healthcheck ${HOST}`, status: "down" }] },
		});
		const [decision] = evaluate(state, [hostnameRule()]);
		expect(decision?.status).toBe("satisfied");
	});

	// Coverage means "we looked", not "the answer was reassuring" -- a DOWN monitor still
	// answers the question the rule asked.
	test("a DOWN monitor for the host counts as covered", () => {
		const state = elasticState({
			data: "synthetics",
			elasticFindings: { syntheticMonitors: [{ name: "ksql", status: "down", url: `https://${HOST}/healthcheck` }] },
		});
		const [decision] = evaluate(state, [hostnameRule()]);
		expect(decision?.status).toBe("satisfied");
	});
});
