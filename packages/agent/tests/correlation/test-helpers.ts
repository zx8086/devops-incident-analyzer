// packages/agent/tests/correlation/test-helpers.ts
import type { ToolError } from "@devops-agent/shared";
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

// SIO-717: production sub-agents emit `data` as a prose string (LLM output) and
// populate result-level `toolErrors`. These helpers build that real shape so
// the SIO-717 rules can be tested against it.
export function withKafkaProseResult(
	state: AgentStateType,
	prose: string,
	toolErrors: ToolError[] = [],
): AgentStateType {
	return {
		...state,
		dataSourceResults: [
			...state.dataSourceResults,
			{
				dataSourceId: "kafka",
				status: "success",
				data: prose,
				duration: 100,
				...(toolErrors.length > 0 && { toolErrors }),
			} as never,
		],
	};
}

export function withElasticSyntheticUp(state: AgentStateType, hostname: string, when: string): AgentStateType {
	return withElasticResult(state, {
		syntheticMonitors: [
			{ url: `https://${hostname}/healthcheck`, status: "up", timestamp: when, monitorName: `test-${hostname}` },
		],
	});
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
