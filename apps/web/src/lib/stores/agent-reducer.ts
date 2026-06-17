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

// Human labels for the per-stack reconcile directions, shared by the choice card (buttons)
// and the drift-report card (results rows) so both read the same friendly text. "Reconcile to
// GitLab" reverts live -> declared (marker MR); "Reconcile to Live Deployment" rewrites the repo
// JSON to match live.
export const RECONCILE_DIRECTION_LABELS: Record<ReconcileDirection, string> = {
	"reconcile-to-json": "Reconcile to GitLab",
	"reconcile-to-live": "Reconcile to Live Deployment",
	skip: "Do Nothing",
};

// SIO-900: one leaf-level diff inside a changed attribute (elastic-iac Increment 2). path is a
// dot/identity-bracket locator (e.g. inputs["kubelet/metrics"].period); op: update | add | remove;
// before = live, after = declared. unstableIndex marks a numeric-array-index path (a hint only).
export interface LeafChange {
	path: string;
	op: "add" | "remove" | "update";
	before?: unknown;
	after?: unknown;
	unstableIndex?: boolean;
}

// SIO-886: one drifted resource with the detail the explainer surfaces (reason / changed keys).
// SIO-900: plus the attribute-grain values + leaf-level changes[] so the cards can expand the
// precise per-leaf detail ("showing X of N").
export interface IacDriftResource {
	address: string;
	actions: string[];
	reason?: string;
	changedKeys?: string[];
	category?: string;
	values?: Record<string, { before?: unknown; after?: unknown }>;
	changes?: LeafChange[];
	changeCount?: number;
	truncated?: boolean;
}

// SIO-900: render one leaf change as a grounded one-liner for the drift/reconcile cards (before =
// live, after = declared). Sentinels become short labels; long values are capped for readability.
const LEAF_REDACTED = "<redacted:sensitive>";
const LEAF_OVERSIZED = "<omitted:too-large>";
export function formatLeafChange(c: LeafChange): string {
	const val = (v: unknown): string => {
		if (v === LEAF_REDACTED) return "<redacted>";
		if (v === LEAF_OVERSIZED) return "<too large>";
		const s = typeof v === "string" ? v : JSON.stringify(v);
		const text = s ?? String(v);
		return text.length > 80 ? `${text.slice(0, 77)}...` : text;
	};
	if (c.op === "add") return `+ ${c.path} = ${val(c.after)}`; // in declared, not live
	if (c.op === "remove") return `- ${c.path} (live: ${val(c.before)})`; // in live, not declared
	return `~ ${c.path}: ${val(c.before)} -> ${val(c.after)}`; // update: live -> declared
}

export interface IacDriftStack {
	stack: string;
	drifted: boolean;
	// SIO-882: true when iac_plan could not be read -- the stack was not assessed.
	planError?: boolean;
	// SIO-887: human-readable reason for planError, shown on the drift card.
	planErrorReason?: string;
	kind: "config-json" | "unwired";
	create: number;
	update: number;
	delete: number;
	// SIO-886: grounded explanation of what drifted (from the explainDrift node).
	explanation?: string;
	resources: IacDriftResource[];
}

export interface IacDriftReport {
	deployment: string;
	stacks: IacDriftStack[];
}

// One per-stack reconcile gate (the current interrupt). directions is the allowed set
// for this stack (reconcile-to-live is absent for unwired / non-live-reconcilable stacks).
export interface IacReconcileChoice {
	threadId: string;
	stack: string;
	kind: "config-json" | "unwired";
	summary: string;
	// SIO-886: grounded explanation + per-resource detail surfaced in the choice card.
	// SIO-900: reuse the full drift-resource shape so the choice card renders leaf-level changes too.
	explanation?: string;
	resources?: IacDriftResource[];
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

// SIO-902: synthetics drift. Whole-deployment monitor diff (source YAML vs live Kibana).
export interface SyntheticsDriftMonitor {
	project: string;
	monitorId: string;
	monitorName: string;
	category: "changed" | "missing_in_kibana" | "extra_in_kibana";
	fields?: Array<{ field: string; source?: unknown; live?: unknown }>;
}

export interface SyntheticsDriftTotals {
	projectsChecked: number;
	monitorsInSource: number;
	monitorsInKibana: number;
	missingInKibana: number;
	extraInKibana: number;
	changed: number;
}

export interface SyntheticsReconcilePlan {
	pushToKibana: { command: string; monitors: Array<{ project: string; monitorId: string; monitorName: string }> };
	addToSource: { action: string; monitors: Array<{ project: string; monitorId: string; monitorName: string }> };
}

export interface SyntheticsDriftReport {
	deployment: string;
	kibanaUrl: string;
	kibanaSpace: string;
	hasActionableDrift: boolean;
	planError?: boolean;
	planErrorReason?: string;
	totals: SyntheticsDriftTotals;
	drift: SyntheticsDriftMonitor[];
	reconcilePlan: SyntheticsReconcilePlan;
}

// The single operator push approve/decline interrupt (no per-stack loop). The UI POSTs
// { approve } to the resume endpoint.
export interface SyntheticsPushChoice {
	threadId: string;
	deployment: string;
	kibanaSpace: string;
	pushableCount: number;
	extraCount: number;
	projectScope: string | null;
	command: string;
	explanation?: string;
	pushMonitors: Array<{ project: string; monitorName: string }>;
	extraMonitors: Array<{ project: string; monitorName: string }>;
	message: string;
}

export interface SyntheticsPushResultRow {
	status: "pushed" | "skipped" | "blocked" | "failed";
	pushedCount: number;
	project?: string;
	pipelineId?: number;
	pipelineStatus?: string;
	note?: string;
}

// SIO-913 / SIO-922: Fleet agent binary-upgrade sub-flow. The preview report (shown before the
// gate), the single operator apply approve/decline interrupt, and the apply outcome.
// SIO-935: version partition of the resolved set (optional -- absent for old CI reports).
export interface FleetVersionCrosstab {
	alreadyOnTarget: number;
	outdated: number;
	versionUnknown: number;
	upgradeableOutdated: number;
}

export interface FleetUpgradePreview {
	deployment: string;
	targetVersion: string;
	resolvedCount: number;
	versionAvailable: boolean;
	rolloutSeconds: number;
	crosstab: { upgradeable: number; notUpgradeable: number; byReason: Array<{ reason: string; count: number }> };
	versionCrosstab?: FleetVersionCrosstab;
	planError?: boolean;
	planErrorReason?: string;
}

export interface FleetUpgradeChoice {
	threadId: string;
	deployment: string;
	targetVersion: string;
	resolvedCount: number;
	upgradeableCount: number;
	notUpgradeableCount: number;
	rolloutSeconds: number;
	byReason: Array<{ reason: string; count: number }>;
	versionCrosstab?: FleetVersionCrosstab;
	message: string;
}

export interface FleetUpgradeResultRow {
	// SIO-926: dispatched = the bulk_upgrade started and is still running past the status window
	// (a long rollout we did not block on), distinct from a real failed pipeline.
	status: "applied" | "dispatched" | "skipped" | "blocked" | "failed";
	actionId?: string;
	pollStatus?: string;
	acked?: number;
	created?: number;
	failedSilent?: number;
	pipelineId?: number;
	pipelineUrl?: string;
	note?: string;
	// SIO-928: a snapshot of the live `iac_pipeline_progress` lines captured when the apply result
	// arrives, so the timeline persists as a collapsed log AFTER the `done` handler clears the live
	// iacPipelineProgress array. Empty/absent when the flow produced no progress lines.
	progressLog?: string[];
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
	// SIO-930: per-turn outcome from the IaC done event ("rejected"/"declined"/etc.); drives the
	// completion chip color/label. "completed" for the incident agent (which omits the field).
	lastOutcome: "completed" | "rejected" | "declined" | "blocked" | "unsupported" | "pipeline-failed";
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
	// SIO-902: synthetics drift sub-flow. The whole-deployment report, the single push
	// approve/decline prompt (interrupt), and the single push outcome.
	syntheticsDriftReport: SyntheticsDriftReport | null;
	syntheticsPushChoice: SyntheticsPushChoice | null;
	syntheticsPushResult: SyntheticsPushResultRow | null;
	// SIO-913 / SIO-922: fleet upgrade sub-flow. The preview (overview), the single apply
	// approve/decline prompt (interrupt), and the single apply outcome.
	fleetUpgradePreview: FleetUpgradePreview | null;
	fleetUpgradeChoice: FleetUpgradeChoice | null;
	fleetUpgradeResult: FleetUpgradeResultRow | null;
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
		lastOutcome: "completed",
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
		syntheticsDriftReport: null,
		syntheticsPushChoice: null,
		syntheticsPushResult: null,
		fleetUpgradePreview: null,
		fleetUpgradeChoice: null,
		fleetUpgradeResult: null,
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
				lastOutcome: event.outcome ?? "completed",
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
					explanation: event.explanation,
					resources: event.resources,
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
		// SIO-902: synthetics drift sub-flow events.
		case "synthetics_drift_report":
			// A fresh report clears any prior push outcome.
			return {
				...state,
				syntheticsDriftReport: {
					deployment: event.deployment,
					kibanaUrl: event.kibanaUrl,
					kibanaSpace: event.kibanaSpace,
					hasActionableDrift: event.hasActionableDrift,
					planError: event.planError,
					planErrorReason: event.planErrorReason,
					totals: event.totals,
					drift: event.drift,
					reconcilePlan: event.reconcilePlan,
				},
				syntheticsPushResult: null,
			};
		case "synthetics_push_choice":
			return {
				...state,
				threadId: event.threadId,
				syntheticsPushChoice: {
					threadId: event.threadId,
					deployment: event.deployment,
					kibanaSpace: event.kibanaSpace,
					pushableCount: event.pushableCount,
					extraCount: event.extraCount,
					projectScope: event.projectScope,
					command: event.command,
					explanation: event.explanation,
					pushMonitors: event.pushMonitors,
					extraMonitors: event.extraMonitors,
					message: event.message,
				},
			};
		case "synthetics_push_result":
			return {
				...state,
				syntheticsPushChoice: null,
				syntheticsPushResult: {
					status: event.status,
					pushedCount: event.pushedCount,
					project: event.project,
					pipelineId: event.pipelineId,
					pipelineStatus: event.pipelineStatus,
					note: event.note,
				},
			};
		// SIO-913 / SIO-922: fleet upgrade sub-flow events.
		case "fleet_upgrade_preview_report":
			// A fresh preview clears any prior apply outcome.
			return {
				...state,
				fleetUpgradePreview: {
					deployment: event.deployment,
					targetVersion: event.targetVersion,
					resolvedCount: event.resolvedCount,
					versionAvailable: event.versionAvailable,
					rolloutSeconds: event.rolloutSeconds,
					crosstab: event.crosstab,
					versionCrosstab: event.versionCrosstab, // SIO-935
					planError: event.planError,
					planErrorReason: event.planErrorReason,
				},
				fleetUpgradeResult: null,
			};
		case "fleet_upgrade_choice":
			return {
				...state,
				threadId: event.threadId,
				fleetUpgradeChoice: {
					threadId: event.threadId,
					deployment: event.deployment,
					targetVersion: event.targetVersion,
					resolvedCount: event.resolvedCount,
					upgradeableCount: event.upgradeableCount,
					notUpgradeableCount: event.notUpgradeableCount,
					rolloutSeconds: event.rolloutSeconds,
					byReason: event.byReason,
					versionCrosstab: event.versionCrosstab, // SIO-935
					message: event.message,
				},
			};
		case "fleet_upgrade_apply_result":
			return {
				...state,
				fleetUpgradeChoice: null,
				fleetUpgradeResult: {
					status: event.status,
					actionId: event.actionId,
					pollStatus: event.pollStatus,
					acked: event.acked,
					created: event.created,
					failedSilent: event.failedSilent,
					pipelineId: event.pipelineId,
					pipelineUrl: event.pipelineUrl,
					note: event.note,
					// SIO-928: capture the live progress lines NOW, before the `done` handler clears
					// iacPipelineProgress, so the timeline persists as a collapsed log under the result.
					...(state.iacPipelineProgress.length > 0 && { progressLog: [...state.iacPipelineProgress] }),
				},
			};
		default:
			return state;
	}
}
