// agent/src/aws-absence-completion.ts
// SIO-1784: finish the ECS enumeration the ReAct loop left unfinished, so the AWS absence proof
// does not depend on how thorough the model happened to be.
//
// A pi verify card is suppressed for an estate only when the ECS ledger PROVES the focus service
// is absent there (SIO-1777). After SIO-1783 the proof is no longer destroyed by a bug, but it
// still only holds if the model listed the services of EVERY cluster. Two replays of one incident
// showed the coin flip: one walked 1 of 5 clusters and a card was proposed for an estate the
// report itself called a confirmed negative; the next walked all 5 and the card was suppressed.
// Same code, same incident. Four cheap list calls settle it.
//
// Why this does not go back through the instrumented proxies (SIO-1784's own dated correction,
// verified against sub-agent-loop-guard.ts): for a cluster the model only PARTLY paginated, page 1
// is already in seenSignatures, and the duplicate check sits BEFORE the RUN_BACKSTOP_EXEMPT_TOOLS
// carve-out, so the re-list is refused. The ledger stores no cursor, so the walk cannot resume
// mid-cluster either. The caller therefore invokes the UNINSTRUMENTED tools and feeds each page
// back through the runSignals.observeEcsPage seam. That also keeps these calls out of the
// iteration counter and the UI progress ticks.
import { AWS_ECS_LIST_SERVICES, nextEcsToken } from "./sub-agent-loop-guard.ts";

// The blocker prefix this completion is the answer to. Every other blocker is either already
// terminal (matched, failed) or describes a gap this cannot close (cluster-pages-incomplete means
// the CLUSTER list itself is unfinished; zero-clusters means there is nothing to walk).
const SERVICES_INCOMPLETE_PREFIX = "services-incomplete:";

// Bounds. Both are deliberately small: the point is to spend a handful of list calls, not to turn
// an unfinished enumeration into an unbounded crawl. Hitting either leaves the proof unproven,
// which is the fail-closed outcome.
export const MAX_COMPLETION_CLUSTERS = 10;
export const MAX_COMPLETION_PAGES_PER_CLUSTER = 5;

export interface AbsenceCompletionDeps {
	// Invokes the UNINSTRUMENTED tool. Throwing is allowed; the caller treats the whole
	// completion as soft-failing.
	invoke: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
	// Folds one page into the run's ledger (runSignals.observeEcsPage).
	observe: (toolName: string, content: unknown, arg: unknown) => void;
	// Re-reads the ledger's blocker AFTER each observed page.
	blocker: () => string | null | undefined;
	// Greptile P1 on #855: absolute epoch ms the whole run must finish by, from the graph
	// budget. Checked BETWEEN calls, so it bounds the entire loop rather than one request --
	// up to MAX_COMPLETION_CLUSTERS x MAX_COMPLETION_PAGES_PER_CLUSTER sequential calls run
	// after the ReAct stream's own timeout has already been spent. Omitted means unbounded,
	// which is only correct in tests.
	deadlineAt?: number | undefined;
}

// Parses the unwalked cluster list out of "services-incomplete:a,b,c". Returns null when the
// blocker is anything else, which is the signal not to run at all.
export function unwalkedClustersFrom(blocker: string | null | undefined): string[] | null {
	if (!blocker?.startsWith(SERVICES_INCOMPLETE_PREFIX)) return null;
	const names = blocker
		.slice(SERVICES_INCOMPLETE_PREFIX.length)
		.split(",")
		.map((c) => c.trim())
		.filter((c) => c.length > 0);
	return names.length > 0 ? names : null;
}

// Reads the continuation token from a page that may arrive as a string, a text-block array, or an
// object. Mirrors parseEcsListResult's coalescing rather than assuming one shape: the ledger
// accepts all three, so the pager must too, or a paginated cluster would silently stop at page 1
// and be left unwalked.
function tokenFromPage(content: unknown): string | null {
	let obj: unknown = content;
	if (typeof obj === "string") {
		try {
			obj = JSON.parse(obj);
		} catch {
			return null;
		}
	}
	if (Array.isArray(obj)) {
		const text = obj
			.map((b) => (typeof b === "object" && b !== null && "text" in b ? String((b as { text: unknown }).text) : ""))
			.join("");
		if (!text) return null;
		try {
			obj = JSON.parse(text);
		} catch {
			return null;
		}
	}
	if (typeof obj !== "object" || obj === null) return null;
	return nextEcsToken(obj as Record<string, unknown>);
}

// Walks the clusters the model left unwalked and returns the ones it actually paged through.
//
// Stops the moment the blocker stops being services-incomplete: a match or a failure found on the
// way ends the hunt by design, because both are terminal answers about this estate. Never marks
// anything complete by hand -- only observeEcsListResult, seeing a genuine final page, does that.
export async function completeEcsEnumeration(deps: AbsenceCompletionDeps): Promise<string[]> {
	const unwalked = unwalkedClustersFrom(deps.blocker());
	if (!unwalked) return [];
	// Over the bound: do nothing at all rather than walk an arbitrary subset. A partial walk would
	// spend calls and still leave the proof unproven.
	if (unwalked.length > MAX_COMPLETION_CLUSTERS) return [];

	// Past the deadline before the first call: do nothing rather than start a walk that cannot finish.
	const outOfTime = (): boolean => deps.deadlineAt !== undefined && Date.now() >= deps.deadlineAt;
	if (outOfTime()) return [];

	const walked: string[] = [];
	for (const cluster of unwalked) {
		if (outOfTime()) return walked;
		let cursor: string | undefined;
		let pages = 0;
		let clusterTouched = false;

		while (pages < MAX_COMPLETION_PAGES_PER_CLUSTER) {
			// Re-walk from page 1: the ledger keeps no cursor, and observeEcsListResult is
			// idempotent for matching, so replaying earlier pages is correct if wasteful.
			const args: Record<string, unknown> = cursor ? { cluster, cursor } : { cluster };
			const content = await deps.invoke(AWS_ECS_LIST_SERVICES, args);
			pages += 1;
			clusterTouched = true;

			// The arg must carry `cluster`: observeEcsListResult sets `failed` without it.
			deps.observe(AWS_ECS_LIST_SERVICES, content, args);

			// A match or a failure observed here ends everything, fail-closed either way.
			if (unwalkedClustersFrom(deps.blocker()) === null) {
				if (clusterTouched) walked.push(cluster);
				return walked;
			}

			const token = tokenFromPage(content);
			if (!token) break; // final page: the ledger has marked this cluster complete
			// Stop between pages too: one slow cluster must not spend the whole remaining budget.
			if (outOfTime()) {
				walked.push(cluster);
				return walked;
			}
			cursor = token;
		}

		if (clusterTouched) walked.push(cluster);
	}

	return walked;
}
