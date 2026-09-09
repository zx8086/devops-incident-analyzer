// tests/monitor-budget.test.ts
import { describe, expect, test } from "bun:test";
import { investigationUsage, planInvestigation } from "../scripts/monitor/budget.ts";
import type { Finding } from "../scripts/monitor/report.ts";

const F = (over: Partial<Finding> = {}): Finding => ({
	family: "logs",
	severity: "warn",
	resource: "/ecs/fargate/eu-oit-prd-log-group",
	summary: "3 error-pattern event(s)",
	dedup_key: "logs:/ecs/fargate/eu-oit-prd-log-group:abc",
	evidence: {},
	at: new Date().toISOString(),
	...over,
});

const rec = (resources: string[]) => ({
	payload: JSON.stringify({ resources, dedup_keys: [], count: resources.length, target: "eu-oit-prd" }),
});

describe("investigationUsage", () => {
	test("counts prompts and per-resource attempts, one per prompt", () => {
		const u = investigationUsage([rec(["a", "b"]), rec(["a", "a"]), { payload: "not json" }]);
		expect(u.used).toBe(2);
		expect(u.attemptsFor("a")).toBe(2);
		expect(u.attemptsFor("b")).toBe(1);
		expect(u.attemptsFor("c")).toBe(0);
	});

	test("refusals do not count: a muted spoke cannot burn the budget", () => {
		const refused = {
			payload: JSON.stringify({ resources: ["a"], dedup_keys: [], count: 1, target: "t", outcome: "refused" }),
		};
		const timedOut = {
			payload: JSON.stringify({ resources: ["a"], dedup_keys: [], count: 1, target: "t", outcome: "timeout" }),
		};
		const u = investigationUsage([refused, refused, timedOut, rec(["a"])]);
		expect(u.used).toBe(2);
		expect(u.attemptsFor("a")).toBe(2);
	});

	test("legacy rows without an outcome still count", () => {
		const u = investigationUsage([rec(["a", "b"])]);
		expect(u.used).toBe(1);
		expect(u.attemptsFor("a")).toBe(1);
	});
});

describe("planInvestigation", () => {
	const limits = { perDay: 24, perResourcePerDay: 3 };

	test("nothing used: everything is sent", () => {
		const plan = planInvestigation([F(), F({ resource: "other", dedup_key: "k2" })], investigationUsage([]), limits);
		expect(plan.send).toHaveLength(2);
		expect(plan.skipped).toHaveLength(0);
	});

	test("a resource at its daily cap is skipped with the reason, others still go", () => {
		const usage = investigationUsage([
			rec(["/ecs/fargate/eu-oit-prd-log-group"]),
			rec(["/ecs/fargate/eu-oit-prd-log-group"]),
			rec(["/ecs/fargate/eu-oit-prd-log-group"]),
		]);
		const plan = planInvestigation([F(), F({ resource: "cpu-alarm", dedup_key: "alarm:cpu:ALARM" })], usage, limits);
		expect(plan.send.map((f) => f.resource)).toEqual(["cpu-alarm"]);
		expect(plan.skipped[0].reason).toBe("resource over daily investigation cap (3/3 in 24h)");
	});

	test("daily budget exhausted: nothing is sent, every finding carries the reason", () => {
		const rows = Array.from({ length: 24 }, (_, i) => rec([`r${i}`]));
		const plan = planInvestigation([F(), F({ resource: "x", dedup_key: "k" })], investigationUsage(rows), limits);
		expect(plan.send).toHaveLength(0);
		expect(plan.skipped).toHaveLength(2);
		expect(plan.skipped[1].reason).toBe("daily investigation budget exhausted (24/24 prompts in 24h)");
	});

	test("empty input is a no-op", () => {
		expect(planInvestigation([], investigationUsage([]), limits)).toEqual({ send: [], skipped: [] });
	});
});
