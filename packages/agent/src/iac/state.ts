// agent/src/iac/state.ts
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

// Parsed natural-language IaC request (e.g. "downsize eu-b2b warm to 8 GB").
export interface IacRequest {
	workflow: "tier-resize" | "ilm-rollout" | "version-upgrade" | "other";
	cluster?: string;
	tier?: string;
	resource?: string;
	newSizeGb?: number;
	newMaxGb?: number;
	policyName?: string;
	// SIO-880: nested phase patch for an ilm-rollout change, e.g.
	// { warm: { forcemerge: { max_num_segments: 1 } }, delete: { min_age: "60d" } }.
	phasesPatch?: Record<string, unknown>;
	// SIO-871: target Elasticsearch version for a version-upgrade workflow (e.g. "9.4.2").
	version?: string;
	reason?: string;
	// Prod requires the user to name the prod cluster explicitly (RULES.md).
	isProd: boolean;
	// When set, the planner needs a direct answer from the human before proceeding.
	clarification?: string;
}

// Snapshot of live cluster state read before drafting (topology + ILM + health).
export interface IacClusterState {
	cluster: string;
	summary: string;
	// True when the target tier currently has a managed ILM/.alerts setup; used by
	// the hot-downsize guard (RULES.md conditional).
	alertsManaged: boolean;
	currentSizeGb?: number;
	raw?: unknown;
}

// The reviewed change surfaced to the human at the planReview interrupt.
export interface IacPlanReview {
	// SIO-874: "config-edit" is a JSON change committed via the GitLab API (no terraform,
	// no gl-testing pre-check; CI plans on the MR). "terraform" is the legacy local path.
	kind: "config-edit" | "terraform";
	cluster: string;
	branch: string;
	title: string;
	diff: string;
	plan: string;
	risks: string[];
	precheckPassed: boolean;
}

// SIO-875: the actual Terraform plan parsed from the MR pipeline's terraform report.
export interface IacPlanReport {
	create: number;
	update: number;
	delete: number;
	resources: Array<{ address: string; actions: string[] }>;
}

// SIO-875: MR approval state from the GitLab approvals API.
export interface IacApprovalState {
	approved: boolean;
	required?: number;
	approvedBy?: string[];
}

// SIO-882: drift reconcile sub-flow. Direction the human picks per drifted stack:
// "reconcile-to-live" rewrites the repo to match the live cluster (config-JSON stacks
// only in Phase 1); "reconcile-to-json" opens an MR re-asserting the declared config so
// CI's plan shows the revert; "skip" leaves the stack untouched.
export type ReconcileDirection = "reconcile-to-json" | "reconcile-to-live" | "skip";

// SIO-900: one leaf-level diff inside a changed attribute, from the drift-report `changes[]`
// field (elastic-iac Increment 2 / MR !77). `path` is a dot/identity-bracket locator from the
// resource root whose first segment is one of `changedKeys`, e.g. `inputs["kubelet/metrics"].period`.
// op: update (both sides, differ) | add (declared-only) | remove (live-only). before = live,
// after = declared; the "<redacted:sensitive>"/"<omitted:too-large>" sentinels must never be
// written back. unstableIndex marks a numeric-array-index path (no stable identity key): treat as
// a hint only and reconcile at attribute grain via `values` instead of writing by path.
export interface LeafChange {
	path: string;
	op: "add" | "remove" | "update";
	before?: unknown;
	after?: unknown;
	unstableIndex?: boolean;
}

// One drifted resource, carrying the drift-report.json detail the explainer surfaces.
// SIO-886: reason/changedKeys/category were previously dropped before reaching the UI.
export interface StackDriftResource {
	address: string;
	actions: string[];
	// "attributes changed: version", "kibana-churn: keys changed = ..." -- CI's human reason.
	reason?: string;
	changedKeys?: string[];
	// create | update | destroy | replace (known-noise is filtered out upstream).
	category?: string;
	// SIO-889: per-changed-key {before: live, after: declared} from the drift-report `values`
	// field (keys 1:1 with changedKeys). before is the reconcile-to-live source; the sentinels
	// "<redacted:sensitive>"/"<omitted:too-large>" must never be written back. Absent on
	// create/destroy/noop and older reports.
	values?: Record<string, { before?: unknown; after?: unknown }>;
	// SIO-900: leaf-level decomposition of the changed attributes (Increment 2). Preferred over
	// `values` for precise explanation + reconcile; falls back to `values` when absent/truncated.
	changes?: LeafChange[];
	// True total leaf changes before the producer's 50-entry cap (UI: "showing X of N").
	changeCount?: number;
	// True when `changes[]` was capped at the producer's limit.
	truncated?: boolean;
}

// One stack's drift from the on-demand drift-check plus its classification.
export interface StackDrift {
	stack: string;
	drifted: boolean;
	// Every stack is JSON-config-driven; "config-json" here means live-reconcile is wired (the agent
	// can edit the repo JSON from live), "unwired" means it is not wired yet. Drives the UI badge.
	kind: "config-json" | "unwired";
	create: number;
	update: number;
	delete: number;
	resources: StackDriftResource[];
	// SIO-886: a concise, grounded human explanation of what drifted (set by explainDrift),
	// shown in the drift card + reconcile-choice card to inform the MR-vs-skip decision.
	explanation?: string;
	// Resolved repo JSON path when kind === "config-json" (set by the path-resolve probe).
	configPath?: string;
	// reconcile-to-live is offered only when a clean live->file mapping exists for the actual
	// drift: SIO-886 enables it for the deployment-config version field (set true in
	// driftCheckStack when version drifted). ILM/tier/HCL still defer it.
	liveReconcilable: boolean;
	// True when the drift-check could not be read for this stack (trigger lock / failed
	// pipeline / unreadable report): the stack was NOT assessed -- neither drifted nor clean.
	planError?: boolean;
	// SIO-887: a human-readable reason for planError (state-lock, classified plan failure,
	// no report, ...), surfaced in the drift card instead of a generic "plan unavailable".
	planErrorReason?: string;
}

export interface DriftReport {
	deployment: string;
	stacks: StackDrift[];
	generatedAt: string;
}

// SIO-902: synthetics drift. The synthetics stack (null_resource + @elastic/synthetics push)
// is invisible to `terraform plan`, so a separate SYNTH_DRIFT_CHECK CI job compares source
// YAML monitors against live Kibana and emits synthetics-drift-report.json. Unlike the TF
// drift report this is whole-deployment (no per-stack), and reconcile is a single remote
// push (re-assert source YAML), not per-resource MRs.

// One drifted monitor from the report `drift[]` array. category: changed (both sides differ) |
// missing_in_kibana (in source, not live -- push creates) | extra_in_kibana (live, no source --
// SURFACE-ONLY, never pushed/deleted). fields present only on "changed" (source vs live diff).
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

// reconcile_plan from the report: the producer's pre-computed bidirectional action split.
// pushToKibana = the source-authoritative set the push asserts (changed + missing_in_kibana),
// with a project-scoped CLI command. addToSource = surface-only guidance for extra_in_kibana
// (the agent NEVER auto-actions this -- a push would delete those live monitors).
export interface SyntheticsReconcilePlan {
	pushToKibana: { command: string; monitors: Array<{ project: string; monitorId: string; monitorName: string }> };
	addToSource: { action: string; monitors: Array<{ project: string; monitorId: string; monitorName: string }> };
}

export interface SyntheticsDriftReport {
	deployment: string;
	kibanaUrl: string;
	kibanaSpace: string;
	// has_actionable_drift -- the PRIMARY signal (false => source and Kibana are in sync).
	hasActionableDrift: boolean;
	totals: SyntheticsDriftTotals;
	drift: SyntheticsDriftMonitor[];
	reconcilePlan: SyntheticsReconcilePlan;
	generatedAt: string;
	// True when the drift-check could not be read (trigger lock / failed pipeline / unreadable
	// report): NOT assessed -- neither drifted nor clean (mirror StackDrift.planError).
	planError?: boolean;
	planErrorReason?: string;
}

// Outcome of the operator-approved push (single, not per-stack). pushed = CI push succeeded;
// skipped = operator declined; blocked = could not trigger (lock/error); failed = push pipeline
// failed/timed out. project is the scope passed (single-project) or undefined (fleet-wide).
export interface SyntheticsPushResult {
	status: "pushed" | "skipped" | "blocked" | "failed";
	project?: string;
	pipelineId?: number | null;
	pipelineStatus?: string;
	pushedCount: number;
	note?: string;
}

// Outcome of reconciling one stack (one independent, idempotent MR or a skip/block).
export interface ReconcileResult {
	stack: string;
	direction: ReconcileDirection;
	status: "opened" | "reused" | "skipped" | "blocked";
	mrUrl?: string;
	branch?: string;
	note?: string;
}

const last = <T>(_current: T, update: T): T => update;

// Dedicated IaC graph state. Kept separate from AgentState so the maker workflow
// never carries the 50-field incident pipeline state (and vice versa). The HITL
// primitives (interrupt/Command/getPendingInterrupt) operate on the checkpointer
// thread, not the state shape, so they are reused unchanged.
export const IacState = Annotation.Root({
	...MessagesAnnotation.spec,
	requestId: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-870: read-vs-write routing. "info" answers from Elastic Cloud reads and
	// stops; "gitops" enters the maker/HITL/MR pipeline. Set by classifyIacIntent.
	// SIO-875: "pipeline-status" is a follow-up ("did the pipeline pass / show me the
	// plan / check my MR") that re-enters watchPipeline using the thread's persisted MR.
	// SIO-882: "drift" enters the drift-detection + per-stack reconcile sub-flow.
	// SIO-902: "synthetics-drift" enters the synthetics monitor drift + operator-approved push sub-flow.
	intent: Annotation<"info" | "gitops" | "pipeline-status" | "drift" | "synthetics-drift" | null>({
		reducer: last,
		default: () => null,
	}),
	iacRequest: Annotation<IacRequest | null>({ reducer: last, default: () => null }),
	clusterState: Annotation<IacClusterState | null>({ reducer: last, default: () => null }),
	branch: Annotation<string>({ reducer: last, default: () => "" }),
	proposedDiff: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-873: GitOps proposer (version-upgrade) — the JSON config file edited and the
	// version it held before the bump, surfaced in the plan-review payload.
	proposedFilePath: Annotation<string>({ reducer: last, default: () => "" }),
	previousVersion: Annotation<string>({ reducer: last, default: () => "" }),
	terraformPlan: Annotation<string>({ reducer: last, default: () => "" }),
	risks: Annotation<string[]>({ reducer: last, default: () => [] }),
	precheckPassed: Annotation<boolean>({ reducer: last, default: () => false }),
	planReview: Annotation<IacPlanReview | null>({ reducer: last, default: () => null }),
	reviewDecision: Annotation<"approved" | "rejected" | null>({ reducer: last, default: () => null }),
	mrUrl: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-875: post-MR pipeline watch. mrIid persists so a follow-up "check my MR" can
	// re-fetch; pipelineStatus is "success"|"failed"|"running"|"unknown"; planReport is
	// the real terraform plan; approvalState is the MR approval summary.
	mrIid: Annotation<number | null>({ reducer: last, default: () => null }),
	pipelineId: Annotation<number | null>({ reducer: last, default: () => null }),
	pipelineStatus: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-878: when the pipeline failed, a human-readable cause hint (e.g. a Terraform
	// state-lock on the shared deployments stack) derived from the plan job log.
	failureHint: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-880: when an ilm-rollout reduces delete.min_age, the from/to surfaced as a
	// HIGH-risk line in the review card + MR body (data deletion is irreversible).
	retentionChange: Annotation<{ from: string; to: string } | null>({ reducer: last, default: () => null }),
	// SIO-899: an ilm-rollout created a previously-untracked policy file (404 -> onboard);
	// surfaced in the review card / MR body / final message so the human reviews a CREATE.
	policyCreated: Annotation<boolean>({ reducer: last, default: () => false }),
	planReport: Annotation<IacPlanReport | null>({ reducer: last, default: () => null }),
	approvalState: Annotation<IacApprovalState | null>({ reducer: last, default: () => null }),
	// false when the unified mcp-server-elastic-iac is not connected; surfaced to the UI.
	connected: Annotation<boolean>({ reducer: last, default: () => true }),
	// terminal blocked reason from the guard (e.g. prod not named, .alerts unmanaged).
	blockedReason: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-882: drift reconcile sub-flow. targetDeployment scopes the audit to one
	// deployment; driftReport holds the per-stack plan; driftIndex walks the drifted
	// stacks sequentially; currentDirection is the gate's chosen direction for the
	// stack at driftIndex (read by the gate->worker edge); reconcileResults accumulates
	// one entry per processed stack (MR opened/reused, skipped, or blocked).
	targetDeployment: Annotation<string>({ reducer: last, default: () => "" }),
	driftReport: Annotation<DriftReport | null>({ reducer: last, default: () => null }),
	driftIndex: Annotation<number>({ reducer: last, default: () => 0 }),
	currentDirection: Annotation<ReconcileDirection | null>({ reducer: last, default: () => null }),
	reconcileResults: Annotation<ReconcileResult[]>({ reducer: last, default: () => [] }),
	// SIO-902: synthetics drift sub-flow. syntheticsDriftReport holds the parsed report (or a
	// planError stub); syntheticsPushApproved is the operator's push decision (read by the
	// gate->worker edge); syntheticsPushResult is the single push outcome. targetDeployment
	// (above) is reused for the resolved deployment.
	syntheticsDriftReport: Annotation<SyntheticsDriftReport | null>({ reducer: last, default: () => null }),
	syntheticsPushApproved: Annotation<boolean | null>({ reducer: last, default: () => null }),
	syntheticsPushResult: Annotation<SyntheticsPushResult | null>({ reducer: last, default: () => null }),
});

export type IacStateType = typeof IacState.State;
