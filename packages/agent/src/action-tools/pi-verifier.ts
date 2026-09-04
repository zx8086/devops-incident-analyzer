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
	type PiComsConfig,
	PiComsConfigSchema,
	PiInvestigationSchema,
	type PiVerdict,
	PiVerdictSchema,
} from "@devops-agent/shared";
import { z } from "zod";
import type { AgentStateType } from "../state.ts";
import { type FetchLike, type PiAgentCard, PiComsClient } from "./pi-coms-client.ts";

const logger = getLogger("agent:action-tools:pi-verifier");

const DEFAULT_PROJECT = "default";
const DEFAULT_FALLBACK_TARGET = "ops";
const DEFAULT_VERIFY_TIMEOUT_MS = 300_000;
const DEFAULT_INVESTIGATE_TIMEOUT_MS = 900_000;
// Above the hub's 30 min default message TTL, so an offline target gets a durable
// mailbox entry instead of a 404.
export const PI_MAILBOX_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_VERIFY_CARDS = 3;
export const REPORT_CHAR_BUDGET = 12_000;
const ESTATE_DEPLOYMENT_PREFIX = "estate:";

export const PiVerifyParamsSchema = z.object({
	estate: z.string().min(1),
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

export function isPiComsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	return !!env.PI_COMS_NET_SERVER_URL && !!env.PI_COMS_NET_AUTH_TOKEN;
}

function readPositiveInt(raw: string | undefined, fallback: number, name: string): number {
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		logger.warn({ name, raw, fallback }, "Invalid positive integer env value; using default");
		return fallback;
	}
	return n;
}

function readEstateAgentMap(raw: string | undefined): Record<string, string> {
	if (raw === undefined || raw.trim() === "") return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		const result = z.record(z.string(), z.string()).safeParse(parsed);
		if (result.success) return result.data;
		logger.warn({ issues: result.error.issues.length }, "PI_COMS_ESTATE_AGENT_MAP is not a string map; ignoring");
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"PI_COMS_ESTATE_AGENT_MAP is not valid JSON; ignoring",
		);
	}
	return {};
}

// Defaults live here, not in the schema (project rule: no .default() in config schemas).
export function resolvePiComsConfig(env: NodeJS.ProcessEnv = process.env): PiComsConfig {
	return PiComsConfigSchema.parse({
		serverUrl: env.PI_COMS_NET_SERVER_URL,
		authToken: env.PI_COMS_NET_AUTH_TOKEN,
		project: env.PI_COMS_NET_PROJECT && env.PI_COMS_NET_PROJECT !== "" ? env.PI_COMS_NET_PROJECT : DEFAULT_PROJECT,
		fallbackTarget:
			env.PI_COMS_FALLBACK_TARGET && env.PI_COMS_FALLBACK_TARGET !== ""
				? env.PI_COMS_FALLBACK_TARGET
				: DEFAULT_FALLBACK_TARGET,
		estateAgentMap: readEstateAgentMap(env.PI_COMS_ESTATE_AGENT_MAP),
		verifyTimeoutMs: readPositiveInt(
			env.PI_COMS_VERIFY_TIMEOUT_MS,
			DEFAULT_VERIFY_TIMEOUT_MS,
			"PI_COMS_VERIFY_TIMEOUT_MS",
		),
		investigateTimeoutMs: readPositiveInt(
			env.PI_COMS_INVESTIGATE_TIMEOUT_MS,
			DEFAULT_INVESTIGATE_TIMEOUT_MS,
			"PI_COMS_INVESTIGATE_TIMEOUT_MS",
		),
	});
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
	config: Pick<PiComsConfig, "estateAgentMap" | "fallbackTarget">,
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
	const config = resolvePiComsConfig(env);
	const caveats = (state.reportCaveats ?? []).map((c) => `${c.claim} (${c.note})`).slice(0, 10);
	return estates.slice(0, MAX_VERIFY_CARDS).map((estate) => {
		const params: PiVerifyParams = {
			estate,
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
	if (params.rootCauseDataSources && params.rootCauseDataSources.length > 0) {
		sidecar.push(`Root cause attributed to datasources: ${params.rootCauseDataSources.join(", ")}`);
	}
	if (params.caveats && params.caveats.length > 0) {
		sidecar.push("Caveats already attached to the report:");
		for (const c of params.caveats) sidecar.push(`- ${c}`);
	}
	return [
		"You are verifying an incident report produced by an automated DevOps incident analyzer.",
		"Check each concrete claim about this AWS account (resources, alarms, log evidence, timings, root cause) against live account state using read-only calls only. Never create, update, or delete anything.",
		"For every claim, decide: confirmed (you observed evidence agreeing with it), contradicted (you observed evidence disagreeing with it), or unverifiable (you could not observe it with the access you have). Cite the specific resource, metric, log group, or API result you checked as evidence.",
		"Also list anything notable you observed that the report missed.",
		"",
		...sidecar,
		"",
		"Reply with JSON only, matching the response schema you were given: { verdict, summary, claims: [{ claim, status, evidence }], additional_observations, recommended_investigation }. Set verdict to confirmed only when every claim is confirmed; use partially_confirmed when at least one claim is confirmed and at least one is not; contradicted when the root cause claim is contradicted; unverifiable when nothing could be checked. Set recommended_investigation to a one-sentence next step when any claim is contradicted or unverifiable, otherwise null.",
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
		"Use read-only calls only: describe, list, get, query, and CloudWatch Logs Insights are fine; never create, update, or delete anything. Paginate before concluding something is absent. Prefer evidence with timestamps and resource identifiers.",
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

type HubOutcome =
	| { kind: "queued"; target: string; msg_id: string }
	| { kind: "reply"; target: string; msg_id: string; response: unknown }
	| { kind: "failed"; error: string };

async function runHubTask(input: {
	estate: string;
	explicitTarget?: string;
	prompt: string;
	responseSchema: object;
	budgetMs: number;
	conversationId?: string;
	config: PiComsConfig;
	deps: PiVerifierDeps;
}): Promise<HubOutcome> {
	const client = new PiComsClient(input.config, { fetchImpl: input.deps.fetchImpl, now: input.deps.now });
	try {
		await client.register();
		const agents = await client.listAgents();
		const resolved = resolvePiTarget(input.estate, agents, input.config, input.explicitTarget);
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
			return { kind: "queued", target: resolved.target, msg_id: queued.msg_id };
		}
		const sent = await client.send(resolved.target, input.prompt, {
			responseSchema: input.responseSchema,
			conversationId: input.conversationId,
		});
		// A "queued" status here means the agent's SSE stream is down although its
		// card is still online; the hub flushes the queue on reconnect, so wait for
		// it within the budget rather than mislabel it as a mailbox send.
		const reply = await client.awaitReply(sent.msg_id, input.budgetMs);
		if (reply.status !== "complete") {
			return {
				kind: "failed",
				error: `pi agent ${resolved.target} did not complete (${reply.status}): ${reply.error ?? "no detail"}`,
			};
		}
		return { kind: "reply", target: resolved.target, msg_id: sent.msg_id, response: reply.response };
	} catch (error) {
		return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
	} finally {
		await client.deregister();
	}
}

export async function executePiVerify(
	rawParams: Record<string, unknown>,
	reportContent: string,
	deps: PiVerifierDeps = {},
): Promise<PiActionOutcome> {
	const env = deps.env ?? process.env;
	if (!isPiComsConfigured(env)) return { status: "error", error: "pi-coms hub is not configured" };
	const parsed = PiVerifyParamsSchema.safeParse(rawParams);
	if (!parsed.success) return { status: "error", error: "verify-with-pi params invalid: estate is required" };
	const params = parsed.data;
	const config = resolvePiComsConfig(env);
	const outcome = await runHubTask({
		estate: params.estate,
		explicitTarget: params.target,
		prompt: buildVerifyPrompt({ params, report: reportContent }),
		responseSchema: PI_VERDICT_RESPONSE_SCHEMA,
		budgetMs: config.verifyTimeoutMs,
		config,
		deps,
	});
	if (outcome.kind === "failed") return { status: "error", error: outcome.error };
	if (outcome.kind === "queued") {
		return {
			status: "success",
			result: { kind: "queued", target: outcome.target, estate: params.estate, msg_id: outcome.msg_id },
		};
	}
	const verdict = PiVerdictSchema.safeParse(outcome.response);
	if (!verdict.success) {
		logger.warn({ target: outcome.target, msg_id: outcome.msg_id }, "pi verdict did not match schema");
		return { status: "error", error: `pi agent ${outcome.target} replied with an unusable verdict (schema mismatch)` };
	}
	const result: PiActionOutcome = {
		status: "success",
		result: {
			kind: "verdict",
			target: outcome.target,
			estate: params.estate,
			msg_id: outcome.msg_id,
			verdict: verdict.data,
		},
	};
	if (needsInvestigation(verdict.data)) {
		result.followUpActions = [buildInvestigateFollowUp(params, verdict.data, outcome.target, outcome.msg_id)];
	}
	return result;
}

export async function executePiInvestigate(
	rawParams: Record<string, unknown>,
	reportContent: string,
	deps: PiVerifierDeps = {},
): Promise<PiActionOutcome> {
	const env = deps.env ?? process.env;
	if (!isPiComsConfigured(env)) return { status: "error", error: "pi-coms hub is not configured" };
	const parsed = PiInvestigateParamsSchema.safeParse(rawParams);
	if (!parsed.success)
		return { status: "error", error: "investigate-with-pi params invalid: estate and focus are required" };
	const params = parsed.data;
	const config = resolvePiComsConfig(env);
	const outcome = await runHubTask({
		estate: params.estate,
		explicitTarget: params.target,
		prompt: buildInvestigatePrompt({ params, report: reportContent }),
		responseSchema: PI_INVESTIGATION_RESPONSE_SCHEMA,
		budgetMs: config.investigateTimeoutMs,
		conversationId: params.conversation_id,
		config,
		deps,
	});
	if (outcome.kind === "failed") return { status: "error", error: outcome.error };
	if (outcome.kind === "queued") {
		return {
			status: "success",
			result: { kind: "queued", target: outcome.target, estate: params.estate, msg_id: outcome.msg_id },
		};
	}
	const investigation = PiInvestigationSchema.safeParse(outcome.response);
	if (!investigation.success) {
		logger.warn({ target: outcome.target, msg_id: outcome.msg_id }, "pi investigation did not match schema");
		return {
			status: "error",
			error: `pi agent ${outcome.target} replied with an unusable investigation (schema mismatch)`,
		};
	}
	return {
		status: "success",
		result: {
			kind: "investigation",
			target: outcome.target,
			estate: params.estate,
			msg_id: outcome.msg_id,
			investigation: investigation.data,
		},
	};
}
