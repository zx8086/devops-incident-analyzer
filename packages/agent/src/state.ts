// agent/src/state.ts

import type {
	AttachmentMeta,
	DataSourceContext,
	DataSourceResult,
	ExtractedEntities,
	MitigationSteps,
	NormalizedIncident,
	ToolPlanStep,
} from "@devops-agent/shared";
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

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
});

export type AgentStateType = typeof AgentState.State;
