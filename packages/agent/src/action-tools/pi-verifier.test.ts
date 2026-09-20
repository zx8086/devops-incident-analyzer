// agent/src/action-tools/pi-verifier.test.ts
// SIO-1635: proposal rules, target routing, prompt shaping and the two execute
// flows, with the hub scripted at the fetch boundary.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PiDiagnosesReplySchema, type PiVerdict } from "@devops-agent/shared";
import { PI_COMS_AWAIT_SLICE_MS, type PiAgentCard } from "./pi-coms-client.ts";
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
	pollPiAction,
	proposePiVerification,
	REPORT_CHAR_BUDGET,
	resolvePiComsConfig,
	resolvePiTarget,
	selectHubForEstate,
	startPiAction,
	unusableVerdictMessage,
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

	// SIO-1777: an estate the run proved irrelevant is dropped on BOTH branches.
	test("drops estates whose aws result proved the focus service absent", () => {
		const dataSourceResults = [
			{ dataSourceId: "aws", deploymentId: "estate:eu-oit-prd", data: null, status: "success" as const },
			{
				dataSourceId: "aws",
				deploymentId: "estate:eu-shared-services-prd",
				data: null,
				status: "success" as const,
				serviceAbsent: true,
			},
		];
		const router = ["eu-oit-prd", "eu-shared-services-prd"];
		expect(estatesFromState({ awsTargetEstates: router, dataSourceResults })).toEqual(["eu-oit-prd"]);
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

	// SIO-1696: replies enumerated every system the spoke could not reach ("all
	// claims about ... Elastic, Couchbase, Kafka, GitLab and Atlassian are
	// unverifiable from here") and recommended querying them. The prompt now says
	// to omit those claims, and reserves `unverifiable` for a failed in-account read.
	test("verify prompt scopes the reply to this account and forbids naming other systems", () => {
		const prompt = buildVerifyPrompt({ params: { estate: "eu-oit-prd" }, report });
		expect(prompt).toContain("Report ONLY on this AWS account");
		expect(prompt).toContain("leave it out of claims[] entirely");
		expect(prompt).toContain("Do not mark them unverifiable");
		expect(prompt).toContain("performable in this account");
		expect(prompt).toContain("Never recommend querying another account or another system");
	});

	test("verify prompt passes a foreign datasource attribution as do-not-report context", () => {
		const prompt = buildVerifyPrompt({
			params: { estate: "eu-oit-prd", rootCauseDataSources: ["couchbase", "elastic"] },
			report,
		});
		expect(prompt).toContain("Context only");
		expect(prompt).toContain("couchbase, elastic");
		expect(prompt).toContain("do not check them and do not mention them in your reply");
	});

	test("verify prompt omits the attribution line when the root cause is AWS-only", () => {
		// Nothing out of scope to name, so the line would only add noise.
		const prompt = buildVerifyPrompt({ params: { estate: "eu-oit-prd", rootCauseDataSources: ["aws"] }, report });
		expect(prompt).not.toContain("Context only");
	});

	test("investigate prompt skips out-of-scope open questions and scopes its suggestions", () => {
		// A card issued before SIO-1696 can still carry an out-of-scope focus entry.
		const prompt = buildInvestigatePrompt({
			params: { estate: "eu-oit-prd", focus: ["unverifiable: Couchbase deep-offset pagination"] },
			report,
		});
		expect(prompt).toContain("Skip any open question that is about another AWS account or a non-AWS system");
		expect(prompt).toContain("never suggest querying another account or another system");
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

// SIO-1829: the verify path deliberately does NOT adapt a diagnoses envelope the way the
// investigate path does (SIO-1830) -- a verdict is a judgement on the report's claims, a
// diagnosis is the spoke's own observation, and synthesising one from the other invents a
// judgement the spoke never made. What it owes the operator is a message that names the
// shape that arrived and the tool that reads it.
describe("SIO-1829: an unusable verdict says what arrived and what to do next", () => {
	// The real production envelope: one top-level key, the analyzer's claims unanswered.
	const diagnosesReply = {
		diagnoses: [
			{
				dedup_key: "logs:/ecs/fargate/orders-prd-log-group:6f4e315e",
				probable_cause: "unguarded Optional.get() at ImageEventConsumer.java:36",
				confidence: 0.8,
			},
		],
	};

	test("names investigate-with-pi when the spoke answered with a diagnosis", () => {
		const msg = unusableVerdictMessage("eu-oit-prd", diagnosesReply);
		expect(msg).toContain("eu-oit-prd");
		expect(msg).toContain("diagnosis, not a verdict");
		expect(msg).toContain("investigate-with-pi");
	});

	// The body carries account ids, arns and trace ids (SIO-1830's rule), so the message
	// may name KEYS but never values. Mutation-checked: a builder that interpolated the
	// body would leak the cause string and fail here.
	test("carries key names only, never values", () => {
		const msg = unusableVerdictMessage("eu-oit-prd", diagnosesReply);
		expect(msg).not.toContain("ImageEventConsumer");
		expect(msg).not.toContain("orders-prd-log-group");
		expect(msg).not.toContain("6f4e315e");
	});

	test("falls back to naming the keys for any other unrecognised shape", () => {
		expect(unusableVerdictMessage("eu-oit-prd", { summary: "s", oops: 1 })).toContain("keys: summary, oops");
		// A diagnoses envelope with extra keys is NOT the known dialect: the specific
		// advice would be a guess, so it degrades to the generic shape report.
		expect(unusableVerdictMessage("eu-oit-prd", { diagnoses: [1], extra: 1 })).toContain("keys: diagnoses, extra");
	});

	// Greptile, PR #856: the advice must be advice that WORKS. These three have `diagnoses`
	// as their sole key but PiDiagnosesReplySchema rejects every one, so investigate-with-pi
	// would fail on them too -- pointing the operator there wastes a hub round trip.
	// Mutation check: dropping the safeParse from the guard turns each of these red.
	test.each([
		["an empty array", { diagnoses: [] }],
		["null", { diagnoses: null }],
		["a string", { diagnoses: "nope" }],
		// probable_cause is the one REQUIRED field of an entry (everything else is
		// optional), so an entry without it is the minimal invalid diagnosis.
		["an entry without probable_cause", { diagnoses: [{ confidence: 0.8 }] }],
	])("does not recommend investigate-with-pi when diagnoses is %s", (_label, response) => {
		const msg = unusableVerdictMessage("eu-oit-prd", response);
		expect(msg).not.toContain("investigate-with-pi");
		expect(msg).toContain("keys: diagnoses");
		// The guard and the investigate path must agree on what the dialect is.
		expect(PiDiagnosesReplySchema.safeParse(response).success).toBe(false);
	});

	test("the recommendation holds only for a reply investigate-with-pi accepts", () => {
		expect(PiDiagnosesReplySchema.safeParse(diagnosesReply).success).toBe(true);
		expect(unusableVerdictMessage("eu-oit-prd", diagnosesReply)).toContain("investigate-with-pi");
	});

	test.each([
		["a bare string", "just prose"],
		["null", null],
		["an array", [{ diagnoses: [] }]],
	])("reports %s as having no object body", (_label, response) => {
		expect(unusableVerdictMessage("eu-oit-prd", response)).toContain("no object body");
	});

	// End to end through the real hub harness: the card's error text is the same message.
	test("executePiVerify surfaces it when the hub returns a diagnoses envelope", async () => {
		const hub = scriptedHub({ agents: online, reply: diagnosesReply });
		const out = await executePiVerify({ estate: "eu-oit-prd" }, report, { env, fetchImpl: hub.fetchImpl });
		expect(out.status).toBe("error");
		expect(out.error).toContain("investigate-with-pi");
		expect(out.error).not.toContain("ImageEventConsumer");
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
		// SIO-1829: a malformed verdict still fails; the message now names the shape that
		// arrived instead of a bare "schema mismatch".
		expect(out.error).toContain("unusable verdict");
		expect(out.error).toContain("keys: verdict, claims");
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

// SIO-1778: the same action split into a send and N short polls, so the fleet pane can
// show it live instead of the card holding one 5-15 minute request open.
describe("startPiAction / pollPiAction", () => {
	const verify = { id: "act-1", tool: "verify-with-pi", params: { estate: "eu-oit-prd" } };

	// The scripted hub always answers msg id "m1" and the started-action registry is
	// per process, so drain it: a finalizing poll removes the entry.
	afterEach(async () => {
		const drain = scriptedHub({ agents: online, reply: confirmedVerdict });
		await pollPiAction("m1", { env, fetchImpl: drain.fetchImpl });
	});

	test("start sends with the response schema, deregisters at once, and hands back the prompt", async () => {
		const hub = scriptedHub({ agents: online });
		const start = await startPiAction(verify, report, { env, fetchImpl: hub.fetchImpl });
		expect(start.status).toBe("sent");
		if (start.status !== "sent") return;
		expect(start).toMatchObject({ target: "eu-oit-prd", msgId: "m1" });
		expect(start.prompt).toContain("eu-oit-prd");
		expect(start.budgetMs).toBeGreaterThan(0);
		const paths = hub.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
		// No await on the start request: that is the whole point.
		expect(paths.some((p) => p.includes("/await"))).toBe(false);
		expect(paths.at(-1)?.startsWith("DELETE /v1/agents/")).toBe(true);
		expect(hub.calls.find((c) => c.path === "/v1/messages")?.body?.response_schema).toBeDefined();
	});

	test("an offline estate agent resolves at start as a mailbox send, with nothing to poll", async () => {
		const hub = scriptedHub({ agents: [] });
		const start = await startPiAction(verify, report, { env, fetchImpl: hub.fetchImpl });
		expect(start.status).toBe("queued");
		if (start.status !== "queued") return;
		expect(start.outcome.result?.kind).toBe("queued");
		expect(hub.calls.find((c) => c.path === "/v1/messages")?.body?.ttl_ms).toBe(PI_MAILBOX_TTL_MS);
		expect(await pollPiAction(start.msgId, { env, fetchImpl: hub.fetchImpl })).toBeNull();
	});

	test("poll is pending while the slice times out, then finalizes exactly like the one-shot path", async () => {
		const waiting = scriptedHub({ agents: online, replyStatus: "timeout" });
		const start = await startPiAction(verify, report, { env, fetchImpl: waiting.fetchImpl });
		expect(start.status).toBe("sent");
		// A frozen clock makes awaitReply spend its whole slice on the first scripted timeout.
		let t = 0;
		const now = () => {
			t += 30_000;
			return t;
		};
		expect(await pollPiAction("m1", { env, fetchImpl: waiting.fetchImpl, now })).toEqual({
			pending: true,
			status: "waiting",
		});

		const answered = scriptedHub({ agents: online, reply: partialVerdict });
		const done = await pollPiAction("m1", { env, fetchImpl: answered.fetchImpl });
		expect(done?.pending).toBe(false);
		if (!done || done.pending) return;
		expect(done.actionId).toBe("act-1");
		expect(done.outcome.result?.kind).toBe("verdict");
		// The follow-up card survives the split.
		expect(done.outcome.followUpActions?.[0]?.tool).toBe("investigate-with-pi");
		// Finalized once: the registry entry is gone.
		expect(await pollPiAction("m1", { env, fetchImpl: answered.fetchImpl })).toBeNull();
	});

	// SIO-1798: each poll runs on a fresh client that never registered, so the hub answers
	// its heartbeat 404 agent_not_found -- ten warnings per verify. scriptedHub answers
	// /heartbeat 200, which is why this was invisible; assert the request is never made.
	// The clock moves only when the await slice is served, so the slice really runs (the
	// test above jumps 30 s per now() call and never reaches a slice).
	test("a poll slice that times out sends no heartbeat from its unregistered client", async () => {
		const hub = scriptedHub({ agents: online, replyStatus: "timeout" });
		await startPiAction(verify, report, { env, fetchImpl: hub.fetchImpl });
		let t = Date.now();
		const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
			if (input.includes("/await")) t += PI_COMS_AWAIT_SLICE_MS;
			return hub.fetchImpl(input, init);
		};
		const before = hub.calls.length;
		expect(await pollPiAction("m1", { env, fetchImpl, now: () => t })).toEqual({ pending: true, status: "waiting" });
		expect(hub.calls.slice(before).map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual([
			"GET /v1/messages/m1/await",
			"GET /v1/messages/m1",
		]);
	});

	test("a reply that misses the analyzer's schema is an action error, not a crash", async () => {
		const hub = scriptedHub({ agents: online, reply: { verdict: "maybe" } });
		await startPiAction(verify, report, { env, fetchImpl: hub.fetchImpl });
		const done = await pollPiAction("m1", { env, fetchImpl: hub.fetchImpl });
		expect(done && !done.pending && done.outcome.status).toBe("error");
	});

	// Greptile, PR #807: the browser retries a failed poll, which is only sound if a hub
	// failure mid-poll leaves the started action in place rather than consuming it.
	test("a hub failure during a poll throws and keeps the action pollable", async () => {
		const hub = scriptedHub({ agents: online, reply: confirmedVerdict });
		await startPiAction(verify, report, { env, fetchImpl: hub.fetchImpl });
		const down = async () => new Response(JSON.stringify({ ok: false, error: "bad_gateway" }), { status: 502 });
		await expect(pollPiAction("m1", { env, fetchImpl: down })).rejects.toThrow();
		const done = await pollPiAction("m1", { env, fetchImpl: hub.fetchImpl });
		expect(done && !done.pending && done.outcome.result?.kind).toBe("verdict");
	});

	test("a msg id this process never started cannot be finalized", async () => {
		const hub = scriptedHub({ agents: online, reply: confirmedVerdict });
		expect(await pollPiAction("someone-elses-message", { env, fetchImpl: hub.fetchImpl })).toBeNull();
		expect(hub.calls).toHaveLength(0);
	});

	test("refuses non-pi tools and invalid params", async () => {
		expect((await startPiAction({ id: "x", tool: "notify-slack", params: {} }, report, { env })).status).toBe("error");
		expect((await startPiAction({ id: "x", tool: "verify-with-pi", params: {} }, report, { env })).status).toBe(
			"error",
		);
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
