// agent/src/action-tools/pi-verifier.ts
// SIO-1635: verify-with-pi / investigate-with-pi action tools. The report is handed
// to the pi-coms hub agent that owns the incident's AWS estate; the agent checks the
// claims against live account state and replies with a schema-shaped verdict. Hub
// replies are rendered as data by the card and are never fed back into the LLM.
import { getLogger } from "@devops-agent/observability";
import {
	type PendingAction,
	PI_INVESTIGATION_RESPONSE_SCHEMA,
	PI_VERDICT_RESPONSE_SCHEMA,
	type PiActionResultPayload,
	type PiComsCapabilities,
	type PiComsConfig,
	type PiComsEnvironment,
	PiComsEnvironmentSchema,
	type PiComsHubConfig,
	PiInvestigationSchema,
	type PiVerdict,
	PiVerdictSchema,
} from "@devops-agent/shared";
import { z } from "zod";
import { recordVerdictDecision } from "../pi-verdict-memory.ts";
import type { AgentStateType } from "../state.ts";
import {
	type FetchLike,
	isPiComsConfigured,
	PI_COMS_AWAIT_SLICE_MS,
	type PiAgentCard,
	PiComsClient,
	resolvePiComsConfig,
} from "./pi-coms-client.ts";

// Re-exported so executor.ts and the tests keep their import path.
export { isPiComsConfigured, resolvePiComsConfig };

// SIO-1655: the single read point for a pi-coms capability gate. Resolving through
// the config keeps every gate declared in PiComsCapabilitiesSchema rather than as
// an ad-hoc process.env read at each call site, and gives them all one default
// rule (ON unless explicitly "false"/"0").
//
// Deliberately does NOT require a configured hub: whether a capability is WANTED
// is separate from whether the infrastructure to serve it exists, and each caller
// already handles an unconfigured hub (the inbox node self-skips, runPiHandoff
// returns "skipped", the console is filtered out of the agent selector). Reading
// the flag alone therefore stays cheap and side-effect free -- resolvePiComsConfig
// would throw here when no hub is set.
export function readPiComsCapability(env: NodeJS.ProcessEnv, capability: keyof PiComsCapabilities): boolean {
	const raw = env[PI_COMS_CAPABILITY_ENV[capability]];
	return raw !== "false" && raw !== "0";
}

const PI_COMS_CAPABILITY_ENV: Record<keyof PiComsCapabilities, string> = {
	handoff: "PI_HANDOFF_ENABLED",
	inbox: "PI_COMS_INBOX_ENABLED",
	fleetGraph: "PI_FLEET_GRAPH_ENABLED",
};

const logger = getLogger("agent:action-tools:pi-verifier");

// Above the hub's 30 min default message TTL, so an offline target gets a durable
// mailbox entry instead of a 404.
export const PI_MAILBOX_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_VERIFY_CARDS = 3;
export const REPORT_CHAR_BUDGET = 12_000;
const ESTATE_DEPLOYMENT_PREFIX = "estate:";

export const PiVerifyParamsSchema = z.object({
	estate: z.string().min(1),
	environment: PiComsEnvironmentSchema.optional(),
	target: z.string().optional(),
	severity: z.string().optional(),
	confidence: z.number().optional(),
	summary: z.string().optional(),
	rootCauseDataSources: z.array(z.string()).optional(),
	caveats: z.array(z.string()).optional(),
});
export type PiVerifyParams = z.infer<typeof PiVerifyParamsSchema>;

export const PiInvestigateParamsSchema = z.object({
	estate: z.string().min(1),
	environment: PiComsEnvironmentSchema.optional(),
	target: z.string().optional(),
	severity: z.string().optional(),
	focus: z.array(z.string()),
	conversation_id: z.string().optional(),
});
export type PiInvestigateParams = z.infer<typeof PiInvestigateParamsSchema>;

export type PiActionOutcome = {
	status: "success" | "error";
	result?: PiActionResultPayload;
	error?: string;
	followUpActions?: PendingAction[];
};

export type PiVerifierDeps = {
	fetchImpl?: FetchLike;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
};

// SIO-1666: an estate is bound to a hub EXPLICITLY, by the hub's `estates` list.
//
// This replaces routing by estate name suffix (-dev/-stg/-prd). That convention
// only worked while one hub owned each environment: with a second prd hub the
// suffix identifies an ENVIRONMENT, not a hub, so `eu-oit-prd` and a different
// domain's prd estate both resolved to whichever prd hub happened to be
// configured -- silently, with no error. The binding is now data, and an estate
// no hub claims is REFUSED rather than guessed, which is how the standing
// no-cross-environment guarantee survives the rekey.
export function environmentForEstate(
	estate: string,
	config: Pick<PiComsConfig, "hubs">,
): PiComsEnvironment | undefined {
	return Object.values(config.hubs).find((hub) => hub.estates.includes(estate))?.environment;
}

export type HubSelection =
	| { ok: true; environment: PiComsEnvironment; hubKey: string; hub: PiComsHubConfig }
	| { ok: false; error: string };

export function selectHubForEstate(estate: string, config: Pick<PiComsConfig, "hubs">): HubSelection {
	const matches = Object.entries(config.hubs).filter(([, hub]) => hub.estates.includes(estate));
	if (matches.length === 0) {
		const known = Object.keys(config.hubs).join(", ") || "(none)";
		return {
			ok: false,
			error: `estate "${estate}" is not listed on any pi-coms hub (hubs: ${known}); add it to that hub's estates in PI_COMS_HUBS`,
		};
	}
	// Two hubs claiming one estate is a config error, not something to pick from:
	// silently choosing would be the very ambiguity this rekey removes.
	if (matches.length > 1) {
		return {
			ok: false,
			error: `estate "${estate}" is claimed by more than one hub (${matches.map(([k]) => k).join(", ")}); an estate belongs to exactly one`,
		};
	}
	const [hubKey, hub] = matches[0] as [string, PiComsHubConfig];
	return { ok: true, environment: hub.environment, hubKey, hub };
}

// The agent name an estate maps to before checking who is online.
export function preferredTargetForEstate(estate: string, config: Pick<PiComsConfig, "estateAgentMap">): string {
	return config.estateAgentMap[estate] ?? estate;
}

export type ResolvedTarget = { target: string; online: boolean; preferred: string };

// Online estate agent wins; otherwise the durable fallback inbox takes the send.
// Only "online" counts: a stale card is about to be reaped and its per-session
// queue is not the durable mailbox (smoke-tested against the hub, SIO-1635).
export function resolvePiTarget(
	estate: string,
	agents: PiAgentCard[],
	config: Pick<PiComsConfig, "estateAgentMap"> & Pick<PiComsHubConfig, "fallbackTarget">,
	explicitTarget?: string,
): ResolvedTarget {
	const preferred = explicitTarget && explicitTarget !== "" ? explicitTarget : preferredTargetForEstate(estate, config);
	const online = agents.some((a) => a.name === preferred && a.status === "online");
	return online
		? { target: preferred, online: true, preferred }
		: { target: config.fallbackTarget, online: false, preferred };
}

// Estates the report actually assessed: the router's list, or the per-estate
// deploymentId tags the AWS sub-agent stamps on its results.
export function estatesFromState(state: Pick<AgentStateType, "awsTargetEstates" | "dataSourceResults">): string[] {
	if (state.awsTargetEstates.length > 0) return [...new Set(state.awsTargetEstates)];
	const seen = new Set<string>();
	for (const r of state.dataSourceResults) {
		if (r.dataSourceId !== "aws" || !r.deploymentId?.startsWith(ESTATE_DEPLOYMENT_PREFIX)) continue;
		const estate = r.deploymentId.slice(ESTATE_DEPLOYMENT_PREFIX.length);
		if (estate) seen.add(estate);
	}
	return [...seen];
}

function firstParagraph(report: string): string {
	const body = report.replace(/^#.*$/gm, "").trim();
	const para = body.split(/\n\s*\n/)[0] ?? "";
	return para.replace(/\s+/g, " ").slice(0, 280);
}

// Deterministic: one verify card per assessed estate, no LLM, no severity gate.
export function proposePiVerification(
	state: Pick<
		AgentStateType,
		| "finalAnswer"
		| "awsTargetEstates"
		| "dataSourceResults"
		| "normalizedIncident"
		| "confidenceScore"
		| "rootCauseDataSources"
		| "reportCaveats"
	>,
	env: NodeJS.ProcessEnv = process.env,
): PendingAction[] {
	if (!isPiComsConfigured(env)) return [];
	const report = state.finalAnswer;
	if (!report || report.length < 50) return [];
	const estates = estatesFromState(state);
	if (estates.length === 0) return [];
	let config: PiComsConfig;
	try {
		config = resolvePiComsConfig(env);
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"pi-coms config invalid; no verification cards",
		);
		return [];
	}
	const caveats = (state.reportCaveats ?? []).map((c) => `${c.claim} (${c.note})`).slice(0, 10);
	// One card per estate that has a hub for its environment; the rest are skipped
	// with a log line rather than routed anywhere else.
	const routed = estates.flatMap((estate) => {
		const selection = selectHubForEstate(estate, config);
		if (!selection.ok) {
			logger.warn({ estate, reason: selection.error }, "Skipping verify card: no hub for estate");
			return [];
		}
		return [{ estate, environment: selection.environment }];
	});
	routed.sort((a, b) => a.environment.localeCompare(b.environment) || a.estate.localeCompare(b.estate));
	return routed.slice(0, MAX_VERIFY_CARDS).map(({ estate, environment }) => {
		const params: PiVerifyParams = {
			estate,
			environment,
			target: preferredTargetForEstate(estate, config),
			severity: state.normalizedIncident?.severity ?? "medium",
			confidence: state.confidenceScore,
			summary: firstParagraph(report),
			rootCauseDataSources: state.rootCauseDataSources ?? [],
			caveats,
		};
		return {
			id: crypto.randomUUID(),
			tool: "verify-with-pi",
			params,
			reason: `Verify the report's AWS claims for estate ${estate} against live account state via the pi agent hub before acting on them.`,
		};
	});
}

function truncateReport(report: string): string {
	if (report.length <= REPORT_CHAR_BUDGET) return report;
	return `${report.slice(0, REPORT_CHAR_BUDGET)}\n\n[report truncated at ${REPORT_CHAR_BUDGET} characters]`;
}

export function buildVerifyPrompt(input: { params: PiVerifyParams; report: string }): string {
	const { params, report } = input;
	const sidecar: string[] = [`AWS estate under review: ${params.estate}`];
	if (params.severity) sidecar.push(`Reported severity: ${params.severity}`);
	if (params.confidence !== undefined) sidecar.push(`Reported confidence: ${params.confidence}`);
	// SIO-1696: the datasource attribution is context for judging what the report
	// asserts, NOT a list to go and check -- the spoke reaches only AWS, in one
	// account. Naming these as a bare fact invited replies that enumerated every
	// system the agent could not reach, so the line says outright not to report on
	// them. An AWS-only attribution is dropped: it names nothing out of scope.
	const foreignDataSources = (params.rootCauseDataSources ?? []).filter((d) => d.toLowerCase() !== "aws");
	if (foreignDataSources.length > 0) {
		sidecar.push(
			`Context only -- the report attributes root cause to: ${foreignDataSources.join(", ")}. These are outside this account; do not check them and do not mention them in your reply.`,
		);
	}
	if (params.caveats && params.caveats.length > 0) {
		sidecar.push("Caveats already attached to the report:");
		for (const c of params.caveats) sidecar.push(`- ${c}`);
	}
	return [
		"You are verifying an incident report produced by an automated DevOps incident analyzer.",
		"Check each concrete claim about this AWS account (resources, alarms, log evidence, timings, root cause) against live account state using read-only calls only. Never create, update, or delete anything.",
		// SIO-1696: the report spans datasources this spoke cannot reach (Elasticsearch,
		// Kafka, Couchbase, GitLab, Atlassian) and other AWS accounts. Reporting those as
		// `unverifiable` produced replies that were mostly a list of systems the agent had
		// no access to, and -- because buildInvestigateFollowUp keys off non-confirmed
		// claims -- spawned investigate cards ordering it to chase them. They are omitted
		// instead, and `unverifiable` narrows to an in-account read that genuinely failed.
		"Report ONLY on this AWS account. Silently skip every claim about another AWS account or about a non-AWS system: leave it out of claims[] entirely, and do not name those accounts or systems anywhere in your reply. Do not mark them unverifiable -- they are out of scope, not unresolved.",
		"For each remaining claim, decide: confirmed (you observed evidence agreeing with it), contradicted (you observed evidence disagreeing with it), or unverifiable (the read is available in this account but you could not complete it -- quote the permission error or the retention limit). Cite the specific resource, metric, log group, or API result you checked as evidence.",
		"Also list anything notable you observed in this account that the report missed.",
		"",
		...sidecar,
		"",
		"Reply with JSON only, matching the response schema you were given: { verdict, summary, claims: [{ claim, status, evidence }], additional_observations, recommended_investigation }. The verdict covers the in-scope claims only: confirmed when every one of them is confirmed; partially_confirmed when at least one is confirmed and at least one is not; contradicted when the root cause claim is contradicted; unverifiable when no in-scope claim could be checked. The summary describes what you found in this account -- it does not enumerate what was out of scope. Set recommended_investigation to a one-sentence next step ONLY when it is an action performable in this account; otherwise null. Never recommend querying another account or another system.",
		"",
		"--- INCIDENT REPORT ---",
		truncateReport(report),
		"--- END REPORT ---",
	].join("\n");
}

export function buildInvestigatePrompt(input: { params: PiInvestigateParams; report: string }): string {
	const { params, report } = input;
	return [
		"You are continuing an incident investigation in this AWS account after a verification pass left open questions.",
		`AWS estate under investigation: ${params.estate}`,
		params.severity ? `Reported severity: ${params.severity}` : "",
		"",
		"Open questions from the verification pass (investigate each):",
		...params.focus.map((f) => `- ${f}`),
		"",
		// SIO-1696: the focus list is derived from the verdict's non-confirmed claims,
		// which the verify prompt now keeps in-account. A card issued before that change
		// can still carry an out-of-scope entry, so skipping is stated here too.
		"Skip any open question that is about another AWS account or a non-AWS system, and do not mention it in your reply. Report only what you can observe in this account.",
		"Use read-only calls only: describe, list, get, query, and CloudWatch Logs Insights are fine; never create, update, or delete anything. Paginate before concluding something is absent. Prefer evidence with timestamps and resource identifiers.",
		"Every suggested action must be performable in this account or by a named owner of this account's resources; never suggest querying another account or another system.",
		"",
		"Reply with JSON only, matching the response schema you were given: { summary, root_cause_hypothesis, evidence: [{ resource, observation }], suggested_actions, confidence } where confidence is 0 to 1 and reflects how well the evidence supports the hypothesis.",
		"",
		"--- ORIGINAL INCIDENT REPORT (context) ---",
		truncateReport(report),
		"--- END REPORT ---",
	]
		.filter((line) => line !== "")
		.join("\n");
}

export function needsInvestigation(verdict: PiVerdict): boolean {
	return verdict.verdict !== "confirmed" || verdict.claims.some((c) => c.status !== "confirmed");
}

export function buildInvestigateFollowUp(
	params: PiVerifyParams,
	verdict: PiVerdict,
	target: string,
	msgId: string,
): PendingAction {
	const focus = verdict.claims.filter((c) => c.status !== "confirmed").map((c) => `${c.status}: ${c.claim}`);
	if (verdict.recommended_investigation) focus.push(`recommended: ${verdict.recommended_investigation}`);
	if (focus.length === 0) focus.push(`verdict ${verdict.verdict}: ${verdict.summary}`);
	const followUp: PiInvestigateParams = {
		estate: params.estate,
		environment: params.environment,
		target,
		severity: params.severity,
		focus,
		conversation_id: msgId,
	};
	return {
		id: crypto.randomUUID(),
		tool: "investigate-with-pi",
		params: followUp,
		reason: `The pi agent could not confirm every claim for estate ${params.estate} (verdict: ${verdict.verdict}). Launch a deeper read-only investigation of the open questions.`,
	};
}

export type HubOutcome =
	| { kind: "queued"; target: string; msg_id: string }
	| { kind: "reply"; target: string; msg_id: string; response: unknown }
	| { kind: "failed"; error: string };

type HubTaskInput = {
	estate: string;
	explicitTarget?: string;
	prompt: string;
	responseSchema: object;
	conversationId?: string;
	config: PiComsConfig;
	deps: PiVerifierDeps;
};

type HubSend = { kind: "queued" | "sent"; hubKey: string; target: string; msg_id: string };

// Register, resolve the target, send. Shared by runHubTask (which then awaits on the
// SAME registered client) and startHubTask (which deregisters straight away), so the
// routing and mailbox-fallback rules cannot drift between the two shapes.
async function sendViaHub(client: PiComsClient, hubKey: string, input: HubTaskInput, fallbackTarget: string) {
	await client.register();
	const agents = await client.listAgents();
	const routing = { estateAgentMap: input.config.estateAgentMap, fallbackTarget };
	const resolved = resolvePiTarget(input.estate, agents, routing, input.explicitTarget);
	if (!resolved.online) {
		logger.info(
			{ estate: input.estate, preferred: resolved.preferred, fallback: resolved.target },
			"Estate agent offline; queueing to the fallback mailbox",
		);
		const queued = await client.send(resolved.target, input.prompt, {
			responseSchema: input.responseSchema,
			ttlMs: PI_MAILBOX_TTL_MS,
			conversationId: input.conversationId,
		});
		return { kind: "queued", hubKey, target: resolved.target, msg_id: queued.msg_id } satisfies HubSend;
	}
	const sent = await client.send(resolved.target, input.prompt, {
		responseSchema: input.responseSchema,
		conversationId: input.conversationId,
	});
	return { kind: "sent", hubKey, target: resolved.target, msg_id: sent.msg_id } satisfies HubSend;
}

// SIO-1651: exported so the pi-handoff workflow's `agent` step reuses this exact
// hub path (register, resolve target, send, await, deregister) instead of a
// second implementation that could drift from the card path.
export async function runHubTask(input: HubTaskInput & { budgetMs: number }): Promise<HubOutcome> {
	const selection = selectHubForEstate(input.estate, input.config);
	if (!selection.ok) return { kind: "failed", error: selection.error };
	const client = new PiComsClient(selection.hub, { fetchImpl: input.deps.fetchImpl, now: input.deps.now });
	try {
		const sent = await sendViaHub(client, selection.hubKey, input, selection.hub.fallbackTarget);
		if (sent.kind === "queued") return { kind: "queued", target: sent.target, msg_id: sent.msg_id };
		// A "queued" status here means the agent's SSE stream is down although its
		// card is still online; the hub flushes the queue on reconnect, so wait for
		// it within the budget rather than mislabel it as a mailbox send.
		const reply = await client.awaitReply(sent.msg_id, input.budgetMs);
		if (reply.status !== "complete") {
			return {
				kind: "failed",
				error: `pi agent ${sent.target} did not complete (${reply.status}): ${reply.error ?? "no detail"}`,
			};
		}
		return { kind: "reply", target: sent.target, msg_id: sent.msg_id, response: reply.response };
	} catch (error) {
		return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
	} finally {
		await client.deregister();
	}
}

// SIO-1778: the send half on its own, for the fleet-pane execution path. The sender
// deregisters before the reply exists; awaiting by id needs only the token, which is
// how the pane's own re-poll already works (apps/web pi-fleet.ts awaitFleetMessage).
export async function startHubTask(
	input: HubTaskInput,
): Promise<(HubSend & { hub: PiComsHubConfig }) | { kind: "failed"; error: string }> {
	const selection = selectHubForEstate(input.estate, input.config);
	if (!selection.ok) return { kind: "failed", error: selection.error };
	const client = new PiComsClient(selection.hub, { fetchImpl: input.deps.fetchImpl, now: input.deps.now });
	try {
		const sent = await sendViaHub(client, selection.hubKey, input, selection.hub.fallbackTarget);
		return { ...sent, hub: selection.hub };
	} catch (error) {
		return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
	} finally {
		await client.deregister();
	}
}

type PiTool = "verify-with-pi" | "investigate-with-pi";

type PreparedPiAction =
	| { ok: false; error: string }
	| {
			ok: true;
			tool: PiTool;
			params: PiVerifyParams | PiInvestigateParams;
			task: HubTaskInput & { budgetMs: number };
	  };

// Params parse + prompt build, once, for both the one-shot and the start/poll shapes.
function preparePiAction(
	tool: PiTool,
	rawParams: Record<string, unknown>,
	reportContent: string,
	deps: PiVerifierDeps,
): PreparedPiAction {
	const env = deps.env ?? process.env;
	if (!isPiComsConfigured(env)) return { ok: false, error: "pi-coms hub is not configured" };
	const config = resolvePiComsConfig(env);
	if (tool === "verify-with-pi") {
		const parsed = PiVerifyParamsSchema.safeParse(rawParams);
		if (!parsed.success) return { ok: false, error: "verify-with-pi params invalid: estate is required" };
		const params = parsed.data;
		return {
			ok: true,
			tool,
			params,
			task: {
				estate: params.estate,
				explicitTarget: params.target,
				prompt: buildVerifyPrompt({ params, report: reportContent }),
				responseSchema: PI_VERDICT_RESPONSE_SCHEMA,
				budgetMs: config.verifyTimeoutMs,
				config,
				deps,
			},
		};
	}
	const parsed = PiInvestigateParamsSchema.safeParse(rawParams);
	if (!parsed.success) return { ok: false, error: "investigate-with-pi params invalid: estate and focus are required" };
	const params = parsed.data;
	return {
		ok: true,
		tool,
		params,
		task: {
			estate: params.estate,
			explicitTarget: params.target,
			prompt: buildInvestigatePrompt({ params, report: reportContent }),
			responseSchema: PI_INVESTIGATION_RESPONSE_SCHEMA,
			budgetMs: config.investigateTimeoutMs,
			conversationId: params.conversation_id,
			config,
			deps,
		},
	};
}

function queuedOutcome(estate: string, target: string, msgId: string): PiActionOutcome {
	return { status: "success", result: { kind: "queued", target, estate, msg_id: msgId } };
}

// The reply half: validate against the analyzer's OWN schema, remember a verdict as
// structured fields, and propose the investigate follow-up. One implementation for
// both execution shapes.
function finalizePiAction(
	tool: PiTool,
	params: PiVerifyParams | PiInvestigateParams,
	reply: { target: string; msg_id: string; response: unknown },
): PiActionOutcome {
	if (tool === "verify-with-pi") {
		const verdict = PiVerdictSchema.safeParse(reply.response);
		if (!verdict.success) {
			logger.warn({ target: reply.target, msg_id: reply.msg_id }, "pi verdict did not match schema");
			return { status: "error", error: `pi agent ${reply.target} replied with an unusable verdict (schema mismatch)` };
		}
		// SIO-1651: remember the verdict as structured fields (enums, counts, ids).
		// The workflow path writes through the same builder, so a verdict is
		// remembered identically however it was asked for. Never throws.
		recordVerdictDecision({
			estate: params.estate,
			target: reply.target,
			msgId: reply.msg_id,
			requestId: reply.msg_id,
			verdict: verdict.data,
		});
		const result: PiActionOutcome = {
			status: "success",
			result: {
				kind: "verdict",
				target: reply.target,
				estate: params.estate,
				msg_id: reply.msg_id,
				verdict: verdict.data,
			},
		};
		if (needsInvestigation(verdict.data)) {
			result.followUpActions = [
				buildInvestigateFollowUp(params as PiVerifyParams, verdict.data, reply.target, reply.msg_id),
			];
		}
		return result;
	}
	const investigation = PiInvestigationSchema.safeParse(reply.response);
	if (!investigation.success) {
		logger.warn({ target: reply.target, msg_id: reply.msg_id }, "pi investigation did not match schema");
		return {
			status: "error",
			error: `pi agent ${reply.target} replied with an unusable investigation (schema mismatch)`,
		};
	}
	return {
		status: "success",
		result: {
			kind: "investigation",
			target: reply.target,
			estate: params.estate,
			msg_id: reply.msg_id,
			investigation: investigation.data,
		},
	};
}

async function executePiAction(
	tool: PiTool,
	rawParams: Record<string, unknown>,
	reportContent: string,
	deps: PiVerifierDeps,
): Promise<PiActionOutcome> {
	const prepared = preparePiAction(tool, rawParams, reportContent, deps);
	if (!prepared.ok) return { status: "error", error: prepared.error };
	const outcome = await runHubTask(prepared.task);
	if (outcome.kind === "failed") return { status: "error", error: outcome.error };
	if (outcome.kind === "queued") return queuedOutcome(prepared.params.estate, outcome.target, outcome.msg_id);
	return finalizePiAction(tool, prepared.params, outcome);
}

export function executePiVerify(
	rawParams: Record<string, unknown>,
	reportContent: string,
	deps: PiVerifierDeps = {},
): Promise<PiActionOutcome> {
	return executePiAction("verify-with-pi", rawParams, reportContent, deps);
}

export function executePiInvestigate(
	rawParams: Record<string, unknown>,
	reportContent: string,
	deps: PiVerifierDeps = {},
): Promise<PiActionOutcome> {
	return executePiAction("investigate-with-pi", rawParams, reportContent, deps);
}

// SIO-1778: start/poll execution, so the fleet pane can show a card-originated send
// live instead of the card holding one 5-15 minute request open.
//
// What a started message is allowed to become is recorded HERE, server-side. A poll
// names only a msg id; the tool, params and target it is finalized with come from
// this registry, never from the browser. Without it a caller could point a poll at
// any message on the hub and have its reply parsed as a verdict and written to
// memory under a target string of its choosing.
type StartedPiAction = {
	actionId: string;
	tool: PiTool;
	params: PiVerifyParams | PiInvestigateParams;
	hub: PiComsHubConfig;
	target: string;
	deadline: number;
};
const MAX_STARTED = 200;
const started = new Map<string, StartedPiAction>();

export type PiActionStart =
	| { status: "error"; error: string }
	| { status: "queued"; outcome: PiActionOutcome; hubKey: string; target: string; msgId: string; prompt: string }
	| { status: "sent"; hubKey: string; target: string; msgId: string; prompt: string; budgetMs: number };

export async function startPiAction(
	action: { id: string; tool: string; params: Record<string, unknown> },
	reportContent: string,
	deps: PiVerifierDeps = {},
): Promise<PiActionStart> {
	if (action.tool !== "verify-with-pi" && action.tool !== "investigate-with-pi") {
		return { status: "error", error: `not a pi action: ${action.tool}` };
	}
	const prepared = preparePiAction(action.tool, action.params, reportContent, deps);
	if (!prepared.ok) return { status: "error", error: prepared.error };
	const sent = await startHubTask(prepared.task);
	if (sent.kind === "failed") return { status: "error", error: sent.error };
	const common = { hubKey: sent.hubKey, target: sent.target, msgId: sent.msg_id, prompt: prepared.task.prompt };
	if (sent.kind === "queued") {
		return { status: "queued", outcome: queuedOutcome(prepared.params.estate, sent.target, sent.msg_id), ...common };
	}
	// ponytail: in-memory, per process. A server restart mid-wait loses the entry and the
	// poll answers "unknown" -- the same exposure as the single long request this replaces.
	if (started.size >= MAX_STARTED) started.delete(started.keys().next().value as string);
	started.set(sent.msg_id, {
		actionId: action.id,
		tool: action.tool,
		params: prepared.params,
		hub: sent.hub,
		target: sent.target,
		deadline: (deps.now ?? Date.now)() + prepared.task.budgetMs,
	});
	return { status: "sent", budgetMs: prepared.task.budgetMs, ...common };
}

export type PiActionPoll =
	| { pending: true; status: string }
	| { pending: false; actionId: string; tool: PiTool; outcome: PiActionOutcome };

// One hub await slice. Pending until the message is terminal or its budget is spent.
export async function pollPiAction(msgId: string, deps: PiVerifierDeps = {}): Promise<PiActionPoll | null> {
	const entry = started.get(msgId);
	if (!entry) return null;
	const done = (outcome: PiActionOutcome): PiActionPoll => {
		started.delete(msgId);
		return { pending: false, actionId: entry.actionId, tool: entry.tool, outcome };
	};
	const now = (deps.now ?? Date.now)();
	const remaining = entry.deadline - now;
	if (remaining <= 0) {
		return done({ status: "error", error: `pi agent ${entry.target} did not reply within its budget` });
	}
	const client = new PiComsClient(entry.hub, { fetchImpl: deps.fetchImpl, now: deps.now });
	const reply = await client.awaitReply(msgId, Math.min(PI_COMS_AWAIT_SLICE_MS, remaining));
	if (reply.status === "budget_exhausted") return { pending: true, status: "waiting" };
	if (reply.status !== "complete") {
		return done({
			status: "error",
			error: `pi agent ${entry.target} did not complete (${reply.status}): ${reply.error ?? "no detail"}`,
		});
	}
	return done(
		finalizePiAction(entry.tool, entry.params, { target: entry.target, msg_id: msgId, response: reply.response }),
	);
}
