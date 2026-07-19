// agent/src/state.ts

import type {
	ActionResult,
	AttachmentMeta,
	DataSourceContext,
	DataSourceResult,
	ExtractedEntities,
	GraphBlastRadiusHit,
	HilApplyReport,
	HilItemEdits,
	InvestigationFocus,
	MitigationSteps,
	NormalizedIncident,
	PendingAction,
	ResolvedIdentifiers,
	ToolPlanStep,
} from "@devops-agent/shared";
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { HilDecisions, LearningProposal } from "./learn/schema.ts";
import type { HilMatchCandidate, TicketResolution } from "./learn/ticket.ts";

// SIO-681: Union of all specialist sub-agent identifiers
export type AgentName =
	| "elastic-agent"
	| "kafka-agent"
	| "capella-agent"
	| "konnect-agent"
	| "gitlab-agent"
	| "atlassian-agent"
	| "aws-agent";

// SIO-681: A correlation rule that fired but could not be fully satisfied
export interface DegradedRule {
	ruleName: string;
	requiredAgent: AgentName;
	reason: string;
	triggerContext: Record<string, unknown>;
}

// SIO-681: Transient routing entry while a re-fan-out correlation is in flight
export interface PendingCorrelation {
	ruleName: string;
	requiredAgent: AgentName;
	triggerContext: Record<string, unknown>;
	attemptsRemaining: number;
	timeoutMs: number;
}

// SIO-741: Per-branch output from the parallel mitigation step. Three branches
// (investigate/monitor/escalate) write fragments which aggregateMitigation
// merges into the durable mitigationSteps field.
export interface MitigationFragment {
	kind: "investigate" | "monitor" | "escalate";
	items: string[];
	failed?: boolean;
}

export const AgentState = Annotation.Root({
	...MessagesAnnotation.spec,

	// SIO-610: Lightweight attachment metadata for routing decisions
	attachmentMeta: Annotation<AttachmentMeta[]>({
		reducer: (current, update) => [...(current ?? []), ...update],
		default: () => [],
	}),

	queryComplexity: Annotation<"simple" | "complex">({
		reducer: (_, next) => next,
		default: () => "complex",
	}),

	targetDataSources: Annotation<string[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	// SIO-649: Elastic deployment IDs to fan out to. Empty = single default deployment.
	targetDeployments: Annotation<string[]>({
		reducer: (_, next) => next ?? [],
		default: () => [],
	}),

	// SIO-697: Deployment IDs that an alignment retry should re-run. Set by the
	// alignment node when an elastic retry dispatches; consumed by queryDataSource
	// to skip deployments that already succeeded on the first attempt. Replaced
	// (not appended) every retry so it doesn't accumulate across retries.
	retryDeployments: Annotation<string[]>({
		reducer: (_, next) => next ?? [],
		default: () => [],
	}),

	// SIO-828: AWS estates to fan out to. Populated by awsEstateRouter from the
	// user's prompt. Empty + aws not selected = no AWS fan-out. Empty + aws
	// selected = router decided "ambiguous" and the AWS sub-agent fans out to
	// all configured estates (resolved at fan-out time, not stored here).
	awsTargetEstates: Annotation<string[]>({
		reducer: (_, next) => next ?? [],
		default: () => [],
	}),

	// SIO-836: AWS estates the user explicitly selected in the UI. When non-empty,
	// awsEstateRouter uses these verbatim and skips the LLM classifier. Empty =
	// no UI selection, router decides (LLM explicit or ambiguous->all).
	uiAwsEstates: Annotation<string[]>({
		reducer: (_, next) => next ?? [],
		default: () => [],
	}),

	// SIO-559: append reducer -- appends new results, empty array resets
	dataSourceResults: Annotation<DataSourceResult[]>({
		reducer: (prev, next) => {
			if (next.length === 0) return [];
			return [...prev, ...next];
		},
		default: () => [],
	}),

	currentDataSource: Annotation<string>({
		reducer: (_, next) => next,
		default: () => "",
	}),

	extractedEntities: Annotation<ExtractedEntities>({
		reducer: (_, next) => next,
		default: () => ({ dataSources: [] }),
	}),

	previousEntities: Annotation<ExtractedEntities>({
		reducer: (_, next) => next,
		default: () => ({ dataSources: [] }),
	}),

	toolPlanMode: Annotation<"planned" | "autonomous">({
		reducer: (_, next) => next,
		default: () => "autonomous",
	}),

	toolPlan: Annotation<ToolPlanStep[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	validationResult: Annotation<"pass" | "fail" | "pass_with_warnings">({
		reducer: (_, next) => next,
		default: () => "pass",
	}),

	retryCount: Annotation<number>({
		reducer: (_, next) => next,
		default: () => 0,
	}),

	alignmentRetries: Annotation<number>({
		reducer: (_, next) => next,
		default: () => 0,
	}),

	alignmentHints: Annotation<string[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	// SIO-626: Datasources skipped by supervisor (e.g., MCP server not connected)
	skippedDataSources: Annotation<string[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	isFollowUp: Annotation<boolean>({
		reducer: (_, next) => next,
		default: () => false,
	}),

	finalAnswer: Annotation<string>({
		reducer: (_, next) => next,
		default: () => "",
	}),

	// SIO-850: compact prior-knowledge context from the knowledge graph
	// (dependencies + similar incidents), produced by the graphEnrich node and
	// inlined into the aggregator prompt. Empty when the graph is disabled.
	graphContext: Annotation<string>({
		reducer: (_, next) => next,
		default: () => "",
	}),

	// SIO-1103: runtime shared-infra blast radius, populated by graphEnrich from the KG
	// so the SYNCHRONOUS correlation rule trigger can read it. Replace reducer (recomputed
	// per turn); default [] so a rule that reads it before graphEnrich runs sees nothing.
	graphBlastRadius: Annotation<GraphBlastRadiusHit[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	dataSourceContext: Annotation<DataSourceContext | undefined>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),

	// SIO-750: Investigation focus anchor. Sticky reducer: only an explicit
	// non-undefined replacement (e.g. SIO-751 topic-shift "fresh" branch)
	// overwrites the focus. Nodes that don't touch it return no key and the
	// prior value is preserved across turns via the checkpointer.
	investigationFocus: Annotation<InvestigationFocus | undefined>({
		reducer: (current, next) => next ?? current,
		default: () => undefined,
	}),

	// SIO-1084: Per-datasource canonical identifiers resolved before fan-out by the
	// resolveIdentifiers node. REPLACE reducer (not sticky) -- resolution is per-turn
	// derived data, so each turn that runs the node overwrites the prior value; a
	// stale prior-turn resolution can't linger. Stamped (resolvedForTurn /
	// resolvedForServices) so the focus block suppresses injection when the stamp
	// no longer matches the current focus.services.
	resolvedIdentifiers: Annotation<ResolvedIdentifiers | undefined>({
		reducer: (_current, next) => next,
		default: () => undefined,
	}),

	// SIO-751: Pending HITL prompt for cross-turn topic shift. Populated by
	// detectTopicShift when new-turn entities have no overlap with the
	// investigation focus. Cleared on resume.
	pendingTopicShiftPrompt: Annotation<
		{ newFocusCandidate: InvestigationFocus; oldFocus: InvestigationFocus } | undefined
	>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),

	requestId: Annotation<string>({
		reducer: (_, next) => next,
		default: () => crypto.randomUUID(),
	}),

	suggestions: Annotation<string[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	// SIO-630: Structured incident data from normalize node
	normalizedIncident: Annotation<NormalizedIncident>({
		reducer: (_, next) => next,
		default: () => ({}),
	}),

	// SIO-631: Mitigation steps from propose-mitigation node
	mitigationSteps: Annotation<MitigationSteps>({
		reducer: (_, next) => next,
		default: () => ({ investigate: [], monitor: [], escalate: [], relatedRunbooks: [] }),
	}),

	// SIO-741: Transient per-branch fragments produced by the three parallel
	// mitigation branches. Aggregated into mitigationSteps by aggregateMitigation.
	mitigationFragments: Annotation<MitigationFragment[]>({
		reducer: (prev, next) => [...prev, ...next],
		default: () => [],
	}),

	// SIO-632: Confidence score extracted from aggregator output
	confidenceScore: Annotation<number>({
		reducer: (_, next) => next,
		default: () => 0,
	}),

	// SIO-632: Set by checkConfidence when score is below the HITL threshold
	lowConfidence: Annotation<boolean>({
		reducer: (_, next) => next,
		default: () => false,
	}),

	// SIO-1155: the raw LLM confidence before any aggregate cap. Lets the correlation
	// recovery path restore the score when the sole cap reason was later cured.
	confidencePreCap: Annotation<number | undefined>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),

	// SIO-1155: which aggregate caps fired this turn ("degraded-subagents", "gaps",
	// "ungrounded-blocker", ...). Empty when no cap triggered.
	capReasons: Annotation<string[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	// SIO-1155: the Gaps bullet texts that actually COUNTED toward the gaps cap after
	// the SIO-1149 judge veto (vetoed bullets excluded). The recovery path subtracts
	// recovered bullets from this set instead of re-running the judge.
	confirmedDegradingGapBullets: Annotation<string[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	// SIO-1155: targeted instruction for a correlation refetch, set per-Send by the
	// enforceCorrelations router and rendered into the sub-agent's volatile focus
	// block. Undefined on every normal fan-out.
	correlationFetchDirective: Annotation<string | undefined>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),

	// SIO-681: Rules that fired but were not fully satisfied; surfaced in the final report
	degradedRules: Annotation<DegradedRule[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	// SIO-681: Upper bound on confidenceScore when one or more correlation rules degraded
	confidenceCap: Annotation<number | undefined>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),

	// SIO-681: Transient routing payload during enforceCorrelations re-fan-out
	pendingCorrelations: Annotation<PendingCorrelation[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	// SIO-634, SIO-635: Action proposals from mitigation node, awaiting user confirmation
	pendingActions: Annotation<PendingAction[]>({
		reducer: (_, next) => next,
		default: () => [],
	}),

	// SIO-634, SIO-635: Results from executed actions
	actionResults: Annotation<ActionResult[]>({
		reducer: (prev, next) => [...prev, ...next],
		default: () => [],
	}),

	// SIO-640: Runbook selector output.
	//   null      -> selector did not run (default)
	//   []        -> selector ran and chose no runbooks
	//   [names]   -> selector chose these runbooks
	selectedRunbooks: Annotation<string[] | null>({
		reducer: (_, next) => next,
		default: () => null,
	}),

	// SIO-1018: per-turn trace of the local skills active in this turn's orchestrator
	// prompt. Drives the SIO-1016 confidence feedback loop (mapped to SKILL.md paths
	// in the post-turn reader). Mirrors selectedRunbooks' tri-state.
	//   null    -> not captured (default; e.g. simple turns that skip aggregate)
	//   []      -> captured, no active skills
	//   [names] -> these skill names were active this turn
	skillsApplied: Annotation<string[] | null>({
		reducer: (_, next) => next,
		default: () => null,
	}),

	// SIO-739: Append-only list of nodes that soft-failed (e.g. per-call LLM
	// deadline exceeded). The SSE handler emits a partial_failure event for
	// each new entry; the graph still reaches END so the validated answer
	// can still be delivered.
	partialFailures: Annotation<Array<{ node: string; reason: string }>>({
		reducer: (prev, next) => [...prev, ...next],
		default: () => [],
	}),

	// SIO-1126: HIL learning lane. All per-turn replace reducers; classify's
	// turnReset clears the ticket key so a prior turn's command never leaks.
	hilLearnTicketKey: Annotation<string | undefined>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),
	hilTicket: Annotation<TicketResolution | undefined>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),
	hilMatchCandidates: Annotation<HilMatchCandidate[]>({
		reducer: (_, next) => next ?? [],
		default: () => [],
	}),
	hilTicketEmbedding: Annotation<number[] | undefined>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),
	// SIO-1130: auto=true marks a match resolved without the interrupt (single
	// ticket-mention pin or zero candidates); the review gate surfaces it.
	hilMatch: Annotation<{ incidentId: string; created: boolean; auto?: boolean } | undefined>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),
	hilProposal: Annotation<LearningProposal | undefined>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),
	hilAlreadyLearned: Annotation<boolean>({
		reducer: (_, next) => next,
		default: () => false,
	}),
	hilDecisions: Annotation<HilDecisions | undefined>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),

	// SIO-1128: per-item text edits from the review card, merged over hilProposal by
	// applyLearnings. Default {} so apply is a no-op when the human made no edits.
	hilEdits: Annotation<HilItemEdits>({
		reducer: (_, next) => next,
		default: () => ({}),
	}),

	// SIO-1146: structured apply outcome; the SSE pump forwards it from
	// applyLearnings' node output as hil_learning_applied for the terminal card.
	hilApplyReport: Annotation<HilApplyReport | undefined>({
		reducer: (_, next) => next,
		default: () => undefined,
	}),
});

export type AgentStateType = typeof AgentState.State;
