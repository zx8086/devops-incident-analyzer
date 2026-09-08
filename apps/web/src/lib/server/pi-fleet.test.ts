// apps/web/src/lib/server/pi-fleet.test.ts
// SIO-1650: the pane's hub access, tested at the network boundary with a scripted
// fetch. The real PiComsClient runs; only the hub is faked. This file does not
// mock @devops-agent/agent (the package test script runs with --isolate).
import { describe, expect, test } from "bun:test";
import { type FetchLike, PiComsHttpError } from "@devops-agent/agent";
import {
	awaitFleetMessage,
	listFleetAgents,
	PiFleetRequestError,
	readFleetMailbox,
	resolvePaneConfig,
	sendFleetMessage,
} from "./pi-fleet.ts";
import { piFleetErrorResponse } from "./pi-fleet-http.ts";

type Call = { method: string; url: string; path: string; auth: string | undefined; body: unknown };
type Route = (call: Call) => { status?: number; body?: unknown } | undefined;

function hubFake(route: Route) {
	const calls: Call[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const headers = init?.headers as Record<string, string> | undefined;
		const url = new URL(input);
		const call: Call = {
			method: init?.method ?? "GET",
			url: input,
			path: url.pathname + url.search,
			auth: headers?.authorization,
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		};
		calls.push(call);
		const reply = route(call) ?? { status: 404, body: { error: "not_found" } };
		return new Response(JSON.stringify(reply.body ?? {}), {
			status: reply.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { calls, fetchImpl };
}

const env: NodeJS.ProcessEnv = {
	PI_COMS_HUBS: JSON.stringify({
		// SIO-1666: keyed by selector; each hub declares its environment + estates.
		"eu-shared-services-dev": {
			serverUrl: "http://dev.hub.test",
			authToken: "dev-tok",
			environment: "dev",
			estates: ["eu-oit-dev"],
		},
		"eu-shared-services-prd": {
			serverUrl: "http://prd.hub.test",
			authToken: "prd-tok",
			fallbackTarget: "ops-prd",
			environment: "prd",
			estates: ["eu-oit-prd"],
		},
	}),
	PI_COMS_PANE_TOKENS: JSON.stringify({ "eu-shared-services-prd": "pane-prd-tok" }),
};

const devAgents = [
	{ session_id: "s2", name: "zeta-dev", status: "stale", purpose: "spoke" },
	{ session_id: "s1", name: "alpha-dev", status: "online" },
	// SIO-1665: the hub lists the monitor pair too (include_explicit); the pane
	// must not offer it as a spoke.
	{ session_id: "s3", name: "monitor-alpha-dev", status: "online", purpose: "Deterministic AWS monitor" },
];

describe("resolvePaneConfig", () => {
	test("is undefined without any hub configuration", () => {
		expect(resolvePaneConfig({})).toBeUndefined();
	});

	test("substitutes the pane token per hub and applies the defaults", () => {
		const pane = resolvePaneConfig(env);
		expect(pane?.senderPrefix).toBe("pi-fleet");
		expect(pane?.awaitMs).toBe(25_000);
		expect(pane?.totalBudgetMs).toBe(300_000);
		expect(pane?.hubs.map((h) => [h.environment, h.hub.authToken])).toEqual([
			["dev", "dev-tok"],
			["prd", "pane-prd-tok"],
		]);
	});

	test("reads the prefix and budgets from the environment and caps the slice", () => {
		const pane = resolvePaneConfig({
			...env,
			PI_COMS_PANE_SENDER_PREFIX: "incident-analyzer",
			PI_COMS_PANE_AWAIT_MS: "90000",
			PI_COMS_PANE_TIMEOUT_MS: "120000",
		});
		expect(pane?.senderPrefix).toBe("incident-analyzer");
		expect(pane?.awaitMs).toBe(60_000);
		expect(pane?.totalBudgetMs).toBe(120_000);
	});

	test("a malformed PI_COMS_PANE_TOKENS or budget is a readable error", () => {
		expect(() => resolvePaneConfig({ ...env, PI_COMS_PANE_TOKENS: "{oops" })).toThrow("PI_COMS_PANE_TOKENS");
		// SIO-1666: tokens are keyed by HUB, so any key parses; a token for an
		// unknown hub is simply never read. Only malformed JSON / a non-string is an error.
		expect(() => resolvePaneConfig({ ...env, PI_COMS_PANE_TOKENS: '{"qa":123}' })).toThrow("PI_COMS_PANE_TOKENS");
		expect(() => resolvePaneConfig({ ...env, PI_COMS_PANE_AWAIT_MS: "soon" })).toThrow("PI_COMS_PANE_AWAIT_MS");
	});
});

describe("listFleetAgents", () => {
	test("reports unconfigured without touching the network", async () => {
		const { calls, fetchImpl } = hubFake(() => undefined);
		const out = await listFleetAgents({ env: {}, fetchImpl });
		expect(out).toMatchObject({ configured: false, hubs: [] });
		expect(calls).toEqual([]);
	});

	test("lists every hub with its own token, sorts peers, drops monitors, and isolates a failing hub", async () => {
		const { calls, fetchImpl } = hubFake((call) => {
			if (call.url.startsWith("http://dev.hub.test/v1/agents")) return { body: { agents: devAgents } };
			if (call.url.startsWith("http://prd.hub.test/v1/agents")) return { status: 500, body: { error: "boom" } };
			return undefined;
		});
		const out = await listFleetAgents({ env, fetchImpl });
		expect(out.configured).toBe(true);
		expect(out.awaitMs).toBe(25_000);
		expect(out.hubs.map((h) => h.environment)).toEqual(["dev", "prd"]);
		expect(out.hubs[0]).toMatchObject({
			project: "default",
			fallbackTarget: "ops",
			error: null,
			peers: [
				{ name: "alpha-dev", status: "online", purpose: null, sessionId: "s1" },
				{ name: "zeta-dev", status: "stale", purpose: "spoke", sessionId: "s2" },
			],
		});
		expect(out.hubs[0]?.peers).toHaveLength(2);
		expect(out.hubs[0]?.peers.map((p) => p.name)).not.toContain("monitor-alpha-dev");
		expect(out.hubs[1]).toMatchObject({ fallbackTarget: "ops-prd", peers: [] });
		expect(out.hubs[1]?.error).toContain("500");
		expect(calls.map((c) => [c.path, c.auth])).toEqual([
			["/v1/agents?project=default&include_explicit=true", "Bearer dev-tok"],
			["/v1/agents?project=default&include_explicit=true", "Bearer pane-prd-tok"],
		]);
	});
});

describe("sendFleetMessage", () => {
	test("registers with the pi-fleet prefix on the target's hub only, sends, awaits one slice, deregisters", async () => {
		const verdict = { summary: "checkout ALB healthy", claims: [] };
		const { calls, fetchImpl } = hubFake((call) => {
			if (call.path === "/v1/agents/register") return { body: { ok: true } };
			if (call.path === "/v1/messages") return { body: { msg_id: "m1", status: "delivered", target_session: "s9" } };
			if (call.path.startsWith("/v1/messages/m1/await"))
				return { body: { msg_id: "m1", status: "complete", response: verdict, error: null } };
			if (call.method === "DELETE") return { body: { ok: true } };
			return undefined;
		});
		const out = await sendFleetMessage(
			{ hubKey: "eu-shared-services-prd", target: "eu-oit-prd", prompt: "Is the ALB healthy?" },
			{ env, fetchImpl, now: () => 1_000 },
		);
		expect(out).toMatchObject({
			hubKey: "eu-shared-services-prd",
			target: "eu-oit-prd",
			msgId: "m1",
			status: "complete",
			response: verdict,
			error: null,
		});
		expect(out.sender).toMatch(/^pi-fleet-[0-9a-f]{8}$/);
		expect(out.sentAt).toBe("1970-01-01T00:00:01.000Z");
		expect(calls.every((c) => c.url.startsWith("http://prd.hub.test/") && c.auth === "Bearer pane-prd-tok")).toBe(true);
		const registration = calls[0]?.body as { session_id: string; name: string; explicit: boolean };
		expect(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([
			"POST /v1/agents/register",
			"POST /v1/messages",
			"GET /v1/messages/m1/await",
			`DELETE /v1/agents/${registration.session_id}`,
		]);
		expect(registration).toMatchObject({ name: out.sender, explicit: true });
		expect(calls[1]?.body as { target: string; prompt: string; response_schema: unknown }).toMatchObject({
			target: "eu-oit-prd",
			prompt: "Is the ALB healthy?",
			response_schema: null,
		});
	});

	// SIO-1661: the misconfiguration that cost a session of curl probing against a
	// live hub. The prefix has no principal, so register is refused -- while
	// listing keeps working (it needs only the bearer token), which is exactly what
	// made it read as a spoke problem. The error must name the sender and the fix.
	test("a refused registration names the rejected sender, the hub and the remedy, and stays a 502", async () => {
		const { calls, fetchImpl } = hubFake((call) => {
			if (call.path === "/v1/agents/register") {
				const name = (call.body as { name: string }).name;
				return {
					status: 403,
					body: { ok: false, error: "name_not_allowed", details: { name, principal: "incident-analyzer" } },
				};
			}
			return undefined;
		});

		const err = await sendFleetMessage(
			{ hubKey: "eu-shared-services-prd", target: "eu-oit-prd", prompt: "Is the ALB healthy?" },
			{ env, fetchImpl, now: () => 1_000 },
		).then(
			() => undefined,
			(e: unknown) => e,
		);

		// Still a PiComsHttpError, so piFleetErrorResponse answers 502 and not 500.
		expect(err).toBeInstanceOf(PiComsHttpError);
		const { message, status, code } = err as InstanceType<typeof PiComsHttpError>;
		expect(status).toBe(403);
		expect(code).toBe("name_not_allowed");
		expect(piFleetErrorResponse(err).status).toBe(502);

		// The first line keeps the original format; the detail is added below it.
		expect(message.split("\n")[0]).toBe("pi-coms hub POST /v1/agents/register failed: 403 name_not_allowed");
		const sender = (calls[0]?.body as { name: string } | undefined)?.name;
		expect(sender).toMatch(/^pi-fleet-[0-9a-f]{8}$/);
		expect(message).toContain(`sender "${sender}"`);
		expect(message).toContain('principal "incident-analyzer"');
		expect(message).toContain('on hub "eu-shared-services-prd"');
		expect(message).toContain("PI_COMS_PANE_SENDER_PREFIX=pi-fleet");
		expect(message).toContain('just token-create pi-fleet "pi-fleet-*" service');

		// Nothing was sent, and no token leaked into the message.
		expect(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual(["POST /v1/agents/register"]);
		expect(message).not.toContain("pane-prd-tok");
	});

	test("a spoke that does not answer within the slice yields budget_exhausted, not a hung request", async () => {
		let clock = 0;
		const { calls, fetchImpl } = hubFake((call) => {
			if (call.path === "/v1/agents/register") return { body: { ok: true } };
			if (call.path === "/v1/messages") return { body: { msg_id: "m2", status: "delivered", target_session: "s9" } };
			if (call.path.startsWith("/v1/messages/m2/await")) {
				clock += 25_000;
				return { body: { msg_id: "m2", status: "timeout", response: null, error: null } };
			}
			if (call.path === "/v1/messages/m2")
				return { body: { msg_id: "m2", status: "delivered", response: null, error: null } };
			if (call.path.endsWith("/heartbeat")) return { body: { ok: true } };
			if (call.method === "DELETE") return { body: { ok: true } };
			return undefined;
		});
		const out = await sendFleetMessage(
			{ hubKey: "eu-shared-services-dev", target: "alpha-dev", prompt: "ping" },
			{ env, fetchImpl, now: () => clock },
		);
		expect(out).toMatchObject({ status: "budget_exhausted", response: null, msgId: "m2" });
		expect(out.error).toContain("25000 ms");
		expect(calls.filter((c) => c.path.startsWith("/v1/messages/m2/await")).length).toBe(1);
		expect(calls.at(-1)?.method).toBe("DELETE");
	});

	test("refuses an unknown hub before any network call", async () => {
		const { calls, fetchImpl } = hubFake(() => undefined);
		const err = await sendFleetMessage(
			{ hubKey: "eu-nowhere-prd", target: "x", prompt: "p" },
			{ env, fetchImpl },
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PiFleetRequestError);
		expect((err as PiFleetRequestError).status).toBe(404);
		expect((err as PiFleetRequestError).message).toContain('no pi-coms hub "eu-nowhere-prd"');
		expect(calls).toEqual([]);
	});

	test("refuses when nothing is configured", async () => {
		const err = await sendFleetMessage(
			{ hubKey: "eu-shared-services-dev", target: "x", prompt: "p" },
			{ env: {} },
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(PiFleetRequestError);
		expect((err as PiFleetRequestError).status).toBe(404);
	});
});

describe("awaitFleetMessage", () => {
	test("re-awaits by id without registering and returns the terminal reply", async () => {
		const { calls, fetchImpl } = hubFake((call) => {
			if (call.path.startsWith("/v1/messages/m3/await"))
				return { body: { msg_id: "m3", status: "error", response: null, error: "spoke crashed" } };
			return undefined;
		});
		const out = await awaitFleetMessage(
			{ hubKey: "eu-shared-services-dev", msgId: "m3" },
			{ env, fetchImpl, now: () => 0 },
		);
		expect(out).toEqual({
			hubKey: "eu-shared-services-dev",
			environment: "dev",
			msgId: "m3",
			status: "error",
			response: null,
			error: "spoke crashed",
		});
		expect(calls.map((c) => c.method)).toEqual(["GET"]);
		expect(calls[0]?.url).toBe("http://dev.hub.test/v1/messages/m3/await?timeout_ms=25000");
	});
});

describe("readFleetMailbox", () => {
	test("reads the hub's fallback inbox by default and maps the entries", async () => {
		const entry = {
			msg_id: "01H",
			sender_name: "monitor-aws-1",
			target_name: "ops-prd",
			prompt: "digest",
			status: "queued",
			error: null,
			response: null,
			created_at: "2026-09-06T10:00:00.000Z",
			delivered_at: null,
			completed_at: null,
		};
		const { calls, fetchImpl } = hubFake((call) => {
			if (call.path.startsWith("/v1/mailbox")) return { body: { ok: true, name: "ops-prd", messages: [entry] } };
			return undefined;
		});
		const out = await readFleetMailbox({ hubKey: "eu-shared-services-prd" }, { env, fetchImpl });
		expect(calls[0]?.path).toBe("/v1/mailbox?project=default&name=ops-prd&limit=20");
		expect(out).toEqual({
			hubKey: "eu-shared-services-prd",
			environment: "prd",
			name: "ops-prd",
			messages: [
				{
					msgId: "01H",
					senderName: "monitor-aws-1",
					targetName: "ops-prd",
					prompt: "digest",
					status: "queued",
					error: null,
					response: null,
					createdAt: "2026-09-06T10:00:00.000Z",
					completedAt: null,
				},
			],
		});
	});

	test("honours an explicit name and limit", async () => {
		const { calls, fetchImpl } = hubFake(() => ({ body: { ok: true, name: "eu-oit-dev", messages: [] } }));
		await readFleetMailbox({ hubKey: "eu-shared-services-dev", name: "eu-oit-dev", limit: 5 }, { env, fetchImpl });
		expect(calls[0]?.path).toBe("/v1/mailbox?project=default&name=eu-oit-dev&limit=5");
	});
});
