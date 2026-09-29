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
import { buildSkillFactText, CANDIDATE_STATUSES, isRunbookDirFor, latestPerSkill } from "./skill-learner.ts";
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
	// SIO-1896 (Codex review): the promotion PR's outcome, persisted on the
	// approved fact once known, so a retry is offered only for a skipped or
	// failed promotion and never re-creates an existing branch.
	promotion?: string;
	prUrl?: string;
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
		...(a.promotion ? { promotion: a.promotion } : {}),
		...(a.pr_url ? { prUrl: a.pr_url } : {}),
		title: parsed.description ?? "",
		whenToUse: parsed.whenToUse ?? "",
		body: parsed.procedure,
		evidence: parsed.evidence ?? [],
	};
}

// Greptile PR #919: latest per (kind, skill_name). A skill and a runbook that
// share a name are two candidates, so each kind is collapsed on its own.
async function latestHits(agent: string): Promise<MemorySearchHit[]> {
	const hits: MemorySearchHit[] = [];
	for (const kind of ["skill", "runbook"]) {
		hits.push(...latestPerSkill(await searchAgentMemory(agent, "", { kind }, 64, { deterministic: true })));
	}
	return hits;
}

export async function listReviewRows(agent: string): Promise<ReviewRow[]> {
	if (selectedBackend() !== "agent-memory") return [];
	return (await latestHits(agent)).map((h) => rowFromHit(agent, h)).filter((r) => r.skillName !== "");
}

export interface ReviewAction {
	agent: string;
	skillName: string;
	// Greptile PR #919: which candidate when a skill and a runbook share a name.
	// Absent means skill, then runbook.
	kind?: "skill" | "runbook";
	// The status the reviewer saw. A transition stored since (another reviewer,
	// a thumbs click) makes the action stale: refused, never applied on top.
	expectedStatus?: CandidateStatus;
	action: "approve" | "reject" | "supersede";
	// Approve-with-edits: the human's title (description) and body (procedure).
	edits?: { title?: string; body?: string };
	// supersede: the skill_name of the candidate that replaces this one.
	supersedes?: string;
}

export type ReviewResult =
	| {
			ok: true;
			status: CandidateStatus;
			prStatus?: string;
			prUrl?: string;
			prReason?: string;
			// Codex SIO-1896: false when the promotion outcome could not be written, so
			// the pane must not offer a retry the server would refuse.
			promotionStored?: boolean;
	  }
	| { ok: false; code: 404 | 409 | 500; reason: string };

export interface ReviewDeps {
	promote?: typeof promoteToMemory;
	fetchBase?: typeof fetchBaseFileContent;
	now?: () => string;
}

// Render the fact text again with the human's edits applied, keeping the
// sections the human did not touch.
// Greptile PR #919: the fact parser reads "Procedure:", "Evidence:", "When to
// use:" and "Proposed skill:" at a line start as section labels, so a reviewer's
// line that happens to start with one would truncate their own procedure.
// Indenting such a line keeps the text and defeats the label match.
const SECTION_LABEL = /^(Proposed skill:|When to use:|Procedure:|Evidence:)/gm;
export function neutraliseLabels(text: string): string {
	return text.replace(SECTION_LABEL, " $1");
}

export function applyEdits(row: ReviewRow, edits: ReviewAction["edits"]): string {
	return buildSkillFactText({
		worthy: true,
		name: row.skillName,
		description: neutraliseLabels(edits?.title?.trim() || row.title).replace(/\n+/g, " "),
		when_to_use: row.whenToUse,
		procedure_summary: neutraliseLabels(edits?.body?.trim() || row.body),
		evidence: row.evidence,
	});
}

// SIO-1892 hands fleet lessons over as kind:runbook candidates; approving one
// stages markdown under the agent's knowledge tree with the catalog frontmatter
// shape (learn/runbook.ts) so the manifest loader accepts it on merge.
// Greptile PR #919: the default follows the OWNING agent's registered runbook
// tree, never another agent's.
export function defaultRunbookDir(agent: string): string {
	return agent === "incident-analyzer"
		? "agents/incident-analyzer/knowledge/general/runbooks"
		: `agents/${agent}/knowledge/runbooks`;
}

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

// SIO-1896: promotion outcomes the pane and the server let a reviewer retry.
export const RETRYABLE_PROMOTIONS: ReadonlySet<string> = new Set(["skipped", "failed"]);

export async function reviewCandidate(action: ReviewAction, deps: ReviewDeps = {}): Promise<ReviewResult> {
	if (selectedBackend() !== "agent-memory") {
		return {
			ok: false,
			code: 409,
			reason: "learning candidates live in the agent-memory backend, which is not active",
		};
	}
	const now = deps.now ?? (() => new Date().toISOString());
	const candidates = (await latestHits(action.agent)).filter((h) => h.annotations.skill_name === action.skillName);
	const hit = action.kind
		? candidates.find((h) => (h.annotations.kind ?? "skill") === action.kind)
		: (candidates.find((h) => (h.annotations.kind ?? "skill") === "skill") ?? candidates[0]);
	if (!hit) return { ok: false, code: 404, reason: `no candidate "${action.skillName}" for agent ${action.agent}` };
	const row = rowFromHit(action.agent, hit);
	const decision = (outcome: "applied" | "skipped", note: string) =>
		recordDecision({ seam: "learning-review", outcome, note: `${action.action}:${note}` });

	// Greptile PR #919: two reviewers, or a reviewer and a thumbs click, can act on
	// the same row. The action carries the status it was shown; a transition stored
	// since makes it stale and it is refused rather than appended on top.
	if (action.expectedStatus && action.expectedStatus !== row.status) {
		decision("skipped", "stale");
		return {
			ok: false,
			code: 409,
			reason: `candidate "${row.skillName}" is now ${row.status}, not ${action.expectedStatus}; reload and decide again`,
		};
	}

	if (row.status === "rejected" || row.status === "superseded") {
		decision("skipped", `already-${row.status}`);
		return { ok: false, code: 409, reason: `candidate "${row.skillName}" is already ${row.status}` };
	}

	const transition = async (
		patch: Partial<Record<string, string>>,
		text = hit.text,
		base: AnnotationMap = hit.annotations,
	): Promise<boolean> => {
		const next: AnnotationMap = { ...base, learned_at: now() };
		for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
		return recordAgentFactNow(action.agent, text, next);
	};

	if (action.action === "reject") {
		// Greptile PR #919: an approved candidate may already be live through its
		// merged PR; a fact alone cannot retract that. Superseding it (below) is the
		// honest state; removing the file is its own PR.
		if (row.status === "approved") {
			decision("skipped", "approved-needs-supersede");
			return {
				ok: false,
				code: 409,
				reason: `candidate "${row.skillName}" is approved; supersede it with its replacement, and remove the activated file in its own PR`,
			};
		}
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
	// SIO-1896 (Codex review): the stored target_dir becomes the PR path; refuse
	// one outside this agent's knowledge tree before anything is written.
	if (row.kind === "runbook" && row.targetDir && !isRunbookDirFor(row.agent, row.targetDir)) {
		decision("skipped", "target-dir-outside-tree");
		return {
			ok: false,
			code: 409,
			reason: `candidate "${row.skillName}" targets a directory outside ${row.agent}'s runbook tree`,
		};
	}
	// Greptile PR #919: a candidate approved earlier whose PR was skipped or failed
	// can be approved again: no second transition (its edits are the approved text),
	// only the promotion PR is retried.
	const reapproval = row.status === "approved";
	// Codex SIO-1896: only a skipped or failed promotion is retried. An opened one
	// is done, a blocked one (secret scan) fails the same way on unchanged text,
	// and an unrecorded outcome is treated as done rather than risk a duplicate.
	if (reapproval && !RETRYABLE_PROMOTIONS.has(row.promotion ?? "")) {
		decision("skipped", "already-promoted");
		return {
			ok: false,
			code: 409,
			reason: `candidate "${row.skillName}" already had its promotion (${row.promotion ?? "outcome not recorded"})${row.prUrl ? ` ${row.prUrl}` : ""}`,
		};
	}
	const text = reapproval ? hit.text : applyEdits(row, action.edits);
	if (!reapproval && !(await transition({ status: "approved" }, text))) {
		return { ok: false, code: 500, reason: "transition not stored" };
	}
	const annotations: AnnotationMap = { ...hit.annotations, status: "approved", learned_at: now() };

	const promote = deps.promote ?? promoteToMemory;
	// Persist the outcome as a newer approved fact once it is known; readers keep
	// the latest per skill, so the row then carries promotion and pr_url.
	// Codex SIO-1896: the outcome is appended on top of the LATEST fact, re-read
	// after the PR call: a reject or supersede written meanwhile wins, and a
	// rejected write leaves the row without an outcome (no retry offered, a later
	// approve refused). Both are said in the response. The re-read and the append
	// are not atomic: Agent Memory facts are append-only with no version token, so
	// the millisecond window between them is the same one every transition in this
	// file has (the expectedStatus check above), accepted rather than a second
	// corrective write.
	const recordPromotion = async (status: string, url?: string): Promise<string | undefined> => {
		const latest = (await latestHits(action.agent)).find(
			(h) => h.annotations.skill_name === row.skillName && (h.annotations.kind ?? "skill") === row.kind,
		);
		const latestStatus = latest?.annotations.status;
		if (!latest || latestStatus !== "approved") {
			logger.warn(
				{ agent: row.agent, skill: row.skillName, promotion: status, status: latestStatus },
				"promotion outcome not stored: row changed during promotion",
			);
			return `row is now ${latestStatus ?? "missing"}; promotion outcome not recorded`;
		}
		const stored = await transition(
			{ status: "approved", promotion: status, ...(url ? { pr_url: url } : {}) },
			text,
			latest.annotations,
		);
		if (stored) return undefined;
		logger.warn({ agent: row.agent, skill: row.skillName, promotion: status }, "promotion outcome not stored");
		return "promotion outcome not stored; the row cannot be retried from the pane";
	};
	const withNote = (reason: string | undefined, note: string | undefined) =>
		note ? (reason ? `${reason}; ${note}` : note) : reason;
	const done = (prStatus: string, prReason: string | undefined, note: string | undefined, prUrl?: string) => ({
		ok: true as const,
		status: "approved" as const,
		prStatus,
		...(prUrl ? { prUrl } : {}),
		prReason: withNote(prReason, note),
		promotionStored: note === undefined,
	});
	try {
		if (row.kind === "runbook") {
			const dir = row.targetDir ?? defaultRunbookDir(row.agent);
			// Greptile PR #919: the branch names the owning agent, so two agents
			// approving the same name never collide.
			const result = await promote({
				kind: "runbook",
				branch: `agent/learn/${row.agent}/runbook-${row.skillName}`,
				title: `Runbook from learning review: ${row.skillName} (${row.agent})`,
				body: `Approved in the learning review pane (SIO-1891). Source: ${row.source}, learned from ${row.learnedFrom}. Merging catalogs it for ${row.agent}.`,
				files: [{ path: `${dir}/${row.skillName}.md`, contents: renderCandidateRunbook(row, text) }],
				labels: ["learning-review", "runbook-draft"],
			});
			const note = await recordPromotion(result.status, result.url);
			decision("applied", `approved-runbook-${result.status}`);
			return done(result.status, result.reason, note, result.url);
		}
		const fetchBase = deps.fetchBase ?? fetchBaseFileContent;
		const base = await fetchBase(agentManifestPath(row.agent));
		if (base.status === "skipped" || base.content === null) {
			const reason = base.status === "skipped" ? base.reason : "agent.yaml not found on base branch";
			const note = await recordPromotion("skipped");
			decision("applied", "approved-no-pr");
			return done("skipped", reason, note);
		}
		const built = buildSkillPrFiles(base.content, {
			agent: row.agent,
			skillName: row.skillName,
			annotations,
			body: text,
		});
		if (!built.ok) {
			const note = await recordPromotion("skipped");
			decision("applied", "approved-no-pr");
			return done("skipped", built.reason, note);
		}
		const result = await promote({
			kind: "new-skill",
			branch: `agent/learn/${row.agent}/skill-${row.skillName}`,
			title: buildSkillPrTitle(row.agent, row.skillName),
			body: buildSkillPrBody(row.agent, row.skillName, annotations),
			files: built.files,
			labels: ["learning-review", "skill-promotion"],
		});
		const note = await recordPromotion(result.status, result.url);
		decision("applied", `approved-skill-${result.status}`);
		return done(result.status, result.reason, note, result.url);
	} catch (error) {
		// The approval is recorded; only the PR failed. Say so rather than undo it.
		logger.warn(
			{ agent: row.agent, skill: row.skillName, error: error instanceof Error ? error.message : String(error) },
			"promotion PR failed after approval",
		);
		const note = await recordPromotion("failed").catch(() => "promotion outcome not stored");
		decision("applied", "approved-pr-failed");
		return done("failed", "promotion PR failed", note);
	}
}
