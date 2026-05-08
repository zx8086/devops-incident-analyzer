// packages/agent/tests/correlation/test-helpers.ts
import type { AgentStateType } from "../../src/state";

export function baseState(): AgentStateType {
	return {
		messages: [],
		attachmentMeta: [],
		queryComplexity: "complex",
		targetDataSources: [],
		targetDeployments: [],
		dataSourceResults: [],
		currentDataSource: "",
		extractedEntities: { dataSources: [] },
		previousEntities: { dataSources: [] },
		toolPlanMode: "autonomous",
		toolPlan: [],
		validationResult: "pass",
		retryCount: 0,
		alignmentRetries: 0,
		alignmentHints: [],
		skippedDataSources: [],
		isFollowUp: false,
		finalAnswer: "",
		dataSourceContext: undefined,
		requestId: "test",
		suggestions: [],
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		confidenceScore: 0,
		lowConfidence: false,
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		degradedRules: [],
		confidenceCap: undefined,
		pendingCorrelations: [],
	} as AgentStateType;
}

export function withKafkaResult(state: AgentStateType, data: unknown): AgentStateType {
	return {
		...state,
		dataSourceResults: [
			...state.dataSourceResults,
			{ dataSourceId: "kafka", status: "success", data, duration: 100 } as never,
		],
	};
}

export function withElasticResult(state: AgentStateType, data: unknown): AgentStateType {
	return {
		...state,
		dataSourceResults: [
			...state.dataSourceResults,
			{ dataSourceId: "elastic", status: "success", data, duration: 100 } as never,
		],
	};
}
