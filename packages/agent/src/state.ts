// agent/src/state.ts

import type {
	ActionResult,
	AttachmentMeta,
	DataSourceContext,
	DataSourceResult,
	ExtractedEntities,
	MitigationSteps,
	NormalizedIncident,
	PendingAction,
	ToolPlanStep,
} from "@devops-agent/shared";
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

// SIO-681: Union of all specialist sub-agent identifiers
export type AgentName = "elastic-agent" | "kafka-agent" | "capella-agent" | "konnect-agent" | "gitlab-agent";

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

	dataSourceContext: Annotation<DataSourceContext | undefined>({
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
});

export type AgentStateType = typeof AgentState.State;
