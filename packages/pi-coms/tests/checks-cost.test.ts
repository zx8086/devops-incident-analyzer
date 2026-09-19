// tests/checks-cost.test.ts
import { describe, expect, test } from "bun:test";
import { checkCost } from "../scripts/monitor/checks/cost.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

function fakeClient(daily: { date: string; usd: number }[]) {
	return {
		async send(cmd: { constructor: { name: string } }) {
			if (cmd.constructor.name !== "GetCostAndUsageCommand") throw new Error("unexpected");
			return {
				ResultsByTime: daily.map((d) => ({
					TimePeriod: { Start: d.date },
					Total: { UnblendedCost: { Amount: String(d.usd), Unit: "USD" } },
				})),
			};
		},
	};
}

// now = 2026-08-30 anywhere in the day; yesterday = 2026-08-29
const NOW = new Date("2026-08-30T08:00:00Z");
function days(baseline: number, yesterday: number) {
	const out: { date: string; usd: number }[] = [];
	for (let d = 15; d >= 2; d--) {
		const dt = new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10);
		out.push({ date: dt, usd: baseline });
	}
	out.push({ date: "2026-08-29", usd: yesterday });
	return out;
}

describe("checkCost", () => {
	test("over both thresholds alerts once per day", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient(days(10, 13)); // +30 pct and +3 usd
		const out = await checkCost(client, state, { now: NOW, pct: 20, abs: 1 });
		expect(out).toHaveLength(1);
		expect(out[0].dedup_key).toBe("cost:2026-08-29");
		expect(await checkCost(client, state, { now: NOW, pct: 20, abs: 1 })).toHaveLength(0);
	});

	test("over pct but under abs stays quiet", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(fakeClient(days(1, 1.5)), state, { now: NOW, pct: 20, abs: 1 }); // +50 pct, +0.50 usd
		expect(out).toHaveLength(0);
	});

	test("over abs but under pct stays quiet", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(fakeClient(days(100, 110)), state, { now: NOW, pct: 20, abs: 1 }); // +10 usd, +10 pct
		expect(out).toHaveLength(0);
	});

	// SIO-1680: fleet default is an absolute $100 gate with the percentage filter off.
	test("default gate: a $99 rise stays quiet, a $101 rise is one warn finding", async () => {
		const quiet = new MonitorState(":memory:");
		expect(await checkCost(fakeClient(days(1000, 1099)), quiet, { now: NOW })).toHaveLength(0);
		const loud = new MonitorState(":memory:");
		const out = await checkCost(fakeClient(days(1000, 1101)), loud, { now: NOW }); // +10 pct only
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("warn");
		expect(out[0].evidence).toEqual({ date: "2026-08-29", usd: 1101, baseline: 1000 });
	});

	// SIO-1739: the baseline was a mean, so one spike day hid every rise under it
	// for the next two weeks.
	test("SIO-1739: one spike day in the baseline does not hide the next real rise", async () => {
		const state = new MonitorState(":memory:");
		const spiked = days(1000, 1101).map((d) => (d.date === "2026-08-20" ? { ...d, usd: 5000 } : d));
		const out = await checkCost(fakeClient(spiked), state, { now: NOW });
		expect(out).toHaveLength(1);
		expect(out[0].evidence).toEqual({ date: "2026-08-29", usd: 1101, baseline: 1000 });
	});

	test("a zero baseline reports the rise without a percentage", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(fakeClient(days(0, 150)), state, { now: NOW });
		expect(out).toHaveLength(1);
		expect(out[0].summary).toContain("(no prior spend)");
		expect(out[0].summary).not.toContain("Infinity");
	});

	test("no baseline yet stays quiet but records costs", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(fakeClient([{ date: "2026-08-29", usd: 5 }]), state, { now: NOW });
		expect(out).toHaveLength(0);
		expect(state.latestCost()).toEqual({ date: "2026-08-29", usd: 5 });
	});
});

// SIO-1819: per-service attribution. The shapes below are the REAL
// GetCostAndUsage response with GroupBy SERVICE, captured from
// eu-shared-services-prd on 2026-09-19 -- including the one detail that makes
// this change dangerous.
describe("checkCost with GroupBy SERVICE", () => {
	// THE TRAP: when GroupBy is set, AWS returns `Total: {}` and puts every
	// figure in Groups. Reading Total.UnblendedCost.Amount (as the pre-SIO-1819
	// code did) would record 0.00 for every day and silently destroy the
	// baseline. Verified against the live API, not assumed.
	function groupedClient(daily: { date: string; services: Record<string, number> }[]) {
		return {
			async send(cmd: { constructor: { name: string } }) {
				if (cmd.constructor.name !== "GetCostAndUsageCommand") throw new Error("unexpected");
				return {
					ResultsByTime: daily.map((d) => ({
						TimePeriod: { Start: d.date },
						Estimated: true,
						Total: {}, // <- empty when grouped, exactly as AWS returns it
						Groups: Object.entries(d.services).map(([svc, usd]) => ({
							Keys: [svc],
							Metrics: { UnblendedCost: { Amount: String(usd), Unit: "USD" } },
						})),
					})),
				};
			},
		};
	}

	// Real service names from the live response: Bedrock bills per MODEL, so
	// there is no service literally called "Bedrock" to match on.
	const SONNET = "Claude Sonnet 4.6 (Amazon Bedrock Edition)";
	const VPC = "Amazon Virtual Private Cloud";

	function groupedDays(baseline: number, yesterdayServices: Record<string, number>) {
		const out: { date: string; services: Record<string, number> }[] = [];
		for (let d = 15; d >= 2; d--) {
			const dt = new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10);
			out.push({ date: dt, services: { [VPC]: baseline } });
		}
		out.push({ date: "2026-08-29", services: yesterdayServices });
		return out;
	}

	test("a grouped response still records the correct daily TOTAL", async () => {
		const state = new MonitorState(":memory:");
		await checkCost(groupedClient(groupedDays(10, { [VPC]: 4, [SONNET]: 6 })), state, { now: NOW });
		// 4 + 6, not 0 from the empty Total.
		expect(state.latestCost()).toEqual({ date: "2026-08-29", usd: 10 });
	});

	test("the finding names the top contributing service and its share", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(groupedClient(groupedDays(1000, { [VPC]: 100, [SONNET]: 1001 })), state, { now: NOW });
		expect(out).toHaveLength(1);
		expect(out[0].summary).toContain(SONNET);
		const ev = out[0].evidence as { topService?: { name: string; usd: number }; byService?: Record<string, number> };
		expect(ev.topService?.name).toBe(SONNET);
		expect(ev.topService?.usd).toBe(1001);
		expect(ev.byService?.[VPC]).toBe(100);
	});

	// The attribution question that prompted the ticket: is a spend rise the
	// monitor investigating, or the workload?
	test("Bedrock model spend is attributable even though no service is named 'Bedrock'", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(groupedClient(groupedDays(1000, { [VPC]: 900, [SONNET]: 300 })), state, { now: NOW });
		const ev = out[0].evidence as { bedrockUsd?: number };
		expect(ev.bedrockUsd).toBe(300);
	});

	test("bedrockUsd is 0, not undefined, on a day with no model spend", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkCost(groupedClient(groupedDays(1000, { [VPC]: 1200 })), state, { now: NOW });
		expect((out[0].evidence as { bedrockUsd?: number }).bedrockUsd).toBe(0);
	});

	// Thresholds are unchanged by this ticket (option (a) in the issue).
	test("grouping does not change when the check fires", async () => {
		const quiet = new MonitorState(":memory:");
		expect(await checkCost(groupedClient(groupedDays(1000, { [VPC]: 1099 })), quiet, { now: NOW })).toHaveLength(0);
		const loud = new MonitorState(":memory:");
		expect(await checkCost(groupedClient(groupedDays(1000, { [VPC]: 1101 })), loud, { now: NOW })).toHaveLength(1);
	});

	// An ungrouped response must keep working: a monitor may run against an
	// older cached shape, and the baseline rows written before this change have
	// no per-service data at all.
	test("an ungrouped response (Total only, no Groups) still records the total", async () => {
		const state = new MonitorState(":memory:");
		await checkCost(fakeClient(days(10, 13)), state, { now: NOW, pct: 20, abs: 1 });
		expect(state.latestCost()).toEqual({ date: "2026-08-29", usd: 13 });
	});
});
