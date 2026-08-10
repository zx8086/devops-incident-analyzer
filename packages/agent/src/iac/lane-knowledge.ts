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
	type ChangeOutcome,
	getGraphStore,
	isKnowledgeGraphEnabled,
	recordIacChange,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import type { FleetUpgradeResult, ReconcileResult, SyntheticsPushResult } from "./state.ts";

const logger = getLogger("agent:iac:lane-knowledge");

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
	if (!input.id || !input.deployment || input.outcome === null) return;
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
