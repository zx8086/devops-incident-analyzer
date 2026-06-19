// agent/src/iac/graph-knowledge.ts
//
// SIO-954: knowledge-graph pipeline nodes for the elastic-iac maker graph.
// recordIacEntities writes the turn's deployment + config-change (+ MR) into the
// embedded graph; graphEnrichIac reads the deployment's recent change history and
// produces state.iacGraphContext for the plan-review payload. Both are gated by
// KNOWLEDGE_GRAPH_ENABLED and soft-fail (never throw) so a cold/absent embedded
// graph degrades to empty context -- mirroring graph-knowledge.ts for the main
// incident pipeline. No embedder: deployment history is a direct lookup, not a
// vector-similarity search.

import {
	buildIacGraphContext,
	getGraphStore,
	isKnowledgeGraphEnabled,
	priorChangesForDeployment,
	recordIacChange,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import type { IacStateType } from "./state.ts";

const logger = getLogger("agent:iac:graph-knowledge");

// The deployment a change targets. targetDeployment is the resolved scope for
// drift/synthetics/fleet flows; a gitops maker turn carries it on iacRequest.cluster.
function targetDeploymentName(state: IacStateType): string {
	return state.targetDeployment || state.iacRequest?.cluster || "";
}

// Compact one-line summary of the change, reused as the ConfigChange.summary.
// The plan-review title is the richest single descriptor already assembled.
function changeSummary(state: IacStateType): string {
	if (state.planReview?.title) return state.planReview.title.slice(0, 280);
	const workflow = state.iacRequest?.workflow ?? "";
	return workflow ? `${workflow} change`.slice(0, 280) : "";
}

// recordIacEntities node: persist the turn's deployment + config-change into the graph.
export async function recordIacEntities(state: IacStateType): Promise<Partial<IacStateType>> {
	if (!isKnowledgeGraphEnabled()) return {};
	const deployment = targetDeploymentName(state);
	if (!deployment) return {};
	try {
		const store = await getGraphStore();
		await recordIacChange(store, {
			id: state.requestId,
			deployment,
			workflow: state.iacRequest?.workflow,
			filePaths: state.proposedFiles,
			summary: changeSummary(state),
			mrUrl: state.mrUrl || undefined,
		});
		return {};
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"recordIacEntities graph write failed; continuing",
		);
		return {};
	}
}

// graphEnrichIac node: read the deployment's recent change history -> iacGraphContext.
export async function graphEnrichIac(state: IacStateType): Promise<Partial<IacStateType>> {
	if (!isKnowledgeGraphEnabled()) return {};
	const deployment = targetDeploymentName(state);
	if (!deployment) return {};
	try {
		const store = await getGraphStore();
		const changes = await priorChangesForDeployment(store, deployment);
		return { iacGraphContext: buildIacGraphContext(deployment, changes) };
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"graphEnrichIac failed; continuing without graph context",
		);
		return {};
	}
}
