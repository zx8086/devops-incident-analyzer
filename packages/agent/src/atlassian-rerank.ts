// agent/src/atlassian-rerank.ts
// SIO-1837: order the Atlassian findings card by what the incident is about.
//
// Relevance is decided twice today and neither step reads the incident. The MCP
// tool adds integers (label 3, service in text 2, each keyword 1) and cuts to
// `limit`; the extractor then drops anything without a structural hit. On the
// SIO-1802 run that returned 15 unrelated tickets ("styles scope" matching a
// ticket that said "Style" and "out of scope"); on SIO-1244 it dropped all 10
// while Atlassian was carrying the report.
//
// This runs in extractFindings, after aggregate, because that is the first place
// the incident text exists -- the tool only ever sees a service name and keywords.
// It reorders and hides rows on the CARD. The report is already written by then;
// re-ranking what the sub-agent reads is SIO-1845.
//
// Safety, the gaps-judge.ts shape: kill-switch defaulting ON, self-skip without a
// key, one deadline across all requests, and null on ANY failure so the caller
// keeps the deterministic list. The rerank can reorder the card; it can never
// leave it worse than the arithmetic did.
import { getLogger } from "@devops-agent/observability";
import type { AtlassianLinkedIssue } from "@devops-agent/shared";
import { redactPiiContent } from "@devops-agent/shared";
import type { AgentStateType } from "./state.ts";
import { askSystemOne, asScore, JEV_MODEL, resolveTypeSafeApiKey, type SystemOneResponse } from "./typesafe-client.ts";

const logger = getLogger("agent:atlassian-rerank");

// Default ON, kill-switch only: "false"/"0" disables. This is the repo rule for
// every capability flag, and it is not negotiable by a threshold being young --
// an opt-in feature nobody enables is dead code, so an untuned constant is a
// reason to tune it (SIO-1861) or watch the decision metrics, never a reason to
// hide the feature. PR #869 shipped this opt-in on a reviewer's objection and it
// was wrong. Read at call time: no module-scope env reads in packages/agent.
export function isAtlassianRerankEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.ATLASSIAN_RERANK_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}

// One deadline for the whole fan-out, not per request: the caller is a node in a
// turn that has already streamed its report, so the bound that matters is how
// long the card can lag behind it.
export const RERANK_DEADLINE_MS = 3000;

// Below this the ticket is hidden from the card. Level 1 is "generic overlap
// only", so 1.0 keeps anything that shares a real subject and drops the
// "out of scope"/"sprint retrospective" shapes that motivated SIO-1802.
//
// SIO-1861: CALIBRATED against real envelopes (findLinkedIncidents service=kafka,
// 7 live PVH tickets, all with the SAME deterministic score of 2) across three
// incidents. The kept/dropped gap straddles 1.0 with room on both sides:
//   kafka-connect sink failure  kept >= 1.04, dropped <= 0.75
//   storefront -> Mule outage   kept >= 1.20, dropped <= 0.81
//   elasticsearch yellow shards all 7 dropped, <= 0.34 (correctly shows nothing)
// Scores track the INCIDENT, not the ticket: DES-783 moves 0.73 -> 0.22 -> 0.05
// across those three, and EPS-28 reads 3.00 at confidence 1.00 against the
// outage it actually describes. Round-trip latency 659-1027 ms for 7 tickets,
// inside RERANK_DEADLINE_MS.
export const RERANK_DROP_BELOW = 1.0;

// The state we send is capped hard. Jev loses accuracy as the state grows with
// material the question does not need (vendor-documented context rot), and the
// hard API limit is 32k tokens for state plus the longest question.
const INCIDENT_QUERY_MAX_CHARS = 1200;
const TICKET_SUMMARY_MAX_CHARS = 300;
const TICKET_EXCERPT_MAX_CHARS = 600;

const RELEVANCE_CRITERIA = [
	"Unrelated: a different system and a different failure",
	"Shares only generic words, or the same broad platform, but not the incident's subject",
	"The same service or component, but a different failure",
	"The same service and the same failure mode",
];

const RELEVANCE_QUESTION_ID = "relatedness";

/** First paragraph of a markdown report, headings stripped. */
function firstParagraph(report: string): string {
	const body = report.replace(/^#.*$/gm, "").trim();
	const para = body.split(/\n\s*\n/)[0] ?? "";
	return para.replace(/\s+/g, " ");
}

/**
 * What the incident is about, in the least text that says it.
 *
 * Deliberately not the whole report: the question is "does this ticket describe
 * the same failure", and a full report drags in every datasource's findings as
 * distractors. PII-redacted because this leaves the account.
 */
export function buildIncidentQuery(
	// Partial, not Pick: every field it reads is optional on a real turn (a first
	// turn has no finalAnswer, an unfocused one no normalizedIncident), and the
	// caller passes the live state object either way.
	state: Partial<Pick<AgentStateType, "normalizedIncident" | "investigationFocus" | "finalAnswer">>,
	focusServices: string[],
): string {
	const parts: string[] = [];
	if (focusServices.length > 0) parts.push(`Services: ${focusServices.join(", ")}`);
	const severity = state.normalizedIncident?.severity;
	if (severity) parts.push(`Severity: ${severity}`);
	const summary = state.finalAnswer ? firstParagraph(state.finalAnswer) : "";
	if (summary) parts.push(summary);
	const joined = parts.join(". ").replace(/\s+/g, " ").trim();
	return redactPiiContent(joined).slice(0, INCIDENT_QUERY_MAX_CHARS);
}

function ticketState(issue: AtlassianLinkedIssue): Record<string, string> {
	const ticket: Record<string, string> = {
		summary: redactPiiContent(issue.summary).slice(0, TICKET_SUMMARY_MAX_CHARS),
	};
	if (issue.descriptionExcerpt) {
		ticket.description = redactPiiContent(issue.descriptionExcerpt).slice(0, TICKET_EXCERPT_MAX_CHARS);
	}
	return ticket;
}

export interface RerankOutcome {
	issues: AtlassianLinkedIssue[];
	dropped: number;
	model: string;
	inputTokens: number;
	latencyMs: number;
	/** Spearman input: the deterministic order, and the order Jev produced. */
	deterministicRanks: number[];
	jevRanks: number[];
}

export type AskSystemOne = typeof askSystemOne;

/**
 * Score each ticket against the incident and return them ordered, sub-threshold
 * ones removed. Returns null on any failure, which means "use the list you
 * already have".
 *
 * One request per ticket rather than one request listing all of them: the
 * judgement is about a pair, and the other tickets in a shared state would be
 * distractors. They run in parallel under a single deadline.
 */
export async function rerankLinkedIssues(
	issues: AtlassianLinkedIssue[],
	incidentQuery: string,
	deps: { apiKey: string; ask?: AskSystemOne; signal?: AbortSignal },
): Promise<RerankOutcome | null> {
	if (issues.length === 0 || incidentQuery.length === 0) return null;
	const ask = deps.ask ?? askSystemOne;
	const started = Date.now();
	const signal = deps.signal ?? AbortSignal.timeout(RERANK_DEADLINE_MS);

	let responses: SystemOneResponse[];
	try {
		responses = await Promise.all(
			issues.map((issue) =>
				ask({
					state: { incident: incidentQuery, ticket: ticketState(issue) },
					questions: {
						[RELEVANCE_QUESTION_ID]: {
							type: "score",
							instructions: "How closely does `ticket` describe the same failure as `incident`?",
							criteria: RELEVANCE_CRITERIA,
						},
					},
					apiKey: deps.apiKey,
					signal,
				}),
			),
		);
	} catch (error) {
		// Promise.all rejects on the FIRST failure, so a single bad response
		// discards the whole round. Deliberate: a partially scored list would mix
		// judged and unjudged tickets in one ordering, which is worse than the
		// arithmetic it replaces because the result would look ranked.
		logger.warn(
			{
				event: "atlassian.rerank_failed",
				issueCount: issues.length,
				durationMs: Date.now() - started,
				error: error instanceof Error ? error.message : String(error),
			},
			"Atlassian rerank failed; keeping the deterministic order",
		);
		return null;
	}

	const scored = issues.map((issue, i) => {
		// asScore, not a cast: the response is untrusted input, and a Noul answer
		// under this id would otherwise read as score: undefined and be treated as a
		// missing verdict rather than a wrong-shaped one. Either way it voids the
		// round below, but the narrowing is what makes that true by construction.
		const answer = asScore(responses[i]?.answers[RELEVANCE_QUESTION_ID]);
		return {
			issue,
			score: answer?.score,
			confidence: answer?.confidence,
			deterministicRank: i,
		};
	});
	// A response that parsed but carried no answer under our question id would
	// leave a ticket unjudged; treat that like any other failure rather than
	// ranking it as 0 and hiding it.
	if (scored.some((s) => s.score === undefined)) {
		logger.warn(
			{ event: "atlassian.rerank_incomplete", issueCount: issues.length },
			"Atlassian rerank answer missing; keeping the deterministic order",
		);
		return null;
	}

	const kept = scored
		.filter((s) => (s.score as number) >= RERANK_DROP_BELOW)
		// Score descending only. Equal scores keep the tool's own order because
		// Array.prototype.sort is stable (ECMA-262 since ES2019, verified on this
		// runtime) and `scored` is built in the tool's order. An explicit
		// `|| a.deterministicRank - b.deterministicRank` was here and removed: it
		// could never change an outcome, so no test could ever catch its deletion,
		// which makes it a comment pretending to be code.
		.sort((a, b) => (b.score as number) - (a.score as number));

	const model = responses[0]?.model ?? JEV_MODEL;
	const inputTokens = responses.reduce((sum, r) => sum + (r.usage?.input_tokens ?? 0), 0);

	return {
		issues: kept.map((s) => ({
			...s.issue,
			relevance: s.score as number,
			...(s.confidence !== undefined ? { relevanceConfidence: s.confidence } : {}),
		})),
		dropped: issues.length - kept.length,
		model,
		inputTokens,
		latencyMs: Date.now() - started,
		deterministicRanks: kept.map((s) => s.deterministicRank),
		jevRanks: kept.map((_, i) => i),
	};
}

export { resolveTypeSafeApiKey };
