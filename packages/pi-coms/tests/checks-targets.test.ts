// tests/checks-targets.test.ts
import { describe, expect, test } from "bun:test";
import { checkTargets } from "../scripts/monitor/checks/targets.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const ARN = "arn:aws:elasticloadbalancing:eu-central-1:x:targetgroup/orders/abc";

type TargetState = { id: string; state: string; reason?: string };

function fakeClient(targets: TargetState[]) {
	return {
		send: async (cmd: { constructor: { name: string } }) => {
			switch (cmd.constructor.name) {
				case "DescribeTargetGroupsCommand":
					return {
						TargetGroups: [
							{
								TargetGroupArn: ARN,
								TargetGroupName: "orders",
								Protocol: "HTTP",
								Port: 8080,
								HealthCheckPath: "/health",
							},
						],
					};
				case "DescribeTargetHealthCommand":
					return {
						TargetHealthDescriptions: targets.map((t) => ({
							Target: { Id: t.id, Port: 8080 },
							TargetHealth: { State: t.state, Reason: t.reason ?? null, Description: null },
						})),
					};
				default:
					throw new Error(`unexpected ${cmd.constructor.name}`);
			}
		},
	};
}

describe("targets check", () => {
	// The negative case is the whole point: without the duration gate this
	// check fires on every rolling deployment.
	test("a target unhealthy for ONE cycle is not a finding", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{ id: "i-1", state: "unhealthy", reason: "Target.FailedHealthChecks" },
			{ id: "i-2", state: "healthy" },
		]);
		expect(await checkTargets(client, state, { now: NOW })).toEqual([]);
		state.close();
	});

	test("the same target unhealthy across TWO cycles is a warn", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{ id: "i-1", state: "unhealthy", reason: "Target.FailedHealthChecks" },
			{ id: "i-2", state: "healthy" },
		]);
		expect(await checkTargets(client, state, { now: NOW })).toEqual([]);
		const second = await checkTargets(client, state, { now: NOW + 900_000 });
		expect(second).toHaveLength(1);
		expect(second[0]?.severity).toBe("warn");
		expect(second[0]?.family).toBe("targets");
		expect(second[0]?.resource).toBe("orders");
		const evidence = second[0]?.evidence as { unhealthy: { id: string }[] } | undefined;
		expect(evidence?.unhealthy[0]?.id).toBe("i-1");
		state.close();
	});

	test("a DIFFERENT target unhealthy each cycle is not a finding", async () => {
		const state = new MonitorState(":memory:");
		await checkTargets(
			fakeClient([
				{ id: "i-1", state: "unhealthy" },
				{ id: "i-2", state: "healthy" },
			]),
			state,
			{
				now: NOW,
			},
		);
		// i-1 recovered and i-2 is now failing: nothing has been down for two
		// cycles, which is what a rolling replacement looks like.
		const second = await checkTargets(
			fakeClient([
				{ id: "i-1", state: "healthy" },
				{ id: "i-2", state: "unhealthy" },
			]),
			state,
			{ now: NOW + 900_000 },
		);
		expect(second).toEqual([]);
		state.close();
	});

	test("draining and initial targets are never read", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{ id: "i-old", state: "draining" },
			{ id: "i-new", state: "initial" },
			{ id: "i-ok", state: "healthy" },
		]);
		await checkTargets(client, state, { now: NOW });
		expect(await checkTargets(client, state, { now: NOW + 900_000 })).toEqual([]);
		state.close();
	});

	test("zero healthy targets is critical", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{ id: "i-1", state: "unhealthy", reason: "Target.Timeout" },
			{ id: "i-2", state: "unhealthy", reason: "Target.Timeout" },
		]);
		await checkTargets(client, state, { now: NOW });
		const second = await checkTargets(client, state, { now: NOW + 900_000 });
		expect(second).toHaveLength(1);
		expect(second[0]?.severity).toBe("critical");
		expect(second[0]?.summary).toContain("no healthy targets");
		state.close();
	});

	test("a group whose targets are all draining raises nothing", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([{ id: "i-1", state: "draining" }]);
		await checkTargets(client, state, { now: NOW });
		expect(await checkTargets(client, state, { now: NOW + 900_000 })).toEqual([]);
		state.close();
	});

	test("recovery re-arms, so the next outage alerts without waiting out the window", async () => {
		const state = new MonitorState(":memory:");
		const bad = fakeClient([
			{ id: "i-1", state: "unhealthy" },
			{ id: "i-2", state: "healthy" },
		]);
		await checkTargets(bad, state, { now: NOW });
		expect(await checkTargets(bad, state, { now: NOW + 900_000 })).toHaveLength(1);
		// Same fingerprint would otherwise stay marked for 24 h.
		const good = fakeClient([
			{ id: "i-1", state: "healthy" },
			{ id: "i-2", state: "healthy" },
		]);
		await checkTargets(good, state, { now: NOW + 1_800_000 });
		await checkTargets(bad, state, { now: NOW + 2_700_000 });
		expect(await checkTargets(bad, state, { now: NOW + 3_600_000 })).toHaveLength(1);
		state.close();
	});
});
