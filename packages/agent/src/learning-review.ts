// agent/src/learning-review.ts
//
// SIO-1891: the human gate over learning candidates (agent-beacon's
// candidate -> approved | rejected | superseded model) as the review pane and
// its routes use it. Reads the latest fact per skill from the agent-memory
// stream, writes state transitions as new facts, and on approve opens the
// promotion PR through the existing memory-pr channel. PR merge stays the only
// activation: nothing here edits a live agent.yaml or knowledge tree.

import { fetchBaseFileContent } from "@devops-agent/memory-pr";
import { getLogger } from "@devops-agent/observability";
import type { AnnotationMap } from "@devops-agent/shared";
import { recordDecision } from "./decision-recorder.ts";
import { agentManifestPath, buildSkillPrBody, buildSkillPrFiles, buildSkillPrTitle } from "./learn/skill-pr.ts";
import { type MemorySearchHit, recordAgentFactNow, searchAgentMemory, selectedBackend } from "./memory-backend.ts";
import { promoteToMemory } from "./memory-promotion.ts";
import { buildSkillFactText, CANDIDATE_STATUSES, latestPerSkill } from "./skill-learner.ts";
import { parseSkillFactBody } from "./skill-promote.ts";

const logger = getLogger("agent:learning-review");

// Default ON, kill-switch read (the capability-flag idiom).
export function isLearningReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.LEARNING_REVIEW_ENABLED;
	return v !== "false" && v !== "0";
}

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export interface ReviewRow {
	agent: string;
	skillName: string;
	kind: string;
	status: CandidateStatus;
	source: string;
	confidence: string;
	taskSuccess: string;
	taskSuccessSource: string;
	learnedAt: string;
	learnedFrom: string;
	supersedes?: string;
	targetDir?: string;
	title: string;
	whenToUse: string;
	body: string;
	evidence: string[];
}

export function rowFromHit(agent: string, hit: MemorySearchHit): ReviewRow {
	const a = hit.annotations;
	const parsed = parseSkillFactBody(hit.text);
	const status = (CANDIDATE_STATUSES as readonly string[]).includes(a.status ?? "")
		? (a.status as CandidateStatus)
		: "candidate";
	return {
		agent,
		skillName: a.skill_name ?? "",
		kind: a.kind ?? "skill",
		status,
		source: a.source ?? "turn",
		confidence: a.confidence ?? "",
		taskSuccess: a.task_success ?? "",
		taskSuccessSource: a.task_success_source ?? "",
		learnedAt: a.learned_at ?? "",
		learnedFrom: a.learned_from ?? "",
		...(a.supersedes ? { supersedes: a.supersedes } : {}),
		...(a.target_dir ? { targetDir: a.target_dir } : {}),
		title: parsed.description ?? "",
		whenToUse: parsed.whenToUse ?? "",
		body: parsed.procedure,
		evidence: parsed.evidence ?? [],
	};
}

async function latestHits(agent: string): Promise<MemorySearchHit[]> {
	const hits: MemorySearchHit[] = [];
	for (const kind of ["skill", "runbook"]) {
		hits.push(...(await searchAgentMemory(agent, "", { kind }, 64, { deterministic: true })));
	}
	return latestPerSkill(hits);
}

export async function listReviewRows(agent: string): Promise<ReviewRow[]> {
	if (selectedBackend() !== "agent-memory") return [];
	return (await latestHits(agent)).map((h) => rowFromHit(agent, h)).filter((r) => r.skillName !== "");
}

export interface ReviewAction {
	agent: string;
	skillName: string;
	action: "approve" | "reject" | "supersede";
	// Approve-with-edits: the human's title (description) and body (procedure).
	edits?: { title?: string; body?: string };
	// supersede: the skill_name of the candidate that replaces this one.
	supersedes?: string;
}

export type ReviewResult =
	| { ok: true; status: CandidateStatus; prStatus?: string; prUrl?: string; prReason?: string }
	| { ok: false; code: 404 | 409 | 500; reason: string };

export interface ReviewDeps {
	promote?: typeof promoteToMemory;
	fetchBase?: typeof fetchBaseFileContent;
	now?: () => string;
}

// Render the fact text again with the human's edits applied, keeping the
// sections the human did not touch.
export function applyEdits(row: ReviewRow, edits: ReviewAction["edits"]): string {
	return buildSkillFactText({
		worthy: true,
		name: row.skillName,
		description: edits?.title?.trim() || row.title,
		when_to_use: row.whenToUse,
		procedure_summary: edits?.body?.trim() || row.body,
		evidence: row.evidence,
	});
}

// SIO-1892 hands fleet lessons over as kind:runbook candidates; approving one
// stages markdown under the agent's knowledge tree with the catalog frontmatter
// shape (learn/runbook.ts) so the manifest loader accepts it on merge.
export const DEFAULT_RUNBOOK_DIR = "agents/incident-analyzer/knowledge/general/runbooks";

export function renderCandidateRunbook(row: ReviewRow, text: string): string {
	const parsed = parseSkillFactBody(text);
	const tokens = row.skillName
		.split("-")
		.filter((w) => w.length > 2)
		.slice(0, 6);
	const metrics = tokens.length > 0 ? tokens : [row.skillName];
	const title = row.skillName
		.split("-")
		.filter((w) => w.length > 0)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
	const lines = [
		"---",
		"triggers:",
		"  metrics:",
		...metrics.map((m) => `    - ${m}`),
		"  severity:",
		"    - high",
		"  match: any",
		`status: draft`,
		"---",
		`# ${title} (DRAFT)`,
		"",
		parsed.description ?? row.title,
		"",
	];
	if (parsed.whenToUse) lines.push("## When to use", "", parsed.whenToUse, "");
	lines.push("## Procedure", "", parsed.procedure, "");
	if (parsed.evidence && parsed.evidence.length > 0) {
		lines.push("## Evidence", "", ...parsed.evidence.map((q) => `- ${q}`), "");
	}
	lines.push(
		"## Provenance",
		"",
		`- source: ${row.source}`,
		`- learned_from: ${row.learnedFrom}`,
		`- approved from the learning review pane (SIO-1891); review before relying on it`,
		"",
	);
	return lines.join("\n");
}

export async function reviewCandidate(action: ReviewAction, deps: ReviewDeps = {}): Promise<ReviewResult> {
	if (selectedBackend() !== "agent-memory") {
		return {
			ok: false,
			code: 409,
			reason: "learning candidates live in the agent-memory backend, which is not active",
		};
	}
	const now = deps.now ?? (() => new Date().toISOString());
	const hit = (await latestHits(action.agent)).find((h) => h.annotations.skill_name === action.skillName);
	if (!hit) return { ok: false, code: 404, reason: `no candidate "${action.skillName}" for agent ${action.agent}` };
	const row = rowFromHit(action.agent, hit);
	const decision = (outcome: "applied" | "skipped", note: string) =>
		recordDecision({ seam: "learning-review", outcome, note: `${action.action}:${note}` });

	if (row.status === "rejected" || row.status === "superseded") {
		decision("skipped", `already-${row.status}`);
		return { ok: false, code: 409, reason: `candidate "${row.skillName}" is already ${row.status}` };
	}

	const transition = async (patch: Partial<Record<string, string>>, text = hit.text): Promise<boolean> => {
		const next: AnnotationMap = { ...hit.annotations, learned_at: now() };
		for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
		return recordAgentFactNow(action.agent, text, next);
	};

	if (action.action === "reject") {
		if (!(await transition({ status: "rejected" }))) return { ok: false, code: 500, reason: "transition not stored" };
		decision("applied", "rejected");
		return { ok: true, status: "rejected" };
	}

	if (action.action === "supersede") {
		const by = action.supersedes?.trim();
		if (!by) return { ok: false, code: 409, reason: "supersede needs the replacing candidate's skill_name" };
		if (by === row.skillName) return { ok: false, code: 409, reason: "a candidate cannot supersede itself" };
		if (!(await transition({ status: "superseded", supersedes: by }))) {
			return { ok: false, code: 500, reason: "transition not stored" };
		}
		decision("applied", "superseded");
		return { ok: true, status: "superseded" };
	}

	// approve: beacon's hard precondition, task_success must be confirmed.
	if (row.taskSuccess !== "1") {
		decision("skipped", "task-success-unconfirmed");
		return {
			ok: false,
			code: 409,
			reason: `candidate "${row.skillName}" has no confirmed task_success (thumbs-up or a completed outcome); refusing to approve`,
		};
	}
	if (row.status === "approved") {
		decision("skipped", "already-approved");
		return { ok: false, code: 409, reason: `candidate "${row.skillName}" is already approved` };
	}
	const text = applyEdits(row, action.edits);
	if (!(await transition({ status: "approved" }, text)))
		return { ok: false, code: 500, reason: "transition not stored" };
	const annotations: AnnotationMap = { ...hit.annotations, status: "approved", learned_at: now() };

	const promote = deps.promote ?? promoteToMemory;
	try {
		if (row.kind === "runbook") {
			const dir = row.targetDir ?? DEFAULT_RUNBOOK_DIR;
			const result = await promote({
				kind: "runbook",
				branch: `agent/learn/runbook-${row.skillName}`,
				title: `Runbook from learning review: ${row.skillName} (${row.agent})`,
				body: `Approved in the learning review pane (SIO-1891). Source: ${row.source}, learned from ${row.learnedFrom}. Merging catalogs it for ${row.agent}.`,
				files: [{ path: `${dir}/${row.skillName}.md`, contents: renderCandidateRunbook(row, text) }],
				labels: ["learning-review", "runbook-draft"],
			});
			decision("applied", `approved-runbook-${result.status}`);
			return { ok: true, status: "approved", prStatus: result.status, prUrl: result.url, prReason: result.reason };
		}
		const fetchBase = deps.fetchBase ?? fetchBaseFileContent;
		const base = await fetchBase(agentManifestPath(row.agent));
		if (base.status === "skipped" || base.content === null) {
			const reason = base.status === "skipped" ? base.reason : "agent.yaml not found on base branch";
			decision("applied", "approved-no-pr");
			return { ok: true, status: "approved", prStatus: "skipped", prReason: reason };
		}
		const built = buildSkillPrFiles(base.content, {
			agent: row.agent,
			skillName: row.skillName,
			annotations,
			body: text,
		});
		if (!built.ok) {
			decision("applied", "approved-no-pr");
			return { ok: true, status: "approved", prStatus: "skipped", prReason: built.reason };
		}
		const result = await promote({
			kind: "new-skill",
			branch: `agent/learn/skill-${row.skillName}`,
			title: buildSkillPrTitle(row.agent, row.skillName),
			body: buildSkillPrBody(row.agent, row.skillName, annotations),
			files: built.files,
			labels: ["learning-review", "skill-promotion"],
		});
		decision("applied", `approved-skill-${result.status}`);
		return { ok: true, status: "approved", prStatus: result.status, prUrl: result.url, prReason: result.reason };
	} catch (error) {
		// The approval is recorded; only the PR failed. Say so rather than undo it.
		logger.warn(
			{ agent: row.agent, skill: row.skillName, error: error instanceof Error ? error.message : String(error) },
			"promotion PR failed after approval",
		);
		decision("applied", "approved-pr-failed");
		return { ok: true, status: "approved", prStatus: "failed", prReason: "promotion PR failed" };
	}
}
