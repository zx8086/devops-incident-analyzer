// apps/web/src/lib/node-labels.ts
//
// Single source of truth for pipeline node display labels, shared by
// StreamingProgress.svelte (live view) and CompletedProgress.svelte
// (historical view). Node ids must match PIPELINE_NODES in
// apps/web/src/lib/server/sse-pump.ts -- that set controls which node_start/
// node_end SSE events the server forwards at all.

export interface NodeLabel {
	id: string;
	activeLabel: string;
	completeLabel: string;
}

// Base incident pipeline (always runs). Mitigation-branch nodes
// (proposeInvestigate/proposeMonitor/proposeEscalate) and the HIL
// learning-lane nodes are listed separately below since they are
// mutually-exclusive / conditional relative to this base flow.
export const INCIDENT_NODES: readonly NodeLabel[] = [
	{ id: "classify", activeLabel: "Classifying", completeLabel: "Classified" },
	{ id: "normalize", activeLabel: "Normalizing", completeLabel: "Normalized" },
	{ id: "entityExtractor", activeLabel: "Extracting", completeLabel: "Extracted" },
	{ id: "detectTopicShift", activeLabel: "Checking topic", completeLabel: "Topic checked" },
	{ id: "queryDataSource", activeLabel: "Querying", completeLabel: "Queried" },
	{ id: "align", activeLabel: "Aligning", completeLabel: "Aligned" },
	{ id: "aggregate", activeLabel: "Analyzing", completeLabel: "Analyzed" },
	{ id: "extractFindings", activeLabel: "Extracting findings", completeLabel: "Findings" },
	{ id: "checkConfidence", activeLabel: "Checking confidence", completeLabel: "Confidence checked" },
	{ id: "validate", activeLabel: "Validating", completeLabel: "Validated" },
	{ id: "aggregateMitigation", activeLabel: "Aggregating mitigation", completeLabel: "Mitigation ready" },
	{ id: "followUp", activeLabel: "Preparing follow-up", completeLabel: "Follow-up ready" },
] as const;

// Simple-turn shortcut (classify -> responder -> followUp -> END), bypassing
// the full complex-turn pipeline. Not part of INCIDENT_NODES since it's
// mutually exclusive with the complex-turn nodes above -- CompletedProgress
// still needs a label for it via ALL_NODE_LABELS.
const RESPONDER_NODE: NodeLabel = { id: "responder", activeLabel: "Responding", completeLabel: "Responded" };

// mitigationRouter picks exactly one of these per turn -- render exclusively,
// mirroring the IaC sub-flow mutual-exclusion idiom below.
export const INCIDENT_MITIGATION_NODES: readonly NodeLabel[] = [
	{ id: "proposeInvestigate", activeLabel: "Proposing investigation", completeLabel: "Investigation proposed" },
	{ id: "proposeMonitor", activeLabel: "Proposing monitor", completeLabel: "Monitor proposed" },
	{ id: "proposeEscalate", activeLabel: "Proposing escalation", completeLabel: "Escalation proposed" },
] as const;

// Only reachable via an explicit "learn from TICKET-123" command -- hidden
// from the live row unless learnFetchTicket is actually seen.
export const HIL_LEARNING_NODES: readonly NodeLabel[] = [
	{ id: "learnFetchTicket", activeLabel: "Fetching ticket", completeLabel: "Ticket fetched" },
	{ id: "learnMatchIncident", activeLabel: "Matching incident", completeLabel: "Incident matched" },
	{ id: "learnMatchGate", activeLabel: "Awaiting match review", completeLabel: "Match reviewed" },
	{ id: "learnDistill", activeLabel: "Distilling learnings", completeLabel: "Learnings distilled" },
	{ id: "learnReviewGate", activeLabel: "Awaiting review", completeLabel: "Review gate" },
	{ id: "applyLearnings", activeLabel: "Applying learnings", completeLabel: "Learnings applied" },
] as const;

// elastic-iac maker happy path (version-upgrade / tier-resize / ilm-rollout).
// classifyIacIntent is plumbing/covered elsewhere and omitted from the live
// row. bootstrap/teardown are intentionally omitted from the live row (SIO-984)
// but kept in ALL_NODE_LABELS below so CompletedProgress can still label them.
export const IAC_MAKER_NODES: readonly NodeLabel[] = [
	{ id: "parseIntent", activeLabel: "Parsing", completeLabel: "Parsed" },
	{ id: "readClusterState", activeLabel: "Reading state", completeLabel: "Read state" },
	{ id: "guard", activeLabel: "Checking", completeLabel: "Checked" },
	{ id: "draftChange", activeLabel: "Drafting", completeLabel: "Drafted" },
	{ id: "reviewPlan", activeLabel: "Preparing review", completeLabel: "Prepared" },
	{ id: "reviewGate", activeLabel: "Awaiting review", completeLabel: "Reviewed" },
	{ id: "openMr", activeLabel: "Opening MR", completeLabel: "MR opened" },
	{ id: "watchPipeline", activeLabel: "Watching pipeline", completeLabel: "Pipeline done" },
] as const;

// SIO-903: drift (SIO-882) + synthetics-drift (SIO-902) sub-flow. A drift run
// never executes the maker nodes (and vice versa).
export const IAC_DRIFT_NODES: readonly NodeLabel[] = [
	{ id: "detectDrift", activeLabel: "Detecting drift", completeLabel: "Drift detected" },
	{ id: "reconcileGate", activeLabel: "Reviewing drift", completeLabel: "Reviewed" },
	{ id: "reconcileStack", activeLabel: "Reconciling", completeLabel: "Reconciled" },
	{ id: "advanceDrift", activeLabel: "Advancing", completeLabel: "Advanced" },
	{ id: "detectSyntheticsDrift", activeLabel: "Checking synthetics", completeLabel: "Synthetics checked" },
	{ id: "syntheticsPushGate", activeLabel: "Reviewing push", completeLabel: "Reviewed" },
	{ id: "pushSynthetics", activeLabel: "Pushing synthetics", completeLabel: "Pushed" },
] as const;

// SIO-935: fleet-upgrade (binary bulk_upgrade) sub-flow. Mutually exclusive
// with maker/drift.
export const IAC_FLEET_NODES: readonly NodeLabel[] = [
	{ id: "detectFleetUpgrade", activeLabel: "Assessing fleet", completeLabel: "Assessed" },
	{ id: "fleetUpgradeGate", activeLabel: "Awaiting approval", completeLabel: "Approved" },
	{ id: "applyFleetUpgrade", activeLabel: "Upgrading", completeLabel: "Upgraded" },
] as const;

// Nodes intentionally excluded from every live row (plumbing / covered
// elsewhere) but still labeled for the historical view.
const EXTRA_COMPLETED_ONLY_NODES: readonly NodeLabel[] = [
	{ id: "bootstrap", activeLabel: "Bootstrapping", completeLabel: "Bootstrapped" },
	{ id: "teardown", activeLabel: "Finishing", completeLabel: "Finished" },
] as const;

// Flat lookup covering every id in sse-pump.ts's PIPELINE_NODES, for
// CompletedProgress.svelte's `completeLabel` needs.
export const ALL_NODE_LABELS: Readonly<Record<string, NodeLabel>> = Object.fromEntries(
	[
		...INCIDENT_NODES,
		RESPONDER_NODE,
		...INCIDENT_MITIGATION_NODES,
		...HIL_LEARNING_NODES,
		...IAC_MAKER_NODES,
		...IAC_DRIFT_NODES,
		...IAC_FLEET_NODES,
		...EXTRA_COMPLETED_ONLY_NODES,
	].map((n) => [n.id, n]),
);
