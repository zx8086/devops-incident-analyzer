// apps/web/src/lib/stores/agent-reducer.ts
import type { ActionResult, DataSourceContext, PendingAction, StreamEvent } from "@devops-agent/shared";

export interface ReducerState {
	currentContent: string;
	threadId: string;
	activeNodes: Set<string>;
	completedNodes: Map<string, { duration: number }>;
	dataSourceProgress: Map<string, { status: string; message?: string }>;
	lastSuggestions: string[];
	lastResponseTime: number | undefined;
	lastToolsUsed: string[];
	lastRunId: string | undefined;
	lastConfidence: number | undefined;
	lastDataSourceContext: DataSourceContext | undefined;
	pendingActions: PendingAction[];
	actionResults: ActionResult[];
}

export function initialReducerState(): ReducerState {
	return {
		currentContent: "",
		threadId: "",
		activeNodes: new Set(),
		completedNodes: new Map(),
		dataSourceProgress: new Map(),
		lastSuggestions: [],
		lastResponseTime: undefined,
		lastToolsUsed: [],
		lastRunId: undefined,
		lastConfidence: undefined,
		lastDataSourceContext: undefined,
		pendingActions: [],
		actionResults: [],
	};
}

export function applyStreamEvent(state: ReducerState, event: StreamEvent): ReducerState {
	switch (event.type) {
		case "message":
			return { ...state, currentContent: state.currentContent + event.content };
		case "tool_call":
			return state;
		case "datasource_progress": {
			const next = new Map(state.dataSourceProgress);
			next.set(event.dataSourceId, { status: event.status, message: event.message });
			return { ...state, dataSourceProgress: next };
		}
		case "node_start": {
			const next = new Set(state.activeNodes);
			next.add(event.nodeId);
			return { ...state, activeNodes: next };
		}
		case "node_end": {
			const active = new Set(state.activeNodes);
			active.delete(event.nodeId);
			const completed = new Map(state.completedNodes);
			completed.set(event.nodeId, { duration: event.duration });
			return { ...state, activeNodes: active, completedNodes: completed };
		}
		case "suggestions":
			return { ...state, lastSuggestions: event.suggestions };
		case "pending_actions":
			return { ...state, pendingActions: event.actions };
		case "done":
			return {
				...state,
				threadId: event.threadId,
				lastResponseTime: event.responseTime,
				lastToolsUsed: event.toolsUsed ?? [],
				lastRunId: event.runId,
				lastConfidence: event.confidence,
				lastDataSourceContext: event.dataSourceContext,
			};
		case "error":
			return { ...state, currentContent: `${state.currentContent}\n\n[Error: ${event.message}]` };
		case "low_confidence":
			return state;
		case "run_id":
			// Server emits run_id before graph output so feedback can be submitted early
			return { ...state, lastRunId: event.runId };
		case "attachment_warnings":
			return state;
		default:
			return state;
	}
}
