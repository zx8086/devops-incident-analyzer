// agent/src/iac/lane-knowledge.ts
//
// SIO-1461: knowledge-graph ConfigChange writes for the three non-gitops maker
// lanes -- drift-reconcile, fleet-upgrade, synthetics-push. The gitops maker lane
// records its change via recordIacEntities on the openMr edge (graph-knowledge.ts);
// these three open MRs / apply changes through their own tool calls and never reach
// openMr, so their history was invisible to priorChangesForDeployment (the "recent
// changes" review-card panel). recordLaneConfigChange mirrors recordIacEntities:
// gated by KNOWLEDGE_GRAPH_ENABLED, soft-failing (never throws) so a cold/absent
// graph never breaks the lane, reusing recordIacChange.
//
// This is a dependency-free LEAF: it imports only the knowledge-graph writer,
// observability, and state.ts *types*. It must NOT import runtime code from
// nodes.ts -- graph-knowledge.ts already imports nodes.ts, so putting these helpers
// there and calling them from nodes.ts would form a nodes.ts <-> graph-knowledge.ts
// cycle. Callers pass primitives + a pre-resolved outcome, not IacStateType.

import {
	attachChangeMr,
	type ChangeOutcome,
	findProposedChangeIdBySummary,
	getGraphStore,
	isKnowledgeGraphEnabled,
	recordIacChange,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import type { FleetUpgradeResult, ReconcileResult, SyntheticsPushResult } from "./state.ts";

const logger = getLogger("agent:iac:lane-knowledge");

// The valid ChangeOutcome values, as a runtime set (ChangeOutcome is a type-only
// union upstream). recordLaneConfigChange is an exported seam, so a future caller
// could pass a value the type system does not catch -- an empty workflow would drop
// the VIA_WORKFLOW edge and a bad outcome would be written straight to the graph.
// A plain guard (matching the id/deployment guard below and recordIacChange's own
// guard) rejects both without a Zod dependency the sibling writers don't carry.
const VALID_OUTCOMES: ReadonlySet<ChangeOutcome> = new Set(["proposed", "applied", "rejected", "failed"]);

export interface LaneChangeInput {
	id: string;
	deployment: string;
	// Free-form Workflow node name, e.g. "drift-reconcile" | "fleet-upgrade" |
	// "synthetics-push". Not an IacWorkflow enum member -- the writer's workflow
	// field and the Workflow{name} node are plain strings.
	workflow: string;
	// null => write nothing (a skipped/blocked lane result). The caller maps its
	// lane-specific status to a ChangeOutcome (or null) via the mappers below.
	outcome: ChangeOutcome | null;
	summary?: string;
	mrUrl?: string; // reconcile only; fleet/synthetics have no config MR
	stackInstanceId?: string; // reconcile only ("<deployment>/<stack>")
	threadId?: string;
}

// One ConfigChange write for a non-gitops lane. Self-gates on KNOWLEDGE_GRAPH_ENABLED
// and a null outcome, and soft-fails -- exactly like recordIacEntities.
export async function recordLaneConfigChange(input: LaneChangeInput): Promise<void> {
	if (!isKnowledgeGraphEnabled()) return;
	// outcome === null is the caller's "skipped/blocked -> do not record" signal.
	if (!input.id || !input.deployment || input.outcome === null) return;
	// Guard the two values a bad caller could otherwise corrupt the graph with:
	// an empty workflow silently drops the VIA_WORKFLOW edge; an out-of-enum outcome
	// would be MERGEd onto the ConfigChange as-is. Both self-skip rather than throw.
	if (!input.workflow || !VALID_OUTCOMES.has(input.outcome)) {
		logger.warn(
			{ id: input.id, workflow: input.workflow, outcome: input.outcome },
			"recordLaneConfigChange: skipping write for invalid workflow/outcome",
		);
		return;
	}
	try {
		const store = await getGraphStore();
		await recordIacChange(store, {
			id: input.id,
			deployment: input.deployment,
			workflow: input.workflow,
			summary: input.summary,
			mrUrl: input.mrUrl,
			stackInstanceId: input.stackInstanceId,
			threadId: input.threadId,
			outcome: input.outcome,
		});
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error), lane: input.workflow },
			"recordLaneConfigChange graph write failed; continuing",
		);
	}
}

// SIO-1527: edge-only follow-up write for a lane whose MR url is discovered AFTER its
// ConfigChange was recorded (renovate: trigger writes the node, watchRenovateMr finds the MR).
// Deliberately NOT recordLaneConfigChange/recordIacChange -- their MERGE...SET would wipe the
// node's summary and bump createdAt. Same gating + soft-fail contract as the writer above.
export async function attachLaneChangeMr(changeId: string, mrUrl: string): Promise<void> {
	if (!isKnowledgeGraphEnabled()) return;
	if (!changeId || !mrUrl) return;
	try {
		const store = await getGraphStore();
		await attachChangeMr(store, changeId, mrUrl);
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error), changeId },
			"attachLaneChangeMr graph write failed; continuing",
		);
	}
}

// SIO-1527: id-less variant for markers checkpointed BEFORE the marker carried the trigger
// requestId -- the node is recovered by its deterministic trigger-time summary instead
// (findProposedChangeIdBySummary). nearIso (the marker's triggerAtIso) anchors the selection to
// the marker's OWN trigger so a newer re-trigger of the same summary cannot steal the attach.
// No matching proposed node -> logged no-op.
export async function attachLaneChangeMrBySummary(
	workflow: string,
	summary: string,
	mrUrl: string,
	nearIso?: string,
): Promise<void> {
	if (!isKnowledgeGraphEnabled()) return;
	if (!workflow || !summary || !mrUrl) return;
	try {
		const store = await getGraphStore();
		const changeId = await findProposedChangeIdBySummary(store, workflow, summary, nearIso);
		if (!changeId) {
			logger.info({ workflow, summary }, "attachLaneChangeMrBySummary: no matching proposed change; skipping");
			return;
		}
		await attachChangeMr(store, changeId, mrUrl);
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error), workflow, summary },
			"attachLaneChangeMrBySummary graph write failed; continuing",
		);
	}
}

// opened/reused have a real MR, so write "proposed" -- the existing KG reconciler
// (reconcile.ts reconcileKnowledgeGraph) picks up PROPOSED_IN changes and promotes
// them to applied/failed/rejected after merge, exactly as it does for gitops MRs.
// skipped/blocked opened no MR -> no ConfigChange.
export function reconcileChangeOutcome(status: ReconcileResult["status"]): ChangeOutcome | null {
	if (status === "opened" || status === "reused") return "proposed";
	return null;
}

// Fleet has no config MR, so the outcome is written terminal here (the KG reconciler,
// which is MR-gated, will never see it). partial == applied on the agents that took
// it (the result note records the partial detail). dispatched is still in flight ->
// "proposed"; the agent-memory fleet reconciler settles the dispatched pipeline.
export function fleetChangeOutcome(status: FleetUpgradeResult["status"]): ChangeOutcome | null {
	if (status === "applied" || status === "partial") return "applied";
	if (status === "dispatched") return "proposed";
	if (status === "failed") return "failed";
	return null; // skipped / blocked
}

// Synthetics is a remote Kibana push (no MR) -> terminal outcome written here.
export function syntheticsChangeOutcome(status: SyntheticsPushResult["status"]): ChangeOutcome | null {
	if (status === "pushed") return "applied";
	if (status === "failed") return "failed";
	return null; // skipped / blocked
}
