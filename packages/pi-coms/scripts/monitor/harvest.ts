// packages/pi-coms/scripts/monitor/harvest.ts
//
// SIO-1892: turn the monitor journal's diagnoses into reviewed-knowledge
// candidates for the analyzer. Runs OPERATOR-SIDE over checkpointed state.db
// files (never on a spoke, never across spokes at runtime): read finding rows
// that carry a diagnosis, join the actionability verdicts, group the recurring
// causes, redact every string, and emit candidate drafts the analyzer's
// learn:ingest CLI turns into kind:runbook candidates. No workspace imports:
// this file ships in the fleet bundle like the rest of scripts/monitor.
import { createHash } from "node:crypto";
import { redactMonitorText } from "./actionability-judge.ts";

export interface JournalRow {
	ts: string;
	kind: string;
	payload: string;
}

export interface HarvestOrigin {
	account: string;
	agent: string;
}

// The account id never leaves the box: the origin is a short digest of it plus
// the agent name, stable across runs so the same spoke groups with itself.
export function originId(origin: HarvestOrigin): string {
	return `${createHash("sha256").update(origin.account).digest("hex").slice(0, 8)}/${origin.agent}`;
}

export interface HarvestedDiagnosis {
	origin: string;
	ts: string;
	family: string;
	severity: string;
	resource: string;
	summary: string;
	dedupKey: string;
	probableCause: string;
	suggestedAction: string;
	evidence: { command: string; observation: string }[];
	confidence: number;
	// The Jev gate's reason when the monitor skipped this finding (routine /
	// duplicate): such a diagnosis never counts as a successful investigation.
	skippedReason?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

// Finding rows with a diagnosis the spoke itself produced (a reused one is
// skipped, or a flapping alarm would count the same lesson many times),
// joined to actionability_verdict rows by dedup_key.
export function harvestJournal(rows: JournalRow[], origin: HarvestOrigin): HarvestedDiagnosis[] {
	const id = originId(origin);
	const skipped = new Map<string, string>();
	for (const row of rows) {
		if (row.kind !== "actionability_verdict") continue;
		const p = asRecord(safeParse(row.payload));
		if (!p) continue;
		const key = str(p.dedup_key);
		if (key) skipped.set(key, str(p.reason) || "skipped");
	}
	const out: HarvestedDiagnosis[] = [];
	for (const row of rows) {
		if (row.kind !== "finding") continue;
		const p = asRecord(safeParse(row.payload));
		if (!p || p.reused_from) continue;
		const d = asRecord(p.diagnosis);
		if (!d) continue;
		const evidence = Array.isArray(d.evidence)
			? d.evidence
					.map((e) => asRecord(e))
					.filter((e): e is Record<string, unknown> => e !== null)
					.map((e) => ({ command: str(e.command), observation: str(e.observation) }))
					.filter((e) => e.command && e.observation)
			: [];
		const probableCause = str(d.probable_cause).trim();
		if (!probableCause) continue;
		const dedupKey = str(p.dedup_key);
		out.push({
			origin: id,
			ts: row.ts,
			family: str(p.family),
			severity: str(p.severity),
			resource: str(p.resource),
			summary: str(p.summary),
			dedupKey,
			probableCause,
			suggestedAction: str(d.suggested_action).trim(),
			evidence,
			confidence: typeof d.confidence === "number" ? d.confidence : 0,
			...(skipped.has(dedupKey) ? { skippedReason: skipped.get(dedupKey) } : {}),
		});
	}
	return out;
}

function safeParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

export interface HarvestGroup {
	key: string;
	family: string;
	probableCause: string;
	members: HarvestedDiagnosis[];
	origins: string[];
}

// ponytail: naive text grouping on the normalised probable cause. Upgrade to
// family+resource keys if fleet output shows the same lesson split across
// wordings.
export function groupKey(d: HarvestedDiagnosis): string {
	const cause = d.probableCause
		.toLowerCase()
		.replace(/\b\d[\d.:/-]*\b/g, "#")
		.replace(/\s+/g, " ")
		.trim();
	return `${d.family}|${cause}`;
}

export function groupDiagnoses(items: HarvestedDiagnosis[]): HarvestGroup[] {
	const groups = new Map<string, HarvestGroup>();
	for (const d of items) {
		const key = groupKey(d);
		let g = groups.get(key);
		if (!g) {
			g = { key, family: d.family, probableCause: d.probableCause, members: [], origins: [] };
			groups.set(key, g);
		}
		g.members.push(d);
		if (!g.origins.includes(d.origin)) g.origins.push(d.origin);
	}
	return [...groups.values()];
}

export interface SelectionThresholds {
	minOrigins: number;
	minOccurrences: number;
}

// A lesson worth reviewing recurred: seen from several spokes, or often on one.
export function selectGroups(groups: HarvestGroup[], t: SelectionThresholds): HarvestGroup[] {
	return groups.filter((g) => g.origins.length >= t.minOrigins || g.members.length >= t.minOccurrences);
}

// The analyzer's LearningCandidate minus `agent` (learn:ingest fills it).
export interface CandidateDraft {
	kind: "runbook";
	skill_name: string;
	title: string;
	applicability: string;
	body: string;
	evidence: { ref: string; excerpt: string }[];
	source: "fleet";
	learned_from: string;
	status: "candidate";
	task_success: "" | "1";
	task_success_source: "" | "fleet-verdict";
	target_dir: string;
}

export const DEFAULT_TARGET_DIR = "agents/incident-analyzer/knowledge/aws/runbooks";
const TITLE_MAX = 80;
const EXCERPT_MAX = 400;
const EVIDENCE_MAX = 5;

export function slug(family: string, cause: string): string {
	const s = `${family}-${cause}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
	return s.slice(0, 60).replace(/-+$/g, "") || "fleet-lesson";
}

// The result never exceeds n, ellipsis included.
function cap(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 3).trimEnd()}...`;
}

function sentence(s: string): string {
	const t = s.trim().replace(/\s+/g, " ");
	if (!t) return t;
	const up = t.charAt(0).toUpperCase() + t.slice(1);
	return /[.!?]$/.test(up) ? up : `${up}.`;
}

// Every string is redacted here, once, before it leaves the box; the ingest
// side treats the draft as data and never sends it to a model unredacted.
export function toCandidateDraft(group: HarvestGroup, targetDir = DEFAULT_TARGET_DIR): CandidateDraft {
	const r = (s: string) => redactMonitorText(s);
	const actions = [...new Set(group.members.map((m) => m.suggestedAction).filter((a) => a.length > 0))];
	const confirm = group.members.flatMap((m) => m.evidence.map((e) => e.command)).find((c) => c.length > 0);
	const bodyParts = [
		`Do: ${sentence(actions[0] ?? "investigate the finding with the evidence below")}`,
		`Why: ${sentence(group.probableCause)} Seen ${group.members.length} time(s) across ${group.origins.length} spoke(s) (${group.family}).`,
	];
	if (actions.length > 1) bodyParts.push(`Also tried: ${actions.slice(1, 3).map(sentence).join(" ")}`);
	if (confirm) bodyParts.push(`Confirm with: ${confirm}`);
	const evidence = group.members
		.flatMap((m, i) =>
			m.evidence.map((e, j) => ({
				ref: `journal:${m.origin}#${i}.${j}`,
				excerpt: cap(r(`${e.command} -> ${e.observation}`), EXCERPT_MAX),
			})),
		)
		.slice(0, EVIDENCE_MAX);
	if (evidence.length === 0) {
		const m = group.members[0];
		if (m) evidence.push({ ref: `journal:${m.origin}#0`, excerpt: cap(r(m.summary || m.probableCause), EXCERPT_MAX) });
	}
	// Task success comes from the fleet's own verdict: a confident diagnosis
	// the monitor did not classify as routine or duplicate.
	const succeeded = group.members.some((m) => m.confidence >= 0.7 && !m.skippedReason);
	return {
		kind: "runbook",
		skill_name: slug(group.family, r(group.probableCause)),
		title: cap(r(sentence(group.probableCause)), TITLE_MAX),
		applicability: r(`When a ${group.family} finding reports: ${sentence(group.probableCause)}`),
		body: r(bodyParts.join("\n")),
		evidence,
		source: "fleet",
		learned_from: r(`fleet:${group.origins.join(",")}`),
		status: "candidate",
		task_success: succeeded ? "1" : "",
		task_success_source: succeeded ? "fleet-verdict" : "",
		target_dir: targetDir,
	};
}

export interface HarvestOutput {
	generated_at: string;
	window_days: number;
	spokes: number;
	candidates: CandidateDraft[];
}

export function harvest(
	inputs: { rows: JournalRow[]; origin: HarvestOrigin }[],
	opts: { windowDays: number; thresholds: SelectionThresholds; targetDir?: string; now?: () => string },
): HarvestOutput {
	const all = inputs.flatMap((i) => harvestJournal(i.rows, i.origin));
	const groups = selectGroups(groupDiagnoses(all), opts.thresholds);
	return {
		generated_at: (opts.now ?? (() => new Date().toISOString()))(),
		window_days: opts.windowDays,
		spokes: inputs.length,
		candidates: groups.map((g) => toCandidateDraft(g, opts.targetDir)),
	};
}
