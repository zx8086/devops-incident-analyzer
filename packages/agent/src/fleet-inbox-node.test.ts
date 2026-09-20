// packages/agent/src/fleet-inbox-node.test.ts
// SIO-1652: the fetchFleetInbox node against a scripted hub. Each estate is read
// from its own environment's hub, failures stay per estate, and a hanging hub
// times out into an error row rather than a failed turn.
import { describe, expect, test } from "bun:test";
import type { FetchLike } from "./action-tools/pi-coms-client.ts";
import { MAILBOX_MAX_PAGES, MAILBOX_READ_LIMIT } from "./fleet-inbox.ts";
import { runFetchFleetInbox } from "./fleet-inbox-node.ts";

type Call = { url: string; auth: string | undefined };
type Route = (url: URL) => { status?: number; body?: unknown } | "hang" | undefined;

function hubFake(route: Route) {
	const calls: Call[] = [];
	const fetchImpl: FetchLike = (input, init) => {
		const headers = init?.headers as Record<string, string> | undefined;
		calls.push({ url: input, auth: headers?.authorization });
		const reply = route(new URL(input));
		if (reply === "hang") return new Promise<Response>(() => undefined);
		const r = reply ?? { status: 404, body: { error: "not_found" } };
		return Promise.resolve(
			new Response(JSON.stringify(r.body ?? {}), {
				status: r.status ?? 200,
				headers: { "content-type": "application/json" },
			}),
		);
	};
	return { calls, fetchImpl };
}

const REPORT =
	"[warn] aws-111122223333: 1 finding(s)\n\n- (warn/alarm) checkout-alb-5xx: Alarm checkout-alb-5xx entered ALARM";

const env: NodeJS.ProcessEnv = {
	PI_COMS_INBOX_ENABLED: "true",
	PI_COMS_INBOX_TIMEOUT_MS: "50",
	// SIO-1666: hubs are keyed by selector and claim their estates explicitly;
	// "eu-x-stg" is deliberately claimed by NO hub, which is what the
	// no-hub-for-this-estate case below asserts.
	PI_COMS_HUBS: JSON.stringify({
		"eu-shared-services-dev": {
			serverUrl: "http://dev.hub.test",
			authToken: "dev-tok",
			environment: "dev",
			estates: ["eu-b2b-dev"],
		},
		"eu-shared-services-prd": {
			serverUrl: "http://prd.hub.test",
			authToken: "prd-tok",
			environment: "prd",
			estates: ["eu-oit-prd"],
		},
	}),
	AWS_ESTATES: JSON.stringify({
		"eu-oit-prd": { assumedRoleArn: "arn:aws:iam::111122223333:role/DevOpsAgentReadOnly", externalId: "x" },
		"eu-b2b-dev": { assumedRoleArn: "arn:aws:iam::444455556666:role/DevOpsAgentReadOnly", externalId: "x" },
	}),
};

const now = () => Date.parse("2026-09-06T12:00:00.000Z");

function row(over: Record<string, unknown>) {
	return {
		msg_id: "01J",
		sender_name: "kim",
		target_name: "eu-oit-prd",
		prompt: "text",
		status: "complete",
		error: null,
		response: "reply",
		created_at: "2026-09-06T11:00:00.000Z",
		delivered_at: null,
		completed_at: "2026-09-06T11:01:00.000Z",
		...over,
	};
}

const state = {
	awsTargetEstates: ["eu-oit-prd", "eu-b2b-dev"],
	dataSourceResults: [],
	investigationFocus: undefined,
	normalizedIncident: { timeWindow: { from: "2026-09-06T00:00:00.000Z", to: "2026-09-06T12:00:00.000Z" } },
};

describe("runFetchFleetInbox", () => {
	// SIO-1655: the capability defaults ON, so "disabled" is now an explicit
	// "false"/"0" rather than an unset/empty value. The two no-op paths are
	// unchanged: explicitly disabled, or enabled with no hub configured.
	test("is a pure no-op when disabled or unconfigured, without any network call", async () => {
		const { calls, fetchImpl } = hubFake(() => undefined);
		expect(
			await runFetchFleetInbox(state, { env: { ...env, PI_COMS_INBOX_ENABLED: "false" }, fetchImpl, now }),
		).toEqual({});
		expect(await runFetchFleetInbox(state, { env: { ...env, PI_COMS_INBOX_ENABLED: "0" }, fetchImpl, now })).toEqual(
			{},
		);
		// Enabled by default but no hub configured: still no network call.
		expect(await runFetchFleetInbox(state, { env: {}, fetchImpl, now })).toEqual({});
		expect(calls).toEqual([]);
	});

	test("clears the slot when no estate was assessed", async () => {
		const { calls, fetchImpl } = hubFake(() => undefined);
		const out = await runFetchFleetInbox({ ...state, awsTargetEstates: [] }, { env, fetchImpl, now });
		expect(out).toEqual({ fleetInboxDigest: undefined });
		expect(calls).toEqual([]);
	});

	test("reads each estate's inbox and its hub's ops inbox from the estate's own hub, attributing ops rows", async () => {
		const { calls, fetchImpl } = hubFake((url) => {
			const name = url.searchParams.get("name");
			if (url.host === "prd.hub.test" && name === "eu-oit-prd")
				return {
					body: {
						ok: true,
						name,
						messages: [
							row({ msg_id: "01K", created_at: "2026-09-06T11:30:00.000Z" }),
							row({ msg_id: "01A", sender_name: "incident-analyzer-abcd1234" }),
						],
					},
				};
			if (url.host === "prd.hub.test" && name === "ops")
				return {
					body: {
						ok: true,
						name,
						messages: [
							row({
								msg_id: "01R",
								sender_name: "monitor-aws-111122223333",
								target_name: "ops",
								prompt: REPORT,
								status: "queued",
								response: null,
								completed_at: null,
							}),
							row({
								msg_id: "01X",
								sender_name: "monitor-aws-999999999999",
								target_name: "ops",
								prompt: REPORT.replace("111122223333", "999999999999"),
								status: "queued",
								response: null,
								completed_at: null,
							}),
							row({
								msg_id: "01O",
								sender_name: "kim",
								target_name: "ops",
								prompt: "old",
								created_at: "2026-09-05T00:00:00.000Z",
							}),
						],
					},
				};
			if (url.host === "dev.hub.test") return { body: { ok: true, name, messages: [] } };
			return undefined;
		});
		const out = await runFetchFleetInbox(state, { env, fetchImpl, now });
		const digest = out.fleetInboxDigest;
		expect(digest?.windowFrom).toBe("2026-09-06T00:00:00.000Z");
		expect(digest?.estates.map((e) => [e.estate, e.environment, e.inboxes])).toEqual([
			["eu-b2b-dev", "dev", ["eu-b2b-dev", "ops"]],
			["eu-oit-prd", "prd", ["eu-oit-prd", "ops"]],
		]);
		const prd = digest?.estates[1];
		// 01K is a completed conversation on the estate inbox: read, then dropped.
		expect(prd?.entries.map((e) => [e.msgId, e.inbox, e.kind])).toEqual([["01R", "ops", "monitor-report"]]);
		expect(prd?.alarmNames).toEqual(["checkout-alb-5xx"]);
		expect(prd?.error).toBeNull();
		expect(digest?.estates[0]?.counts.total).toBe(0);
		const prdCalls = calls.filter((c) => c.url.startsWith("http://prd.hub.test/"));
		expect(prdCalls.every((c) => c.auth === "Bearer prd-tok")).toBe(true);
		expect(prdCalls.map((c) => new URL(c.url).searchParams.get("name")).sort()).toEqual(["eu-oit-prd", "ops"]);
		expect(
			calls.filter((c) => c.url.startsWith("http://dev.hub.test/")).every((c) => c.auth === "Bearer dev-tok"),
		).toBe(true);
		expect(calls.every((c) => c.url.includes("limit=100"))).toBe(true);
	});

	test("a failing or hanging hub degrades to an error row for its estates only", async () => {
		const { fetchImpl } = hubFake((url) => {
			if (url.host === "dev.hub.test") return "hang";
			if (url.host === "prd.hub.test" && url.searchParams.get("name") === "ops")
				return { status: 500, body: { error: "boom" } };
			if (url.host === "prd.hub.test")
				// A report is only monitor traffic when a monitor sent it (Greptile, PR #854):
				// the default `kim` here is a human, whose quoted header must not be counted.
				return {
					body: {
						ok: true,
						name: "eu-oit-prd",
						messages: [row({ prompt: REPORT, sender_name: "monitor-eu-oit-prd" })],
					},
				};
			return undefined;
		});
		const out = await runFetchFleetInbox(state, { env, fetchImpl, now });
		const [dev, prd] = out.fleetInboxDigest?.estates ?? [];
		expect(dev?.error).toContain("timed out");
		expect(dev?.counts.total).toBe(0);
		expect(prd?.counts.total).toBe(1);
		expect(prd?.error).toContain("500");
	});

	test("an estate without a hub for its environment is an error row, and the others still read", async () => {
		const { calls, fetchImpl } = hubFake(() => ({ body: { ok: true, name: "x", messages: [] } }));
		const out = await runFetchFleetInbox(
			{ ...state, awsTargetEstates: ["eu-oit-prd", "eu-x-stg"] },
			{ env, fetchImpl, now },
		);
		const stg = out.fleetInboxDigest?.estates.find((e) => e.estate === "eu-x-stg");
		// SIO-1666: refused because no hub claims it, not because its environment is unconfigured.
		expect(stg?.error).toContain("not listed on any pi-coms hub");
		expect(stg?.environment).toBe("stg");
		expect(calls.every((c) => c.url.startsWith("http://prd.hub.test/"))).toBe(true);
	});
});

// SIO-1828: before this, the read was one newest-first page of MAILBOX_READ_LIMIT rows.
// An incident whose window sat behind those rows read as an empty inbox -- the digest
// said "0 monitor message(s)" for an account the monitor had reported on all along.
// The fake below is the hub's real forward-paging contract: `since` is an exclusive
// ULID cursor, rows come back ascending, and a page is capped at MAILBOX_READ_LIMIT.
describe("SIO-1828 window paging", () => {
	// Ascending msg_ids across a mailbox deeper than one page. The window below
	// covers the EARLY rows, which is exactly what a newest-first read cannot see.
	function deepMailbox(total: number) {
		return Array.from({ length: total }, (_, i) => {
			const minute = String(i % 60).padStart(2, "0");
			const hour = String(2 + Math.floor(i / 60)).padStart(2, "0");
			return row({
				// A real hub ULID: 10 timestamp chars then 16 of randomness. Ascending
				// here because the suffix ascends, which is all the cursor compares.
				msg_id: `01M2XW5F2X${String(i).padStart(16, "0")}`,
				sender_name: "monitor-aws-111122223333",
				prompt: REPORT,
				created_at: `2026-09-06T${hour}:${minute}:00.000Z`,
			});
		});
	}

	function pagingHub(rowsByInbox: Record<string, ReturnType<typeof row>[]>) {
		return hubFake((url) => {
			const name = url.searchParams.get("name") ?? "";
			const since = url.searchParams.get("since");
			const limit = Number(url.searchParams.get("limit") ?? "100");
			const all = rowsByInbox[name] ?? [];
			// The hub's two modes: forward from an exclusive cursor, else newest-first.
			const messages = since ? all.filter((m) => m.msg_id > since).slice(0, limit) : all.slice(-limit).reverse();
			return { body: { ok: true, name, messages } };
		});
	}

	test("finds the window's messages when they sit behind more than one page of newer rows", async () => {
		const { calls, fetchImpl } = pagingHub({ ops: deepMailbox(250), "eu-oit-prd": [] });
		const out = await runFetchFleetInbox(
			{ ...state, awsTargetEstates: ["eu-oit-prd"] },
			{ env: { ...env, PI_COMS_INBOX_TIMEOUT_MS: "5000" }, fetchImpl, now },
		);

		const prd = out.fleetInboxDigest?.estates.find((e) => e.estate === "eu-oit-prd");
		// All 250 rows fall inside the 00:00-12:00 window, and every one is attributable
		// to this estate. A single newest-first page would have capped this at 100.
		expect(prd?.counts.total).toBe(250);
		expect(prd?.counts.incidentReports).toBe(250);
		// The read walked forward from a floor cursor rather than asking for the newest.
		const opsCalls = calls.filter((c) => c.url.includes("name=ops"));
		expect(opsCalls.length).toBe(3);
		expect(opsCalls.every((c) => c.url.includes("since="))).toBe(true);
		// A full read is not a partial one.
		expect(prd?.error).toBeNull();
	});

	test("the page cap truncates rather than hangs, and the digest says the read was capped", async () => {
		// 5 pages x 100 = the cap, with rows still unread beyond it.
		const { fetchImpl } = pagingHub({ ops: deepMailbox(700), "eu-oit-prd": [] });
		const out = await runFetchFleetInbox(
			{ ...state, awsTargetEstates: ["eu-oit-prd"] },
			{ env: { ...env, PI_COMS_INBOX_TIMEOUT_MS: "5000" }, fetchImpl, now },
		);

		const prd = out.fleetInboxDigest?.estates.find((e) => e.estate === "eu-oit-prd");
		expect(prd?.counts.total).toBe(MAILBOX_MAX_PAGES * MAILBOX_READ_LIMIT);
		// The honesty rule: a short read is stated, never silent.
		expect(prd?.error).toContain("read capped before the end of the window");
	});

	// Greptile P1, PR #858: a page that times out mid-walk used to reject out of the
	// loop, so the catch discarded every page already fetched and the estate reported a
	// failed read with zero messages -- strictly worse than the bug this ticket fixes,
	// because the rows were already in hand.
	test("a page that times out keeps the pages already read and marks the walk capped", async () => {
		let call = 0;
		const rows = deepMailbox(250);
		const { fetchImpl } = hubFake((url) => {
			if (!url.searchParams.get("name")?.includes("ops")) return { body: { ok: true, name: "x", messages: [] } };
			call++;
			// Two full pages, then a hang that burns the rest of the budget.
			if (call >= 3) return "hang";
			return { body: { ok: true, name: "ops", messages: rows.slice((call - 1) * 100, call * 100) } };
		});
		const out = await runFetchFleetInbox(
			{ ...state, awsTargetEstates: ["eu-oit-prd"] },
			{ env: { ...env, PI_COMS_INBOX_TIMEOUT_MS: "150" }, fetchImpl, now },
		);

		const prd = out.fleetInboxDigest?.estates.find((e) => e.estate === "eu-oit-prd");
		// The 200 rows already fetched survive the timeout.
		expect(prd?.counts.total).toBe(200);
		expect(prd?.error).toContain("read capped before the end of the window");
	});

	// Greptile round 2, PR #858: a later-page failure keeps the earlier pages AND names
	// what stopped the walk. Flattening a 500 into a bare "read capped" made a real
	// service failure read as a benign limit.
	test("a later-page failure names its cause in the partial note", async () => {
		let call = 0;
		const rows = deepMailbox(250);
		const { fetchImpl } = hubFake((url) => {
			if (!url.searchParams.get("name")?.includes("ops")) return { body: { ok: true, name: "x", messages: [] } };
			call++;
			if (call >= 3) return { status: 500, body: { error: "upstream_unavailable" } };
			return { body: { ok: true, name: "ops", messages: rows.slice((call - 1) * 100, call * 100) } };
		});
		const out = await runFetchFleetInbox(
			{ ...state, awsTargetEstates: ["eu-oit-prd"] },
			{ env: { ...env, PI_COMS_INBOX_TIMEOUT_MS: "5000" }, fetchImpl, now },
		);

		const prd = out.fleetInboxDigest?.estates.find((e) => e.estate === "eu-oit-prd");
		expect(prd?.counts.total).toBe(200);
		expect(prd?.error).toContain("read capped before the end of the window");
		// The operational cause survives, so a 500 is not mistaken for the page cap.
		expect(prd?.error).toContain("500");
	});

	// Greptile P2, PR #858: `truncated` keyed only off a full fifth page, so post-window
	// traffic on a busy inbox stamped a COMPLETE window as capped (and paged through
	// rows that could not match the window anyway).
	test("a window fully covered before the page cap is not reported as capped", async () => {
		// 700 rows, but the window ends at 12:00 and rows run well past it.
		const { calls, fetchImpl } = pagingHub({ ops: deepMailbox(700), "eu-oit-prd": [] });
		const out = await runFetchFleetInbox(
			{
				...state,
				awsTargetEstates: ["eu-oit-prd"],
				normalizedIncident: { timeWindow: { from: "2026-09-06T00:00:00.000Z", to: "2026-09-06T03:00:00.000Z" } },
			},
			{ env: { ...env, PI_COMS_INBOX_TIMEOUT_MS: "5000" }, fetchImpl, now },
		);

		const prd = out.fleetInboxDigest?.estates.find((e) => e.estate === "eu-oit-prd");
		// The walk stopped once a page's newest row passed 03:00, so no false warning...
		expect(prd?.error).toBeNull();
		// ...and it did not burn all five pages getting there.
		expect(calls.filter((c) => c.url.includes("name=ops")).length).toBeLessThan(MAILBOX_MAX_PAGES);
	});

	test("a window the hub's cursor cannot express falls back to the newest-first read", async () => {
		const { calls, fetchImpl } = pagingHub({ ops: deepMailbox(250), "eu-oit-prd": [] });
		const out = await runFetchFleetInbox(
			{
				...state,
				awsTargetEstates: ["eu-oit-prd"],
				normalizedIncident: { timeWindow: { from: "not-a-date", to: "2026-09-06T12:00:00.000Z" } },
			},
			{ env, fetchImpl, now },
		);

		const opsCalls = calls.filter((c) => c.url.includes("name=ops"));
		expect(opsCalls.length).toBe(1);
		expect(opsCalls.every((c) => c.url.includes("since="))).toBe(false);
		// The read itself succeeded: no error row, and the digest still reports the
		// window it was given. (An unparseable window then keeps no rows downstream --
		// withinWindow rejects every timestamp against NaN -- which is unchanged here.)
		expect(out.fleetInboxDigest?.estates[0]?.error).toBeNull();
		expect(out.fleetInboxDigest?.windowFrom).toBe("not-a-date");
	});
});
