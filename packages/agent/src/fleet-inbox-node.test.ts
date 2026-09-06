// packages/agent/src/fleet-inbox-node.test.ts
// SIO-1652: the fetchFleetInbox node against a scripted hub. Each estate is read
// from its own environment's hub, failures stay per estate, and a hanging hub
// times out into an error row rather than a failed turn.
import { describe, expect, test } from "bun:test";
import type { FetchLike } from "./action-tools/pi-coms-client.ts";
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
	PI_COMS_HUBS: JSON.stringify({
		dev: { serverUrl: "http://dev.hub.test", authToken: "dev-tok" },
		prd: { serverUrl: "http://prd.hub.test", authToken: "prd-tok" },
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
	test("is a pure no-op when disabled or unconfigured, without any network call", async () => {
		const { calls, fetchImpl } = hubFake(() => undefined);
		expect(await runFetchFleetInbox(state, { env: { ...env, PI_COMS_INBOX_ENABLED: "" }, fetchImpl, now })).toEqual({});
		expect(await runFetchFleetInbox(state, { env: { PI_COMS_INBOX_ENABLED: "true" }, fetchImpl, now })).toEqual({});
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
		expect(prd?.entries.map((e) => [e.msgId, e.inbox, e.kind])).toEqual([
			["01K", "eu-oit-prd", "conversation"],
			["01R", "ops", "monitor-report"],
		]);
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
			if (url.host === "prd.hub.test") return { body: { ok: true, name: "eu-oit-prd", messages: [row({})] } };
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
		expect(stg?.error).toContain('environment "stg"');
		expect(stg?.environment).toBe("stg");
		expect(calls.every((c) => c.url.startsWith("http://prd.hub.test/"))).toBe(true);
	});
});
