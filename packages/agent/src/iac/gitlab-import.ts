// agent/src/iac/gitlab-import.ts
// SIO-1525: import externally-made config changes from the elastic-iac GitLab repo into BOTH
// durable stores (Agent Memory facts + knowledge-graph ConfigChange nodes). Every pre-existing
// write path is keyed on an MR the agent itself opened (state.mrUrl), so a human editing
// environments/_deployments/<cluster>.json to 9.5.2 directly in GitLab -- or ANOTHER agent's MR --
// left no trace in this agent's history. This sweep lists first-parent commits on main via plain
// fetch (the seed-iac.ts precedent; the elastic-iac MCP exposes no commit-history tools), keeps
// only paths the agent can itself change (the WORKFLOW_VALUES catalogue -- the scope contract),
// skips changes this agent already recorded (KG PROPOSED_IN edge or an iac-change fact carrying
// the same mr_url; AGENT_MR_LABELS are deliberately NOT trusted as authorship, other agents use
// the same labels), and writes one record per (commit, deployment, workflow) group.
//
// Watermark is IN-PROCESS ONLY: correctness comes entirely from per-record dedupe (KG MERGE on a
// stable id + the memory external_import filter set); the watermark merely bounds repeat GitLab
// listing between sweeps in one process. A restart re-scans the lookback window and no-ops.
//
// Leaf module: must NOT import nodes.ts (nodes.ts calls importExternalChanges from bootstrapIac,
// which would form the reconcile.ts-class cycle SIO-1047 untangled).

import {
	configChangeExists,
	type GraphStore,
	getGraphStore,
	isKnowledgeGraphEnabled,
	mrUrlHasChange,
	recordIacChange,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { type AnnotationMap, redactPiiContent } from "@devops-agent/shared";
import { recordAgentFactNow, searchAgentMemory, selectedBackend } from "../memory-backend.ts";
import { appendDailyLog } from "../memory-writer.ts";
import type { IacWorkflow } from "./state.ts";

const log = getLogger("agent:iac:gitlab-import");
const AGENT = "elastic-iac";

const DEFAULT_LOOKBACK_DAYS = 30;
// Re-scan overlap so a commit landing while the previous sweep listed is never missed.
const WATERMARK_OVERLAP_MS = 15 * 60 * 1000;
// The memory dedupe recall is deterministic (filter-only), but bound the set we build from it.
const MEMORY_DEDUPE_LIMIT = 200;

// SIO-1525: first-run lookback window (days) -- this IS the backfill that captures external
// changes made before the sweep existed. Read defensively (mirrors applyNotStartedSettleDays):
// an unset/invalid override falls back to the 30-day default.
export function importLookbackDays(): number {
	const raw = process.env.IAC_IMPORT_LOOKBACK_DAYS;
	if (!raw) return DEFAULT_LOOKBACK_DAYS;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_LOOKBACK_DAYS;
}

// Mirrors reconcileEnabled(): useful work needs at least one durable store, plus the GitLab token
// (the read side is plain REST, not the MCP). Drives both the cron registration gate (apps/web)
// and the bootstrap call's decision to fire.
export function importEnabled(): boolean {
	if (!process.env.ELASTIC_IAC_GITLAB_TOKEN) return false;
	return selectedBackend() === "agent-memory" || isKnowledgeGraphEnabled();
}

export interface PathClassification {
	deployment: string;
	stack: string;
	// "deployments-json" is a sentinel: _deployments/<cluster>.json needs the field-level diff
	// (classifyDeploymentsChange) to pick version-upgrade vs tier-resize vs topology-edit.
	workflow: IacWorkflow | "deployments-json";
}

export interface DiffPathInput {
	path: string;
	deleted: boolean;
	newFile: boolean;
}

// The stack each import-visible workflow writes under. Values match nodes.ts's WORKFLOW_STACK
// (the enum-sync test asserts parity via stackForWorkflow, which this leaf must not import).
const STACK_BY_DIR: Record<string, true> = {
	"lifecycle-policies": true,
	"fleet-integrations": true,
	slos: true,
	alerting: true,
	dataviews: true,
	"cluster-defaults": true,
	"cluster-settings": true,
	spaces: true,
	security: true,
	dashboards: true,
	"index-templates": true,
	"ingest-pipelines": true,
};

// Classify one changed repo path into the agent-changeable scope, or null = out of scope.
// Deletions map to the delete workflows where the agent has one (ilm-delete,
// cluster-default-delete); a deleted _deployments cluster file is out of scope (the agent cannot
// decommission a deployment, so the change does not "align with what the agent can change").
export function classifyRepoPath(input: DiffPathInput): PathClassification | null {
	const parts = input.path.split("/").filter((s) => s.length > 0);
	if (parts[0] !== "environments" || parts.length < 3) return null;
	const second = parts[1];
	if (!second) return null;

	if (second === "_deployments") {
		const file = parts[2];
		if (parts.length !== 3 || !file || !file.endsWith(".json")) return null;
		// traffic-filters.json / versions.json live in _deployments but are not cluster files.
		if (file === "traffic-filters.json" || file === "versions.json") return null;
		if (input.deleted) return null;
		return { deployment: file.slice(0, -".json".length), stack: "deployments", workflow: "deployments-json" };
	}

	// environments/<cluster>/<stack>/<file> -- underscore dirs (_shared) are config buckets.
	if (second.startsWith("_") || parts.length !== 4) return null;
	const stack = parts[2];
	const file = parts[3];
	if (!stack || !file || !STACK_BY_DIR[stack]) return null;
	const deployment = second;

	switch (stack) {
		case "lifecycle-policies":
			if (!file.endsWith(".json")) return null;
			return { deployment, stack, workflow: input.deleted ? "ilm-delete" : "ilm-rollout" };
		case "fleet-integrations":
			if (file !== "integrations.json" || input.deleted) return null;
			return { deployment, stack, workflow: "fleet-integration" };
		case "slos":
			if (!file.endsWith(".json") || input.deleted) return null;
			return { deployment, stack, workflow: "slo-edit" };
		case "alerting":
			if (!file.endsWith(".json") || input.deleted) return null;
			return { deployment, stack, workflow: "alerting-edit" };
		case "dataviews":
			if (!file.endsWith(".json") || input.deleted) return null;
			return { deployment, stack, workflow: "dataview-edit" };
		case "cluster-defaults":
			if (!file.endsWith(".json")) return null;
			return { deployment, stack, workflow: input.deleted ? "cluster-default-delete" : "cluster-default-edit" };
		case "cluster-settings":
			if (file !== "settings.json" || input.deleted) return null;
			return { deployment, stack, workflow: "cluster-settings-edit" };
		case "spaces":
			if (!file.endsWith(".json") || input.deleted) return null;
			return { deployment, stack, workflow: "space-edit" };
		case "security":
			if (file !== "security.json" || input.deleted) return null;
			return { deployment, stack, workflow: "security-edit" };
		case "dashboards":
			// Path-only classification: dashboard ndjson is never parsed by the importer.
			if (!file.endsWith(".ndjson") || input.deleted) return null;
			return { deployment, stack, workflow: "dashboard-edit" };
		case "index-templates":
			if (!file.endsWith(".json") || input.deleted) return null;
			return { deployment, stack, workflow: "index-template-create" };
		case "ingest-pipelines":
			if (!file.endsWith(".json") || input.deleted) return null;
			return { deployment, stack, workflow: input.newFile ? "ingest-pipeline-create" : "ingest-pipeline-edit" };
		default:
			return null;
	}
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Dotted key paths whose values differ between two parsed JSON documents. Arrays and other
// non-object leaves compare by JSON identity (any difference reports the containing path).
export function changedJsonKeyPaths(before: unknown, after: unknown, prefix = ""): string[] {
	if (isPlainObject(before) && isPlainObject(after)) {
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		const out: string[] = [];
		for (const key of keys) {
			const path = prefix ? `${prefix}.${key}` : key;
			out.push(...changedJsonKeyPaths(before[key], after[key], path));
		}
		return out;
	}
	if (JSON.stringify(before) === JSON.stringify(after)) return [];
	return prefix ? [prefix] : ["<root>"];
}

export interface DeploymentsClassification {
	workflow: "version-upgrade" | "tier-resize" | "topology-edit";
	version?: string;
}

const TIER_SIZE_PATH = /^elasticsearch\.[^.]+\.(size|max_size)$/;

// A `version` change wins (the field the 9.5.2 upgrades edited); a change touching ONLY
// elasticsearch tier size fields is a tier-resize; everything else -- zone_count, autoscale,
// user_settings_yaml, kibana/integrations_server sizing, new cluster files, mixed edits,
// unparseable JSON on either side -- is the topology-edit catch-all (the proposer's own surface
// for those fields). Never throws.
export function classifyDeploymentsChange(before: unknown, after: unknown): DeploymentsClassification {
	if (!isPlainObject(after)) return { workflow: "topology-edit" };
	if (!isPlainObject(before)) return { workflow: "topology-edit" };
	const changed = changedJsonKeyPaths(before, after);
	if (changed.includes("version")) {
		const version = typeof after.version === "string" ? after.version : undefined;
		return { workflow: "version-upgrade", ...(version ? { version } : {}) };
	}
	if (changed.length > 0 && changed.every((p) => TIER_SIZE_PATH.test(p))) {
		return { workflow: "tier-resize" };
	}
	return { workflow: "topology-edit" };
}

// Stable, deterministic record id: KG MERGE makes re-imports idempotent and the memory dedupe
// set keys on it. One id per (commit, deployment, workflow) group.
export function externalChangeId(sha: string, deployment: string, workflow: string): string {
	return `gitlab:${sha.slice(0, 12)}:${deployment}:${workflow}`;
}

interface GitlabConfig {
	base: string;
	token: string;
	projectEnc: string;
}

function loadGitlabConfig(env: NodeJS.ProcessEnv = process.env): GitlabConfig {
	const base = env.ELASTIC_IAC_GITLAB_BASE_URL || "https://gitlab.com";
	const token = env.ELASTIC_IAC_GITLAB_TOKEN || "";
	const project = env.ELASTIC_IAC_GITLAB_PROJECT || "pvhcorp/dhco/observability/observability-elastic-iac";
	if (!token) throw new Error("ELASTIC_IAC_GITLAB_TOKEN is required to import from the live repo");
	return { base, token, projectEnc: encodeURIComponent(project) };
}

export interface GitlabCommit {
	id: string;
	parent_ids: string[];
	title: string;
	committed_date: string;
}

export interface GitlabDiffEntry {
	old_path: string;
	new_path: string;
	new_file: boolean;
	deleted_file: boolean;
	renamed_file: boolean;
}

interface GitlabCommitMr {
	iid: number;
	state: string;
	web_url: string;
}

// Bounded request timeout: a stalled GitLab connection would otherwise hold the sweep (and its
// sweepRunning re-entrancy guard) open for the process lifetime, disabling the importer.
const GITLAB_TIMEOUT_MS = 30_000;

async function gitlabJson<T>(cfg: GitlabConfig, pathAndQuery: string): Promise<T> {
	const url = `${cfg.base}/api/v4/projects/${cfg.projectEnc}/${pathAndQuery}`;
	const res = await fetch(url, {
		headers: { "PRIVATE-TOKEN": cfg.token },
		signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`GitLab ${pathAndQuery.split("?")[0]}: ${res.status} ${res.statusText}`);
	return (await res.json()) as T;
}

// Paginate until a short page (seed-iac's listTree pattern), bounded by maxItems.
async function gitlabPaged<T>(cfg: GitlabConfig, pathAndQuery: string, maxItems: number): Promise<T[]> {
	const sep = pathAndQuery.includes("?") ? "&" : "?";
	const out: T[] = [];
	for (let page = 1; out.length < maxItems; page++) {
		const batch = await gitlabJson<T[]>(cfg, `${pathAndQuery}${sep}per_page=100&page=${page}`);
		if (batch.length === 0) break;
		out.push(...batch);
		if (batch.length < 100) break;
	}
	return out.slice(0, maxItems);
}

// Per-round bound on the window listing; a window with more commits back-walks via `until`.
const LISTING_CAP = 1000;
// Back-walk rounds: LISTING_CAP * MAX_LISTING_ROUNDS is the absolute per-sweep listing bound. A
// window still capped after all rounds makes the sweep abort with an error rather than silently
// strand its oldest commits (5000 first-parent commits in one lookback window is an anomaly).
const MAX_LISTING_ROUNDS = 5;

// first_parent=true collapses merged branches to their merge/squash commit, so one main-branch
// commit represents one landed change (branch-interior commits never double-import).
//
// GitLab lists newest-first with no ascending option, so a window bigger than one LISTING_CAP
// page set would otherwise retain only the NEWEST commits -- and the sweep's oldest-first
// processing would then advance the watermark past unlisted older commits, stranding them
// forever. When a round comes back full, anchor `until` at the oldest commit seen and re-list
// the older region (the boundary commit repeats across rounds; the sha map dedupes it).
// `capped` is true only when the final round was still full -- the true oldest commits are then
// still unreached and the caller must NOT process (or advance the watermark) at all.
async function listMainCommitsSince(
	cfg: GitlabConfig,
	sinceIso: string,
): Promise<{ commits: GitlabCommit[]; capped: boolean }> {
	const bySha = new Map<string, GitlabCommit>();
	let untilIso: string | null = null;
	let capped = false;
	for (let round = 0; round < MAX_LISTING_ROUNDS; round++) {
		// Explicit annotations break the untilIso -> query -> batch -> untilIso inference cycle.
		const query: string =
			`repository/commits?ref_name=main&first_parent=true&since=${encodeURIComponent(sinceIso)}` +
			(untilIso ? `&until=${encodeURIComponent(untilIso)}` : "");
		const batch: GitlabCommit[] = await gitlabPaged<GitlabCommit>(cfg, query, LISTING_CAP);
		for (const c of batch) bySha.set(c.id, c);
		if (batch.length < LISTING_CAP) {
			capped = false;
			break;
		}
		capped = true;
		const oldest: GitlabCommit = batch.reduce((a, b) =>
			Date.parse(a.committed_date) <= Date.parse(b.committed_date) ? a : b,
		);
		untilIso = oldest.committed_date;
	}
	// The sweep processes oldest-first so the watermark only ever advances past commits it has
	// actually handled; the processing cap (opts.limit) must then keep the OLDEST commits
	// (truncating the newest leaves them ABOVE the watermark for the next sweep; live-probe
	// finding). Sort by epoch, NOT lexicographically: committed_date carries the commit author's
	// UTC offset (e.g. "+02:00" observed live), so string order diverges from time order.
	const commits = [...bySha.values()].sort((a, b) => Date.parse(a.committed_date) - Date.parse(b.committed_date));
	return { commits, capped };
}

async function getCommitDiff(cfg: GitlabConfig, sha: string): Promise<GitlabDiffEntry[]> {
	return gitlabPaged<GitlabDiffEntry>(cfg, `repository/commits/${sha}/diff`, 500);
}

async function getCommitMergedMrUrl(cfg: GitlabConfig, sha: string): Promise<{ url: string; iid: number } | null> {
	const mrs = await gitlabJson<GitlabCommitMr[]>(cfg, `repository/commits/${sha}/merge_requests`);
	const merged = mrs.find((m) => m.state === "merged" && m.web_url);
	return merged ? { url: merged.web_url, iid: merged.iid } : null;
}

async function getRawJsonAtRef(cfg: GitlabConfig, path: string, ref: string): Promise<unknown> {
	const url = `${cfg.base}/api/v4/projects/${cfg.projectEnc}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;
	const res = await fetch(url, {
		headers: { "PRIVATE-TOKEN": cfg.token },
		signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
	});
	// Only a genuinely missing blob (new file at the parent ref) may fall through to the
	// topology-edit classifier default. A transient 429/5xx must THROW so the commit errors and
	// is retried next sweep -- silently classifying it would persist the wrong workflow under a
	// permanent record id (the id embeds the workflow, so it would never self-correct).
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`GitLab raw ${path}@${ref.slice(0, 12)}: ${res.status} ${res.statusText}`);
	try {
		return JSON.parse(await res.text()) as unknown;
	} catch {
		return null; // malformed JSON IN the repo is a real (permanent) state -> classifier fallback
	}
}

interface ImportedRecord {
	id: string;
	deployment: string;
	stack: string;
	workflow: string;
	filePaths: string[];
	version?: string;
	commit: GitlabCommit;
	mrUrl?: string;
	mrIid?: number;
}

export function buildImportedAnnotations(record: ImportedRecord): AnnotationMap {
	// Mirrors buildIacChangeAnnotations' join keys (nodes.ts) so cross-store recall by
	// {stack_instance, kind} and by mr_url reads imported and agent-made changes identically.
	// lifecycle:"applied" is TERMINAL so enumerateUnreconciledChanges never re-polls imports
	// (belt-and-braces: most imports also carry no mr_iid, which skips them anyway).
	const a: AnnotationMap = {
		kind: "iac-change",
		outcome: "applied",
		lifecycle: "applied",
		external_import: "true",
		commit_sha: record.commit.id,
		config_change_id: record.id,
		deployment: record.deployment,
		stack: record.stack,
		stack_instance: `${record.deployment}/${record.stack}`,
		workflow: record.workflow,
	};
	if (record.version) a.version = record.version;
	const summary = redactPiiContent(record.commit.title).trim();
	if (summary) a.change_summary = summary;
	if (record.mrUrl) a.mr_url = record.mrUrl;
	if (record.mrIid != null) a.mr_iid = String(record.mrIid);
	return a;
}

// The durable Profile-fact statement. Identity lives in the annotations (the service paraphrases
// this prose on ingest); the text just has to state the truth plainly: applied, made externally.
export function buildImportedDecision(record: ImportedRecord): string {
	const scope = `${record.deployment}/${record.stack}`;
	const what =
		record.workflow === "version-upgrade" && record.version
			? `version upgraded to ${record.version}`
			: `${record.workflow} (${redactPiiContent(record.commit.title).trim() || record.filePaths[0] || "config change"})`;
	const via = record.mrUrl ? `via MR ${record.mrUrl}` : "by direct push";
	const when = new Date(record.commit.committed_date).toISOString();
	return (
		`Elastic IaC change APPLIED (made outside this agent) on ${scope}: ${what}. ` +
		`Landed on main in GitLab ${via} (commit ${record.commit.id.slice(0, 12)}, ${when}); ` +
		"imported by the gitlab-import sweep."
	);
}

export interface ImportOptions {
	source: "cron" | "bootstrap";
	limit?: number; // cap commits processed this sweep (bootstrap passes a small limit)
}

export interface ImportSummary {
	source: string;
	commitsListed: number;
	skippedAlreadyRecorded: number; // commit's MR already in this agent's stores
	skippedOutOfScope: number; // no agent-changeable path in the diff (incl. empty diffs)
	imported: number;
	alreadyImported: number; // record id present in every enabled store (idempotent re-scan)
	errors: number;
	truncated: boolean; // commit cap hit; the remainder is picked up by later sweeps
}

const DEFAULT_SWEEP_LIMIT = 200;

// In-process only (see module header). Exported reset keeps the sweep testable.
let watermarkIso: string | null = null;
let sweepRunning = false;

export function resetImportStateForTests(): void {
	watermarkIso = null;
	sweepRunning = false;
}

function emptySummary(source: string): ImportSummary {
	return {
		source,
		commitsListed: 0,
		skippedAlreadyRecorded: 0,
		skippedOutOfScope: 0,
		imported: 0,
		alreadyImported: 0,
		errors: 0,
		truncated: false,
	};
}

// Build the memory-side dedupe sets via deterministic recalls: ids of already-imported records
// and mr_urls of every fact kind that records an MR this agent already knows about (iac-change
// proposals/reconciles AND renovate-trigger facts -- the renovate lane stores its MR under its
// own kind with no KG MergeRequest edge, so without it a merged renovate MR would double-record
// as an external change; live-probe finding). Filter-only retrieval -- a query string would rank
// identifier-keyed targets out of the top-k window (SIO-998).
async function loadMemoryDedupe(): Promise<{ importedIds: Set<string>; recordedMrUrls: Set<string> }> {
	const importedIds = new Set<string>();
	const recordedMrUrls = new Set<string>();
	if (selectedBackend() !== "agent-memory") return { importedIds, recordedMrUrls };
	for (const kind of ["iac-change", "renovate-trigger"]) {
		const hits = await searchAgentMemory(AGENT, "", { kind }, MEMORY_DEDUPE_LIMIT, { deterministic: true });
		for (const hit of hits) {
			const a = hit.annotations;
			if (a.external_import === "true") {
				// The importer's own facts feed the per-record id set ONLY -- never the commit-level
				// mr_url skip. A partially-imported MR commit (fact written, KG write failed) must
				// re-enter persistRecord so the missing store retries; counting its mr_url here
				// would skip the whole commit first. mrUrlHasChange applies the same exclusion.
				if (a.config_change_id) importedIds.add(a.config_change_id);
				continue;
			}
			if (a.mr_url) recordedMrUrls.add(a.mr_url);
		}
	}
	return { importedIds, recordedMrUrls };
}

// Classify a commit's diff into (deployment, workflow) groups, fetching before/after blobs only
// for _deployments cluster files (never for dashboards ndjson or other stacks).
async function buildRecordsForCommit(
	cfg: GitlabConfig,
	commit: GitlabCommit,
	diff: GitlabDiffEntry[],
	mr: { url: string; iid: number } | null,
): Promise<ImportedRecord[]> {
	const groups = new Map<string, ImportedRecord>();
	for (const entry of diff) {
		const path = entry.deleted_file ? entry.old_path : entry.new_path;
		const classified = classifyRepoPath({ path, deleted: entry.deleted_file, newFile: entry.new_file });
		if (!classified) continue;

		let workflow: string = classified.workflow;
		let version: string | undefined;
		if (classified.workflow === "deployments-json") {
			const parent = commit.parent_ids[0];
			const before = entry.new_file || !parent ? null : await getRawJsonAtRef(cfg, path, parent);
			const after = await getRawJsonAtRef(cfg, path, commit.id);
			const result = classifyDeploymentsChange(before, after);
			workflow = result.workflow;
			version = result.version;
		}

		const key = `${classified.deployment}:${workflow}`;
		const existing = groups.get(key);
		if (existing) {
			existing.filePaths.push(path);
			if (version && !existing.version) existing.version = version;
			continue;
		}
		groups.set(key, {
			id: externalChangeId(commit.id, classified.deployment, workflow),
			deployment: classified.deployment,
			stack: classified.stack,
			workflow,
			filePaths: [path],
			...(version ? { version } : {}),
			commit,
			...(mr ? { mrUrl: mr.url, mrIid: mr.iid } : {}),
		});
	}
	return [...groups.values()];
}

// Write one record into every enabled store it is missing from. Returns "imported" when every
// enabled store now holds it and at least one write was new, "already" when every enabled store
// had it, "partial" when one store accepted the write but another enabled store failed, and
// "failed" when no store accepted it. partial/failed freeze the watermark so the commit is
// re-listed next sweep -- per-store dedupe makes the retry write only the missing side.
async function persistRecord(
	record: ImportedRecord,
	store: GraphStore | null,
	importedIds: Set<string>,
): Promise<"imported" | "already" | "partial" | "failed"> {
	let wrote = false;
	let had = false;
	let failed = false;

	if (store) {
		if (await configChangeExists(store, record.id)) {
			had = true;
		} else {
			try {
				await recordIacChange(store, {
					id: record.id,
					deployment: record.deployment,
					workflow: record.workflow,
					filePaths: record.filePaths,
					summary: buildKgSummary(record),
					...(record.mrUrl ? { mrUrl: record.mrUrl } : {}),
					stackInstanceId: `${record.deployment}/${record.stack}`,
					// Normalized to UTC: committed_date carries the author's offset, and the KG's
					// createdAt ordering is lexicographic, so mixed offsets would break it.
					createdAt: new Date(record.commit.committed_date).toISOString(),
					outcome: "applied",
				});
				wrote = true;
			} catch (error) {
				failed = true;
				log.warn(
					{ id: record.id, error: error instanceof Error ? error.message : String(error) },
					"gitlab-import: KG write failed",
				);
			}
		}
	}

	if (selectedBackend() === "agent-memory") {
		if (importedIds.has(record.id)) {
			had = true;
		} else {
			const ok = await recordAgentFactNow(AGENT, buildImportedDecision(record), buildImportedAnnotations(record));
			if (ok) {
				wrote = true;
				importedIds.add(record.id); // in-sweep dedupe for later commits touching the same group
			} else {
				failed = true;
			}
		}
	}

	if (wrote && failed) return "partial";
	if (wrote) return "imported";
	if (failed) return "failed";
	return had ? "already" : "failed"; // neither store enabled should not reach here (importEnabled gate)
}

function buildKgSummary(record: ImportedRecord): string {
	const title = redactPiiContent(record.commit.title).trim();
	const what =
		record.workflow === "version-upgrade" && record.version ? `-> ${record.version}` : title || "external edit";
	return `[${record.deployment}] ${record.workflow} ${what} (external, commit ${record.commit.id.slice(0, 12)})`;
}

// SIO-1525: sweep external GitLab changes into both stores. Best-effort per commit -- one
// failure never aborts the sweep, but it DOES freeze the watermark at the last clean commit so
// the failed one is re-listed (and deduped) next sweep.
export async function importExternalChanges(opts: ImportOptions): Promise<ImportSummary> {
	const summary = emptySummary(opts.source);
	if (!importEnabled()) {
		log.info({ source: opts.source }, "gitlab-import skipped: no durable store or GitLab token missing");
		return summary;
	}
	if (sweepRunning) {
		log.info({ source: opts.source }, "gitlab-import skipped: a sweep is already running");
		return summary;
	}
	sweepRunning = true;
	try {
		const cfg = loadGitlabConfig();
		const limit = opts.limit ?? DEFAULT_SWEEP_LIMIT;
		const since = watermarkIso
			? new Date(new Date(watermarkIso).getTime() - WATERMARK_OVERLAP_MS).toISOString()
			: new Date(Date.now() - importLookbackDays() * 24 * 60 * 60 * 1000).toISOString();

		const { commits: listed, capped } = await listMainCommitsSince(cfg, since);
		if (capped) {
			// The oldest commits of the window are still unreached (see listMainCommitsSince);
			// processing now would advance the watermark past them forever. Operator signal.
			summary.errors += 1;
			log.error(
				{ source: opts.source, since, cap: LISTING_CAP * MAX_LISTING_ROUNDS },
				"gitlab-import: window exceeds the listing bound; aborting sweep without processing",
			);
			log.info(summary, "gitlab-import sweep complete");
			return summary;
		}
		summary.truncated = listed.length > limit;
		// Oldest `limit` commits: the newest overflow stays above the watermark for later sweeps.
		const commits = listed.slice(0, limit);
		summary.commitsListed = commits.length;
		log.info(
			{ source: opts.source, since, commits: commits.length, truncated: summary.truncated },
			"gitlab-import sweep start",
		);

		const { importedIds, recordedMrUrls } = await loadMemoryDedupe();
		let store: GraphStore | null = null;
		if (isKnowledgeGraphEnabled()) {
			try {
				store = await getGraphStore();
			} catch (error) {
				// Abort rather than continue memory-only: a clean sweep here would advance the
				// watermark past records the enabled KG never received, and they'd never retry.
				summary.errors += 1;
				log.warn(
					{ source: opts.source, error: error instanceof Error ? error.message : String(error) },
					"gitlab-import: getGraphStore failed; aborting sweep (retried next tick)",
				);
				log.info(summary, "gitlab-import sweep complete");
				return summary;
			}
		}

		let watermarkFrozen = false;
		for (const commit of commits) {
			let commitClean = true;
			try {
				const mr = await getCommitMergedMrUrl(cfg, commit.id);
				if (mr && (recordedMrUrls.has(mr.url) || (store !== null && (await mrUrlHasChange(store, mr.url))))) {
					// This agent already recorded the change behind this MR (proposal fact / KG node);
					// the reconcile sweep owns advancing its outcome. Nothing to import.
					summary.skippedAlreadyRecorded += 1;
				} else {
					const diff = await getCommitDiff(cfg, commit.id);
					const records = await buildRecordsForCommit(cfg, commit, diff, mr);
					if (records.length === 0) {
						summary.skippedOutOfScope += 1;
					} else {
						for (const record of records) {
							const outcome = await persistRecord(record, store, importedIds);
							if (outcome === "imported") {
								summary.imported += 1;
								appendDailyLog({
									requestId: record.id,
									services: [record.deployment],
									datasources: ["gitlab"],
									summary: `Imported external GitLab change ${record.workflow} on ${record.deployment}/${record.stack} (commit ${commit.id.slice(0, 12)})`,
								});
								log.info(
									{ id: record.id, deployment: record.deployment, workflow: record.workflow, mrUrl: record.mrUrl },
									"gitlab-import: recorded external change",
								);
							} else if (outcome === "already") {
								summary.alreadyImported += 1;
							} else {
								// "partial" and "failed" both freeze the watermark: at least one
								// enabled store is still missing the record, so the commit must
								// re-list next sweep (the store that has it dedupes the retry).
								summary.errors += 1;
								commitClean = false;
							}
						}
					}
				}
			} catch (error) {
				summary.errors += 1;
				commitClean = false;
				log.warn(
					{ sha: commit.id, error: error instanceof Error ? error.message : String(error) },
					"gitlab-import: commit failed; continuing sweep",
				);
			}
			// Advance past clean commits only; the first failure freezes the watermark so the failed
			// commit is re-listed next sweep (later successes still import now and dedupe then).
			// Normalized to UTC so watermark comparisons never mix author offsets.
			if (commitClean && !watermarkFrozen) watermarkIso = new Date(commit.committed_date).toISOString();
			else watermarkFrozen = true;
		}

		if (summary.truncated) {
			log.info(
				{ source: opts.source, limit },
				"gitlab-import: commit cap hit; remaining commits will import on later sweeps",
			);
		}
		log.info(summary, "gitlab-import sweep complete");
		return summary;
	} finally {
		sweepRunning = false;
	}
}
