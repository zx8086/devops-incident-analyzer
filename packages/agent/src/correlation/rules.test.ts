// packages/agent/src/correlation/rules.test.ts
// Unit tests for the Phase 5 AWS correlation rules.
import { describe, expect, test } from "bun:test";
import type { ToolError } from "@devops-agent/shared";
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
