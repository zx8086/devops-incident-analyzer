// agent/src/skill-learner.ts
//
// SIO-1015: the skill-learning subsystem. After a completed turn, judge whether
// the task exercised a reusable, effective pattern worth crystallizing. Worthy
// patterns are written as durable agent-memory facts (kind:skill) carrying the
// gitagent.sh learning fields as annotations. PROPOSE-ONLY: nothing is auto-loaded
// into prompts; a human promotes a candidate (the SIO-1891 review pane, the
// skill:promote CLI, or the HIL lane's PR).
//
// SIO-1889: runs for EVERY top-level agent, not only the orchestrator. Turns
// carry either a confidence signal (incident-analyzer) or a turn outcome (the
// others); a Jev gate (learning-gate.ts) runs before the full-model judge; the
// fact is a LearningCandidate with beacon's state fields, and the judge must
// quote its evidence from the transcript.

import { getLogger } from "@devops-agent/observability";
import { type AnnotationMap, redactPiiContent } from "@devops-agent/shared";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { recordDecision } from "./decision-recorder.ts";
import { gateLearning, type LearningGateResult, transcriptToEvents } from "./learning-gate.ts";
import { createLlm, type InvokableLlm, invokeWithDeadline } from "./llm.ts";
import { parseLlmJson } from "./llm-json.ts";
import {
	dedupePreferring,
	enqueueFact,
	getActiveMemoryRef,
	type MemorySearchHit,
	recordAgentFactNow,
	resolveUserId,
	searchAgentMemory,
	selectedBackend,
} from "./memory-backend.ts";
import { extractTextFromContent } from "./message-utils.ts";

const logger = getLogger("agent:skill-learner");

// Pre-gate thresholds for a confidence-bearing turn. Below this confidence a
// turn is too uncertain to be a model worth keeping; fewer than this many
// distinct datasources is too trivial.
const MIN_CONFIDENCE = 0.6;
const MIN_DISTINCT_DATASOURCES = 2;

// SIO-1889: default ON with kill-switch semantics (the HIL_LEARNING_ENABLED
// idiom). Availability still follows infrastructure: the learner is a no-op on
// the file backend, where there is nowhere to store a candidate fact.
export function isSkillLearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.SKILL_LEARNING_ENABLED;
	return v !== "false" && v !== "0";
}

// The completed-turn snapshot the learner needs. Read by the caller (the web app
// owns the graphs) and injected here so this module never imports the runtime
// layer. A turn carries ONE success signal: confidenceScore (+ datasourcesUsed)
// for the orchestrator, or outcome for an agent without a confidence score.
export interface SkillLearnerTurn {
	agentName: string;
	threadId: string;
	queryComplexity: "simple" | "complex";
	confidenceScore?: number;
	// distinct dataSourceIds that actually produced tool output this turn
	datasourcesUsed: string[];
	// SIO-1889: the graph's own terminal outcome for agents without a confidence
	// score ("completed" is the only value that passes the pre-gate).
	outcome?: string;
	// a compact transcript of the turn (user asks + assistant report). May contain
	// PII as built by the caller; every model or storage path redacts it here.
	transcript: string;
}

// The judge's structured verdict. `worthy:false` ends the flow; otherwise the
// remaining fields become the crystallized proposal.
export const SkillProposalSchema = z.object({
	worthy: z.boolean(),
	name: z
		.string()
		.regex(/^[a-z0-9-]+$/)
		.optional(),
	description: z.string().optional(),
	when_to_use: z.string().optional(),
	procedure_summary: z.string().optional(),
	task_category: z.string().optional(),
	// SIO-1889: verbatim quotes from the transcript that ground the lesson.
	evidence: z.array(z.string()).optional(),
});
export type SkillProposal = z.infer<typeof SkillProposalSchema>;

// SIO-1889: the unified candidate record (agent-beacon's candidate -> approved |
// rejected | superseded model) as it lives in the agent-memory fact stream. The
// string fields below are annotations; title/applicability/body/evidence are
// rendered into the fact text (buildSkillFactText) and parsed back by
// skill-promote.ts. Facts are immutable, so a state change is a NEW fact with
// the same skill_name and a later learned_at; readers keep the latest.
export const CANDIDATE_STATUSES = ["candidate", "approved", "rejected", "superseded"] as const;
export const CANDIDATE_SOURCES = ["turn", "hil", "reflect", "fleet"] as const;
export const TASK_SUCCESS_SOURCES = ["", "jev", "feedback", "hil", "turn-outcome", "fleet-verdict", "reflect"] as const;

export const LearningCandidateSchema = z.object({
	kind: z.enum(["skill", "runbook"]),
	skill_name: z.string().regex(/^[a-z0-9-]+$/),
	// Imperative, short (beacon's lesson-quality rubric).
	title: z.string().min(1).max(80),
	// Starts with when / before / after.
	applicability: z.string().min(1),
	// What to do, why, how to confirm.
	body: z.string().min(1),
	evidence: z
		.array(z.object({ ref: z.string(), excerpt: z.string().max(400) }))
		.min(1)
		.max(5),
	source: z.enum(CANDIDATE_SOURCES),
	learned_from: z.string().min(1),
	status: z.enum(CANDIDATE_STATUSES),
	task_success: z.enum(["", "0", "1"]),
	// Precedence when several arrive: feedback > hil > turn-outcome / fleet-verdict > jev.
	task_success_source: z.enum(TASK_SUCCESS_SOURCES),
	supersedes: z.string().optional(),
	// runbook kind only: the knowledge dir the approved markdown lands in.
	target_dir: z.string().optional(),
	agent: z.string().min(1),
});
export type LearningCandidate = z.infer<typeof LearningCandidateSchema>;

const JUDGE_PROMPT = `You evaluate a completed turn of a DevOps agent (incident analysis, Elastic infrastructure-as-code, AWS landing-zone Terraform, or fleet operations) and decide whether it exercised a REUSABLE, effective pattern worth saving as a new skill for future turns.

Say worthy:true ONLY when the turn followed a generalizable procedure that would help a similar future task (e.g. "correlate Kafka consumer lag with downstream Elasticsearch error spikes"). Say worthy:false for one-off lookups, trivial questions, failed/uncertain work, or anything too specific to this turn to reuse.

When worthy, return:
- "name": kebab-case
- "description": ONE imperative sentence under 80 characters saying what the skill does
- "when_to_use": the trigger condition, starting with "When", "Before" or "After"
- "procedure_summary": the steps, 1-4 sentences: what to do, why, and how to confirm it worked
- "task_category": e.g. "lag-correlation", "error-triage"
- "evidence": 1-3 SHORT quotes copied VERBATIM from the transcript that show the pattern being used

Return ONLY JSON, no prose:
{"worthy": true|false, "name": "...", "description": "...", "when_to_use": "...", "procedure_summary": "...", "task_category": "...", "evidence": ["..."]}`;

// Cheap pre-LLM gates: only spend a judge call on turns that could plausibly
// yield a reusable skill. Returns a skip reason (for logging) or null to proceed.
export function preGateSkip(turn: SkillLearnerTurn): string | null {
	if (turn.queryComplexity !== "complex") return "simple turn";
	if (turn.confidenceScore !== undefined) {
		if (turn.confidenceScore < MIN_CONFIDENCE) return `confidence ${turn.confidenceScore} < ${MIN_CONFIDENCE}`;
		const distinct = new Set(turn.datasourcesUsed).size;
		if (distinct < MIN_DISTINCT_DATASOURCES) return `only ${distinct} datasource(s) used`;
		return null;
	}
	// SIO-1889: no confidence signal -> the graph's own outcome is the gate.
	if (turn.outcome !== "completed") return `turn outcome ${turn.outcome ?? "unknown"}`;
	return null;
}

function parseProposal(raw: string): SkillProposal | null {
	// Tolerate fenced/garnished JSON and control chars echoed into string values.
	const result = parseLlmJson(raw, SkillProposalSchema);
	if (!result.ok) {
		// SIO-1221: the no-JSON case previously returned null with no log at all, so a
		// judge that stopped emitting JSON looked identical to a "not worthy" verdict.
		logger.warn({ reason: result.reason, detail: result.message }, "skill proposal parse failed");
		return null;
	}
	return result.data;
}

// The exact text handed to the LLM judge: the transcript, capped and PII-redacted.
// The caller is not trusted to have redacted, and the judge input is just as
// sensitive as the persisted body. Exported so the redaction guarantee is testable
// without depending on the (process-global) LLM mock.
const MAX_TRANSCRIPT_CHARS = 6000;
export function redactForJudge(transcript: string): string {
	return redactPiiContent(transcript.slice(0, MAX_TRANSCRIPT_CHARS));
}

// SIO-1889: a quote the judge did not actually copy from the transcript is not
// evidence. Whitespace-normalised substring check; nothing fuzzier, so a
// paraphrase never passes as a citation. Greptile PR #917: only the ASSISTANT's
// part of the transcript grounds a lesson -- a procedure the user merely stated
// is a claim, not observed work. The caller's transcript labels turns
// "User:" / "Assistant:" (readCompletedTurn); with no such labels the whole text
// is treated as the agent's.
export function assistantText(transcript: string): string {
	const parts = transcript.split(/(?=^(?:User|Assistant):)/m);
	const assistant = parts.filter((p) => p.startsWith("Assistant:"));
	return assistant.length > 0 ? assistant.join("\n") : transcript;
}

export function verifyEvidence(quotes: string[] | undefined, redactedTranscript: string): string[] {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
	const haystack = norm(assistantText(redactedTranscript));
	return (quotes ?? []).map((q) => q.trim()).filter((q) => q.length >= 8 && haystack.includes(norm(q)));
}

// Asks the LLM judge whether this turn is worth crystallizing. Returns a worthy,
// well-formed proposal (with only VERIFIED evidence) or null. Best-effort: any
// error yields null.
export async function judgeTurn(turn: SkillLearnerTurn): Promise<SkillProposal | null> {
	try {
		const llm = createLlm("skillLearner", turn.agentName);
		const redacted = redactForJudge(turn.transcript);
		const result = await invokeWithDeadline(llm as InvokableLlm, "skillLearner", [
			new SystemMessage(JUDGE_PROMPT),
			new HumanMessage(redacted),
		]);
		// SIO-1222: an empty string here silently disabled skill learning entirely.
		const content = extractTextFromContent(result.content);
		const proposal = parseProposal(content);
		if (!proposal?.worthy) return null;
		// A worthy verdict must carry at least a name + description to be useful.
		if (!proposal.name || !proposal.description) {
			logger.info("skill judge returned worthy without name/description; skipping");
			return null;
		}
		return { ...proposal, evidence: verifyEvidence(proposal.evidence, redacted) };
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "skill judge invocation failed");
		return null;
	}
}

// SIO-1889: beacon's lesson-quality rubric as a checklist. A candidate that fails
// it is not stored; the reason is recorded so the judge prompt can be tuned from
// the decision_metrics table rather than from anecdotes.
export const TITLE_MAX_CHARS = 80;
export const APPLICABILITY_LEAD = /^(when|before|after)\b/i;
export const BODY_MIN_CHARS = 40;
export const BODY_MAX_CHARS = 2000;

export function lessonQuality(proposal: SkillProposal): { ok: true } | { ok: false; reason: string } {
	const title = proposal.description?.trim() ?? "";
	if (title.length === 0 || title.length > TITLE_MAX_CHARS) return { ok: false, reason: "title" };
	if (!APPLICABILITY_LEAD.test(proposal.when_to_use?.trim() ?? "")) return { ok: false, reason: "applicability" };
	const body = proposal.procedure_summary?.trim() ?? "";
	if (body.length < BODY_MIN_CHARS || body.length > BODY_MAX_CHARS) return { ok: false, reason: "body" };
	if ((proposal.evidence?.length ?? 0) === 0) return { ok: false, reason: "evidence" };
	return { ok: true };
}

// Dedup: agent-memory facts are durable + undeletable, so a re-record permanently
// doubles a proposal. Skip if a kind:skill fact with this skill_name already exists
// (deterministic filter-only lookup, same idiom as the iac-change recall).
// SIO-1127: exported as skillProposalExists so the HIL learning apply path dedups
// heuristic-derived skill proposals against the same store.
export async function skillProposalExists(skillName: string, agentName = "incident-analyzer"): Promise<boolean> {
	const hits = await searchAgentMemory(agentName, "", { kind: "skill", skill_name: skillName }, 1, {
		deterministic: true,
	});
	return hits.length > 0;
}

// SIO-1345 / SIO-1889: discovery for the promotion flow and the review pane. A
// deterministic filter-only listing of the candidate facts for an agent, collapsed
// to the LATEST fact per skill_name (a state transition is a newer fact with the
// same name), optionally filtered by status. The pure summarizer is split out so it
// is testable without the backend; its parameter type is structural so tests
// never import memory-backend types (MemorySearchHit satisfies it).
export interface SkillProposalSummary {
	name: string;
	category: string;
	learnedAt: string;
	learnedFrom: string;
	status: string;
	source: string;
	taskSuccess: string;
	taskSuccessSource: string;
	kind: string;
	text: string;
}

export function summarizeSkillProposalHits(
	hits: Array<{ text: string; annotations: Record<string, string | undefined> }>,
): SkillProposalSummary[] {
	return hits
		.map((h) => ({
			name: h.annotations.skill_name ?? "",
			category: h.annotations.task_category ?? "",
			learnedAt: h.annotations.learned_at ?? "",
			learnedFrom: h.annotations.learned_from ?? "",
			// Facts written before SIO-1889 carry no status: they are candidates.
			status: h.annotations.status ?? "candidate",
			source: h.annotations.source ?? "turn",
			taskSuccess: h.annotations.task_success ?? "",
			taskSuccessSource: h.annotations.task_success_source ?? "",
			kind: h.annotations.kind ?? "skill",
			text: h.text,
		}))
		.filter((p) => p.name !== "");
}

// Latest fact per skill_name wins; learned_at is ISO so string order is time order.
export function latestPerSkill(hits: MemorySearchHit[]): MemorySearchHit[] {
	return dedupePreferring(
		hits,
		(h) => h.annotations.skill_name || undefined,
		(h) => Date.parse(h.annotations.learned_at ?? "") || 0,
	);
}

export async function listLearningCandidates(
	agentName: string,
	opts: { status?: (typeof CANDIDATE_STATUSES)[number]; kind?: "skill" | "runbook" } = {},
): Promise<SkillProposalSummary[]> {
	const hits: MemorySearchHit[] = [];
	for (const kind of opts.kind ? [opts.kind] : ["skill", "runbook"]) {
		hits.push(...(await searchAgentMemory(agentName, "", { kind }, 64, { deterministic: true })));
	}
	const summaries = summarizeSkillProposalHits(latestPerSkill(hits));
	return opts.status ? summaries.filter((s) => s.status === opts.status) : summaries;
}

// Kept for the SIO-1345 CLI: the candidates of one agent, any status.
export async function listSkillProposals(agentName = "incident-analyzer"): Promise<SkillProposalSummary[]> {
	return listLearningCandidates(agentName);
}

// Build the durable-fact annotations carrying the gitagent.sh learning fields.
// All values are strings (AnnotationMap). confidence is SEEDED, not measured —
// there is no live success/failure feedback loop against immutable facts (SIO-1015
// known limit), so counts start at 0 and the human promoter owns the rest.
// SIO-1127: learnedFrom overrides the default `thread:<id>` provenance so the HIL
// learning path can stamp `ticket:<key>` instead.
// SIO-1889: `overrides` sets the candidate state fields (status / source /
// task_success / task_success_source, or a transition's supersedes) on top of the
// candidate defaults.
export function buildSkillAnnotations(
	proposal: SkillProposal,
	threadId: string,
	nowIso: string,
	learnedFrom?: string,
	overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
	const base: Record<string, string> = {
		kind: "skill",
		skill_name: proposal.name ?? "",
		task_category: proposal.task_category ?? "",
		confidence: "0.5",
		learned_from: learnedFrom ?? `thread:${threadId}`,
		learned_at: nowIso,
		usage_count: "0",
		success_count: "0",
		failure_count: "0",
		status: "candidate",
		source: "turn",
		task_success: "",
		task_success_source: "",
		evidence_count: String(proposal.evidence?.length ?? 0),
	};
	for (const [k, v] of Object.entries(overrides)) if (v !== undefined) base[k] = v;
	return base;
}

// The human-readable proposal body (the fact text). PII-redacted before write.
export function buildSkillFactText(proposal: SkillProposal): string {
	const parts = [`Proposed skill: ${proposal.name} - ${proposal.description}`];
	if (proposal.when_to_use) parts.push(`When to use: ${proposal.when_to_use}`);
	if (proposal.procedure_summary) parts.push(`Procedure: ${proposal.procedure_summary}`);
	if (proposal.evidence && proposal.evidence.length > 0) {
		parts.push(`Evidence:\n${proposal.evidence.map((q) => `- ${q.replace(/\n+/g, " ")}`).join("\n")}`);
	}
	return redactPiiContent(parts.join("\n"));
}

// SIO-1889: the candidate's initial task_success and where it came from. Turn
// outcome outranks Jev (it is the graph's own terminal state, not an estimate);
// feedback (SIO-1890) later outranks both.
export function initialTaskSuccess(
	turn: SkillLearnerTurn,
	gate: LearningGateResult,
): { task_success: string; task_success_source: string } {
	if (turn.confidenceScore === undefined && turn.outcome === "completed") {
		return { task_success: "1", task_success_source: "turn-outcome" };
	}
	if (gate.outcome === "applied") {
		return { task_success: gate.verdict.taskSuccess >= 0.5 ? "1" : "0", task_success_source: "jev" };
	}
	return { task_success: "", task_success_source: "" };
}

export interface LearnFromTurnDeps {
	gate?: typeof gateLearning;
}

// Entry point invoked by the post-turn learner seam. Gated, best-effort, never
// throws to the caller. `nowIso` is injected so the module stays deterministic in
// tests (Date is not called here).
export async function learnFromTurn(
	turn: SkillLearnerTurn,
	nowIso: string,
	deps: LearnFromTurnDeps = {},
): Promise<void> {
	if (!isSkillLearningEnabled()) return;
	// Durable proposals require the agent-memory backend; on the file default there
	// is nowhere to store a kind:skill fact, so the learner is a no-op.
	if (selectedBackend() !== "agent-memory") return;

	const skip = preGateSkip(turn);
	if (skip) {
		logger.debug({ threadId: turn.threadId, agent: turn.agentName, reason: skip }, "skill-learner pre-gate skip");
		return;
	}

	// SIO-1889: one cheap Jev call before the full-model judge. A turn with no
	// reusable, evidence-backed correction ends here. Skipped/failed falls through
	// to the judge exactly as before the gate existed.
	const gate = await (deps.gate ?? gateLearning)({ events: transcriptToEvents(turn.transcript) });
	if (gate.outcome === "applied" && !gate.verdict.qualifies) {
		logger.debug(
			{ threadId: turn.threadId, agent: turn.agentName, reason: gate.verdict.reason },
			"learning gate: not reusable",
		);
		return;
	}

	const proposal = await judgeTurn(turn);
	if (!proposal?.name) return;

	const quality = lessonQuality(proposal);
	if (!quality.ok) {
		recordDecision({ seam: "learning-gate", outcome: "skipped", note: `rubric:${quality.reason}` });
		logger.info({ skill: proposal.name, reason: quality.reason }, "skill proposal failed the lesson rubric; skipping");
		return;
	}

	if (await skillProposalExists(proposal.name, turn.agentName)) {
		logger.debug({ skill: proposal.name }, "skill proposal already exists; skipping (dedup)");
		return;
	}

	// Greptile PR #917: the write-behind queue binds whatever session is active at
	// enqueue time, and three awaits sit between the pre-gate and this line, so an
	// overlapping request could relabel the candidate. The direct write binds
	// turn.agentName itself.
	const text = buildSkillFactText(proposal);
	const annotations = buildSkillAnnotations(proposal, turn.threadId, nowIso, undefined, initialTaskSuccess(turn, gate));
	const stored = await recordAgentFactNow(turn.agentName, text, annotations);
	if (!stored) {
		// Greptile PR #917 (round 2): a transient rejection must not lose the
		// candidate. The write-behind queue retries at flush and teardown, but it
		// binds whatever session is active NOW, so it is only a safe fallback when
		// that session is this turn's own; otherwise the candidate is dropped with a
		// warning rather than filed under another conversation.
		const active = getActiveMemoryRef();
		if (active && active.userId === resolveUserId(turn.agentName) && active.sessionId === turn.threadId) {
			enqueueFact(text, nowIso, annotations);
			logger.warn(
				{ skill: proposal.name, agent: turn.agentName },
				"skill candidate queued for retry after a rejected write",
			);
		} else {
			logger.warn({ skill: proposal.name, agent: turn.agentName }, "skill candidate write was not accepted; dropped");
		}
		return;
	}
	logger.info(
		{ skill: proposal.name, agent: turn.agentName, category: proposal.task_category },
		"crystallized skill candidate",
	);
}

// SIO-1890: thumbs feedback is the human task_success signal (agent-beacon's hard
// precondition). It is recorded as its own fact and applied to every candidate
// this thread produced as a state transition: thumbs-up sets task_success=1 from
// feedback (outranking jev and the turn outcome), thumbs-down rejects. Already
// rejected or superseded candidates are left alone. Same fact stream, no new store.
export async function recordTurnFeedback(
	agentName: string,
	threadId: string,
	score: 0 | 1,
	nowIso: string = new Date().toISOString(),
): Promise<{ transitions: number }> {
	if (selectedBackend() !== "agent-memory") return { transitions: 0 };
	await recordAgentFactNow(agentName, `User feedback ${score === 1 ? "up" : "down"} on thread ${threadId}`, {
		kind: "feedback",
		thread_id: threadId,
		score: String(score),
	});
	const hits = latestPerSkill(
		await searchAgentMemory(agentName, "", { kind: "skill", learned_from: `thread:${threadId}` }, 64, {
			deterministic: true,
		}),
	);
	let transitions = 0;
	let eligible = 0;
	for (const hit of hits) {
		const status = hit.annotations.status ?? "candidate";
		// Greptile PR #918: a rejection that came from an earlier thumbs-down is the
		// human's previous verdict, and the latest verdict replaces it (a changed vote
		// reopens the candidate). A rejection from the review pane, or a supersession,
		// stands.
		const feedbackRejected = status === "rejected" && hit.annotations.task_success_source === "feedback";
		if (status === "superseded" || (status === "rejected" && !feedbackRejected)) continue;
		eligible += 1;
		const next: AnnotationMap = {
			...hit.annotations,
			learned_at: nowIso,
			task_success: String(score),
			task_success_source: "feedback",
			status: score === 0 ? "rejected" : feedbackRejected ? "candidate" : status,
		};
		if (await recordAgentFactNow(agentName, hit.text, next)) transitions += 1;
	}
	// Greptile PR #918: the row says whether the transitions were stored, not
	// whether they were attempted.
	recordDecision({
		seam: "learning-feedback",
		outcome: transitions === eligible ? "applied" : "failed",
		itemsIn: hits.length,
		itemsDropped: score === 0 ? transitions : 0,
		note: `${score === 1 ? "thumbs-up" : "thumbs-down"}:${transitions}/${eligible}`,
	});
	return { transitions };
}

export type { AnnotationMap };
