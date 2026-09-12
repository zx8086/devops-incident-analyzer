// tests/checks-trail.test.ts
import { describe, expect, test } from "bun:test";
import { checkTrail, DescribeTrailsCommand, type GetTrailStatusCommand } from "../scripts/monitor/checks/trail.ts";
import { MonitorState } from "../scripts/monitor/state.ts";

type TrailStatus = { IsLogging?: boolean; LatestDeliveryError?: string };

function fakeClient(trails: { name: string; status: TrailStatus | Error }[]) {
	return {
		send: async (cmd: DescribeTrailsCommand | GetTrailStatusCommand) => {
			if (cmd instanceof DescribeTrailsCommand) {
				return { trailList: trails.map((t) => ({ Name: t.name, TrailARN: `arn:trail/${t.name}` })) };
			}
			const name = (cmd.input.Name as string).replace("arn:trail/", "");
			const t = trails.find((x) => x.name === name);
			if (t?.status instanceof Error) throw t.status;
			return t?.status ?? {};
		},
	};
}

describe("checkTrail", () => {
	test("a trail that stopped logging is critical once", async () => {
		const state = new MonitorState(":memory:");
		const client = fakeClient([{ name: "main", status: { IsLogging: false } }]);
		const first = await checkTrail(client, state);
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("critical");
		expect(first[0].summary).toContain("NOT logging");
		const second = await checkTrail(client, state);
		expect(second).toHaveLength(0);
	});

	test("delivery error is warn; recovery ships info and clears", async () => {
		const state = new MonitorState(":memory:");
		const bad = fakeClient([
			{ name: "main", status: { IsLogging: true, LatestDeliveryError: "AccessDenied to bucket" } },
		]);
		const first = await checkTrail(bad, state);
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("warn");
		const good = fakeClient([{ name: "main", status: { IsLogging: true } }]);
		const rec = await checkTrail(good, state);
		expect(rec).toHaveLength(1);
		expect(rec[0].severity).toBe("info");
		const quiet = await checkTrail(good, state);
		expect(quiet).toHaveLength(0);
	});

	test("healthy trail produces nothing", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkTrail(fakeClient([{ name: "main", status: { IsLogging: true } }]), state);
		expect(out).toHaveLength(0);
	});

	test("no trails at all is an info finding once", async () => {
		const state = new MonitorState(":memory:");
		const first = await checkTrail(fakeClient([]), state);
		expect(first).toHaveLength(1);
		expect(first[0].severity).toBe("info");
		const second = await checkTrail(fakeClient([]), state);
		expect(second).toHaveLength(0);
	});

	// SIO-1713: DescribeTrails in a member account also returns the organization's
	// trails, owned by the management account. A stopped one there is not
	// actionable locally and is routinely a deliberate consolidation, so severity
	// must follow account COVERAGE (is any trail logging?), not one trail's flag.
	test("SIO-1713: a stopped trail is warn, not critical, while another trail covers the account", async () => {
		const state = new MonitorState(":memory:");
		// The observed shape: two org trails stopped, a third still delivering.
		const out = await checkTrail(
			fakeClient([
				{ name: "aws-controltower-BaselineCloudTrail", status: { IsLogging: false } },
				{ name: "infra-log-org-trail", status: { IsLogging: false } },
				{ name: "security-trail", status: { IsLogging: true } },
			]),
			state,
		);
		expect(out).toHaveLength(2);
		for (const f of out) {
			expect(f.severity).toBe("warn");
			expect(f.summary).toContain("another trail still covers this account");
			expect((f.evidence as { otherTrailLogging: boolean }).otherTrailLogging).toBe(true);
		}
	});

	test("SIO-1713: every trail stopped is still critical -- the account is dark", async () => {
		const state = new MonitorState(":memory:");
		const out = await checkTrail(
			fakeClient([
				{ name: "org-trail", status: { IsLogging: false } },
				{ name: "local-trail", status: { IsLogging: false } },
			]),
			state,
		);
		expect(out).toHaveLength(2);
		for (const f of out) {
			expect(f.severity).toBe("critical");
			expect(f.summary).toContain("NOT logging");
			expect((f.evidence as { otherTrailLogging: boolean }).otherTrailLogging).toBe(false);
		}
	});

	test("SIO-1713: a denied shadow trail cannot establish coverage", async () => {
		const state = new MonitorState(":memory:");
		// One trail stopped, the only other unreadable: a denied status says nothing
		// either way, so it must not downgrade a genuine loss of coverage.
		const out = await checkTrail(
			fakeClient([
				{ name: "local-trail", status: { IsLogging: false } },
				{ name: "org-shadow", status: new Error("AccessDeniedException") },
			]),
			state,
		);
		expect(out).toHaveLength(1);
		expect(out[0].severity).toBe("critical");
	});

	test("one denied shadow trail is tolerated; all failing throws", async () => {
		const state = new MonitorState(":memory:");
		const mixed = fakeClient([
			{ name: "org-shadow", status: new Error("AccessDeniedException") },
			{ name: "local", status: { IsLogging: true } },
		]);
		const out = await checkTrail(mixed, state);
		expect(out).toHaveLength(0);
		const allBad = fakeClient([{ name: "org-shadow", status: new Error("AccessDeniedException") }]);
		await expect(checkTrail(allBad, state)).rejects.toThrow("all 1 trail status read(s) failed");
	});
});
