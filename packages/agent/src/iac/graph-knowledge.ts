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
	type ChangeOutcome,
	changeHistoryForStackInstance,
	deploymentsRunningStack,
	getGraphStore,
	isKnowledgeGraphEnabled,
	priorChangesForDeployment,
	recordIacChange,
	recordPipeline,
	setChangeOutcome,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { iacTurnOutcome, stackFromPaths } from "./nodes.ts";
import type { IacStateType } from "./state.ts";

const logger = getLogger("agent:iac:graph-knowledge");

// The deployment a change targets. targetDeployment is the resolved scope for
// drift/synthetics/fleet flows; a gitops maker turn carries it on iacRequest.cluster.
function targetDeploymentName(state: IacStateType): string {
	return state.targetDeployment || state.iacRequest?.cluster || "";
}

// SIO-965: "<deployment>/<stack>" StackInstance id, or "" when either is unknown.
function stackInstanceId(state: IacStateType): string {
	const deployment = targetDeploymentName(state);
	const stack = stackFromPaths(state.proposedFiles);
	return deployment && stack ? `${deployment}/${stack}` : "";
}

// SIO-965: map the user-facing turn outcome to the graph's ChangeOutcome. Only a
// terminally-successful pipeline counts as "applied" (a human still merges, but
// pipeline success is the best automatic proxy the maker observes).
function changeOutcome(state: IacStateType): ChangeOutcome {
	const outcome = iacTurnOutcome(state);
	if (outcome === "rejected") return "rejected";
	if (outcome === "pipeline-failed") return "failed";
	if (state.pipelineStatus === "success") return "applied";
	return "proposed";
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
			// SIO-965: three-layer attachments. Each is optional in the writer, so a turn
			// missing any of them degrades to the SIO-954 behaviour.
			stackInstanceId: stackInstanceId(state) || undefined,
			threadId: state.threadId || undefined,
			outcome: "proposed", // promoted to applied/failed by recordIacOutcome after watchPipeline
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

// SIO-965: recordIacOutcome node: after watchPipeline, record the MR's CI pipeline
// and promote the change's outcome to its terminal value. Runs for both the gitops
// MR flow and the pipeline-status re-check; the writes no-op without an mrUrl/requestId.
export async function recordIacOutcome(state: IacStateType): Promise<Partial<IacStateType>> {
	if (!isKnowledgeGraphEnabled()) return {};
	try {
		const store = await getGraphStore();
		if (state.mrUrl && state.pipelineId != null) {
			await recordPipeline(store, {
				mrUrl: state.mrUrl,
				pipelineId: state.pipelineId,
				status: state.pipelineStatus,
			});
		}
		if (state.requestId) await setChangeOutcome(store, state.requestId, changeOutcome(state));
		return {};
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"recordIacOutcome graph write failed; continuing",
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
		// SIO-965: per-(deployment,stack) history + blast radius (other deployments
		// running the same stack). Both are best-effort additions to the SIO-954 view.
		const stack = stackFromPaths(state.proposedFiles);
		const siId = stack ? `${deployment}/${stack}` : "";
		const stackInstanceChanges = siId ? await changeHistoryForStackInstance(store, siId) : [];
		const otherDeployments = stack ? (await deploymentsRunningStack(store, stack)).filter((d) => d !== deployment) : [];
		const alsoRunningStack = otherDeployments.length > 0 ? { stack, deployments: otherDeployments } : undefined;
		// SIO-969: the latest prior change to this exact (deployment, stack) cell. The reader
		// returns most-recent-first, so [0] is the last attempt; reviewPlan raises a HIGH risk
		// when its outcome is "failed".
		const latest = stackInstanceChanges[0];
		const lastStackInstanceOutcome = latest
			? { outcome: latest.outcome, mrUrl: latest.mrUrl, summary: latest.summary }
			: undefined;
		return {
			iacGraphContext: buildIacGraphContext(deployment, changes, { stackInstanceChanges, alsoRunningStack }),
			lastStackInstanceOutcome,
		};
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"graphEnrichIac failed; continuing without graph context",
		);
		return {};
	}
}
