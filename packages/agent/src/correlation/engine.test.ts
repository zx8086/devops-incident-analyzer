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
