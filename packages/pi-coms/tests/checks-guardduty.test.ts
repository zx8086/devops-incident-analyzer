// tests/checks-guardduty.test.ts
import { describe, expect, test } from "bun:test";
import { checkGuardDuty } from "../scripts/monitor/checks/guardduty.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

const NOW = Date.parse("2026-09-14T12:00:00Z");
const HOUR = 3_600_000;

type GdFinding = { Id: string; Severity: number; Type: string; Title: string; UpdatedAt: string };

function fakeClient(detectors: string[], findings: GdFinding[]) {
	const seen: { since?: number }[] = [];
	return {
		seen,
		send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
			switch (cmd.constructor.name) {
				case "ListDetectorsCommand":
					return { DetectorIds: detectors };
				case "ListFindingsCommand": {
					const crit = (cmd.input.FindingCriteria as { Criterion: { updatedAt: { GreaterThanOrEqual: number } } })
						.Criterion;
					seen.push({ since: crit.updatedAt.GreaterThanOrEqual });
					return {
						FindingIds: findings
							.filter((f) => Date.parse(f.UpdatedAt) >= crit.updatedAt.GreaterThanOrEqual)
							.map((f) => f.Id),
					};
				}
				case "GetFindingsCommand": {
					const ids = cmd.input.FindingIds as string[];
					return {
						Findings: findings
							.filter((f) => ids.includes(f.Id))
							.map((f) => ({ ...f, Resource: { ResourceType: "Instance" }, Service: { Count: 3 } })),
					};
				}
				default:
					throw new Error(`unexpected ${cmd.constructor.name}`);
			}
		},
	};
}

const high: GdFinding = {
	Id: "f-high",
	Severity: 8,
	Type: "UnauthorizedAccess:EC2/SSHBruteForce",
	Title: "SSH brute force",
	UpdatedAt: new Date(NOW - HOUR).toISOString(),
};
const medium: GdFinding = { ...high, Id: "f-med", Severity: 5, UpdatedAt: new Date(NOW - 2 * HOUR).toISOString() };

describe("checkGuardDuty (SIO-1740)", () => {
	test("no detector is silent", async () => {
		expect(await checkGuardDuty(fakeClient([], [high]), new MonitorState(":memory:"), { now: NOW })).toHaveLength(0);
	});

	test("high is critical, medium is warn, each alerts once, and the watermark advances", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient(["d1"], [high, medium]);
		const out = await checkGuardDuty(client, state, { now: NOW });
		expect(out.map((f) => [f.resource, f.severity])).toEqual([
			["Instance/f-high", "critical"],
			["Instance/f-med", "warn"],
		]);
		expect(out[0].summary).toContain("SSH brute force");
		expect(out[0].evidence).toMatchObject({ id: "f-high", severity: 8, count: 3 });
		// First lookback is 24h; afterwards the newest UpdatedAt seen.
		expect(client.seen[0].since).toBe(NOW - 24 * HOUR);
		expect(state.getWatermark("guardduty:d1")).toBe(Date.parse(high.UpdatedAt));
		expect(await checkGuardDuty(client, state, { now: NOW })).toHaveLength(0);
	});

	test("a recurrence within a day does not re-page, and only findings past the watermark are fetched", async () => {
		const state = new MonitorState(":memory:");
		await checkGuardDuty(fakeClient(["d1"], [high]), state, { now: NOW });
		const later = { ...high, UpdatedAt: new Date(NOW + HOUR).toISOString() };
		const client = fakeClient(["d1"], [later, medium]);
		expect(await checkGuardDuty(client, state, { now: NOW + 2 * HOUR })).toHaveLength(0);
		// The second pass asked from the first pass's newest UpdatedAt, so the
		// older medium finding was never listed.
		expect(client.seen[0].since).toBe(Date.parse(high.UpdatedAt));
		expect(state.getWatermark("guardduty:d1")).toBe(Date.parse(later.UpdatedAt));
	});
});
