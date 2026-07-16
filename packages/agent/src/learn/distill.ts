// agent/src/learn/distill.ts
//
// SIO-1126: the HIL distiller. Diffs the agent's original diagnosis (the ticket
// description / earlier agent-authored comments) against the later human
// resolution comments and emits a structured, evidence-grounded
// LearningProposal. Compute node only -- the review interrupt lives in
// learnReviewGate so a resume never re-runs the LLM call.

import { getGraphStore, type RootCause, rootCauseForIncident } from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { redactPiiContent } from "@devops-agent/shared";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { interrupt } from "@langchain/langgraph";
import { createLlm, type InvokableLlm, invokeWithDeadline } from "../llm.ts";
import { searchAgentMemory } from "../memory-backend.ts";
import { getRunbookCatalog } from "../prompt-context.ts";
import type { AgentStateType } from "../state.ts";
import { type HilDecisions, type LearningProposal, LearningProposalSchema } from "./schema.ts";
import type { TicketResolution } from "./ticket.ts";

const logger = getLogger("agent:learn:distill");

const LEARNER_AGENT = "incident-analyzer";

export interface DistillerInput {
	ticket: TicketResolution;
	incidentSummary: string;
	existingRootCause: RootCause | null;
	runbookCatalog: Array<{ filename: string; title: string }>;
}

// Phase 1 (SIO-1126) emits rootCause + memoryFacts; bindings/heuristics activate
// in Phase 2 (SIO-1127) with their writers -- until then the distiller must
// return them empty so the review card never shows items that cannot be applied.
const DISTILLER_PROMPT = `You distill a HUMAN-RESOLVED incident ticket into structured learnings for a DevOps incident-analysis agent's knowledge graph and memory.

The ticket description (and possibly some comments) contain the AGENT'S OWN incident reports. Later comments by humans contain the actual resolution: the corrected root cause, what fixed it, and which of the agent's hypotheses were wrong. Your job is to DIFF the agent's diagnosis against the human resolution.

Rules:
- Ground EVERY item in 1-3 VERBATIM quotes from the ticket (the "evidence" array). If you cannot quote it, do not emit it.
- rootCause: emit exactly one when the human comments establish (or correct) the cause; null when they do not. causeClass is a kebab-case class name for the cause pattern (not this specific ticket), e.g. "route53-resolver-rule-vpc-association-missing". description says what actually caused it; resolution says what fixed it (or the agreed fix). invalidatedHypotheses lists agent hypotheses the humans ruled out, with the reason.
- rootCause.runbookFilename: set ONLY when one of the provided catalog runbooks genuinely covers the fix; otherwise omit it.
- memoryFacts: 1-6 durable, self-contained facts a future investigation of a SIMILAR incident should recall. Include transferable diagnostic lessons (e.g. why a symptom mimicked a different cause) and topology corrections stated by the humans. Each fact must stand alone without this ticket in front of the reader.
- bindings and heuristics MUST be empty arrays in this version.
- Item ids: rc-1 for the root cause, fact-1..fact-N for memory facts.

Return ONLY JSON, no prose:
{"ticketKey": "...", "rootCause": {"id": "rc-1", "kind": "root-cause", "causeClass": "...", "description": "...", "resolution": "...", "invalidatedHypotheses": [{"hypothesis": "...", "reason": "..."}], "runbookFilename": "...", "evidence": ["..."]} | null, "bindings": [], "heuristics": [], "memoryFacts": [{"id": "fact-1", "kind": "memory-fact", "text": "...", "evidence": ["..."]}]}`;

function renderTicket(ticket: TicketResolution): string {
	const lines = [
		`Ticket ${ticket.key}: ${ticket.summary}`,
		`Status: ${ticket.status}${ticket.resolutionDate ? ` (resolved ${ticket.resolutionDate})` : ""}`,
		"",
		"--- DESCRIPTION ---",
		ticket.description,
	];
	for (const [i, c] of ticket.comments.entries()) {
		lines.push("", `--- COMMENT ${i + 1} by ${c.author || "unknown"} at ${c.createdAt} ---`, c.body);
	}
	return lines.join("\n");
}

export function buildDistillerMessages(input: DistillerInput): BaseMessage[] {
	const context = [
		input.incidentSummary
			? `Matched stored incident: ${input.incidentSummary}`
			: "No stored incident matched; a new incident record will be created.",
		input.existingRootCause
			? `Currently recorded root cause (machine-derived, will be replaced by a correction): ${input.existingRootCause.class} -- ${input.existingRootCause.description}`
			: "No root cause is currently recorded for this incident.",
		input.runbookCatalog.length > 0
			? `Runbook catalog (for runbookFilename, only if one genuinely covers the fix): ${input.runbookCatalog.map((r) => `${r.filename} (${r.title})`).join("; ")}`
			: "Runbook catalog is empty; omit runbookFilename.",
	].join("\n");

	// Redact before the LLM call; persistence redacts again (recordKeyDecision),
	// so PII never depends on a single layer (the skill-learner double guarantee).
	return [
		new SystemMessage(DISTILLER_PROMPT),
		new HumanMessage(redactPiiContent(`${context}\n\n${renderTicket(input.ticket)}`)),
	];
}

export function parseLearningProposal(raw: string): LearningProposal | null {
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		const result = LearningProposalSchema.safeParse(JSON.parse(match[0]));
		if (!result.success) {
			logger.warn({ issues: result.error.issues.slice(0, 3) }, "learning proposal failed schema validation");
			return null;
		}
		return result.data;
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "learning proposal parse failed");
		return null;
	}
}

// Deterministic filter-only lookup: has this ticket already been learned from?
// A hit does NOT block re-learning -- it surfaces on the review gate and makes
// applyLearnings skip fact re-writes (immutable facts would double). On a thrown
// lookup error we fail CLOSED (treat as already learned): skipping a fact write
// is recoverable, doubling an immutable fact is not (CodeRabbit, PR #392).
// Residual limit: searchAgentMemory itself soft-fails to [] internally, which is
// indistinguishable from a genuine miss here.
async function ticketAlreadyLearned(ticketKey: string): Promise<boolean> {
	try {
		const hits = await searchAgentMemory(LEARNER_AGENT, "", { kind: "hil-resolution", ticket: ticketKey }, 1, {
			deterministic: true,
		});
		return hits.length > 0;
	} catch (error) {
		logger.warn(
			{ ticket: ticketKey, error: error instanceof Error ? error.message : String(error) },
			"HIL dedup lookup failed; failing closed (fact writes will be skipped)",
		);
		return true;
	}
}

// Drop proposal items whose "verbatim" evidence quotes do not actually occur in
// the ticket text the distiller saw -- hallucinated evidence must not reach the
// review card (CodeRabbit, PR #392). Comparison is whitespace/case-normalized
// against the SAME redacted rendering handed to the LLM.
function normalizeForEvidence(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function verifyProposalEvidence(
	proposal: LearningProposal,
	ticket: TicketResolution,
): { proposal: LearningProposal; droppedIds: string[] } {
	const haystack = normalizeForEvidence(redactPiiContent(renderTicket(ticket)));
	const droppedIds: string[] = [];
	const keep = <T extends { id: string; evidence: string[] }>(item: T): boolean => {
		const grounded = item.evidence.every((quote) => haystack.includes(normalizeForEvidence(quote)));
		if (!grounded) droppedIds.push(item.id);
		return grounded;
	};
	const rootCause = proposal.rootCause && keep(proposal.rootCause) ? proposal.rootCause : null;
	return {
		proposal: {
			...proposal,
			rootCause,
			bindings: proposal.bindings.filter(keep),
			heuristics: proposal.heuristics.filter(keep),
			memoryFacts: proposal.memoryFacts.filter(keep),
		},
		droppedIds,
	};
}

// learnDistill node: LLM call + proposal parse. On failure the lane ends with a
// user-facing message (hilProposal stays unset; the gate and apply self-skip).
export async function learnDistill(state: AgentStateType): Promise<Partial<AgentStateType>> {
	const ticket = state.hilTicket;
	const match = state.hilMatch;
	if (!ticket || !match) return {};

	let existingRootCause: RootCause | null = null;
	let incidentSummary = "";
	if (!match.created) {
		try {
			const store = await getGraphStore();
			existingRootCause = await rootCauseForIncident(store, match.incidentId);
			incidentSummary = state.hilMatchCandidates.find((c) => c.id === match.incidentId)?.summary ?? "";
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"existing root-cause read failed; distilling without it",
			);
		}
	}

	const alreadyLearned = await ticketAlreadyLearned(ticket.key);

	let catalog: Array<{ filename: string; title: string }> = [];
	try {
		catalog = getRunbookCatalog().map((r) => ({ filename: r.filename, title: r.title }));
	} catch {
		// no catalog (agent without runbooks) -- the distiller omits runbookFilename
	}

	try {
		const llm = createLlm("hilDistiller", LEARNER_AGENT);
		const result = await invokeWithDeadline(
			llm as InvokableLlm,
			"hilDistiller",
			buildDistillerMessages({ ticket, incidentSummary, existingRootCause, runbookCatalog: catalog }),
		);
		const content = typeof result.content === "string" ? result.content : "";
		const parsed = parseLearningProposal(content);
		if (!parsed) {
			return {
				messages: [
					new AIMessage(
						`I fetched ${ticket.key} but could not distill a well-formed learning proposal from it. Nothing was recorded.`,
					),
				],
				partialFailures: [{ node: "learnDistill", reason: "proposal-parse-failed" }],
			};
		}
		const { proposal, droppedIds } = verifyProposalEvidence(parsed, ticket);
		if (droppedIds.length > 0) {
			logger.warn(
				{ ticket: ticket.key, droppedIds },
				"HIL proposal items dropped: evidence quotes not found in the ticket text",
			);
		}
		if (!proposal.rootCause && proposal.memoryFacts.length === 0) {
			return {
				messages: [
					new AIMessage(
						`I read ${ticket.key} but found no grounded human resolution content to learn from (no corrected root cause, no durable facts with verifiable evidence). Nothing was recorded.`,
					),
				],
			};
		}
		logger.info(
			{ ticket: ticket.key, rootCause: proposal.rootCause?.causeClass ?? null, facts: proposal.memoryFacts.length },
			"HIL learning proposal distilled",
		);
		return { hilProposal: { ...proposal, ticketKey: ticket.key }, hilAlreadyLearned: alreadyLearned };
	} catch (error) {
		// Log the provider detail; keep the chat message generic (no internal
		// exception text reflected to the user -- CodeRabbit, PR #392).
		const message = error instanceof Error ? error.message : String(error);
		logger.warn({ ticket: ticket.key, error: message }, "HIL distiller invocation failed");
		return {
			messages: [
				new AIMessage(`Distilling learnings from ${ticket.key} failed. Nothing was recorded; please try again.`),
			],
			partialFailures: [{ node: "learnDistill", reason: "distiller-failed" }],
		};
	}
}

export interface HilReviewDecision {
	decisions: HilDecisions;
}

// learnReviewGate node: interrupt #2 -- per-item approve/reject. Gate only.
// SIO-1130: the payload carries the matched investigation (and whether it was
// auto-confirmed by the ticket-mention pin) so the human still SEES the linkage
// before anything is written, even when the match gate never interrupted.
export function learnReviewGate(state: AgentStateType): Partial<AgentStateType> {
	const proposal = state.hilProposal;
	if (!proposal) return {};

	const match = state.hilMatch;
	const matchedIncidentSummary = match?.created
		? undefined
		: state.hilMatchCandidates.find((c) => c.id === match?.incidentId)?.summary;

	const decision = interrupt({
		type: "hil_learning_review",
		ticketKey: proposal.ticketKey,
		proposal,
		alreadyLearned: state.hilAlreadyLearned === true,
		...(matchedIncidentSummary !== undefined && { matchedIncidentSummary }),
		autoMatched: match?.auto === true,
		matchCreated: match?.created === true,
		message: `Review the learnings distilled from ${proposal.ticketKey}. Approved items are written to the knowledge graph and agent memory.`,
	}) as HilReviewDecision;

	return { hilDecisions: decision?.decisions ?? {} };
}
