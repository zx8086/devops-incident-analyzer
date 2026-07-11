// packages/agent/src/iac/lifecycle.ts
// SIO-1005: pure helpers shared by the reconciliation pass (reconcile.ts), the closing-line
// renderer (iacClosingLine), and the recall tag/dedup sites. Single source of truth for the IaC
// change apply taxonomy so the recorded state and the rendered state never drift.
import type { AnnotationMap } from "@devops-agent/shared";

// The true post-proposal lifecycle of an agent IaC change, derived from the MR state + the apply
// JOB's status (NOT the parent pipeline -- SIO-995). "open" = MR still open (plan staged, nothing
// merged); the three apply-* states only occur once merged.
export type IacLifecycle = "open" | "closed" | "apply-not-started" | "apply-running" | "apply-failed" | "applied";

// SIO-1005: map (mrState, applyStatus) -> lifecycle. mrState is gitlab_get_merge_request's state
// ("opened"|"merged"|"closed"|""); applyStatus is gitlab_get_merge_commit_apply_result's apply-JOB
// status ("success"|"failed"|"canceled"|"running"|"pending"|""). Only meaningful once merged. This
// is the same taxonomy iacClosingLine branches on -- it now calls this so they cannot diverge.
export function classifyLiveState(mrState: string, applyStatus: string): IacLifecycle {
	if (mrState === "closed") return "closed";
	if (mrState !== "merged") return "open"; // "opened" or unread -> nothing merged/applied yet
	if (applyStatus === "success") return "applied";
	if (applyStatus === "failed" || applyStatus === "canceled") return "apply-failed";
	if (applyStatus === "") return "apply-not-started"; // apply job not appeared yet (never success)
	return "apply-running"; // running/pending or any other non-terminal status
}

// A lifecycle is TERMINAL when re-checking it later cannot change it: the change is live, the apply
// failed for good, or the MR was closed without merging. The reconciliation pass writes an
// authoritative fact ONLY on a terminal advance, so transient states (open / apply-running /
// apply-not-started) never churn near-duplicate facts into the append-only store.
export function isTerminalLifecycle(lifecycle: IacLifecycle): boolean {
	return lifecycle === "applied" || lifecycle === "apply-failed" || lifecycle === "closed";
}

// SIO-1074: a merged MR whose merge-commit PARENT pipeline finished successfully without ever
// spawning the apply child job. classifyLiveState calls this apply-not-started (transient), but the
// apply will never start on that pipeline -- applies run per-stack, often batched or via a later
// full-stack refresh -- so without settlement the change re-qualifies for the reconcile sweep
// forever. Requirements are deliberately strict: only a SUCCESSFUL, terminal parent qualifies (a
// running/pending parent may still spawn the apply; a failed parent is a different problem), and the
// merge must be at least settleAfterDays old so a late batched apply still gets to report normally.
export interface OrphanedApplyInput {
	mrState: string;
	applyStatus: string;
	parentStatus?: string;
	mergedAt?: string;
}

export function isOrphanedApply(live: OrphanedApplyInput, now: Date, settleAfterDays: number): boolean {
	if (live.mrState !== "merged" || live.applyStatus !== "") return false;
	if (live.parentStatus !== "success") return false;
	if (!live.mergedAt) return false;
	const mergedMs = Date.parse(live.mergedAt);
	if (Number.isNaN(mergedMs)) return false;
	return now.getTime() - mergedMs >= settleAfterDays * 86_400_000;
}

// SIO-1005: rank a recalled iac-change hit's annotations so dedupePreferring picks the most
// informative fact per MR. A reconciled fact carries a `lifecycle` annotation; a legacy proposal
// fact does not (rank 0, always loses to a reconciled fact for the same MR). Terminal states
// outrank transient ones. Rank is STATE-based (not write-time) so the reconciled fact wins even if
// the append-only flush ordering or a stray re-record of the proposal lands out of order.
export function lifecycleRank(annotations: AnnotationMap): number {
	const ranks: Record<IacLifecycle, number> = {
		open: 1,
		"apply-not-started": 2,
		"apply-running": 3,
		closed: 4,
		"apply-failed": 5,
		applied: 6,
	};
	const lifecycle = annotations.lifecycle as IacLifecycle | undefined;
	return lifecycle && lifecycle in ranks ? ranks[lifecycle] : 0; // no lifecycle = legacy proposal
}

// SIO-1005: the tag rendered after a recalled change in the plan-review panels and the
// search_memory tool. Before this, all three render sites put the raw `outcome` annotation here, so
// a still-only-PROPOSED change read the misleading "[ilm-rollout completed]" (outcome:"completed"
// only meant the proposal turn finished). Now: a reconciled fact shows its lifecycle
// (applied/apply-failed/closed); a proposal-only fact shows "proposed" instead of "completed"; and
// the genuinely-distinct outcomes (rejected/blocked/pipeline-failed/declined/unsupported) pass
// through verbatim -- those must NOT be relabelled.
export function lifecycleTag(annotations: AnnotationMap): string {
	if (annotations.lifecycle) return annotations.lifecycle;
	if (annotations.outcome === "completed") return "proposed";
	return annotations.outcome ?? "";
}
