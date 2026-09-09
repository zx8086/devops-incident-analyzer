// tests/checks-drift.test.ts
import { describe, expect, test } from "bun:test";
import { checkDrift } from "../scripts/monitor/checks/drift.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

function fakeClient(
	instances: { id: string; state: string }[],
	statuses: { id: string; system: string; instance: string }[] = [],
) {
	return {
		async send(cmd: { constructor: { name: string } }) {
			if (cmd.constructor.name === "DescribeInstancesCommand") {
				return {
					Reservations: [
						{
							Instances: instances.map((i) => ({ InstanceId: i.id, State: { Name: i.state } })),
						},
					],
				};
			}
			if (cmd.constructor.name === "DescribeInstanceStatusCommand") {
				return {
					InstanceStatuses: statuses.map((s) => ({
						InstanceId: s.id,
						SystemStatus: { Status: s.system },
						InstanceStatus: { Status: s.instance },
					})),
				};
			}
			throw new Error(`unexpected ${cmd.constructor.name}`);
		},
	};
}

describe("checkDrift", () => {
	test("first run establishes the baseline silently", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state);
		expect(out).toHaveLength(0);
		expect(state.getSnapshot("instances")).toEqual({ "i-1": "running" });
	});

	test("running to stopped is warn, once", async () => {
		const state = new MonitorState(":memory:");
		await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state);
		const out = await checkDrift(fakeClient([{ id: "i-1", state: "stopped" }]), state);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		const again = await checkDrift(fakeClient([{ id: "i-1", state: "stopped" }]), state);
		expect(again).toHaveLength(0);
	});

	test("disappeared instance is warn; new instance is info", async () => {
		const state = new MonitorState(":memory:");
		await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state);
		const out = await checkDrift(fakeClient([{ id: "i-2", state: "running" }]), state);
		const sevs = out.map((f) => `${f.resource}:${f.severity}`).sort();
		expect(sevs).toEqual(["i-1:warn", "i-2:info"]);
	});

	test("failed status check is warn once and clears on recovery", async () => {
		const state = new MonitorState(":memory:");
		const bad = fakeClient([{ id: "i-1", state: "running" }], [{ id: "i-1", system: "impaired", instance: "ok" }]);
		await checkDrift(fakeClient([{ id: "i-1", state: "running" }]), state); // baseline
		const out = await checkDrift(bad, state);
		expect(out).toHaveLength(1);
		expect(out[0].summary).toContain("status check");
		expect(await checkDrift(bad, state)).toHaveLength(0);
		const good = fakeClient([{ id: "i-1", state: "running" }], [{ id: "i-1", system: "ok", instance: "ok" }]);
		await checkDrift(good, state);
		const badAgain = await checkDrift(bad, state);
		expect(badAgain).toHaveLength(1);
	});
});

describe("checkDrift batches (SIO-1676)", () => {
	const many = (n: number, state: string, prefix = "i-") =>
		Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, state }));

	test("many instances disappearing in one cycle is one warn finding listing them", async () => {
		const state = new MonitorState(":memory:");
		await checkDrift(fakeClient(many(12, "running")), state);
		const out = await checkDrift(fakeClient([]), state);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		expect(out[0].resource).toBe("ec2:batch");
		expect(out[0].dedup_key).toMatch(/^drift:batch:gone:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
		expect(out[0].summary).toContain("12 instances disappeared in one cycle");
		expect(out[0].summary).toContain("(+2 more)");
		expect((out[0].evidence as { instances: unknown[] }).instances).toHaveLength(12);
	});

	test("same transition on many instances collapses; different transitions stay apart", async () => {
		const state = new MonitorState(":memory:");
		await checkDrift(fakeClient([...many(3, "running", "a-"), ...many(2, "stopped", "b-")]), state);
		const out = await checkDrift(fakeClient([...many(3, "terminated", "a-"), ...many(2, "running", "b-")]), state);
		const bySummary = out.map((f) => `${f.severity}:${f.summary.split(":")[0]}`).sort();
		expect(bySummary).toEqual([
			"info:2 instances changed state stopped->running in one cycle",
			"warn:3 instances changed state running->terminated in one cycle",
		]);
	});

	test("a lone change keeps the per-instance shape and dedup key", async () => {
		const state = new MonitorState(":memory:");
		await checkDrift(
			fakeClient([
				{ id: "i-1", state: "running" },
				{ id: "i-2", state: "running" },
			]),
			state,
		);
		const out = await checkDrift(
			fakeClient([
				{ id: "i-2", state: "running" },
				{ id: "i-3", state: "running" },
			]),
			state,
		);
		const keys = out.map((f) => f.dedup_key).sort();
		expect(keys).toEqual(["drift:i-1:gone", "drift:i-3:new"]);
	});
});
