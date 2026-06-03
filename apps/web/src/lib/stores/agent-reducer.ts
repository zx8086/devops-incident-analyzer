// apps/web/src/lib/stores/agent-reducer.ts
import type {
	ActionResult,
	AtlassianFindings,
	AwsFindings,
	CouchbaseFindings,
	DataSourceContext,
	ElasticFindings,
	GitLabFindings,
	KafkaFindings,
	PendingAction,
	StreamEvent,
} from "@devops-agent/shared";

export interface TopicShiftPrompt {
	threadId: string;
	oldFocusSummary: string;
	newFocusSummary: string;
	oldServices: string[];
	newServices: string[];
	message: string;
}

// elastic-iac plan-review gate: the reviewed change surfaced to the human.
export interface IacReview {
	// SIO-874: "config-edit" = JSON change via the GitLab API (no terraform/gl-testing;
	// CI plans on the MR). "terraform" = legacy local plan path. Optional for back-compat
	// with any in-flight payload that predates the field.
	kind?: "config-edit" | "terraform";
	cluster: string;
	branch: string;
	title: string;
	diff: string;
	plan: string;
	risks: string[];
	precheckPassed: boolean;
}

export interface IacPlanReviewPrompt {
	threadId: string;
	message: string;
	review: IacReview | null;
}

export interface IacClarifyPrompt {
	threadId: string;
	question: string;
}

// SIO-882: drift sub-flow UI state.
export type ReconcileDirection = "reconcile-to-json" | "reconcile-to-live" | "skip";

export interface IacDriftStack {
	stack: string;
	drifted: boolean;
	// SIO-882: true when iac_plan could not be read -- the stack was not assessed.
	planError?: boolean;
	kind: "config-json" | "hcl";
	create: number;
	update: number;
	delete: number;
	resources: Array<{ address: string; actions: string[] }>;
}

export interface IacDriftReport {
	deployment: string;
	stacks: IacDriftStack[];
}

// One per-stack reconcile gate (the current interrupt). directions is the allowed set
// for this stack (reconcile-to-live is absent for HCL/non-live-reconcilable stacks).
export interface IacReconcileChoice {
	threadId: string;
	stack: string;
	kind: "config-json" | "hcl";
	summary: string;
	directions: ReconcileDirection[];
	message: string;
}

export interface IacReconcileResultRow {
	stack: string;
	direction: ReconcileDirection;
	status: "opened" | "reused" | "skipped" | "blocked";
	mrUrl?: string;
	note?: string;
}

// SIO-775: typed findings keyed by bare dataSourceId (e.g. "kafka", "gitlab",
// "couchbase"). Populated by datasource_result events emitted from the
// extractFindings node. Absence of an entry = sub-agent didn't run or had
// nothing typed to report.
export interface DataSourceFindings {
	status: "success" | "error";
	duration?: number;
	error?: string;
	kafkaFindings?: KafkaFindings;
	gitlabFindings?: GitLabFindings;
	couchbaseFindings?: CouchbaseFindings;
	elasticFindings?: ElasticFindings;
	// SIO-785 Phase 2 (2026-05-18).
	awsFindings?: AwsFindings;
	atlassianFindings?: AtlassianFindings;
}

export interface ReducerState {
	currentContent: string;
	threadId: string;
	activeNodes: Set<string>;
	completedNodes: Map<string, { duration: number }>;
	dataSourceProgress: Map<string, { status: string; message?: string }>;
	dataSourceFindings: Map<string, DataSourceFindings>;
	lastSuggestions: string[];
	lastResponseTime: number | undefined;
	lastToolsUsed: string[];
	lastRunId: string | undefined;
	lastConfidence: number | undefined;
	lastDataSourceContext: DataSourceContext | undefined;
	pendingActions: PendingAction[];
	actionResults: ActionResult[];
	// SIO-751: when the graph pauses on detectTopicShift, the SSE handler
	// emits topic_shift_prompt and the UI shows a banner with two buttons.
	topicShiftPrompt: TopicShiftPrompt | null;
	// elastic-iac maker graph interrupts.
	iacClarify: IacClarifyPrompt | null;
	iacPlanReview: IacPlanReviewPrompt | null;
	// SIO-876: live pipeline-watch status lines (e.g. "Pipeline #355: running"),
	// shown in the streaming area; the final status+plan+approval lands as the message.
	iacPipelineProgress: string[];
	// SIO-882: drift sub-flow. The full report (overview), the current per-stack choice
	// prompt (interrupt), and the accumulating per-stack results.
	iacDriftReport: IacDriftReport | null;
	iacReconcileChoice: IacReconcileChoice | null;
	iacReconcileResults: IacReconcileResultRow[];
}

export function initialReducerState(): ReducerState {
	return {
		currentContent: "",
		threadId: "",
		activeNodes: new Set(),
		completedNodes: new Map(),
		dataSourceProgress: new Map(),
		dataSourceFindings: new Map(),
		lastSuggestions: [],
		lastResponseTime: undefined,
		lastToolsUsed: [],
		lastRunId: undefined,
		lastConfidence: undefined,
		lastDataSourceContext: undefined,
		pendingActions: [],
		actionResults: [],
		topicShiftPrompt: null,
		iacClarify: null,
		iacPlanReview: null,
		iacPipelineProgress: [],
		iacDriftReport: null,
		iacReconcileChoice: null,
		iacReconcileResults: [],
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
		case "datasource_result": {
			const next = new Map(state.dataSourceFindings);
			next.set(event.dataSourceId, {
				status: event.status,
				duration: event.duration,
				error: event.error,
				kafkaFindings: event.kafkaFindings,
				gitlabFindings: event.gitlabFindings,
				couchbaseFindings: event.couchbaseFindings,
				elasticFindings: event.elasticFindings,
				// SIO-785 Phase 2 (2026-05-18).
				awsFindings: event.awsFindings,
				atlassianFindings: event.atlassianFindings,
			});
			return { ...state, dataSourceFindings: next };
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
		case "topic_shift_prompt":
			return {
				...state,
				topicShiftPrompt: {
					threadId: event.threadId,
					oldFocusSummary: event.oldFocusSummary,
					newFocusSummary: event.newFocusSummary,
					oldServices: event.oldServices,
					newServices: event.newServices,
					message: event.message,
				},
			};
		case "topic_shift_resolved":
			return { ...state, topicShiftPrompt: null };
		case "iac_clarify":
			return {
				...state,
				threadId: event.threadId,
				iacClarify: { threadId: event.threadId, question: event.question },
			};
		case "iac_plan_review":
			return {
				...state,
				threadId: event.threadId,
				iacPlanReview: { threadId: event.threadId, message: event.message, review: event.review },
			};
		case "iac_pipeline_progress": {
			const label = event.pipelineId ? `Pipeline #${event.pipelineId}: ${event.status}` : `Pipeline: ${event.status}`;
			return { ...state, iacPipelineProgress: [...state.iacPipelineProgress, label] };
		}
		// SIO-882: drift sub-flow events.
		case "iac_drift_report":
			// A fresh report starts a new reconcile pass.
			return {
				...state,
				iacDriftReport: { deployment: event.deployment, stacks: event.stacks },
				iacReconcileResults: [],
			};
		case "iac_reconcile_choice":
			return {
				...state,
				threadId: event.threadId,
				iacReconcileChoice: {
					threadId: event.threadId,
					stack: event.stack,
					kind: event.kind,
					summary: event.summary,
					directions: event.directions,
					message: event.message,
				},
			};
		case "iac_reconcile_result":
			return {
				...state,
				iacReconcileResults: [
					...state.iacReconcileResults,
					{
						stack: event.stack,
						direction: event.direction,
						status: event.status,
						mrUrl: event.mrUrl,
						note: event.note,
					},
				],
			};
		default:
			return state;
	}
}
