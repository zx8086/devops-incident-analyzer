// agent/src/action-tools/pi-verifier.test.ts
// SIO-1635: proposal rules, target routing, prompt shaping and the two execute
// flows, with the hub scripted at the fetch boundary.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PiVerdict } from "@devops-agent/shared";
import type { PiAgentCard } from "./pi-coms-client.ts";
import {
	buildInvestigateFollowUp,
	buildInvestigatePrompt,
	buildVerifyPrompt,
	environmentForEstate,
	estatesFromState,
	executePiInvestigate,
	executePiVerify,
	isPiComsConfigured,
	MAX_VERIFY_CARDS,
	needsInvestigation,
	PI_MAILBOX_TTL_MS,
	proposePiVerification,
	REPORT_CHAR_BUDGET,
	resolvePiComsConfig,
	resolvePiTarget,
	selectHubForEstate,
} from "./pi-verifier.ts";

// Single-hub form: the hub serves prd, where the fixtures' estates live.
const env: NodeJS.ProcessEnv = {
	PI_COMS_NET_SERVER_URL: "http://hub.test",
	PI_COMS_NET_AUTH_TOKEN: "tok",
	PI_COMS_NET_ENVIRONMENT: "prd",
	// SIO-1666: even the single-hub shape lists its estates -- routing is an
	// explicit binding now, so a hub that claims nothing serves nothing.
	PI_COMS_NET_ESTATES: "eu-oit-prd,eu-b2b-prd,e,e1-prd,e2-prd,e3-prd,e4-prd,e5-prd",
};

// Two hubs; each names the estates it serves (no cross-environment access).
const hubsEnv: NodeJS.ProcessEnv = {
	// SIO-1666: hubs keyed by selector; each declares its environment and the
	// estates it owns, so routing is an explicit binding rather than a suffix.
	PI_COMS_HUBS: JSON.stringify({
		"eu-shared-services-dev": {
			serverUrl: "http://dev.hub.test",
			authToken: "d",
			environment: "dev",
			estates: ["eu-oit-dev"],
		},
		"eu-shared-services-prd": {
			serverUrl: "http://prd.hub.test",
			authToken: "p",
			environment: "prd",
			estates: ["eu-oit-prd", "eu-b2b-prod"],
		},
	}),
};

const report = `## Summary\n\nALB 5xx spike on checkout at 10:02 UTC caused by target group draining.\n\n## Root Cause\n\nDeployment rolled out with zero healthy targets.\n\nConfidence: 0.72`;

type Call = { method: string; path: string; url: string; body: Record<string, unknown> | undefined };

function scriptedHub(opts: { agents: PiAgentCard[]; reply?: unknown; replyStatus?: string; sendStatus?: string }) {
	const calls: Call[] = [];
	const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
		const parsed = new URL(input);
		const path = parsed.pathname + parsed.search;
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		calls.push({ method, path, url: input, body });
		const json = (b: unknown, status = 200) =>
			new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
		if (path === "/v1/agents/register") return json({ ok: true, agent: { name: "incident-analyzer" } });
		if (path.startsWith("/v1/agents?")) return json({ agents: opts.agents });
		if (path === "/v1/messages")
			return json({ ok: true, msg_id: "m1", status: opts.sendStatus ?? "delivered", target_session: "t1" });
		if (path.startsWith("/v1/messages/m1/await"))
			return json({ msg_id: "m1", status: opts.replyStatus ?? "complete", response: opts.reply ?? null, error: null });
		if (path.startsWith("/v1/messages/m1"))
			return json({ msg_id: "m1", status: "delivered", response: null, error: null });
		if (path.includes("/heartbeat")) return json({ ok: true });
		if (method === "DELETE") return json({ ok: true });
		return json({ ok: false, error: `unscripted ${method} ${path}` }, 500);
	};
	return { calls, fetchImpl };
}

const online: PiAgentCard[] = [{ session_id: "s1", name: "eu-oit-prd", status: "online" }];

const confirmedVerdict: PiVerdict = {
	verdict: "confirmed",
	summary: "All claims hold.",
	claims: [{ claim: "ALB 5xx spike at 10:02", status: "confirmed", evidence: "CloudWatch HTTPCode_ELB_5XX_Count" }],
	additional_observations: [],
	recommended_investigation: null,
};

const partialVerdict: PiVerdict = {
	verdict: "partially_confirmed",
	summary: "Spike confirmed, draining cause not observed.",
	claims: [
		{ claim: "ALB 5xx spike at 10:02", status: "confirmed", evidence: "CloudWatch metric" },
		{
			claim: "target group draining caused it",
			status: "unverifiable",
			evidence: "no deregistration events in window",
		},
	],
	recommended_investigation: "Check ECS service events around 10:00 UTC.",
};

const baseState = {
	finalAnswer: report,
	awsTargetEstates: ["eu-oit-prd"],
	dataSourceResults: [],
	normalizedIncident: { severity: "high" as const },
	confidenceScore: 0.72,
	rootCauseDataSources: ["aws"],
	reportCaveats: [{ guard: "g", claim: "no alarms fired", occurrences: 1, note: "alarms were unscoped" }],
};

describe("config", () => {
	test("isPiComsConfigured requires url and token", () => {
		expect(isPiComsConfigured(env)).toBe(true);
		expect(isPiComsConfigured({ PI_COMS_NET_SERVER_URL: "http://hub.test" })).toBe(false);
		expect(isPiComsConfigured({})).toBe(false);
	});

	test("resolvePiComsConfig applies defaults outside the schema", () => {
		const cfg = resolvePiComsConfig(env);
		expect(cfg.hubs.prd?.project).toBe("default");
		expect(cfg.hubs.prd?.fallbackTarget).toBe("ops");
		expect(cfg.estateAgentMap).toEqual({});
		expect(cfg.verifyTimeoutMs).toBe(300_000);
		expect(cfg.investigateTimeoutMs).toBe(900_000);
	});

	test("resolvePiComsConfig honours overrides and tolerates a bad map", () => {
		const cfg = resolvePiComsConfig({
			...env,
			PI_COMS_NET_PROJECT: "ops-net",
			PI_COMS_FALLBACK_TARGET: "duty",
			PI_COMS_ESTATE_AGENT_MAP: '{"eu-oit-prd":"eu-oit-dev"}',
			PI_COMS_VERIFY_TIMEOUT_MS: "1000",
			PI_COMS_INVESTIGATE_TIMEOUT_MS: "oops",
		});
		expect(cfg.hubs.prd?.project).toBe("ops-net");
		expect(cfg.hubs.prd?.fallbackTarget).toBe("duty");
		expect(cfg.estateAgentMap).toEqual({ "eu-oit-prd": "eu-oit-dev" });
		expect(cfg.verifyTimeoutMs).toBe(1000);
		expect(cfg.investigateTimeoutMs).toBe(900_000);
		expect(resolvePiComsConfig({ ...env, PI_COMS_ESTATE_AGENT_MAP: "{not json" }).estateAgentMap).toEqual({});
	});
});

describe("routing", () => {
	const cfg = { estateAgentMap: { "eu-oit-prd": "eu-oit-dev" }, fallbackTarget: "ops" };

	test("map override wins when that agent is online", () => {
		const r = resolvePiTarget("eu-oit-prd", [{ session_id: "s", name: "eu-oit-dev", status: "online" }], cfg);
		expect(r).toEqual({ target: "eu-oit-dev", online: true, preferred: "eu-oit-dev" });
	});

	test("estate name is the default target", () => {
		const r = resolvePiTarget(
			"eu-shared-services-prd",
			[{ session_id: "s", name: "eu-shared-services-prd", status: "online" }],
			cfg,
		);
		expect(r.target).toBe("eu-shared-services-prd");
		expect(r.online).toBe(true);
	});

	test("a stale card does not count as online", () => {
		const r = resolvePiTarget(
			"eu-shared-services-prd",
			[{ session_id: "s", name: "eu-shared-services-prd", status: "stale" }],
			cfg,
		);
		expect(r.online).toBe(false);
		expect(r.target).toBe("ops");
	});

	test("offline agent falls back to the durable inbox", () => {
		const r = resolvePiTarget("eu-shared-services-prd", [], cfg);
		expect(r).toEqual({ target: "ops", online: false, preferred: "eu-shared-services-prd" });
	});

	test("an explicit target on the card takes precedence over the map", () => {
		const r = resolvePiTarget("eu-oit-prd", [{ session_id: "s", name: "custom", status: "online" }], cfg, "custom");
		expect(r.target).toBe("custom");
	});
});

describe("estatesFromState", () => {
	test("prefers the router's estates and dedupes", () => {
		expect(estatesFromState({ awsTargetEstates: ["a", "b", "a"], dataSourceResults: [] })).toEqual(["a", "b"]);
	});

	test("falls back to estate: deploymentId tags on aws results only", () => {
		const dataSourceResults = [
			{ dataSourceId: "aws", deploymentId: "estate:eu-oit-prd", data: null, status: "success" as const },
			{ dataSourceId: "aws", deploymentId: "estate:eu-oit-prd", data: null, status: "success" as const },
			{ dataSourceId: "elastic", deploymentId: "estate:nope", data: null, status: "success" as const },
			{ dataSourceId: "aws", data: null, status: "error" as const },
		];
		expect(estatesFromState({ awsTargetEstates: [], dataSourceResults })).toEqual(["eu-oit-prd"]);
	});
});

describe("proposePiVerification", () => {
	test("returns nothing when the hub is not configured", () => {
		expect(proposePiVerification(baseState, {})).toEqual([]);
	});

	test("returns nothing for a short report or no estates", () => {
		expect(proposePiVerification({ ...baseState, finalAnswer: "short" }, env)).toEqual([]);
		expect(proposePiVerification({ ...baseState, awsTargetEstates: [] }, env)).toEqual([]);
	});

	test("emits one verify card per estate with the sidecars as params", () => {
		const cards = proposePiVerification(baseState, { ...env, PI_COMS_ESTATE_AGENT_MAP: '{"eu-oit-prd":"eu-oit-dev"}' });
		expect(cards.length).toBe(1);
		const card = cards[0];
		expect(card?.tool).toBe("verify-with-pi");
		expect(card?.params.estate).toBe("eu-oit-prd");
		expect(card?.params.target).toBe("eu-oit-dev");
		expect(card?.params.severity).toBe("high");
		expect(card?.params.confidence).toBe(0.72);
		expect(card?.params.rootCauseDataSources).toEqual(["aws"]);
		expect(card?.params.caveats).toEqual(["no alarms fired (alarms were unscoped)"]);
		expect(String(card?.params.summary)).toContain("ALB 5xx spike");
		expect(card?.reason).toContain("eu-oit-prd");
	});

	test("caps the number of cards", () => {
		const estates = ["e1-prd", "e2-prd", "e3-prd", "e4-prd", "e5-prd"];
		const cards = proposePiVerification({ ...baseState, awsTargetEstates: estates }, env);
		expect(cards.length).toBe(MAX_VERIFY_CARDS);
	});
});

describe("prompts", () => {
	test("verify prompt carries the sidecars, the schema instruction and the read-only rule", () => {
		const prompt = buildVerifyPrompt({
			params: {
				estate: "eu-oit-prd",
				severity: "high",
				confidence: 0.7,
				rootCauseDataSources: ["aws"],
				caveats: ["c1"],
			},
			report,
		});
		expect(prompt).toContain("AWS estate under review: eu-oit-prd");
		expect(prompt).toContain("Reported confidence: 0.7");
		expect(prompt).toContain("- c1");
		expect(prompt).toContain("read-only");
		expect(prompt).toContain("Reply with JSON only");
		expect(prompt).toContain("target group draining");
	});

	test("prompts truncate an oversized report", () => {
		const huge = "x".repeat(REPORT_CHAR_BUDGET + 500);
		const prompt = buildInvestigatePrompt({ params: { estate: "e", focus: ["q1"] }, report: huge });
		expect(prompt).toContain(`[report truncated at ${REPORT_CHAR_BUDGET} characters]`);
		expect(prompt).toContain("- q1");
	});
});

describe("follow-up", () => {
	test("needsInvestigation only when a claim is not confirmed", () => {
		expect(needsInvestigation(confirmedVerdict)).toBe(false);
		expect(needsInvestigation(partialVerdict)).toBe(true);
		expect(needsInvestigation({ ...confirmedVerdict, verdict: "unverifiable" })).toBe(true);
	});

	test("buildInvestigateFollowUp lists the open claims and threads the conversation", () => {
		const card = buildInvestigateFollowUp(
			{ estate: "eu-oit-prd", severity: "high" },
			partialVerdict,
			"eu-oit-prd",
			"m1",
		);
		expect(card.tool).toBe("investigate-with-pi");
		expect(card.params.conversation_id).toBe("m1");
		expect(card.params.target).toBe("eu-oit-prd");
		expect(card.params.focus).toEqual([
			"unverifiable: target group draining caused it",
			"recommended: Check ECS service events around 10:00 UTC.",
		]);
	});
});

describe("executePiVerify", () => {
	test("refuses when unconfigured or params are invalid", async () => {
		expect((await executePiVerify({ estate: "e" }, report, { env: {} })).status).toBe("error");
		const bad = await executePiVerify({}, report, { env });
		expect(bad.status).toBe("error");
		expect(bad.error).toContain("estate");
	});

	test("returns a validated verdict and no follow-up when everything is confirmed", async () => {
		const hub = scriptedHub({ agents: online, reply: confirmedVerdict });
		const out = await executePiVerify({ estate: "eu-oit-prd" }, report, { env, fetchImpl: hub.fetchImpl });
		expect(out.status).toBe("success");
		expect(out.result?.kind).toBe("verdict");
		if (out.result?.kind === "verdict") {
			expect(out.result.target).toBe("eu-oit-prd");
			expect(out.result.verdict.claims.length).toBe(1);
		}
		expect(out.followUpActions).toBeUndefined();
		const send = hub.calls.find((c) => c.path === "/v1/messages");
		expect(send?.body?.target).toBe("eu-oit-prd");
		expect(send?.body?.response_schema).toBeDefined();
		expect("ttl_ms" in (send?.body ?? {})).toBe(false);
		expect(hub.calls.at(-1)?.method).toBe("DELETE");
	});

	test("proposes the investigate card when the verdict is partial", async () => {
		const hub = scriptedHub({ agents: online, reply: partialVerdict });
		const out = await executePiVerify({ estate: "eu-oit-prd", severity: "high" }, report, {
			env,
			fetchImpl: hub.fetchImpl,
		});
		expect(out.status).toBe("success");
		expect(out.followUpActions?.length).toBe(1);
		expect(out.followUpActions?.[0]?.tool).toBe("investigate-with-pi");
		expect(out.followUpActions?.[0]?.params.conversation_id).toBe("m1");
	});

	test("queues to the fallback inbox with a durable ttl when the estate agent is offline", async () => {
		const hub = scriptedHub({ agents: [], sendStatus: "queued" });
		const out = await executePiVerify({ estate: "eu-oit-prd" }, report, { env, fetchImpl: hub.fetchImpl });
		expect(out.status).toBe("success");
		expect(out.result).toEqual({ kind: "queued", target: "ops", estate: "eu-oit-prd", msg_id: "m1" });
		const send = hub.calls.find((c) => c.path === "/v1/messages");
		expect(send?.body?.target).toBe("ops");
		expect(send?.body?.ttl_ms).toBe(PI_MAILBOX_TTL_MS);
		expect(hub.calls.some((c) => c.path.includes("/await"))).toBe(false);
	});

	test("awaits a send the hub queued for an online agent instead of reporting a mailbox send", async () => {
		const hub = scriptedHub({ agents: online, reply: confirmedVerdict, sendStatus: "queued" });
		const out = await executePiVerify({ estate: "eu-oit-prd" }, report, { env, fetchImpl: hub.fetchImpl });
		expect(out.status).toBe("success");
		expect(out.result?.kind).toBe("verdict");
		expect(hub.calls.some((c) => c.path.includes("/await"))).toBe(true);
	});

	test("rejects a reply that does not match the verdict schema", async () => {
		const hub = scriptedHub({ agents: online, reply: { verdict: "confirmed", claims: "nope" } });
		const out = await executePiVerify({ estate: "eu-oit-prd" }, report, { env, fetchImpl: hub.fetchImpl });
		expect(out.status).toBe("error");
		expect(out.error).toContain("schema mismatch");
		expect(hub.calls.at(-1)?.method).toBe("DELETE");
	});

	test("surfaces a non-complete terminal status as an error", async () => {
		const hub = scriptedHub({ agents: online, replyStatus: "error" });
		const out = await executePiVerify({ estate: "eu-oit-prd" }, report, { env, fetchImpl: hub.fetchImpl });
		expect(out.status).toBe("error");
		expect(out.error).toContain("(error)");
	});

	test("surfaces hub http failures without throwing and still deregisters", async () => {
		const calls: string[] = [];
		const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
			calls.push(`${init?.method ?? "GET"} ${input.replace("http://hub.test", "")}`);
			if (input.endsWith("/register")) return new Response(JSON.stringify({ ok: true, agent: { name: "x" } }));
			return new Response(JSON.stringify({ ok: false, error: "not_owner" }), { status: 403 });
		};
		const out = await executePiVerify({ estate: "eu-oit-prd" }, report, { env, fetchImpl });
		expect(out.status).toBe("error");
		expect(out.error).toContain("403 not_owner");
		expect(calls.at(-1)?.startsWith("DELETE")).toBe(true);
	});
});

describe("executePiInvestigate", () => {
	test("returns a validated investigation threaded on the verify message", async () => {
		const investigation = {
			summary: "ECS deploy replaced all tasks at once.",
			root_cause_hypothesis: "minimumHealthyPercent 0 on checkout service",
			evidence: [{ resource: "ecs:service/checkout", observation: "deployment config minimumHealthyPercent=0" }],
			suggested_actions: ["Set minimumHealthyPercent to 100"],
			confidence: 0.8,
		};
		const hub = scriptedHub({ agents: online, reply: investigation });
		const out = await executePiInvestigate(
			{ estate: "eu-oit-prd", focus: ["unverifiable: draining"], conversation_id: "m0" },
			report,
			{ env, fetchImpl: hub.fetchImpl },
		);
		expect(out.status).toBe("success");
		expect(out.result?.kind).toBe("investigation");
		if (out.result?.kind === "investigation") expect(out.result.investigation.confidence).toBe(0.8);
		const send = hub.calls.find((c) => c.path === "/v1/messages");
		expect(send?.body?.conversation_id).toBe("m0");
		expect(String(send?.body?.prompt)).toContain("- unverifiable: draining");
	});

	test("requires estate and focus", async () => {
		const out = await executePiInvestigate({ estate: "e" }, report, { env });
		expect(out.status).toBe("error");
		expect(out.error).toContain("focus");
	});
});

describe("hub routing (SIO-1666: explicit binding, no cross-environment access)", () => {
	test("environmentForEstate reads the hub that claims the estate", () => {
		const config = resolvePiComsConfig(hubsEnv);
		expect(environmentForEstate("eu-oit-dev", config)).toBe("dev");
		expect(environmentForEstate("eu-oit-prd", config)).toBe("prd");
		// A -prod suffix no longer implies anything: the binding is data. This
		// estate is claimed by the prd hub, so it resolves -- by the list, not the name.
		expect(environmentForEstate("eu-b2b-prod", config)).toBe("prd");
		// Unclaimed estates have no environment, however they are named.
		expect(environmentForEstate("eu-b2b-stg", config)).toBeUndefined();
		expect(environmentForEstate("eu-oit", config)).toBeUndefined();
	});

	test("selectHubForEstate resolves by the hub's estate list and names the hub", () => {
		const config = resolvePiComsConfig(hubsEnv);
		const prdHub = config.hubs["eu-shared-services-prd"];
		if (!prdHub) throw new Error("fixture: prd hub missing");
		expect(selectHubForEstate("eu-oit-prd", config)).toEqual({
			ok: true,
			environment: "prd",
			hubKey: "eu-shared-services-prd",
			hub: prdHub,
		});
	});

	// The routing hazard this rekey removes: a suffix identifies an ENVIRONMENT,
	// not a hub, so it silently picked one once two hubs shared an environment.
	test("an estate no hub claims is refused, never guessed from its name", () => {
		const config = resolvePiComsConfig(hubsEnv);
		expect(selectHubForEstate("eu-b2b-stg", config)).toMatchObject({
			ok: false,
			error: expect.stringContaining('estate "eu-b2b-stg" is not listed on any pi-coms hub'),
		});
		expect(selectHubForEstate("eu-oit", config)).toMatchObject({ ok: false });
	});

	test("an estate claimed by two hubs is refused rather than chosen between", () => {
		const config = resolvePiComsConfig({
			PI_COMS_HUBS: JSON.stringify({
				"a-prd": { serverUrl: "http://a.test", authToken: "a", environment: "prd", estates: ["shared-prd"] },
				"b-prd": { serverUrl: "http://b.test", authToken: "b", environment: "prd", estates: ["shared-prd"] },
			}),
		});
		expect(selectHubForEstate("shared-prd", config)).toMatchObject({
			ok: false,
			error: expect.stringContaining("claimed by more than one hub"),
		});
	});

	// Two hubs in ONE environment is the whole point of the rekey.
	test("two prd hubs coexist and each estate reaches its own", () => {
		const config = resolvePiComsConfig({
			PI_COMS_HUBS: JSON.stringify({
				"eu-shared-services-prd": {
					serverUrl: "http://shared.test",
					authToken: "s",
					environment: "prd",
					estates: ["eu-oit-prd"],
				},
				"eu-other-domain-prd": {
					serverUrl: "http://other.test",
					authToken: "o",
					environment: "prd",
					estates: ["eu-other-prd"],
				},
			}),
		});
		const a = selectHubForEstate("eu-oit-prd", config);
		const b = selectHubForEstate("eu-other-prd", config);
		expect(a.ok && a.hub.serverUrl).toBe("http://shared.test");
		expect(b.ok && b.hub.serverUrl).toBe("http://other.test");
	});

	test("a prd estate only ever talks to the prd hub", async () => {
		const { calls, fetchImpl } = scriptedHub({ agents: online, reply: confirmedVerdict });
		const out = await executePiVerify({ estate: "eu-oit-prd" }, report, { fetchImpl, env: hubsEnv });
		expect(out.status).toBe("success");
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => c.url.startsWith("http://prd.hub.test/"))).toBe(true);
	});

	test("a dev estate only ever talks to the dev hub", async () => {
		const { calls, fetchImpl } = scriptedHub({
			agents: [{ session_id: "s1", name: "eu-oit-dev", status: "online" }],
			reply: confirmedVerdict,
		});
		await executePiVerify({ estate: "eu-oit-dev" }, report, { fetchImpl, env: hubsEnv });
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => c.url.startsWith("http://dev.hub.test/"))).toBe(true);
	});

	test("an estate with no hub is a readable error and makes no hub call", async () => {
		const { calls, fetchImpl } = scriptedHub({ agents: online });
		const out = await executePiVerify({ estate: "eu-b2b-stg" }, report, { fetchImpl, env: hubsEnv });
		// SIO-1666: the refusal names the estate and the hubs that exist, rather
		// than an environment -- an environment no longer identifies a hub.
		expect(out).toMatchObject({
			status: "error",
			error: expect.stringContaining('estate "eu-b2b-stg" is not listed on any pi-coms hub'),
		});
		expect(calls).toEqual([]);
	});

	test("proposePiVerification skips estates without a hub and orders cards by environment", () => {
		const cards = proposePiVerification(
			{ ...baseState, awsTargetEstates: ["eu-oit-prd", "eu-b2b-stg", "eu-oit-dev"] },
			hubsEnv,
		);
		expect(cards.map((c) => [c.params.environment, c.params.estate])).toEqual([
			["dev", "eu-oit-dev"],
			["prd", "eu-oit-prd"],
		]);
	});

	test("proposePiVerification yields no cards on a malformed hubs map", () => {
		expect(proposePiVerification(baseState, { PI_COMS_HUBS: "{oops" })).toEqual([]);
	});
});

describe("process.env fallback", () => {
	const originalEnv = { ...process.env };
	beforeEach(() => {
		delete process.env.PI_COMS_NET_SERVER_URL;
		delete process.env.PI_COMS_NET_AUTH_TOKEN;
	});
	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("defaults to process.env when no env is injected", async () => {
		expect(isPiComsConfigured()).toBe(false);
		expect((await executePiVerify({ estate: "e" }, report)).error).toContain("not configured");
	});
});
