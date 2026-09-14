// tests/checks-health.test.ts
import { describe, expect, test } from "bun:test";
import { checkHealth } from "../scripts/monitor/checks/health.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const NOW = Date.parse("2026-09-14T12:00:00Z");
const HOUR = 3_600_000;

type Ev = {
	arn: string;
	service?: string;
	eventTypeCode?: string;
	eventTypeCategory?: string;
	statusCode?: string;
	region?: string;
	startTime?: Date;
};

function fakeClient(events: Ev[] | Error) {
	return {
		send: async (_cmd: unknown) => {
			if (events instanceof Error) throw events;
			return { events };
		},
	};
}

const issue: Ev = {
	arn: "arn:aws:health:eu-central-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/x1",
	service: "EC2",
	eventTypeCode: "AWS_EC2_OPERATIONAL_ISSUE",
	eventTypeCategory: "issue",
	statusCode: "open",
	region: "eu-central-1",
};

describe("checkHealth (SIO-1740)", () => {
	test("an open issue is one warn finding, re-alerted after a day, with the event in evidence", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkHealth(fakeClient([issue]), state, { now: NOW });
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		expect(out[0].family).toBe("health");
		expect(out[0].resource).toBe("EC2/eu-central-1");
		expect(out[0].dedup_key).toBe(`health:${issue.arn}:warn`);
		expect(out[0].evidence).toMatchObject({ category: "issue", status: "open", eventTypeCode: issue.eventTypeCode });
		expect(await checkHealth(fakeClient([issue]), state, { now: NOW })).toHaveLength(0);
	});

	test("a scheduled change is info beyond 48h and warn inside it; a notification is info", async () => {
		const far: Ev = {
			...issue,
			arn: "arn:far",
			eventTypeCategory: "scheduledChange",
			startTime: new Date(NOW + 72 * HOUR),
		};
		const near: Ev = {
			...issue,
			arn: "arn:near",
			eventTypeCategory: "scheduledChange",
			startTime: new Date(NOW + 12 * HOUR),
		};
		const note: Ev = { ...issue, arn: "arn:note", eventTypeCategory: "accountNotification" };
		const out = await checkHealth(fakeClient([far, near, note]), new MonitorState(":memory:"), { now: NOW });
		const sev = Object.fromEntries(out.map((f) => [f.evidence && (f.evidence as { arn: string }).arn, f.severity]));
		expect(sev).toEqual({ "arn:far": "info", "arn:near": "warn", "arn:note": "info" });
	});

	test("an event that closes and reopens alerts again", async () => {
		const state = new MonitorState(":memory:");
		await checkHealth(fakeClient([issue]), state, { now: NOW });
		expect(await checkHealth(fakeClient([]), state, { now: NOW })).toHaveLength(0);
		expect(await checkHealth(fakeClient([issue]), state, { now: NOW })).toHaveLength(1);
	});

	test("an account without a support plan reports one info finding, never a check error", async () => {
		const state = new MonitorState(":memory:");
		const denied = Object.assign(new Error("AWS Premium Support Subscription is required"), {
			name: "SubscriptionRequiredException",
		});
		const first = await checkHealth(fakeClient(denied), state, { now: NOW });
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("info");
		expect(first[0].summary).toContain("support plan");
		expect(await checkHealth(fakeClient(denied), state, { now: NOW })).toHaveLength(0);
	});

	test("any other error still throws, so the cycle journals a check error", async () => {
		await expect(
			checkHealth(fakeClient(new Error("Throttling")), new MonitorState(":memory:"), { now: NOW }),
		).rejects.toThrow("Throttling");
	});

	// Review finding on #774: an ARN-only key kept a scheduled change at info for
	// a day after it crossed into the 48h window.
	test("a scheduled change crossing into the 48h window is warned at once, not after the info re-alert", async () => {
		const state = new MonitorState(":memory:");
		const change: Ev = {
			...issue,
			arn: "arn:change",
			eventTypeCategory: "scheduledChange",
			startTime: new Date(NOW + 49 * HOUR),
		};
		const first = await checkHealth(fakeClient([change]), state, { now: NOW });
		expect(first.map((f) => f.severity)).toEqual(["info"]);
		const later = await checkHealth(fakeClient([change]), state, { now: NOW + 2 * HOUR });
		expect(later.map((f) => f.severity)).toEqual(["warn"]);
		expect(await checkHealth(fakeClient([change]), state, { now: NOW + 3 * HOUR })).toHaveLength(0);
	});
});
