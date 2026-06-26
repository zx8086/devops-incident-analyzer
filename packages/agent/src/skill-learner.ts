// agent/src/skill-learner.ts
//
// SIO-1015: the skill-learning subsystem. After a completed incident-analyzer
// turn, judge whether the task exercised a reusable, effective pattern worth
// crystallizing. Worthy patterns are written as durable agent-memory facts
// (kind:skill) with the gitagent.sh learning fields as annotations, surfaced to
// humans at recall. PROPOSE-ONLY: nothing is auto-loaded into prompts; a human
// promotes a proposal by authoring a real SKILL.md. Scoped to incident-analyzer
// (the agent with a clean confidence + multi-tool signal); a no-op elsewhere.

import { getLogger } from "@devops-agent/observability";
import { redactPiiContent } from "@devops-agent/shared";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createLlm, type InvokableLlm, invokeWithDeadline } from "./llm.ts";
import { enqueueFact, searchAgentMemory, selectedBackend } from "./memory-backend.ts";

const logger = getLogger("agent:skill-learner");

// The learner only runs for the orchestrator: it is the agent with a confidence
// score and a multi-datasource tool signal. elastic-iac has neither and is skipped.
const LEARNER_AGENT = "incident-analyzer";

// Pre-gate thresholds. Below this confidence a turn is too uncertain to be a
// model worth keeping; fewer than this many distinct datasources is too trivial.
const MIN_CONFIDENCE = 0.6;
const MIN_DISTINCT_DATASOURCES = 2;

export function isSkillLearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.SKILL_LEARNING_ENABLED;
	return v === "true" || v === "1";
}

// The completed-turn snapshot the learner needs. Read by the caller (the web app
// owns getGraph/getState) and injected here so this module never imports the
// runtime layer.
export interface SkillLearnerTurn {
	agentName: string;
	threadId: string;
	queryComplexity: "simple" | "complex";
	confidenceScore: number;
	// distinct dataSourceIds that actually produced tool output this turn
	datasourcesUsed: string[];
	// a compact transcript of the turn (user asks + assistant report). May contain
	// PII as built by the caller; judgeTurn redacts it before it reaches the LLM and
	// buildSkillFactText redacts before persistence, so the learner never trusts the
	// caller to have redacted.
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
});
export type SkillProposal = z.infer<typeof SkillProposalSchema>;

const JUDGE_PROMPT = `You evaluate a completed DevOps incident-analysis turn and decide whether it exercised a REUSABLE, effective investigation pattern worth saving as a new skill for future turns.

Say worthy:true ONLY when the turn followed a generalizable procedure that would help a similar future incident (e.g. "correlate Kafka consumer lag with downstream Elasticsearch error spikes"). Say worthy:false for one-off lookups, trivial questions, failed/uncertain investigations, or anything too specific to this incident to reuse.

When worthy, return a kebab-case "name", a one-line "description" (what the skill does), "when_to_use" (the trigger condition), a short "procedure_summary" (the steps, 1-4 sentences), and a "task_category" (e.g. "lag-correlation", "error-triage").

Return ONLY JSON, no prose:
{"worthy": true|false, "name": "...", "description": "...", "when_to_use": "...", "procedure_summary": "...", "task_category": "..."}`;

// Cheap pre-LLM gates: only spend a judge call on turns that could plausibly
// yield a reusable skill. Returns a skip reason (for logging) or null to proceed.
export function preGateSkip(turn: SkillLearnerTurn): string | null {
	if (turn.agentName !== LEARNER_AGENT) return `agent ${turn.agentName} not eligible`;
	if (turn.queryComplexity !== "complex") return "simple turn";
	if (turn.confidenceScore < MIN_CONFIDENCE) return `confidence ${turn.confidenceScore} < ${MIN_CONFIDENCE}`;
	const distinct = new Set(turn.datasourcesUsed).size;
	if (distinct < MIN_DISTINCT_DATASOURCES) return `only ${distinct} datasource(s) used`;
	return null;
}

function parseProposal(raw: string): SkillProposal | null {
	// Tolerate fenced/garnished JSON: pull the first {...} block.
	const match = raw.match(/\{[\s\S]*\}/);
	if (!match) return null;
	try {
		return SkillProposalSchema.parse(JSON.parse(match[0]));
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "skill proposal parse failed");
		return null;
	}
}

// The exact text handed to the LLM judge: the transcript, capped and PII-redacted.
// The caller is not trusted to have redacted, and the judge input is just as
// sensitive as the persisted body. Exported so the redaction guarantee is testable
// without depending on the (process-global) LLM mock.
const MAX_TRANSCRIPT_CHARS = 6000;
export function redactForJudge(transcript: string): string {
	return redactPiiContent(transcript.slice(0, MAX_TRANSCRIPT_CHARS));
}

// Asks the LLM judge whether this turn is worth crystallizing. Returns a worthy,
// well-formed proposal or null. Best-effort: any error yields null.
export async function judgeTurn(turn: SkillLearnerTurn): Promise<SkillProposal | null> {
	try {
		const llm = createLlm("skillLearner", LEARNER_AGENT);
		const result = await invokeWithDeadline(llm as InvokableLlm, "skillLearner", [
			new SystemMessage(JUDGE_PROMPT),
			new HumanMessage(redactForJudge(turn.transcript)),
		]);
		const content = typeof result.content === "string" ? result.content : "";
		const proposal = parseProposal(content);
		if (!proposal?.worthy) return null;
		// A worthy verdict must carry at least a name + description to be useful.
		if (!proposal.name || !proposal.description) {
			logger.info("skill judge returned worthy without name/description; skipping");
			return null;
		}
		return proposal;
	} catch (error) {
		logger.warn({ error: error instanceof Error ? error.message : String(error) }, "skill judge invocation failed");
		return null;
	}
}

// Dedup: agent-memory facts are durable + undeletable, so a re-record permanently
// doubles a proposal. Skip if a kind:skill fact with this skill_name already exists
// (deterministic filter-only lookup, same idiom as the iac-change recall).
async function proposalExists(skillName: string): Promise<boolean> {
	const hits = await searchAgentMemory(LEARNER_AGENT, "", { kind: "skill", skill_name: skillName }, 1, {
		deterministic: true,
	});
	return hits.length > 0;
}

// Build the durable-fact annotations carrying the gitagent.sh learning fields.
// All values are strings (AnnotationMap). confidence is SEEDED, not measured —
// there is no live success/failure feedback loop against immutable facts (SIO-1015
// known limit), so counts start at 0 and the human promoter owns the rest.
export function buildSkillAnnotations(
	proposal: SkillProposal,
	threadId: string,
	nowIso: string,
): Record<string, string> {
	return {
		kind: "skill",
		skill_name: proposal.name ?? "",
		task_category: proposal.task_category ?? "",
		confidence: "0.5",
		learned_from: `thread:${threadId}`,
		learned_at: nowIso,
		usage_count: "0",
		success_count: "0",
		failure_count: "0",
	};
}

// The human-readable proposal body (the fact text). PII-redacted before write.
export function buildSkillFactText(proposal: SkillProposal): string {
	const parts = [`Proposed skill: ${proposal.name} - ${proposal.description}`];
	if (proposal.when_to_use) parts.push(`When to use: ${proposal.when_to_use}`);
	if (proposal.procedure_summary) parts.push(`Procedure: ${proposal.procedure_summary}`);
	return redactPiiContent(parts.join("\n"));
}

// Entry point invoked by the post-turn learner seam. Gated, best-effort, never
// throws to the caller. `nowIso` is injected so the module stays deterministic in
// tests (Date is not called here).
export async function learnFromTurn(turn: SkillLearnerTurn, nowIso: string): Promise<void> {
	if (!isSkillLearningEnabled()) return;
	// Durable proposals require the agent-memory backend; on the file default there
	// is nowhere to store a kind:skill fact, so the learner is a no-op.
	if (selectedBackend() !== "agent-memory") return;

	const skip = preGateSkip(turn);
	if (skip) {
		logger.debug({ threadId: turn.threadId, reason: skip }, "skill-learner pre-gate skip");
		return;
	}

	const proposal = await judgeTurn(turn);
	if (!proposal?.name) return;

	if (await proposalExists(proposal.name)) {
		logger.debug({ skill: proposal.name }, "skill proposal already exists; skipping (dedup)");
		return;
	}

	enqueueFact(buildSkillFactText(proposal), nowIso, buildSkillAnnotations(proposal, turn.threadId, nowIso));
	logger.info({ skill: proposal.name, category: proposal.task_category }, "crystallized skill proposal");
}
