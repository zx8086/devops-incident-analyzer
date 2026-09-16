// tests/checks-alarms.test.ts
import { describe, expect, test } from "bun:test";
import { checkAlarms, isScalingTrigger } from "../scripts/monitor/checks/alarms.ts";
import { MonitorState } from "../scripts/monitor/state.ts";
import { ALARM_ACTIONS_OBSERVED as ARN } from "./aws-samples.ts";

type Alarm = {
	AlarmName: string;
	StateValue: string;
	MetricName?: string;
	Namespace?: string;
	ComparisonOperator?: string;
	Threshold?: number;
	StateReason?: string;
	Dimensions?: { Name: string; Value: string }[];
};

// history: transitions into ALARM the fake reports for DescribeAlarmHistory;
// "deny" makes that call throw, as a role without the read would.
function fakeClient(alarms: Alarm[], history: number | "deny" = 0) {
	return {
		send: async (cmd: { constructor: { name: string } }) => {
			if (cmd.constructor.name === "DescribeAlarmHistoryCommand") {
				if (history === "deny") throw new Error("AccessDenied");
				return {
					AlarmHistoryItems: [
						...Array.from({ length: history }, () => ({ HistorySummary: "Alarm updated from OK to ALARM" })),
						{ HistorySummary: "Alarm updated from ALARM to OK" },
					],
				};
			}
			return { MetricAlarms: alarms, CompositeAlarms: [] };
		},
	};
}

const lowCpu: Alarm = {
	AlarmName: "orders-api-CPU-Utilization-Low-20",
	StateValue: "ALARM",
	MetricName: "CPUUtilization",
	Namespace: "AWS/ECS",
	ComparisonOperator: "LessThanThreshold",
	Threshold: 20,
	StateReason: "Threshold Crossed: 1 datapoint [19.94 (14/09/26 16:40:00)] was less than the threshold (20.0).",
	Dimensions: [{ Name: "ServiceName", Value: "orders-api" }],
};

describe("checkAlarms", () => {
	test("transition into ALARM is critical; still-firing does not repeat", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([{ AlarmName: "cpu-high", StateValue: "ALARM" }]);
		const first = await checkAlarms(client, state);
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("critical");
		expect(first[0].dedup_key).toBe("alarm:cpu-high:ALARM");
		const second = await checkAlarms(client, state);
		expect(second).toHaveLength(0);
	});

	test("INSUFFICIENT_DATA is info (designed nightly metric gaps, never investigated)", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkAlarms(fakeClient([{ AlarmName: "a", StateValue: "INSUFFICIENT_DATA" }]), state);
		expect(out[0].severity).toBe("info");
	});

	test("recovery to OK ships info once, then quiet", async () => {
		const state = new MonitorState(":memory:");
		await checkAlarms(fakeClient([{ AlarmName: "cpu-high", StateValue: "ALARM" }]), state);
		const rec = await checkAlarms(fakeClient([{ AlarmName: "cpu-high", StateValue: "OK" }]), state);
		expect(rec).toHaveLength(1);
		expect(rec[0].severity).toBe("info");
		const quiet = await checkAlarms(fakeClient([{ AlarmName: "cpu-high", StateValue: "OK" }]), state);
		expect(quiet).toHaveLength(0);
	});

	test("an alarm that was always OK produces nothing", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkAlarms(fakeClient([{ AlarmName: "fine", StateValue: "OK" }]), state);
		expect(out).toHaveLength(0);
	});

	test("re-entering ALARM after recovery alerts again", async () => {
		const state = new MonitorState(":memory:");
		const alarm = (v: string) => fakeClient([{ AlarmName: "x", StateValue: v }]);
		await checkAlarms(alarm("ALARM"), state);
		await checkAlarms(alarm("OK"), state);
		const again = await checkAlarms(alarm("ALARM"), state);
		expect(again).toHaveLength(1);
	});

	// SIO-1739: a production low-CPU alarm (19.94% vs a 20% floor)
	// paged critical and burned its investigation cap by flapping.
	test("SIO-1739: a low-side utilization alarm is warn, with the metric and datapoint in evidence", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkAlarms(fakeClient([lowCpu]), state);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		expect(out[0].summary).toContain("low-side utilization alarm");
		expect(out[0].evidence).toMatchObject({
			metric: { namespace: "AWS/ECS", name: "CPUUtilization", dimensions: { ServiceName: "orders-api" } },
			comparison: "LessThanThreshold",
			threshold: 20,
			datapoint: 19.94,
		});
		expect(out[0].evidence).not.toHaveProperty("flapping");
	});

	test("SIO-1739: too few healthy hosts is still critical even though it is a LessThan alarm", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkAlarms(
			fakeClient([
				{
					AlarmName: "alb-healthy-hosts",
					StateValue: "ALARM",
					MetricName: "HealthyHostCount",
					ComparisonOperator: "LessThanThreshold",
					Threshold: 1,
				},
			]),
			state,
		);
		expect(out[0].severity).toBe("critical");
	});

	test("SIO-1739: an alarm that entered ALARM three times in 24h is flapping and warns", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkAlarms(
			fakeClient([{ AlarmName: "cpu-high", StateValue: "ALARM", MetricName: "CPUUtilization" }], 3),
			state,
		);
		expect(out[0].severity).toBe("warn");
		expect(out[0].summary).toContain("flapping: 3 transitions into ALARM in 24h");
		expect(out[0].evidence).toMatchObject({ flapping: 3 });
	});

	test("SIO-1739: alarm history is walked past the first page before deciding it is not flapping", async () => {
		const state = new MonitorState(":memory:");
		const pages = [
			{
				AlarmHistoryItems: [
					{ HistorySummary: "Alarm updated from OK to ALARM" },
					{ HistorySummary: "Alarm updated from ALARM to OK" },
				],
				NextToken: "p2",
			},
			{ AlarmHistoryItems: [{ HistorySummary: "Alarm updated from OK to ALARM" }], NextToken: "p3" },
			{ AlarmHistoryItems: [{ HistorySummary: "Alarm updated from OK to ALARM" }] },
		];
		const client = {
			send: async (cmd: { constructor: { name: string }; input: { NextToken?: string } }) => {
				if (cmd.constructor.name !== "DescribeAlarmHistoryCommand") {
					return { MetricAlarms: [{ AlarmName: "pager", StateValue: "ALARM" }], CompositeAlarms: [] };
				}
				return pages[cmd.input.NextToken === "p2" ? 1 : cmd.input.NextToken === "p3" ? 2 : 0];
			},
		};
		const out = await checkAlarms(client, state);
		expect(out[0].severity).toBe("warn");
		expect(out[0].evidence).toMatchObject({ flapping: 3 });
	});

	test("SIO-1739: two transitions is not flapping; a denied history read leaves severity alone", async () => {
		const two = await checkAlarms(
			fakeClient([{ AlarmName: "a", StateValue: "ALARM" }], 2),
			new MonitorState(":memory:"),
		);
		expect(two[0].severity).toBe("critical");
		const denied = await checkAlarms(
			fakeClient([{ AlarmName: "a", StateValue: "ALARM" }], "deny"),
			new MonitorState(":memory:"),
		);
		expect(denied).toHaveLength(1);
		expect(denied[0].severity).toBe("critical");
	});
});

describe("SIO-1754 scaling triggers", () => {
	test("an alarm whose only actions are scaling policies is a scaling trigger", () => {
		expect(isScalingTrigger({ AlarmActions: [ARN.ecsServiceScaleUp] })).toBe(true);
		expect(isScalingTrigger({ AlarmActions: [ARN.mskBrokerScaling] })).toBe(true);
	});

	test("an alarm that also notifies someone stays a finding", () => {
		expect(isScalingTrigger({ AlarmActions: [ARN.ecsServiceScaleUp, ARN.snsTopic] })).toBe(false);
		expect(isScalingTrigger({ AlarmActions: [ARN.snsTopic] })).toBe(false);
	});

	test("an alarm with no actions is not a scaling trigger", () => {
		expect(isScalingTrigger({ AlarmActions: [] })).toBe(false);
		expect(isScalingTrigger({})).toBe(false);
	});
});
