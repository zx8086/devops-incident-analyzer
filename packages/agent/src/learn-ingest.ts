// agent/src/learn-ingest.ts
//
// SIO-1892: turn externally produced candidate drafts (the fleet harvest, and
// SIO-1893's reflect items) into kind:runbook / kind:skill candidate facts under
// an agent's identity. Same gates as the post-turn learner: the Jev learning
// gate, the lesson-quality rubric, dedupe by skill_name, an identity-bound
// write. Drafts are data: they reach no model here except through the gate's
// redacted projection.
import { z } from "zod";
import { gateLearning, type LearningGateResult } from "./learning-gate.ts";
import { recordAgentFactNow, searchAgentMemory, selectedBackend } from "./memory-backend.ts";
import {
	buildSkillAnnotations,
	buildSkillFactText,
	LearningCandidateSchema,
	lessonQuality,
	type SkillProposal,
} from "./skill-learner.ts";

// Greptile PR #920: a draft need not come from the fleet harvest (which redacts
// AWS identifiers itself), so the ingest boundary redacts them too, before the
// Jev projection and before storage. packages/shared's redactor keeps these on
// purpose (SIO-861: an address is often the subject), so the patterns live here.
const AWS_REDACTIONS: readonly { re: RegExp; to: string }[] = [
	{ re: /\barn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:\S+/g, to: "[ARN_REDACTED]" },
	{ re: /\b\d{12}\b/g, to: "[ACCOUNT_REDACTED]" },
	{ re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, to: "[AKID_REDACTED]" },
];
export function redactAwsIdentifiers(text: string): string {
	let out = text;
	for (const { re, to } of AWS_REDACTIONS) out = out.replace(re, to);
	return out;
}

export function redactDraft(d: CandidateDraft): CandidateDraft {
	return {
		...d,
		title: redactAwsIdentifiers(d.title),
		applicability: redactAwsIdentifiers(d.applicability),
		body: redactAwsIdentifiers(d.body),
		evidence: d.evidence.map((e) => ({ ref: redactAwsIdentifiers(e.ref), excerpt: redactAwsIdentifiers(e.excerpt) })),
		learned_from: redactAwsIdentifiers(d.learned_from),
		// Greptile PR #920 round 2: the annotation fields are stored too.
		...(d.supersedes ? { supersedes: redactAwsIdentifiers(d.supersedes) } : {}),
		...(d.target_dir ? { target_dir: redactAwsIdentifiers(d.target_dir) } : {}),
	};
}

// Default ON, kill-switch read (the capability-flag idiom).
export function isLearningIngestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.LEARNING_INGEST_ENABLED;
	return v !== "false" && v !== "0";
}

// The harvest writes everything but `agent`; ingest supplies it.
export const CandidateDraftSchema = LearningCandidateSchema.omit({ agent: true });
export type CandidateDraft = z.infer<typeof CandidateDraftSchema>;

export const HarvestFileSchema = z.object({
	generated_at: z.string().optional(),
	candidates: z.array(z.unknown()),
});

export interface IngestDeps {
	gate?: typeof gateLearning;
	exists?: (agent: string, kind: string, skillName: string) => Promise<boolean>;
	write?: typeof recordAgentFactNow;
	now?: () => string;
	dryRun?: boolean;
}

export interface IngestReport {
	stored: string[];
	skipped: { name: string; reason: string }[];
}

export function draftToProposal(d: CandidateDraft): SkillProposal {
	return {
		worthy: true,
		name: d.skill_name,
		description: d.title,
		when_to_use: d.applicability,
		procedure_summary: d.body,
		evidence: d.evidence.map((e) => e.excerpt),
	};
}

async function defaultExists(agent: string, kind: string, skillName: string): Promise<boolean> {
	const hits = await searchAgentMemory(agent, "", { kind, skill_name: skillName }, 1, { deterministic: true });
	return hits.length > 0;
}

function taskSuccessFor(
	d: CandidateDraft,
	gate: LearningGateResult,
): { task_success: string; task_success_source: string } {
	// The draft's own verdict (fleet-verdict) outranks the Jev estimate.
	if (d.task_success !== "") return { task_success: d.task_success, task_success_source: d.task_success_source };
	if (gate.outcome === "applied") {
		return { task_success: gate.verdict.taskSuccess >= 0.5 ? "1" : "0", task_success_source: "jev" };
	}
	return { task_success: "", task_success_source: "" };
}

export async function ingestCandidates(drafts: unknown[], agent: string, deps: IngestDeps = {}): Promise<IngestReport> {
	const report: IngestReport = { stored: [], skipped: [] };
	if (!isLearningIngestEnabled()) {
		report.skipped.push({ name: "*", reason: "LEARNING_INGEST_ENABLED is off" });
		return report;
	}
	if (!deps.dryRun && selectedBackend() !== "agent-memory") {
		report.skipped.push({ name: "*", reason: "candidates live in the agent-memory backend, which is not active" });
		return report;
	}
	const gate = deps.gate ?? gateLearning;
	const exists = deps.exists ?? defaultExists;
	const write = deps.write ?? recordAgentFactNow;
	const now = deps.now ?? (() => new Date().toISOString());

	for (const [i, raw] of drafts.entries()) {
		const parsed = CandidateDraftSchema.safeParse(raw);
		if (!parsed.success) {
			const path = parsed.error.issues[0]?.path.join(".") ?? "";
			report.skipped.push({ name: `#${i}`, reason: `invalid draft: ${path || "shape"}` });
			continue;
		}
		const d = redactDraft(parsed.data);
		const proposal = draftToProposal(d);
		const quality = lessonQuality(proposal);
		if (!quality.ok) {
			report.skipped.push({ name: d.skill_name, reason: `rubric:${quality.reason}` });
			continue;
		}
		const verdict = await gate({
			events: [d.title, d.applicability, ...d.body.split("\n"), ...d.evidence.map((e) => e.excerpt)],
		});
		if (verdict.outcome === "applied" && !verdict.verdict.qualifies) {
			report.skipped.push({ name: d.skill_name, reason: `jev:${verdict.verdict.reason}` });
			continue;
		}
		// Greptile PR #920: with neither a fleet verdict nor a Jev verdict the draft
		// is unevaluated material; a reviewer should not meet it as a qualified
		// candidate. A draft filed rejected (reflect's negative case) is kept as is.
		if (verdict.outcome !== "applied" && d.task_success === "" && d.status !== "rejected") {
			report.skipped.push({ name: d.skill_name, reason: `unevaluated:${verdict.reason}` });
			continue;
		}
		if (!deps.dryRun && (await exists(agent, d.kind, d.skill_name))) {
			report.skipped.push({ name: d.skill_name, reason: "duplicate" });
			continue;
		}
		const nowIso = now();
		// Greptile PR #920: a draft enters as a candidate whatever it claims; only
		// the review pane approves. rejected is allowed in (reflect's negative case).
		const annotations = buildSkillAnnotations(proposal, "", nowIso, d.learned_from, {
			kind: d.kind,
			status: d.status === "rejected" ? "rejected" : "candidate",
			source: d.source,
			...taskSuccessFor(d, verdict),
			...(d.target_dir ? { target_dir: d.target_dir } : {}),
			...(d.supersedes ? { supersedes: d.supersedes } : {}),
		});
		if (deps.dryRun) {
			report.stored.push(d.skill_name);
			continue;
		}
		if (await write(agent, buildSkillFactText(proposal), annotations)) report.stored.push(d.skill_name);
		else report.skipped.push({ name: d.skill_name, reason: "write not accepted" });
	}
	return report;
}
