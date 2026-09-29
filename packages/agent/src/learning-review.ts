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
	// SIO-1896: the promotion PR's outcome, read from a separate kind:promotion
	// fact (Greptile #924: an outcome stored as another approved skill fact could
	// outrank a reject written meanwhile). A retry is offered only for a skipped
	// or failed promotion and never re-creates an existing branch.
	promotion?: string;
	prUrl?: string;
	title: string;
	whenToUse: string;
	body: string;
	evidence: string[];
}

function strictlyAfter(stamp: string, previous: string | undefined): string {
	const prev = Date.parse(previous ?? "");
	const next = Date.parse(stamp);
	return Number.isFinite(prev) && next <= prev ? new Date(prev + 1).toISOString() : stamp;
}

function parseStatus(raw: string | undefined): CandidateStatus {
	return (CANDIDATE_STATUSES as readonly string[]).includes(raw ?? "") ? (raw as CandidateStatus) : "candidate";
}

// The latest promotion outcome per (target kind, skill name), each its own fact.
export type PromotionOutcome = { promotion: string; prUrl?: string };

function promotionKey(kind: string, skillName: string): string {
	return `${kind}:${skillName}`;
}

// Codex SIO-1896: one targeted read per APPROVED candidate (the only rows a
// retry decision needs), keyed by the candidate's own kind and name. No bulk
// read: a bounded bulk result could go stale or miss a row once history is
// long, and the fallback it needed was where the last two defects lived.
// Codex SIO-1896: deterministic retrieval ignores `limit` (memory-backend omits
// relevant_k), so an agent can have far more approved candidates than 64 per
// kind; the reads run in bounded batches rather than one request per row at once.
const OUTCOME_READ_CONCURRENCY = 8;

async function latestPromotions(agent: string, candidates: MemorySearchHit[]): Promise<Map<string, PromotionOutcome>> {
	const out = new Map<string, PromotionOutcome>();
	const approved = candidates.filter((h) => h.annotations.status === "approved" && h.annotations.skill_name);
	for (let i = 0; i < approved.length; i += OUTCOME_READ_CONCURRENCY) {
		await Promise.all(
			approved.slice(i, i + OUTCOME_READ_CONCURRENCY).map(async (h) => {
				const target_kind = h.annotations.kind ?? "skill";
				const skill_name = h.annotations.skill_name ?? "";
				const hits = await searchAgentMemory(agent, "", { kind: "promotion", target_kind, skill_name }, 8, {
					deterministic: true,
				});
				let best: MemorySearchHit | undefined;
				for (const hit of hits) {
					if (!hit.annotations.promotion) continue;
					if (!best || newest(hit) > newest(best)) best = hit;
				}
				if (!best) return;
				out.set(promotionKey(target_kind, skill_name), {
					promotion: best.annotations.promotion ?? "",
					...(best.annotations.pr_url ? { prUrl: best.annotations.pr_url } : {}),
				});
			}),
		);
	}
	return out;
}

const newest = (h: MemorySearchHit) => Date.parse(h.annotations.learned_at ?? "") || 0;

export function rowFromHit(agent: string, hit: MemorySearchHit, outcome?: PromotionOutcome): ReviewRow {
	const a = hit.annotations;
	const parsed = parseSkillFactBody(hit.text);
	const status = parseStatus(a.status);
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
		...(outcome ? { promotion: outcome.promotion } : {}),
		...(outcome?.prUrl ? { prUrl: outcome.prUrl } : {}),
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
	const hits = await latestHits(agent);
	const promotions = await latestPromotions(agent, hits);
	return hits
		.map((h) =>
			rowFromHit(agent, h, promotions.get(promotionKey(h.annotations.kind ?? "skill", h.annotations.skill_name ?? ""))),
		)
		.filter((r) => r.skillName !== "");
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
	const hits = await latestHits(action.agent);
	const candidates = hits.filter((h) => h.annotations.skill_name === action.skillName);
	const promotions = await latestPromotions(action.agent, candidates);
	const hit = action.kind
		? candidates.find((h) => (h.annotations.kind ?? "skill") === action.kind)
		: (candidates.find((h) => (h.annotations.kind ?? "skill") === "skill") ?? candidates[0]);
	if (!hit) return { ok: false, code: 404, reason: `no candidate "${action.skillName}" for agent ${action.agent}` };
	const row = rowFromHit(
		action.agent,
		hit,
		promotions.get(promotionKey(hit.annotations.kind ?? "skill", action.skillName)),
	);
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
		// Codex SIO-1896: latestPerSkill keeps the EARLIER hit on a learned_at tie,
		// and two writes in one call (approval, then a synchronous skipped outcome)
		// can share a millisecond; the later fact is stamped strictly newer.
		const next: AnnotationMap = { ...base, learned_at: strictlyAfter(now(), base.learned_at) };
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
	type Recorded = { note?: string; status: CandidateStatus };
	// Greptile #924: the outcome is its OWN fact (kind:promotion), merged into the
	// row at read time, so it can never outrank a reject or supersede written
	// while the PR was opening (facts are immutable and the latest skill fact
	// wins by learned_at; an outcome written as an approved skill fact could).
	// The re-read after the PR call only decides what status to REPORT.
	const recordPromotion = async (status: string, url?: string): Promise<Recorded> => {
		const stored = await recordAgentFactNow(
			action.agent,
			`Promotion outcome for ${row.kind} ${row.skillName}: ${status}${url ? ` ${url}` : ""}`,
			{
				kind: "promotion",
				skill_name: row.skillName,
				target_kind: row.kind,
				promotion: status,
				...(url ? { pr_url: url } : {}),
				learned_at: now(),
				agent: action.agent,
			},
		);
		const latest = (await latestHits(action.agent)).find(
			(h) => h.annotations.skill_name === row.skillName && (h.annotations.kind ?? "skill") === row.kind,
		);
		const latestStatus = parseStatus(latest?.annotations.status);
		const reported: CandidateStatus =
			latestStatus === "rejected" || latestStatus === "superseded" ? latestStatus : "approved";
		if (stored) return { status: reported };
		logger.warn({ agent: row.agent, skill: row.skillName, promotion: status }, "promotion outcome not stored");
		return { note: "promotion outcome not stored; the row cannot be retried from the pane", status: reported };
	};
	const withNote = (reason: string | undefined, note: string | undefined) =>
		note ? (reason ? `${reason}; ${note}` : note) : reason;
	const done = (prStatus: string, prReason: string | undefined, rec: Recorded, prUrl?: string) => ({
		ok: true as const,
		status: rec.status,
		prStatus,
		...(prUrl ? { prUrl } : {}),
		prReason: withNote(prReason, rec.note),
		promotionStored: rec.note === undefined,
	});
	// Codex SIO-1896: only the PR work is inside this try. A memory failure while
	// storing the outcome afterwards is reported as such, never as a PR failure
	// (which would offer a retry against a PR that did open).
	type Promotion = { prStatus: string; reason?: string; url?: string; note: string };
	const runPromotion = async (): Promise<Promotion> => {
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
				return {
					prStatus: result.status,
					reason: result.reason,
					url: result.url,
					note: `approved-runbook-${result.status}`,
				};
			}
			const fetchBase = deps.fetchBase ?? fetchBaseFileContent;
			const base = await fetchBase(agentManifestPath(row.agent));
			if (base.status === "skipped" || base.content === null) {
				const reason = base.status === "skipped" ? base.reason : "agent.yaml not found on base branch";
				return { prStatus: "skipped", reason, note: "approved-no-pr" };
			}
			const built = buildSkillPrFiles(base.content, {
				agent: row.agent,
				skillName: row.skillName,
				annotations,
				body: text,
			});
			if (!built.ok) {
				// Codex SIO-1896: a manifest that already lists the skill fails the same
				// way on every retry ("blocked", not retryable); one the edit cannot
				// parse may be repaired on the base branch later ("skipped", retryable).
				return built.terminal
					? { prStatus: "blocked", reason: built.reason, note: "approved-blocked" }
					: { prStatus: "skipped", reason: built.reason, note: "approved-no-pr" };
			}
			const result = await promote({
				kind: "new-skill",
				branch: `agent/learn/${row.agent}/skill-${row.skillName}`,
				title: buildSkillPrTitle(row.agent, row.skillName),
				body: buildSkillPrBody(row.agent, row.skillName, annotations),
				files: built.files,
				labels: ["learning-review", "skill-promotion"],
			});
			return {
				prStatus: result.status,
				reason: result.reason,
				url: result.url,
				note: `approved-skill-${result.status}`,
			};
		} catch (error) {
			// The approval is recorded; only the PR failed. Say so rather than undo it.
			logger.warn(
				{ agent: row.agent, skill: row.skillName, error: error instanceof Error ? error.message : String(error) },
				"promotion PR failed after approval",
			);
			return { prStatus: "failed", reason: "promotion PR failed", note: "approved-pr-failed" };
		}
	};
	const outcome = await runPromotion();
	const rec = await recordPromotion(outcome.prStatus, outcome.url).catch((error): Recorded => {
		logger.warn(
			{ agent: row.agent, skill: row.skillName, error: error instanceof Error ? error.message : String(error) },
			"promotion outcome not stored",
		);
		return { note: "promotion outcome not stored; the row cannot be retried from the pane", status: "approved" };
	});
	decision("applied", outcome.note);
	return done(outcome.prStatus, outcome.reason, rec, outcome.url);
}
