// apps/web/src/lib/server/pi-fleet.test.ts
// SIO-1650: the pane's hub access, tested at the network boundary with a scripted
// fetch. The real PiComsClient runs; only the hub is faked. This file does not
// mock @devops-agent/agent (the package test script runs with --isolate).
import { describe, expect, test } from "bun:test";
import { type FetchLike, PiComsHttpError } from "@devops-agent/agent";
import {
	anchorOnDigest,
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
		// SIO-1666: two hubs may share an environment, so the listing needs a
		// second prd row to prove per-hub isolation after SIO-1696 drops dev.
		"eu-ediservices-prd": {
			serverUrl: "http://prd2.hub.test",
			authToken: "prd2-tok",
			environment: "prd",
			// SIO-1703: a spoke is named for the estate it serves, so the fixture's
			// peers must appear here or the pane correctly refuses to list them.
			estates: ["alpha-prd", "zeta-prd"],
		},
	}),
	PI_COMS_PANE_TOKENS: JSON.stringify({ "eu-shared-services-prd": "pane-prd-tok" }),
};

// SIO-1703: the hub lists an operator console too (`just coms <hub> <name>`,
// registered --explicit). It is not an account agent and must not be offered as
// a target; the hub's `estates` config is what says which names are spokes.
const prdAgents = [
	{ session_id: "s2", name: "zeta-prd", status: "stale", purpose: "spoke" },
	{ session_id: "s1", name: "alpha-prd", status: "online" },
	// SIO-1665: the hub lists the monitor pair too (include_explicit); the pane
	// must not offer it as a spoke.
	{ session_id: "s3", name: "monitor-alpha-prd", status: "online", purpose: "Deterministic AWS monitor" },
];

const devAgents = [{ session_id: "s4", name: "alpha-dev", status: "online" }];

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
			["prd", "prd2-tok"],
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

	test("lists every prd hub with its own token, sorts peers, drops monitors, and isolates a failing hub", async () => {
		const { calls, fetchImpl } = hubFake((call) => {
			if (call.url.startsWith("http://prd2.hub.test/v1/agents")) return { body: { agents: prdAgents } };
			if (call.url.startsWith("http://prd.hub.test/v1/agents")) return { status: 500, body: { error: "boom" } };
			return undefined;
		});
		const out = await listFleetAgents({ env, fetchImpl });
		expect(out.configured).toBe(true);
		expect(out.awaitMs).toBe(25_000);
		expect(out.hubs.map((h) => h.hubKey)).toEqual(["eu-shared-services-prd", "eu-ediservices-prd"]);
		expect(out.hubs[1]).toMatchObject({
			project: "default",
			fallbackTarget: "ops",
			error: null,
			peers: [
				{ name: "alpha-prd", status: "online", purpose: null, sessionId: "s1" },
				{ name: "zeta-prd", status: "stale", purpose: "spoke", sessionId: "s2" },
			],
		});
		expect(out.hubs[1]?.peers).toHaveLength(2);
		expect(out.hubs[1]?.peers.map((p) => p.name)).not.toContain("monitor-alpha-prd");
		expect(out.hubs[0]).toMatchObject({ fallbackTarget: "ops-prd", peers: [] });
		expect(out.hubs[0]?.error).toContain("500");
		expect(calls.map((c) => [c.path, c.auth])).toEqual([
			["/v1/agents?project=default&include_explicit=true", "Bearer pane-prd-tok"],
			["/v1/agents?project=default&include_explicit=true", "Bearer prd2-tok"],
		]);
	});

	// SIO-1701: a down SSM tunnel surfaced as a bare "fetch failed" -- the
	// browser's own TypeError text, naming neither the hub nor the cause. These
	// hubs sit behind a localhost port a tunnel forwards, so that is the fix to
	// name, following the SIO-1661 precedent of adding the command that helps.
	test("explains an unreachable localhost hub as a down tunnel, with the command", async () => {
		const fetchImpl: FetchLike = async () => {
			// How undici surfaces a refused connection: bare message, real reason in `cause`.
			const err = new Error("fetch failed");
			(err as Error & { cause?: unknown }).cause = new Error("connect ECONNREFUSED 127.0.0.1:8788");
			throw err;
		};
		// The shared `env` fixture points at http://prd.hub.test; a tunnelled hub is
		// a localhost port, which is what production uses and what the advice keys on.
		const tunnelledEnv: NodeJS.ProcessEnv = {
			PI_COMS_HUBS: JSON.stringify({
				"eu-shared-services-prd": {
					serverUrl: "http://127.0.0.1:8788",
					authToken: "t",
					environment: "prd",
					estates: ["eu-oit-prd"],
				},
			}),
		};
		const out = await listFleetAgents({ env: tunnelledEnv, fetchImpl });
		const hub = out.hubs.find((h) => h.hubKey === "eu-shared-services-prd");
		expect(hub?.error).toContain("cannot reach hub");
		expect(hub?.error).toContain("eu-shared-services-prd");
		expect(hub?.error).toContain("ECONNREFUSED");
		expect(hub?.error).toContain("just hub-tunnel eu-shared-services-prd");
		// The bare browser text must not be what the operator reads.
		expect(hub?.error).not.toBe("fetch failed");
	});

	test("does not advise a tunnel for a hub reached over a remote URL", async () => {
		// The advice would be wrong: nothing is tunnelled to a remote host.
		const remoteEnv: NodeJS.ProcessEnv = {
			PI_COMS_HUBS: JSON.stringify({
				"remote-prd": {
					serverUrl: "https://hub.example.internal",
					authToken: "t",
					environment: "prd",
					estates: ["eu-oit-prd"],
				},
			}),
		};
		const fetchImpl: FetchLike = async () => {
			throw new Error("fetch failed");
		};
		const out = await listFleetAgents({ env: remoteEnv, fetchImpl });
		expect(out.hubs[0]?.error).toContain("cannot reach hub");
		expect(out.hubs[0]?.error).toContain("hub.example.internal");
		expect(out.hubs[0]?.error).not.toContain("hub-tunnel");
	});

	test("leaves a real hub error untouched", async () => {
		// A 500 from the hub is not a reachability problem; SIO-1661 already
		// frames those, and re-framing here would bury the upstream status.
		const { fetchImpl } = hubFake(() => ({ status: 500, body: { error: "boom" } }));
		const out = await listFleetAgents({ env, fetchImpl });
		expect(out.hubs[0]?.error).toContain("500");
		expect(out.hubs[0]?.error).not.toContain("hub-tunnel");
	});

	test("lists only the hub's configured estates, dropping an operator console", async () => {
		const { fetchImpl } = hubFake((call) => {
			if (call.url.startsWith("http://prd.hub.test/v1/agents")) {
				return {
					body: {
						agents: [
							{ session_id: "s1", name: "eu-oit-prd", status: "online" },
							// An operator console: explicit, no purpose, not an estate.
							{ session_id: "s2", name: "simon", status: "online", explicit: true },
							// A spoke on a DIFFERENT hub: not in this hub's estates list.
							{ session_id: "s3", name: "eu-b2b-ecom-prd", status: "online" },
						],
					},
				};
			}
			return { body: { agents: [] } };
		});
		const out = await listFleetAgents({ env, fetchImpl });
		const hub = out.hubs.find((h) => h.hubKey === "eu-shared-services-prd");
		expect(hub?.peers.map((p) => p.name)).toEqual(["eu-oit-prd"]);
		expect(hub?.peers.map((p) => p.name)).not.toContain("simon");
	});

	// SIO-1696: the pane is production incident triage. A dev hub is never listed
	// and is never even contacted -- but resolvePaneConfig still carries it, so
	// the send and mailbox paths (and the hub CLI) still reach dev spokes.
	test("omits non-prd hubs from the listing without contacting them", async () => {
		const { calls, fetchImpl } = hubFake((call) => {
			if (call.url.startsWith("http://dev.hub.test/v1/agents")) return { body: { agents: devAgents } };
			return { body: { agents: [] } };
		});
		const out = await listFleetAgents({ env, fetchImpl });
		expect(out.hubs.map((h) => h.environment)).toEqual(["prd", "prd"]);
		expect(out.hubs.map((h) => h.hubKey)).not.toContain("eu-shared-services-dev");
		expect(calls.map((c) => c.auth)).not.toContain("Bearer dev-tok");
		expect(resolvePaneConfig(env)?.hubs.map((h) => h.hubKey)).toContain("eu-shared-services-dev");
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
			missingDigest: [],
			windowTruncated: false,
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

// SIO-1705: the ops inbox shows, per estate, that estate's newest daily digest
// and everything after it. Per-estate rather than one fleet-wide cutoff: the six
// monitors write their digests seconds apart, so a shared cutoff would drop the
// earlier accounts' digests from view.
describe("anchorOnDigest", () => {
	const row = (senderName: string, prompt: string) => ({ senderName, prompt });
	// Hub order is oldest-first.
	const DIGEST_A = row("monitor-eu-oit-prd", "[info] aws-762715229080 daily digest (since ...)");
	const DIGEST_B = row("monitor-eu-mendix-platform-prd", "[warn] aws-654654584630 daily digest DEGRADED");

	test("returns each estate's newest digest and everything after it", () => {
		const messages = [
			row("monitor-eu-oit-prd", "[warn] yesterday, before the digest"),
			DIGEST_A,
			row("monitor-eu-oit-prd", "[warn] after the digest"),
			row("monitor-eu-oit-prd", "[critical] also after"),
		];
		const { messages: out, missingDigest } = anchorOnDigest(messages, ["eu-oit-prd"]);
		expect(out.map((m) => m.prompt)).toEqual([DIGEST_A.prompt, "[warn] after the digest", "[critical] also after"]);
		expect(missingDigest).toEqual([]);
	});

	test("anchors per estate, so an earlier estate keeps its own digest", () => {
		// The fleet-wide alternative would cut at DIGEST_B and lose DIGEST_A entirely.
		const messages = [DIGEST_A, row("monitor-eu-oit-prd", "oit follow-up"), DIGEST_B];
		const { messages: out } = anchorOnDigest(messages, ["eu-oit-prd", "eu-mendix-platform-prd"]);
		expect(out).toContain(DIGEST_A);
		expect(out).toContain(DIGEST_B);
		expect(out.map((m) => m.prompt)).toContain("oit follow-up");
	});

	test("uses the NEWEST digest when a window spans two days", () => {
		const older = row("monitor-eu-oit-prd", "[info] aws-762715229080 daily digest (since day1)");
		const newer = row("monitor-eu-oit-prd", "[info] aws-762715229080 daily digest (since day2)");
		const { messages: out } = anchorOnDigest(
			[older, row("monitor-eu-oit-prd", "mid-day-1"), newer, row("monitor-eu-oit-prd", "mid-day-2")],
			["eu-oit-prd"],
		);
		expect(out.map((m) => m.prompt)).toEqual([newer.prompt, "mid-day-2"]);
	});

	test("drops estates outside the scope", () => {
		const { messages: out } = anchorOnDigest([DIGEST_A, DIGEST_B], ["eu-oit-prd"]);
		expect(out).toEqual([DIGEST_A]);
	});

	// A monitor that missed its digest must not make its estate look empty: the
	// findings are live, and hiding them behind a missing anchor is the worse error.
	test("keeps every row for an estate with no digest, and names it", () => {
		const messages = [row("monitor-eu-oit-prd", "[critical] alarm, no digest today"), DIGEST_B];
		const { messages: out, missingDigest } = anchorOnDigest(messages, ["eu-oit-prd", "eu-mendix-platform-prd"]);
		expect(out.map((m) => m.prompt)).toContain("[critical] alarm, no digest today");
		expect(missingDigest).toEqual(["eu-oit-prd"]);
	});

	// SIO-1704's rule survives: a sender with no estate has no digest to anchor on.
	test("keeps a sender that is not estate-shaped", () => {
		const note = row("simon", "handover note");
		const { messages: out, missingDigest } = anchorOnDigest([note, DIGEST_A], ["eu-oit-prd"]);
		expect(out).toContain(note);
		expect(missingDigest).toEqual([]);
	});

	// SIO-1704: no estate selected means no account is in scope. An empty scope
	// must not fall back to "everything" -- that is the inversion SIO-1704 fixed.
	test("an empty scope returns no estate rows, but keeps non-estate senders", () => {
		const note = row("simon", "handover note");
		const { messages: out } = anchorOnDigest([note, DIGEST_A, DIGEST_B], []);
		expect(out).toEqual([note]);
	});
});
