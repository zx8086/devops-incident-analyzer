// packages/agent/src/iac/reconcile.ts
// SIO-1005: reconcile durable iac-change memory facts from "proposed" to their real terminal state
// (applied / apply-failed / closed). The elastic-iac agent records a fact at proposal time whose
// outcome:"completed" only means the proposal turn finished -- nothing re-checks whether the MR
// later merged and its terraform apply succeeded. Agent Memory facts are append-only, so this pass
// APPENDS a new authoritative fact (same MR identity keys + a `lifecycle` annotation) rather than
// mutating the stale one; recall then prefers the terminal fact per MR (dedupePreferring +
// lifecycleRank). Driven by an in-process Bun.cron sweep and a bounded refresh in bootstrapIac.

import {
	type ChangeOutcome,
	type GraphStore,
	getGraphStore,
	isKnowledgeGraphEnabled,
	proposedChangesWithMr,
	setChangeOutcome,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import type { AnnotationMap } from "@devops-agent/shared";
import { dedupeHitsBy, searchAgentMemory, selectedBackend } from "../memory-backend.ts";
import { appendDailyLog, recordKeyDecision } from "../memory-writer.ts";
import { classifyLiveState, type IacLifecycle, isTerminalLifecycle } from "./lifecycle.ts";
import { fetchMrLiveState } from "./mr-live-state.ts";

const log = getLogger("agent:iac:reconcile");
const AGENT = "elastic-iac";

const DEFAULT_PROPOSAL_TTL_SECONDS = 7_776_000; // 90 days

// SIO-1005: the TTL (seconds) the PROPOSAL iac-change fact should carry, or undefined for "durable,
// no decay". Reconciliation is driven entirely by the agent-memory backend (no separate flag): when
// it is active the reconciler runs (cron + bootstrap) and WILL write the durable applied/failed/
// closed fact, so the proposal can safely decay after the TTL. On any other backend reconcile is a
// no-op, so we must NOT let the proposal expire (it would leave the MR with no stored fact at all)
// -> undefined. Read defensively (mirrors dailyLogTtlSeconds): an unset/invalid override falls back
// to the 90-day default.
export function iacProposalFactTtlSeconds(): number | undefined {
	if (selectedBackend() !== "agent-memory") return undefined; // no reconciler -> keep proposals durable
	const raw = process.env.IAC_PROPOSAL_FACT_TTL_SECONDS;
	if (!raw) return DEFAULT_PROPOSAL_TTL_SECONDS;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_PROPOSAL_TTL_SECONDS;
}

// A proposed iac-change fact worth re-checking: its MR identity + scope, read from annotations.
export interface ReconcileTarget {
	mrIid: number;
	mrUrl?: string;
	configChangeId?: string;
	threadId?: string;
	deployment?: string;
	stack?: string;
	stackInstance?: string;
	changeSummary?: string;
	workflow?: string;
	pipelineId?: string;
}

export interface ReconcileResult {
	target: ReconcileTarget;
	lifecycle: IacLifecycle;
	applyPipelineId: number | null;
	applyPipelineUrl: string;
	recorded: boolean; // did we append an authoritative fact this sweep?
}

export interface ReconcileSummary {
	source: string;
	checked: number;
	advanced: number; // terminal facts appended
	applied: number;
	failed: number; // apply-failed
	closed: number;
	stillOpen: number; // open / apply-running / apply-not-started (skipped, re-checked next sweep)
	errors: number;
}

export interface ReconcileOptions {
	source: "cron" | "bootstrap";
	limit?: number; // cap targets re-checked this sweep (bootstrap passes a small limit)
}

// SIO-1005: enumerate proposed iac-change facts that are NOT yet terminal-reconciled. Deterministic
// filter-only recall (the kind filter is authoritative; a query string would rank targets out of the
// top-k window). dedupeHitsBy collapses re-records per MR. We skip any hit that already carries a
// TERMINAL `lifecycle` annotation -- those are done; re-checking GitLab for them is wasted work.
export async function enumerateUnreconciledChanges(limit = 50): Promise<ReconcileTarget[]> {
	if (selectedBackend() !== "agent-memory") return [];
	const hits = await searchAgentMemory(AGENT, "", { kind: "iac-change" }, limit, { deterministic: true });
	const deduped = dedupeHitsBy(hits, (h) => h.annotations.mr_url ?? h.annotations.config_change_id);
	const targets: ReconcileTarget[] = [];
	for (const hit of deduped) {
		const a = hit.annotations;
		const lifecycle = a.lifecycle as IacLifecycle | undefined;
		if (lifecycle && isTerminalLifecycle(lifecycle)) continue; // already reconciled to a terminal state
		const mrIid = a.mr_iid ? Number(a.mr_iid) : Number.NaN;
		if (!Number.isFinite(mrIid)) continue; // no MR iid -> cannot re-check
		targets.push(targetFromAnnotations(mrIid, a));
	}
	return targets;
}

function targetFromAnnotations(mrIid: number, a: AnnotationMap): ReconcileTarget {
	return {
		mrIid,
		...(a.mr_url ? { mrUrl: a.mr_url } : {}),
		...(a.config_change_id ? { configChangeId: a.config_change_id } : {}),
		...(a.thread_id ? { threadId: a.thread_id } : {}),
		...(a.deployment ? { deployment: a.deployment } : {}),
		...(a.stack ? { stack: a.stack } : {}),
		...(a.stack_instance ? { stackInstance: a.stack_instance } : {}),
		...(a.change_summary ? { changeSummary: a.change_summary } : {}),
		...(a.workflow ? { workflow: a.workflow } : {}),
		...(a.pipeline_id ? { pipelineId: a.pipeline_id } : {}),
	};
}

// SIO-1005: re-check one proposed MR's live state and, ONLY on a terminal advance, append an
// authoritative fact + a dailylog breadcrumb. Open / apply-running / apply-not-started are returned
// (so the summary counts them) but NOT recorded -- they are re-checked next sweep, avoiding a churn
// of near-duplicate transient facts in the append-only store. Best-effort: never throws.
export async function reconcileOne(target: ReconcileTarget): Promise<ReconcileResult> {
	const live = await fetchMrLiveState(target.mrIid);
	const lifecycle = classifyLiveState(live.mrState, live.applyStatus);
	const base: ReconcileResult = {
		target,
		lifecycle,
		applyPipelineId: live.applyPipelineId,
		applyPipelineUrl: live.applyPipelineUrl,
		recorded: false,
	};
	if (!isTerminalLifecycle(lifecycle)) return base;

	recordKeyDecision({
		requestId: target.configChangeId ?? `reconcile:${target.mrIid}`,
		decision: buildReconciledIacDecision(target, lifecycle),
		rationale: buildReconciledIacRationale(target, live.applyPipelineUrl),
		annotations: buildReconciledIacAnnotations(target, lifecycle, live.applyPipelineId, live.applyPipelineUrl),
	});
	appendDailyLog({
		requestId: target.configChangeId ?? `reconcile:${target.mrIid}`,
		services: [],
		datasources: ["gitlab"],
		summary: `Reconciled MR !${target.mrIid} -> ${lifecycle}${target.stackInstance ? ` (${target.stackInstance})` : ""}`,
	});
	log.info(
		{ mrIid: target.mrIid, mrUrl: target.mrUrl, lifecycle, applyPipelineId: live.applyPipelineId },
		"reconcileOne: recorded authoritative iac-change fact",
	);
	return { ...base, recorded: true };
}

// SIO-1053: the two lifecycle stores are gated independently -- agent-memory reconciliation needs the
// agent-memory backend, KG reconciliation needs KNOWLEDGE_GRAPH_ENABLED. The sweep should do useful
// work when EITHER is on, so this predicate drives both the bootstrap sweep's decision to run and the
// cron's decision to register (imported by apps/web via @devops-agent/agent).
export function reconcileEnabled(): boolean {
	return selectedBackend() === "agent-memory" || isKnowledgeGraphEnabled();
}

// SIO-1005/SIO-1053: sweep all unreconciled changes across BOTH stores. One item's failure never
// aborts the sweep. The agent-memory loop runs only under the agent-memory backend; the KG pass runs
// only under KNOWLEDGE_GRAPH_ENABLED. Either store being off is a legitimate no-op (logged, not silent).
export async function reconcileAll(opts: ReconcileOptions): Promise<ReconcileSummary> {
	const summary: ReconcileSummary = {
		source: opts.source,
		checked: 0,
		advanced: 0,
		applied: 0,
		failed: 0,
		closed: 0,
		stillOpen: 0,
		errors: 0,
	};

	// Agent-memory store (SIO-1005): unchanged behaviour, only when the backend is selected.
	if (selectedBackend() === "agent-memory") {
		const targets = await enumerateUnreconciledChanges(opts.limit ?? 50);
		log.info({ source: opts.source, targets: targets.length, limit: opts.limit ?? 50 }, "reconcile sweep start");
		for (const target of targets) {
			try {
				const result = await reconcileOne(target);
				summary.checked += 1;
				if (result.recorded) summary.advanced += 1;
				if (result.lifecycle === "applied") summary.applied += 1;
				else if (result.lifecycle === "apply-failed") summary.failed += 1;
				else if (result.lifecycle === "closed") summary.closed += 1;
				else summary.stillOpen += 1;
			} catch (error) {
				summary.errors += 1;
				log.warn(
					{ mrIid: target.mrIid, error: error instanceof Error ? error.message : String(error) },
					"reconcileOne failed; continuing sweep",
				);
			}
		}
	} else {
		log.info({ source: opts.source }, "agent-memory reconcile skipped: backend not selected");
	}

	// Knowledge-graph store (SIO-1053): independent gate; reports via its own log line, does not
	// change the agent-memory summary counts (keeps the summary shape stable for the cron log).
	await reconcileKnowledgeGraph(opts);

	// SIO-1005: one summary line per sweep, ALWAYS -- so cron, bootstrap, and a direct live-probe call
	// all report their outcome (including checked:0) in one place, and the callers don't each repeat it.
	log.info(summary, "reconcile sweep complete");
	return summary;
}

// SIO-1053: GitLab MR urls end in ".../-/merge_requests/<iid>"; derive the numeric iid so a KG
// ConfigChange (which stores its MR by url, not iid) can be re-checked via fetchMrLiveState.
export function mrIidFromUrl(url: string): number | null {
	const m = /\/merge_requests\/(\d+)/.exec(url);
	return m ? Number(m[1]) : null;
}

// SIO-1053: map the reconciler's live IacLifecycle to the KG's ChangeOutcome. Returns null for
// transient lifecycles (open / apply-running / apply-not-started) -> no KG write, re-checked next
// sweep. "closed" (MR closed unmerged) maps to the KG's "rejected" (its closest existing value).
export function lifecycleToChangeOutcome(lifecycle: IacLifecycle): ChangeOutcome | null {
	if (lifecycle === "applied") return "applied";
	if (lifecycle === "apply-failed") return "failed";
	if (lifecycle === "closed") return "rejected";
	return null;
}

// SIO-1053: reconcile the KG ConfigChange.outcome for every proposed change with an MR. Reuses the
// process-wide getGraphStore() singleton -- the SAME lbug handle the agent pipeline and the in-process
// KG MCP already hold (one exclusive-lock opener). It NEVER constructs a store and NEVER closes one
// (a second opener contends the lock; native close segfaults Bun). Best-effort per change; a single
// failure never aborts the pass.
export async function reconcileKnowledgeGraph(opts: ReconcileOptions): Promise<void> {
	if (!isKnowledgeGraphEnabled()) {
		log.info({ source: opts.source }, "KG reconcile skipped: KNOWLEDGE_GRAPH_ENABLED not set");
		return;
	}
	let store: GraphStore;
	try {
		store = await getGraphStore();
	} catch (error) {
		log.warn(
			{ source: opts.source, error: error instanceof Error ? error.message : String(error) },
			"KG reconcile skipped: getGraphStore failed",
		);
		return;
	}
	// A bit wider than the agent-memory limit: KG ConfigChanges and agent-memory facts are not 1:1.
	const proposed = await proposedChangesWithMr(store, opts.limit ? opts.limit * 4 : 200);
	log.info({ source: opts.source, proposed: proposed.length }, "KG reconcile start");
	let advanced = 0;
	for (const change of proposed) {
		try {
			const iid = mrIidFromUrl(change.mrUrl);
			if (iid == null) {
				// A persistently malformed MR url would otherwise be silently re-skipped every sweep.
				log.warn({ changeId: change.id, mrUrl: change.mrUrl }, "KG reconcile: MR url has no derivable iid, skipping");
				continue;
			}
			const live = await fetchMrLiveState(iid);
			const lifecycle = classifyLiveState(live.mrState, live.applyStatus);
			const outcome = lifecycleToChangeOutcome(lifecycle);
			if (!outcome) continue; // transient -> leave "proposed", re-check next sweep
			await setChangeOutcome(store, change.id, outcome);
			advanced += 1;
			log.info({ changeId: change.id, iid, lifecycle, outcome }, "KG reconcile: advanced ConfigChange.outcome");
		} catch (error) {
			log.warn(
				{ changeId: change.id, mrUrl: change.mrUrl, error: error instanceof Error ? error.message : String(error) },
				"KG reconcile one failed; continuing",
			);
		}
	}
	log.info({ source: opts.source, proposed: proposed.length, advanced }, "KG reconcile complete");
}

// SIO-1005: the authoritative annotations. Mirrors buildIacChangeAnnotations' identity keys
// (carried VERBATIM from the proposal fact so dedup/recall match the same MR) and adds the
// `lifecycle` annotation (the new source of truth) plus apply-job traceability. outcome is kept for
// back-compat, set to the terminal outcome.
export function buildReconciledIacAnnotations(
	target: ReconcileTarget,
	lifecycle: IacLifecycle,
	applyPipelineId: number | null,
	applyPipelineUrl: string,
): AnnotationMap {
	const a: AnnotationMap = { kind: "iac-change", lifecycle, outcome: terminalOutcome(lifecycle) };
	a.mr_iid = String(target.mrIid);
	if (target.mrUrl) a.mr_url = target.mrUrl;
	if (target.configChangeId) a.config_change_id = target.configChangeId;
	if (target.threadId) a.thread_id = target.threadId;
	if (target.deployment) a.deployment = target.deployment;
	if (target.stack) a.stack = target.stack;
	if (target.stackInstance) a.stack_instance = target.stackInstance;
	if (target.changeSummary) a.change_summary = target.changeSummary;
	if (target.workflow) a.workflow = target.workflow;
	if (target.pipelineId) a.pipeline_id = target.pipelineId;
	if (applyPipelineId != null) a.apply_pipeline_id = String(applyPipelineId);
	if (applyPipelineUrl) a.apply_pipeline_url = applyPipelineUrl;
	return a;
}

// back-compat outcome value for the terminal lifecycle (the prose tag now reads lifecycle).
function terminalOutcome(lifecycle: IacLifecycle): string {
	if (lifecycle === "applied") return "applied";
	if (lifecycle === "apply-failed") return "apply-failed";
	return "closed";
}

// SIO-1005: the durable Profile-fact statement. States the truth plainly so even after the
// agent-memory service paraphrases the body, the semantic tokens say applied/live (or
// apply-failed / closed), not "proposed".
export function buildReconciledIacDecision(target: ReconcileTarget, lifecycle: IacLifecycle): string {
	const scope = target.stackInstance || target.deployment || "an Elastic deployment";
	const title = target.changeSummary || target.workflow || "config change";
	const mr = target.mrUrl ? ` (MR ${target.mrUrl})` : ` (MR !${target.mrIid})`;
	if (lifecycle === "applied") {
		return `Elastic IaC change APPLIED (live) on ${scope}: ${title}. Merged${mr}; the terraform apply job on main succeeded.`;
	}
	if (lifecycle === "apply-failed") {
		return `Elastic IaC change APPLY FAILED on ${scope}: ${title}. Merged${mr}, but the terraform apply job on main did NOT succeed -- the change is NOT live.`;
	}
	return `Elastic IaC change CLOSED without merging on ${scope}: ${title}.${mr} Nothing was applied.`;
}

function buildReconciledIacRationale(target: ReconcileTarget, applyPipelineUrl: string): string {
	const bits: string[] = [];
	if (target.mrUrl) bits.push(`MR ${target.mrUrl}`);
	if (applyPipelineUrl) bits.push(`apply ${applyPipelineUrl}`);
	return bits.length > 0
		? `${bits.join(", ")}. Reconciled from the live MR + apply-job status.`
		: "Reconciled from the live MR + apply-job status.";
}
