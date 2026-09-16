// tests/checks-scaling.test.ts
import { describe, expect, test } from "bun:test";
import { checkScaling } from "../scripts/monitor/checks/scaling.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const NOW = Date.parse("2026-09-16T12:00:00Z");

type Act = { id: string; group: string; code: string; message: string; at: number };

function fakeClient(activities: Act[]) {
	return {
		send: async (cmd: { constructor: { name: string } }) => {
			if (cmd.constructor.name !== "DescribeScalingActivitiesCommand") {
				throw new Error(`unexpected ${cmd.constructor.name}`);
			}
			return {
				// Auto Scaling returns activities newest first.
				Activities: [...activities]
					.sort((a, b) => b.at - a.at)
					.map((a) => ({
						ActivityId: a.id,
						AutoScalingGroupName: a.group,
						StatusCode: a.code,
						StatusMessage: a.message,
						Cause: "At 12:00 a monitor alarm TargetTracking triggered a policy",
						Description: `Launching a new EC2 instance for ${a.group}`,
						StartTime: new Date(a.at),
					})),
			};
		},
	};
}

describe("scaling check", () => {
	test("successful activities raise nothing", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{ id: "a1", group: "web", code: "Successful", message: "OK", at: NOW - 60_000 },
			{ id: "a2", group: "web", code: "Successful", message: "OK", at: NOW - 30_000 },
		]);
		expect(await checkScaling(client, state, { now: NOW })).toEqual([]);
		state.close();
	});

	test("a failed activity is a warn naming the group and the message", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{
				id: "a1",
				group: "web",
				code: "Failed",
				message: "Could not launch On-Demand Instances. InsufficientInstanceCapacity",
				at: NOW - 60_000,
			},
		]);
		const findings = await checkScaling(client, state, { now: NOW });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.family).toBe("scaling");
		expect(findings[0]?.severity).toBe("warn");
		expect(findings[0]?.resource).toBe("web");
		expect(findings[0]?.summary).toContain("InsufficientInstanceCapacity");
		state.close();
	});

	// One AZ running out of capacity fails every launch into it. That is one
	// problem, and it must cost one finding and one investigation.
	test("failures sharing a cause across groups collapse into one finding", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{
				id: "a1",
				group: "web",
				code: "Failed",
				message: "Could not launch instance i-111. InsufficientInstanceCapacity",
				at: NOW - 60_000,
			},
			{
				id: "a2",
				group: "api",
				code: "Failed",
				message: "Could not launch instance i-222. InsufficientInstanceCapacity",
				at: NOW - 50_000,
			},
			{
				id: "a3",
				group: "jobs",
				code: "Failed",
				message: "Could not launch instance i-333. InsufficientInstanceCapacity",
				at: NOW - 40_000,
			},
		]);
		const findings = await checkScaling(client, state, { now: NOW });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.resource).toBe("asg:batch");
		const evidence = findings[0]?.evidence as { count: number; autoScalingGroups: string[] } | undefined;
		expect(evidence?.count).toBe(3);
		expect(evidence?.autoScalingGroups).toHaveLength(3);
		state.close();
	});

	test("distinct causes stay distinct findings", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{ id: "a1", group: "web", code: "Failed", message: "InsufficientInstanceCapacity", at: NOW - 60_000 },
			{ id: "a2", group: "web", code: "Cancelled", message: "The security group does not exist", at: NOW - 50_000 },
		]);
		expect(await checkScaling(client, state, { now: NOW })).toHaveLength(2);
		state.close();
	});

	test("the watermark stops an activity being reported twice", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([
			{ id: "a1", group: "web", code: "Failed", message: "InsufficientInstanceCapacity", at: NOW - 60_000 },
		]);
		expect(await checkScaling(client, state, { now: NOW })).toHaveLength(1);
		expect(await checkScaling(client, state, { now: NOW + 900_000 })).toEqual([]);
		state.close();
	});
});
