// tests/checks-ingestion.test.ts
import { describe, expect, test } from "bun:test";
import { checkIngestion } from "../scripts/monitor/checks/ingestion.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const HOUR = 3_600_000;
// Fixed "now" 10 minutes past an hour boundary; the check observes the last
// full hour before that boundary.
const NOW = Math.floor(Date.parse("2026-09-01T12:00:00Z") / HOUR) * HOUR + 600_000;
const LAST_HOUR = Math.floor(NOW / HOUR) * HOUR - HOUR;

// Builds one MetricDataResults series per group from {offsetHours: value}.
function fakeClient(groups: Record<string, Record<number, number>>) {
	return {
		send: async () => ({
			MetricDataResults: Object.entries(groups).map(([label, points]) => ({
				Label: label,
				Timestamps: Object.keys(points).map((h) => new Date(LAST_HOUR - Number(h) * HOUR)),
				Values: Object.values(points),
			})),
		}),
	};
}

// A group chatty at this hour on each of the prior 7 days.
const activeBaseline = (lastHourValue: number): Record<number, number> => {
	const p: Record<number, number> = { 0: lastHourValue };
	for (let d = 1; d <= 7; d++) p[d * 24] = 100;
	return p;
};

// SIO-1711: the recent hours spelled out, index 0 being the observed hour.
// activeBaseline cannot express "only ONE zero hour" -- it leaves hours 1 and 2
// absent, and CloudWatch omits zero-count hours, so absent reads as zero and the
// fixture would already be a full zero run.
const withRecentHours = (recent: number[], daily = 100): Record<number, number> => {
	const p: Record<number, number> = {};
	recent.forEach((v, h) => {
		p[h] = v;
	});
	for (let d = 1; d <= 7; d++) p[d * 24] = daily;
	return p;
};

describe("checkIngestion", () => {
	test("a normally-active group at zero warns once", async () => {
		const state = new MonitorState(":memory:");
		// Three explicit zero hours: the default gate needs a contiguous run, and
		// spelling it out keeps the precondition visible rather than accidental.
		const client = fakeClient({ "/ecs/api": withRecentHours([0, 0, 0]) });
		const first = await checkIngestion(client, state, { now: NOW });
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("warn");
		expect(first[0].summary).toContain("stopped");
		const second = await checkIngestion(client, state, { now: NOW });
		expect(second).toHaveLength(0);
	});

	test("ingestion present produces nothing", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkIngestion(fakeClient({ "/ecs/api": activeBaseline(80) }), state, { now: NOW });
		expect(out).toHaveLength(0);
	});

	test("nightly scale-to-zero is silent: same-hour baseline is zero", async () => {
		const state = new MonitorState(":memory:");
		// Quiet at this hour every day; volume elsewhere is irrelevant.
		const points: Record<number, number> = { 0: 0 };
		for (let d = 1; d <= 7; d++) points[d * 24] = 0;
		const out = await checkIngestion(fakeClient({ "/ecs/nightly": points }), state, { now: NOW });
		expect(out).toHaveLength(0);
	});

	test("recovery ships one info finding and clears", async () => {
		const state = new MonitorState(":memory:");
		await checkIngestion(fakeClient({ "/ecs/api": withRecentHours([0, 0, 0]) }), state, { now: NOW });
		const rec = await checkIngestion(fakeClient({ "/ecs/api": activeBaseline(55) }), state, { now: NOW });
		expect(rec).toHaveLength(1);
		expect(rec[0].severity).toBe("info");
		expect(rec[0].summary).toContain("resumed");
		const quiet = await checkIngestion(fakeClient({ "/ecs/api": activeBaseline(55) }), state, { now: NOW });
		expect(quiet).toHaveLength(0);
	});

	test("excluded prefixes are skipped", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkIngestion(fakeClient({ "/aws/events/trail": activeBaseline(0) }), state, { now: NOW });
		expect(out).toHaveLength(0);
	});

	test("a low-volume group below the median floor never alerts", async () => {
		const state = new MonitorState(":memory:");
		const points: Record<number, number> = { 0: 0 };
		for (let d = 1; d <= 7; d++) points[d * 24] = 3; // median 3 < default floor 10
		const out = await checkIngestion(fakeClient({ "/ecs/sparse": points }), state, { now: NOW });
		expect(out).toHaveLength(0);
	});

	// SIO-1711: an event-driven function legitimately has quiet hours. These cases
	// pin the consecutive-zero gate; the pre-existing cases above cannot, because
	// absent points read as zero and so already express a full zero run.
	test("SIO-1711: a single quiet hour on an event-driven group does not warn", async () => {
		const state = new MonitorState(":memory:");
		// The reported shape: median 27 (>= the floor of 10) and exactly one zero
		// hour, the two prior hours carrying traffic.
		const out = await checkIngestion(fakeClient({ "/aws/lambda/fwd": withRecentHours([0, 12, 6], 27) }), state, {
			now: NOW,
		});
		expect(out).toHaveLength(0);
	});

	test("SIO-1711: two zero hours does not warn at the default gate of three", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkIngestion(fakeClient({ "/aws/lambda/fwd": withRecentHours([0, 0, 6], 27) }), state, {
			now: NOW,
		});
		expect(out).toHaveLength(0);
	});

	test("SIO-1711: three consecutive zero hours is a genuine stop and warns", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkIngestion(fakeClient({ "/aws/lambda/fwd": withRecentHours([0, 0, 0], 27) }), state, {
			now: NOW,
		});
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		expect(out[0].summary).toContain("0 events for 3h");
		expect((out[0].evidence as { zeroHours: number }).zeroHours).toBe(3);
	});

	test("SIO-1711: an alternating 0,5,0 group never warns", async () => {
		const state = new MonitorState(":memory:");
		// Ingestion demonstrably works: a real stop is a contiguous run, not a comb.
		const out = await checkIngestion(fakeClient({ "/aws/lambda/blippy": withRecentHours([0, 5, 0], 27) }), state, {
			now: NOW,
		});
		expect(out).toHaveLength(0);
	});

	test("SIO-1711: zeroHours is configurable", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient({ "/aws/lambda/fwd": withRecentHours([0, 0, 6], 27) });
		expect(await checkIngestion(client, state, { now: NOW, zeroHours: 6 })).toHaveLength(0);
		const out = await checkIngestion(client, state, { now: NOW, zeroHours: 2 });
		expect(out).toHaveLength(1);
		expect(out[0].summary).toContain("0 events for 2h");
	});

	test("SIO-1711: a brand-new group with no history at all stays quiet", async () => {
		const state = new MonitorState(":memory:");
		// Every point absent, baseline included, so the median floor -- not the
		// zero-run gate -- is what protects a first appearance.
		const out = await checkIngestion(fakeClient({ "/aws/lambda/just-created": { 0: 0 } }), state, { now: NOW });
		expect(out).toHaveLength(0);
	});

	test("nested group names do not cross-clear fingerprints", async () => {
		const state = new MonitorState(":memory:");
		// /ecs/a silent, /ecs/a-b healthy: recovery/clear on one must not
		// touch the other.
		await checkIngestion(fakeClient({ "/ecs/a": withRecentHours([0, 0, 0]), "/ecs/a-b": activeBaseline(50) }), state, {
			now: NOW,
		});
		const rec = await checkIngestion(
			fakeClient({ "/ecs/a": activeBaseline(60), "/ecs/a-b": activeBaseline(50) }),
			state,
			{ now: NOW },
		);
		expect(rec).toHaveLength(1);
		expect(rec[0].resource).toBe("/ecs/a");
	});
});
