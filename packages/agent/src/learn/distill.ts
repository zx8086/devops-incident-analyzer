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
import { type HilDecisions, type HilItemEdits, type LearningProposal, LearningProposalSchema } from "./schema.ts";
import type { TicketResolution } from "./ticket.ts";

const logger = getLogger("agent:learn:distill");

const LEARNER_AGENT = "incident-analyzer";

export interface DistillerInput {
	ticket: TicketResolution;
	incidentSummary: string;
	existingRootCause: RootCause | null;
	runbookCatalog: Array<{ filename: string; title: string }>;
}

// Phase 2 (SIO-1127) activates bindings + heuristics with their writers. Every class is
// still gated by the verbatim-evidence verifier (verifyProposalEvidence), and a binding's
// resourceId must appear LITERALLY in the ticket or the verifier silently drops it.
const DISTILLER_PROMPT = `You distill a HUMAN-RESOLVED incident ticket into structured learnings for a DevOps incident-analysis agent's knowledge graph and memory.

The ticket description (and possibly some comments) contain the AGENT'S OWN incident reports. Later comments by humans contain the actual resolution: the corrected root cause, what fixed it, and which of the agent's hypotheses were wrong. Your job is to DIFF the agent's diagnosis against the human resolution.

Rules:
- Ground EVERY item in 1-3 VERBATIM quotes from the ticket (the "evidence" array). If you cannot quote it, do not emit it.
- rootCause: emit exactly one when the human comments establish (or correct) the cause; null when they do not. causeClass is a kebab-case class name for the cause pattern (not this specific ticket), e.g. "route53-resolver-rule-vpc-association-missing". description says what actually caused it; resolution says what fixed it (or the agreed fix). invalidatedHypotheses lists agent hypotheses the humans ruled out, with the reason.
- rootCause.runbookFilename: set ONLY when one of the provided catalog runbooks genuinely covers the fix; otherwise omit it.
- bindings: 0-10 telemetry-binding corrections the humans stated -- a service maps to (or NO LONGER maps to) a specific telemetry resource. action is "confirm" (the mapping is correct) or "invalidate" (the mapping is wrong/stale). service is the affected service name; datasource is one of elastic|aws|kafka|couchbase|konnect|gitlab|atlassian; bindingKind is the telemetry kind (e.g. logGroup, index, topic, cluster, bucket); resourceId is the concrete resource identifier. CRITICAL: resourceId MUST appear VERBATIM (character-for-character) in the ticket text -- copy it exactly, do not paraphrase, reformat, or infer it. locator is an optional scope (e.g. cluster id, region). reason states why, grounded in a quote. Omit any binding whose resourceId you cannot copy literally from the ticket.
- heuristics: 0-3 transferable diagnostic rules the humans taught (e.g. "a symptom that mimicked a different cause -> check X first"). name is a kebab-case skill name; description summarizes it; whenToUse names the trigger; procedure is the check to run. Only emit a heuristic the humans explicitly stated.
- memoryFacts: 1-6 durable, self-contained facts a future investigation of a SIMILAR incident should recall. Include transferable diagnostic lessons (e.g. why a symptom mimicked a different cause) and topology corrections stated by the humans. Each fact must stand alone without this ticket in front of the reader.
- Item ids: rc-1 for the root cause, bind-1..bind-N for bindings, heur-1..heur-N for heuristics, fact-1..fact-N for memory facts.

Return ONLY JSON, no prose:
{"ticketKey": "...", "rootCause": {"id": "rc-1", "kind": "root-cause", "causeClass": "...", "description": "...", "resolution": "...", "invalidatedHypotheses": [{"hypothesis": "...", "reason": "..."}], "runbookFilename": "...", "evidence": ["..."]} | null, "bindings": [{"id": "bind-1", "kind": "binding", "action": "confirm", "service": "...", "datasource": "...", "bindingKind": "...", "resourceId": "...", "locator": "...", "reason": "...", "evidence": ["..."]}], "heuristics": [{"id": "heur-1", "kind": "heuristic", "name": "...", "description": "...", "whenToUse": "...", "procedure": "...", "evidence": ["..."]}], "memoryFacts": [{"id": "fact-1", "kind": "memory-fact", "text": "...", "evidence": ["..."]}]}`;

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

// SIO-1131: the redacted human text is built ONCE and shared between the prompt
// and the evidence verifier -- verification must run against EXACTLY the string
// the model saw. A separate redaction pass over the ticket alone is not
// byte-identical (and quotes may legitimately come from the context block), so
// the original per-ticket haystack rejected every honest quote.
export function buildDistillerHumanText(input: DistillerInput): string {
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
	return redactPiiContent(`${context}\n\n${renderTicket(input.ticket)}`);
}

export function buildDistillerMessages(input: DistillerInput): BaseMessage[] {
	return [new SystemMessage(DISTILLER_PROMPT), new HumanMessage(buildDistillerHumanText(input))];
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
// the text the distiller saw -- hallucinated evidence must not reach the review
// card (CodeRabbit, PR #392). SIO-1131: the comparison is deliberately tolerant
// of the ways an HONEST quote diverges from the source string: markdown emphasis
// the model strips when quoting (**bold**, `code`), unicode punctuation folding
// (curly quotes, en/em dashes, ellipsis), and "..." elisions inside a quote.
function normalizeForEvidence(text: string): string {
	return (
		text
			.toLowerCase()
			// Fold unicode punctuation to the ascii the model may emit either way.
			.replace(/[‘’‚‛]/g, "'")
			.replace(/[“”„‟]/g, '"')
			.replace(/[–—−]/g, "-")
			.replace(/…/g, "...")
			// Strip markdown emphasis/code markers that quoting usually drops.
			.replace(/[*_`]/g, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

// A quote may elide with "..." -- EVERY non-empty fragment must occur (a short
// fabricated tail must not ride along on a grounded head -- CodeRabbit, PR #396);
// the length threshold only requires that at least one fragment is substantial
// enough to be meaningful grounding.
const MIN_FRAGMENT_CHARS = 12;
function quoteGrounded(quote: string, haystack: string): boolean {
	const normalized = normalizeForEvidence(quote);
	if (normalized.length === 0) return false;
	if (!/\.{3,}/.test(normalized)) return haystack.includes(normalized);
	const fragments = normalized
		.split(/\.{3,}/)
		.map((f) => f.trim())
		.filter(Boolean);
	return fragments.some((f) => f.length >= MIN_FRAGMENT_CHARS) && fragments.every((f) => haystack.includes(f));
}

export function verifyProposalEvidence(
	proposal: LearningProposal,
	promptText: string,
): { proposal: LearningProposal; droppedIds: string[] } {
	// SIO-1131: promptText is the SAME redacted string handed to the LLM
	// (buildDistillerHumanText) -- never a re-rendered/re-redacted copy.
	const haystack = normalizeForEvidence(promptText);
	const droppedIds: string[] = [];
	const keep = <T extends { id: string; evidence: string[] }>(item: T): boolean => {
		const grounded = item.evidence.every((quote) => quoteGrounded(quote, haystack));
		if (!grounded) droppedIds.push(item.id);
		return grounded;
	};
	// SIO-1127 (CodeRabbit PR #406): a binding is kept only if its evidence grounds AND its
	// resourceId appears LITERALLY in the prompt text. The evidence quotes alone are
	// insufficient -- a binding could carry grounded-but-unrelated evidence while its
	// resourceId was inferred/context-derived, persisting a resource id the ticket never named.
	const keepBinding = (b: (typeof proposal.bindings)[number]): boolean => {
		if (!keep(b)) return false;
		if (haystack.includes(normalizeForEvidence(b.resourceId))) return true;
		droppedIds.push(b.id);
		return false;
	};
	const rootCause = proposal.rootCause && keep(proposal.rootCause) ? proposal.rootCause : null;
	return {
		proposal: {
			...proposal,
			rootCause,
			bindings: proposal.bindings.filter(keepBinding),
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
		// SIO-1131: build the redacted prompt text ONCE; the verifier must check
		// quotes against exactly what the model saw.
		const input: DistillerInput = { ticket, incidentSummary, existingRootCause, runbookCatalog: catalog };
		const humanText = buildDistillerHumanText(input);
		const llm = createLlm("hilDistiller", LEARNER_AGENT);
		const result = await invokeWithDeadline(llm as InvokableLlm, "hilDistiller", [
			new SystemMessage(DISTILLER_PROMPT),
			new HumanMessage(humanText),
		]);
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
		const { proposal, droppedIds } = verifyProposalEvidence(parsed, humanText);
		if (droppedIds.length > 0) {
			logger.warn(
				{ ticket: ticket.key, droppedIds },
				"HIL proposal items dropped: evidence quotes not found in the distiller prompt text",
			);
		}
		// SIO-1127: bindings/heuristics count too -- a binding-only or heuristic-only
		// proposal is real learning that must reach the review card, not be treated as empty.
		const hasContent =
			proposal.rootCause !== null ||
			proposal.memoryFacts.length > 0 ||
			proposal.bindings.length > 0 ||
			proposal.heuristics.length > 0;
		if (!hasContent) {
			// SIO-1131: distinguish "verifier rejected everything" from "the ticket
			// genuinely has no resolution content" -- the former is our fault and
			// must not read like a ticket-lookup failure.
			const message =
				droppedIds.length > 0
					? `I read ${ticket.key} and distilled ${droppedIds.length} candidate learning(s), but none survived evidence verification (their quotes could not be matched to the ticket text). Nothing was recorded; please try again or report this if it persists.`
					: `I read ${ticket.key} but its content contains no human resolution to learn from (no corrected root cause, no durable facts). Nothing was recorded.`;
			return {
				messages: [new AIMessage(message)],
				...(droppedIds.length > 0
					? { partialFailures: [{ node: "learnDistill", reason: "evidence-verification-dropped-all" }] }
					: {}),
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
	edits?: HilItemEdits;
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

	return { hilDecisions: decision?.decisions ?? {}, hilEdits: decision?.edits ?? {} };
}
