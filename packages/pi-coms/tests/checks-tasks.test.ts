// tests/checks-tasks.test.ts
import { describe, expect, test } from "bun:test";
import { checkTasks } from "../scripts/monitor/checks/tasks.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const CLUSTER = "arn:aws:ecs:eu-central-1:x:cluster/prod";

type Svc = {
	name: string;
	desired: number;
	running: number;
	rolloutState?: string;
	rolloutStateReason?: string;
	events?: { message: string; at: number }[];
};

function fakeClient(services: Svc[]) {
	return {
		send: async (cmd: { constructor: { name: string } }) => {
			switch (cmd.constructor.name) {
				case "ListClustersCommand":
					return { clusterArns: [CLUSTER] };
				case "ListServicesCommand":
					return { serviceArns: services.map((s) => `${CLUSTER}/${s.name}`) };
				case "DescribeServicesCommand":
					return {
						services: services.map((s) => ({
							serviceName: s.name,
							serviceArn: `${CLUSTER}/${s.name}`,
							desiredCount: s.desired,
							runningCount: s.running,
							pendingCount: 0,
							launchType: "FARGATE",
							taskDefinition: `${s.name}:42`,
							deployments: [
								{
									status: "PRIMARY",
									rolloutState: s.rolloutState ?? "COMPLETED",
									rolloutStateReason: s.rolloutStateReason ?? null,
									desiredCount: s.desired,
									runningCount: s.running,
									failedTasks: 0,
									taskDefinition: `${s.name}:42`,
								},
							],
							events: (s.events ?? []).map((e) => ({ message: e.message, createdAt: new Date(e.at) })),
						})),
					};
				default:
					throw new Error(`unexpected ${cmd.constructor.name}`);
			}
		},
	};
}

describe("tasks check", () => {
	test("a healthy service raises nothing", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([{ name: "orders", desired: 3, running: 3 }]);
		expect(await checkTasks(client, state, { now: NOW })).toEqual([]);
		state.close();
	});

	// Routine ECS chatter must never match. These are the messages a normal
	// deployment emits, and they arrive constantly.
	test("routine service events raise nothing", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{
				name: "orders",
				desired: 3,
				running: 3,
				events: [
					{ message: "(service orders) has started 1 tasks: (task abc).", at: NOW - 60_000 },
					{ message: "(service orders) has begun draining connections on 1 tasks.", at: NOW - 30_000 },
					{ message: "(service orders) has reached a steady state.", at: NOW - 10_000 },
				],
			},
		]);
		expect(await checkTasks(client, state, { now: NOW })).toEqual([]);
		state.close();
	});

	test("a FAILED deployment rollout is critical immediately", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{ name: "orders", desired: 3, running: 0, rolloutState: "FAILED", rolloutStateReason: "circuit breaker" },
		]);
		const findings = await checkTasks(client, state, { now: NOW });
		const rollout = findings.filter((f) => f.dedup_key.endsWith(":rollout-failed"));
		expect(rollout).toHaveLength(1);
		expect(rollout[0]?.severity).toBe("critical");
		expect(rollout[0]?.resource).toBe("prod/orders");
		expect(rollout[0]?.summary).toContain("circuit breaker");
		state.close();
	});

	// The crash loop counts cannot see: tasks die and are replaced fast enough
	// that runningCount never drops below desiredCount.
	test("ECS reporting a crash loop is critical even at full task count", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{
				name: "orders",
				desired: 3,
				running: 3,
				events: [{ message: "(service orders) is unable to consistently start tasks successfully.", at: NOW - 60_000 }],
			},
		]);
		const findings = await checkTasks(client, state, { now: NOW });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("critical");
		const evidence = findings[0]?.evidence as { classification: string } | undefined;
		expect(evidence?.classification).toBe("crash loop");
		state.close();
	});

	test("a capacity placement failure is a warn", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{
				name: "orders",
				desired: 3,
				running: 2,
				events: [
					{
						message:
							"(service orders) was unable to place a task because no container instance met all of its requirements.",
						at: NOW - 60_000,
					},
				],
			},
		]);
		const findings = await checkTasks(client, state, { now: NOW });
		const capacity = findings.filter((f) => f.dedup_key.includes("no capacity"));
		expect(capacity).toHaveLength(1);
		expect(capacity[0]?.severity).toBe("warn");
		state.close();
	});

	// Without the duration gate this fires on every deployment.
	test("a shortfall for ONE cycle raises nothing; two cycles is a warn", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([{ name: "orders", desired: 3, running: 1 }]);
		expect(await checkTasks(client, state, { now: NOW })).toEqual([]);
		const second = await checkTasks(client, state, { now: NOW + 900_000 });
		expect(second).toHaveLength(1);
		expect(second[0]?.severity).toBe("warn");
		expect(second[0]?.dedup_key).toContain("below-desired");
		expect(second[0]?.summary).toContain("1/3");
		state.close();
	});

	test("a service that recovers between cycles raises nothing", async () => {
		const state = new MonitorState(":memory:");
		await checkTasks(fakeClient([{ name: "orders", desired: 3, running: 1 }]), state, { now: NOW });
		expect(
			await checkTasks(fakeClient([{ name: "orders", desired: 3, running: 3 }]), state, { now: NOW + 900_000 }),
		).toEqual([]);
		state.close();
	});

	test("an event already seen is not re-raised on the next cycle", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{
				name: "orders",
				desired: 3,
				running: 3,
				events: [{ message: "(service orders) is unable to consistently start tasks successfully.", at: NOW - 60_000 }],
			},
		]);
		expect(await checkTasks(client, state, { now: NOW })).toHaveLength(1);
		expect(await checkTasks(client, state, { now: NOW + 900_000 })).toEqual([]);
		state.close();
	});
});
