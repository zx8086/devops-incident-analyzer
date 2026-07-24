// agent/src/iac/state.ts
import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { PipelineFailureClass } from "./fleet-apply-result.ts";

// SIO-1003: the single source of truth for the IaC workflow enum. The IacRequest.workflow type, the
// parseIntent zod schema, AND the parseIntent instruction's "workflow (...)" prose are all derived from
// this in nodes.ts, so a new workflow added here is automatically offered to the planner and accepted by
// the parser -- they can never drift (the SIO-1003 bug was cluster-settings-edit present in the schema
// but missing from the instruction enum, so the LLM could not select it).
export const WORKFLOW_VALUES = [
	"tier-resize",
	"ilm-rollout",
	"ilm-delete",
	"version-upgrade",
	"fleet-integration",
	"slo-edit",
	"alerting-edit",
	"dataview-edit",
	"cluster-default-edit",
	"cluster-default-delete",
	"cluster-settings-edit",
	"space-edit",
	"security-edit",
	"topology-edit",
	"dashboard-edit",
	"index-template-create",
	"ingest-pipeline-create",
	"ingest-pipeline-edit",
	"other",
] as const;

export type IacWorkflow = (typeof WORKFLOW_VALUES)[number];

// Parsed natural-language IaC request (e.g. "downsize eu-b2b warm to 8 GB").
export interface IacRequest {
	workflow: IacWorkflow;
	cluster?: string;
	tier?: string;
	resource?: string;
	newSizeGb?: number;
	newMaxGb?: number;
	policyName?: string;
	// SIO-880: nested phase patch for an ilm-rollout change, e.g.
	// { warm: { forcemerge: { max_num_segments: 1 } }, delete: { min_age: "60d" } }.
	phasesPatch?: Record<string, unknown>;
	// SIO-931: ilm-rollout "copy/clone/exact copy of <policy>" -- the reference policy filename to
	// read from the SAME cluster's lifecycle-policies/ dir and use as the (correctly-shaped) base.
	sourcePolicy?: string;
	// SIO-932: ilm-rollout naming MORE THAN ONE policy file in one request (e.g. "in metrics.json
	// and logs.json set warm replicas to 0"). Each entry is an independent {policyName, phasesPatch?,
	// sourcePolicy?, ilmFullPolicy?} applied to the SAME cluster; draftChange commits them all to ONE
	// branch and opens ONE MR. A single-policy request leaves this undefined and uses the singular
	// fields above (parseIntentJson folds a single-entry array back to the singular path for back-compat).
	// SIO-1011: ilmFullPolicy is the per-entry analogue of the singular ilmFullPolicy -- the authoritative
	// complete body for a from-scratch onboard, so naming >=2 NEW policy files with full bodies (and "do
	// not copy from live") is expressible in the multi-file path, not just the single-file one.
	ilmPolicies?: Array<{
		policyName: string;
		phasesPatch?: Record<string, unknown>;
		sourcePolicy?: string;
		ilmFullPolicy?: Record<string, unknown>;
	}>;
	// SIO-1001: ilm-rollout onboarding an AUTHORITATIVE policy body -- the user supplied the COMPLETE
	// file (e.g. pasted `{ name, hot, delete }` and said "exactly these keys / do not add warm/cold/
	// frozen"). Distinct from phasesPatch (a partial overlay deep-merged onto a sibling/canonical base):
	// for a from-scratch (404) policy this object is the file VERBATIM, so the committed phase set is
	// exactly what the user gave with no sibling-derived phases bleeding in. Only the named phases are
	// written; absent phases are absent. Ignored when phasesPatch/sourcePolicy is used instead.
	ilmFullPolicy?: Record<string, unknown>;
	// SIO-871: target Elasticsearch version for a version-upgrade workflow (e.g. "9.4.2").
	version?: string;
	// SIO-914: fleet-integration workflow -- the integration alias key in integrations.json
	// (e.g. "aws", "kafka") and its target package version (e.g. "6.15.0"). force pins a
	// reinstall (higher risk).
	integration?: string;
	integrationVersion?: string;
	force?: boolean;
	// SIO-1032: fleet-upgrade host scoping + count guard. selectedHostnames is the plain host list
	// the user named ("upgrade agents A, B, C only") -> the agent builds the Fleet KQL from it.
	// fleetSelector is a raw KQL selector the user wrote verbatim (passthrough; wins over the host
	// list). expectedAgentCount is "must resolve to exactly N / stop if any other count" -- a gate
	// WARNING, not a hard block; the apply stays selector-scoped regardless.
	selectedHostnames?: string[];
	fleetSelector?: string;
	expectedAgentCount?: number;
	// SIO-915: slo-edit workflow -- the SLO file basename and the override fields. sloTarget is
	// a percent (99.5) or fraction (0.995); sloWindow is a duration string ("60d"); sloTags
	// replace the file-level tags.
	sloName?: string;
	sloTarget?: number;
	sloWindow?: string;
	sloTags?: string[];
	// SIO-916: alerting-edit workflow -- the rule file basename (<space>__<rule-name>) + the
	// safe scalar fields to change. alertEnabled:false silences the rule (higher risk).
	ruleName?: string;
	alertThreshold?: number;
	alertWindowSize?: number;
	alertWindowUnit?: string;
	alertEnabled?: boolean;
	alertInterval?: string;
	// SIO-917: dataview-edit workflow -- the data-view file basename + a runtime field (config
	// form: script_source) and/or title/name. cluster-default-edit -- the index-template file
	// basename + the total_shards_per_node value.
	dataviewName?: string;
	runtimeFieldName?: string;
	runtimeFieldType?: string;
	runtimeFieldScript?: string;
	dataviewTitle?: string;
	dataviewDisplayName?: string;
	templateName?: string;
	totalShardsPerNode?: number;
	// SIO-979: cluster-default-edit freeform index settings patch (relative to settings.index, e.g.
	// `{ refresh_interval: "30s" }`) -- any index setting, validity enforced by CI's terraform plan.
	// clusterDefaults[] is the multi-file form (one MR over several templates); >=2 entries keep the
	// array and the proposer commits all files in one atomic commit (mirrors ilmPolicies[]).
	settingsPatch?: Record<string, unknown>;
	clusterDefaults?: Array<{ templateName: string; settingsPatch: Record<string, unknown> }>;
	// SIO-1022: cluster-default-delete -- REMOVE one or more cluster-defaults override files
	// (environments/<dep>/cluster-defaults/<templateName>.json). The filename (minus .json) is the
	// Terraform for_each key, so deleting the file drops exactly that one resource (AGENTS.md s3).
	// templateName is the file basename VERBATIM (e.g. `logs-elasticsearch.querylog@settings`). Always
	// an array (one MR per batch); each entry whose file is already absent is a per-file no-op.
	clusterDefaultDeletes?: Array<{ templateName: string }>;
	// SIO-1037: ilm-delete -- REMOVE one or more whole ILM policy files
	// (environments/<dep>/lifecycle-policies/<policyName>.json). Mirrors clusterDefaultDeletes: the
	// filename (minus .json) is the Terraform for_each key, so deleting the file drops exactly that one
	// policy resource. policyName is the file basename VERBATIM, INCLUDING any leading dot (e.g.
	// `.alerts-ilm-policy`). Always an array (one MR per batch); a file already absent is a per-file no-op.
	ilmDeletes?: Array<{ policyName: string }>;
	// SIO-994: cluster-settings-edit -- the cluster-level persistent/transient settings file
	// (environments/<dep>/cluster-settings/settings.json, the PUT _cluster/settings surface, distinct
	// from cluster-defaults' per-index-template settings). Each patch is a FLAT dotted-key map merged
	// into its top-level block (e.g. { "xpack.monitoring.collection.interval": "60s" }); validity is
	// left to CI's terraform plan, safety to a short danger denylist in guards.ts.
	persistentPatch?: Record<string, unknown>;
	transientPatch?: Record<string, unknown>;
	// SIO-996: cluster-settings-edit key REMOVAL (revert) -- dotted names to delete from each block.
	// Distinct from a set-to-null patch (which writes a literal null); these drop the leaf entirely.
	removeKeysPersistent?: string[];
	removeKeysTransient?: string[];
	// SIO-933: ilm-rollout optional bind -- point a cluster-defaults component-template's
	// settings.index.lifecycle.name at the created/edited policy, in the SAME MR. Basename, no .json.
	bindTemplate?: string;
	// SIO-918: space-edit -- the per-space file basename + name/description/color. security-edit
	// -- the role name + ADDITIVE privilege grants (cluster / index names+privileges / Kibana
	// application+privileges). role_mappings + api_keys are never touched.
	spaceName?: string;
	spaceDisplayName?: string;
	spaceDescription?: string;
	spaceColor?: string;
	roleName?: string;
	grantCluster?: string[];
	grantIndexNames?: string[];
	grantIndexPrivileges?: string[];
	grantKibanaApplication?: string;
	grantKibanaPrivileges?: string[];
	// SIO-919: topology-edit -- the global autoscale toggle and/or a tier's zone_count / per-tier
	// autoscale in the _deployments JSON. Always HIGH risk (single shared state, long apply).
	autoscaleEnabled?: boolean;
	topologyTier?: string;
	tierZoneCount?: number;
	tierAutoscale?: boolean;
	// SIO-919: topology-edit also covers the SSO user_settings_yaml (raw YAML-in-JSON; HIGH -- can
	// lock out login) and the non-data component sizing (integrations_server / kibana).
	userSettingsTarget?: "elasticsearch_config" | "kibana";
	userSettingsYaml?: string;
	// SIO-997: a SURGICAL single-key merge into the existing user_settings_yaml (e.g. set
	// xpack.monitoring.collection.interval), distinct from userSettingsYaml's whole-block replace.
	// The dotted key is set in place; every sibling subtree (incl. xpack.security/OIDC) is preserved
	// byte-for-byte, so a non-SSO setting can be added without the planner reproducing the SSO block.
	userSettingsMergeTarget?: "elasticsearch_config" | "kibana";
	userSettingsMergeKey?: string;
	userSettingsMergeValue?: string;
	// SIO-999: SURGICAL key REMOVAL from the existing user_settings_yaml (e.g. drop the appended
	// xpack.monitoring subtree), mirroring SIO-996's cluster-settings removeKeys*. The named dotted
	// leaves are deleted in place; every sibling subtree (incl. xpack.security/OIDC) is preserved
	// byte-for-byte. Distinct from a set-to-null merge (which writes a literal null). Reuses
	// userSettingsMergeTarget to name the block.
	userSettingsRemoveKeys?: string[];
	sizeComponent?: "integrations_server" | "kibana";
	componentSize?: string;
	componentZoneCount?: number;
	// SIO-1073: topology-edit also covers the top-level `observability` block (ships this
	// deployment's logs/metrics to a monitoring deployment; stacks/deployments reads
	// try(each.value.observability, null); the module defaults ref_id="main-elasticsearch",
	// logs=true, metrics=true). The set fields ADD/UPDATE the block (deployment id required only
	// when the block does not exist yet; a NAME is resolved to an id via the live deployments
	// list). observabilityRemove=true DELETES the whole block -- destructive (disconnects
	// monitoring shipping), surfaced HIGH, never combined with the set fields.
	observabilityDeploymentId?: string;
	observabilityDeploymentName?: string;
	observabilityRefId?: string;
	observabilityLogs?: boolean;
	observabilityMetrics?: boolean;
	observabilityRemove?: boolean;
	// SIO-920: dashboard-edit -- whole-file add/replace of a Kibana NDJSON saved-object export
	// at environments/<dep>/dashboards/<space>__<name>.ndjson. MEDIUM risk (display-only; a
	// malformed NDJSON fails CI's import job, not prod). Whole-file only -- no surgical panel edits.
	// The NDJSON is committed verbatim (never JSON.parsed as one object -- it is line-delimited).
	// delete is parsed but blocked as a follow-up (the GitLab MCP exposes no delete-file tool;
	// gitlab_commit_file is a create/update upsert).
	dashboardSpace?: string;
	dashboardName?: string;
	dashboardNdjson?: string;
	dashboardAction?: "add" | "replace" | "delete";
	// SIO-978: index-template-create -- add one or more NEW index-template JSON files under
	// environments/<dep>/index-templates/ (each becomes an elasticstack_elasticsearch_index_template
	// resource via the dedicated index-templates stack). N templates commit to ONE branch / ONE MR.
	// ILM binding is carried via the template settings (index.lifecycle.name); the provider has no
	// separate ILM argument. allow_custom_routing is 8.x-only -- emitted only when explicitly true.
	indexTemplates?: Array<{
		name: string;
		indexPatterns: string[];
		composedOf?: string[];
		ignoreMissingComponentTemplates?: string[];
		priority?: number;
		lifecycleName?: string;
		dataStreamHidden?: boolean;
		dataStreamAllowCustomRouting?: boolean;
	}>;
	// SIO-1019: ingest-pipeline-create -- add one or more NEW @custom ingest-pipeline JSON files under
	// environments/<dep>/ingest-pipelines/ (the dedicated ingest-pipelines stack auto-discovers *.json
	// in its config_path). Simpler than index-template-create: the user pastes the COMPLETE pipeline
	// body and `body` is written VERBATIM (no buildXxxConfig shaping). N pipelines commit to ONE branch
	// / ONE MR; an entry whose file already exists is skipped (additive create only -- edit is a
	// separate, unsupported workflow). Always an array (no singular companion fields, like indexTemplates).
	ingestPipelines?: Array<{ name: string; body: Record<string, unknown> }>;
	// SIO-1024: ingest-pipeline-edit -- REPLACE the full body of one or more EXISTING @custom
	// ingest-pipeline files under environments/<dep>/ingest-pipelines/. Sibling to ingest-pipeline-create
	// with the file-existence rule inverted: the target file MUST already exist (a 404 blocks, never
	// creates) and the commit uses action "update". `name` is the FILE BASENAME the user names in the path
	// (e.g. 'drop-cisco-meraki-ip-session'), NOT the body's `name` field -- the two can differ (a file
	// named drop-cisco-meraki-ip-session.json can hold a pipeline named logs-cisco_meraki.log@custom), and
	// the create path's name->filename derivation would 404 on that mismatch. `body` is written VERBATIM.
	// N files commit to ONE branch / ONE MR. Always an array (no singular companion fields).
	ingestPipelineEdits?: Array<{ name: string; body: Record<string, unknown> }>;
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
	// SIO-954: rendered knowledge-graph context (this deployment's recent change
	// history) surfaced to the reviewer. Empty when the graph is disabled/cold.
	recentChanges?: string;
	// SIO-970: rendered agent-memory recall (prior learnings/decisions for this
	// deployment/stack cell) surfaced to the reviewer. Undefined when the agent-memory
	// backend is off or recall returned no hits.
	priorLearnings?: string;
	// SIO-1083: three-state status per recall source so the card can distinguish a
	// disabled backend ("off" -> hide) from an enabled-but-cold one ("empty" -> show a
	// "no records yet" line) from one with hits ("populated" -> render the list). Derived
	// from the backend gate, not from whether the string above is empty (both the off and
	// cold cases leave that string ""). Optional: a payload without them reads as "off".
	recentChangesStatus?: "off" | "empty" | "populated";
	priorLearningsStatus?: "off" | "empty" | "populated";
	// SIO-983: rendered live-parity advisory -- the drafted change diffed against the LIVE
	// cluster (fields in the draft but not live, value changes, fields live has that the draft
	// drops). Undefined when no live equivalent was read or the draft matches live.
	liveParity?: string;
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

// SIO-913: Fleet agent BINARY upgrade is imperative (POST /api/fleet/agents/bulk_upgrade),
// NOT Terraform -- so it runs through an on-demand CI pipeline (preview -> HITL gate ->
// apply), mirroring the synthetics push sub-flow. The repo's fleet-bulk-upgrade.sh emits a
// `fleet-upgrade-report.json` (contract: experiments/HANDOFF-2026-06-16-SIO-913-...md,
// "fleet-upgrade-report/v1"). This is the parsed preview report. snake_case in the artifact
// is mapped to camelCase here (same idiom as SyntheticsDriftReport).
export interface FleetUpgradeCrosstab {
	upgradeable: number;
	notUpgradeable: number; // Wolfi/container agents (upgradeable:false) -> image-tag bump, not this flow
	byReason: Array<{ reason: string; count: number }>;
}

// SIO-935: version partition of the resolved selector set. Additive + OPTIONAL -- the
// upgradeable_crosstab above is computed purely from Fleet's upgradeable:false boolean (Wolfi
// detection via os.name) and says NOTHING about version, so "already on target" was invisible
// (agents fell into the opaque unknown/other reason buckets). This block is emitted by the CI
// script's new pre-flight version queries; an old v1 report without it yields undefined here.
// Invariant (CI-enforced): alreadyOnTarget + outdated + versionUnknown === resolvedCount.
export interface FleetUpgradeVersionCrosstab {
	alreadyOnTarget: number; // resolved agents whose version == target (bulk_upgrade no-ops them)
	outdated: number; // resolved agents strictly below target (the genuine backlog)
	versionUnknown: number; // resolved agents whose version could not be read
	upgradeableOutdated: number; // Fleet-upgradeable AND outdated == what THIS flow actually moves
}

export interface FleetUpgradeReport {
	deployment: string;
	targetVersion: string;
	rolloutSeconds: number;
	selector: string;
	// SIO-1032: the selector the AGENT sent to CI (built from a host list or the user's raw KQL),
	// kept distinct from `selector` (which the CI report echoes back). applyFleetUpgrade resends
	// this exact string so an approved apply stays scoped to the named set. Undefined = unscoped
	// (all outdated agents, the pre-SIO-1032 behavior).
	requestedSelector?: string;
	// SIO-1032: the "must resolve to exactly N agents" guard the user stated. When set and it does
	// not equal resolvedCount, the gate card carries a WARNING (operator may still override).
	expectedAgentCount?: number;
	resolvedCount: number; // agents matched by the selector
	versionAvailable: boolean; // target present in /api/fleet/agents/available_versions
	maxAgents: number;
	crosstab: FleetUpgradeCrosstab;
	versionCrosstab?: FleetUpgradeVersionCrosstab; // SIO-935: present only when CI emits version_crosstab
	generatedAt: string;
	// NOT assessed -- the preview pipeline could not be read (trigger lock / failed / unreadable
	// report). Mirrors SyntheticsDriftReport.planError: neither upgradeable nor confirmed-empty.
	planError?: boolean;
	planErrorReason?: string;
	// SIO-971: rendered agent-memory recall (prior fleet upgrades for this deployment), the
	// fleet-path twin of SIO-970's priorLearnings. Undefined when the agent-memory backend is
	// off or recall found nothing. Carried onto the fleet_upgrade_choice gate card.
	priorUpgrades?: string;
}

// Outcome of the operator-approved apply (single). applied = the bulk_upgrade ran to a
// terminal poll; dispatched = started and still running past the status window (SIO-926 --
// a long rollout we did not block on, NOT a failure); skipped = operator declined; blocked =
// could not trigger (lock/error); failed = apply pipeline actually failed/canceled.
// failedSilent is the verify-sweep UPG_FAILED count (Fleet action_status undercounts -- the
// 2026-05-17 ground truth); it leads the report.
export interface FleetUpgradeResult {
	// SIO-961: "partial" = the rollout reached its deadline / the job exited non-zero, but
	// the failures are agent/env-side (download, disk, health-check rollback) and most agents
	// are unsettled-offline (will upgrade when they reconnect). Distinct from "failed", which
	// is a genuine pipeline/infra failure (state lock, plan error) where nothing was applied.
	status: "applied" | "partial" | "dispatched" | "skipped" | "blocked" | "failed";
	pipelineId?: number | null;
	// SIO-924: the apply pipeline's GitLab web_url, so the UI can render a clickable link to the
	// live bulk_upgrade run (parity with how config edits surface the MR link).
	pipelineUrl?: string;
	pipelineStatus?: string;
	actionId?: string;
	pollStatus?: string; // COMPLETE | ROLLOUT_PASSED | FAILED | ...
	acked?: number;
	created?: number;
	failedSilent?: number;
	// SIO-961: full per-agent breakdown so the summary reports a partial outcome honestly.
	succeeded?: number;
	failed?: number;
	rolledBack?: number;
	unsettled?: number;
	failedAgents?: { hostname: string; agentId: string; failedState: string; error: string }[];
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

// SIO-990: the durable "active change context" for one session. Captured at PROPOSE time
// (draftChange) so it survives a rejected/propose-only turn -- unlike mrUrl/mrIid which only
// openMr sets. It is the single anchor a follow-up turn reads to (a) amend the change in place
// on the SAME branch instead of proposing from scratch, and (b) answer "check my MR" with the
// right deployment/MR/pipeline. deployment/stack/kind/branch/proposedFiles/title are set by the
// proposer; mr* are merged in by openMr; pipeline* by watchPipeline. module is best-effort (the
// repo Stack->Module link is not name-derivable; left undefined when not cheaply resolvable).
export interface IacActiveChange {
	deployment: string;
	stack: string;
	module?: string;
	kind: IacRequest["workflow"];
	branch: string;
	proposedFiles: string[];
	title?: string;
	mrUrl?: string;
	mrIid?: number;
	pipelineId?: number;
	pipelineStatus?: string;
	// requestId of the turn that last wrote this context (debug/trace aid).
	updatedAtTurn: string;
}

const last = <T>(_current: T, update: T): T => update;

// Dedicated IaC graph state. Kept separate from AgentState so the maker workflow
// never carries the 50-field incident pipeline state (and vice versa). The HITL
// primitives (interrupt/Command/getPendingInterrupt) operate on the checkpointer
// thread, not the state shape, so they are reused unchanged.
export const IacState = Annotation.Root({
	...MessagesAnnotation.spec,
	requestId: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-965: the checkpointer thread id, captured in bootstrapIac from the runnable
	// config (configurable.thread_id). Survives the resume leg (it is checkpointed on
	// leg 1) and backs the knowledge-graph Session node grouping a conversation's turns.
	threadId: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-870: read-vs-write routing. "info" answers from Elastic Cloud reads and
	// stops; "gitops" enters the maker/HITL/MR pipeline. Set by classifyIacIntent.
	// SIO-875: "pipeline-status" is a follow-up ("did the pipeline pass / show me the
	// plan / check my MR") that re-enters watchPipeline using the thread's persisted MR.
	// SIO-882: "drift" enters the drift-detection + per-stack reconcile sub-flow.
	// SIO-902: "synthetics-drift" enters the synthetics monitor drift + operator-approved push sub-flow.
	// SIO-913: "fleet-upgrade" enters the Fleet agent binary-upgrade sub-flow (preview -> gate -> apply).
	// SIO-930: "converse" answers a conversational follow-up ABOUT the agent's own prior answer
	// (explain/critique), with full conversation history, over the read-only tool subset. Selectable
	// only on a follow-up turn (see coerceConverseIntent).
	// SIO-990: "gitops-amend" is a CORRECTION to the change just proposed this session (e.g. "4d is
	// wrong, use 14d", "do as instructed", "proceed"). Selectable only when an activeChange.branch
	// exists; routes to amendChange, which re-commits onto that SAME branch (updating the existing MR
	// in place) instead of proposing from scratch.
	intent: Annotation<
		| "info"
		| "gitops"
		| "gitops-amend"
		| "pipeline-status"
		| "drift"
		| "synthetics-drift"
		| "fleet-upgrade"
		| "converse"
		| null
	>({
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
	// SIO-932: all repo file paths committed this turn. A single-file change sets exactly one
	// entry (mirroring proposedFilePath); a multi-file ilm-rollout sets one per policy. The MR
	// body lists them under "Files touched"; proposedDiff carries the combined per-file diffs.
	proposedFiles: Annotation<string[]>({ reducer: last, default: () => [] }),
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
	// SIO-992: the MR's lifecycle state read from gitlab_get_merge_request ("opened"|"merged"|
	// "closed"|""). watchPipeline only sees the pre-merge PLAN pipeline, so without this a merged
	// MR still reads as "staged and ready to merge". Drives the lifecycle-aware closing line: open
	// (plan ready, not merged) vs merged (apply runs on main, not visible here). "" = not read.
	mrState: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-993: the post-merge terraform APPLY pipeline on main (found via the MR's merge_commit_sha).
	// applyPipelineStatus is GitLab's pipeline status ("running"|"success"|"failed"|...) or "" when the
	// apply hasn't started / MR isn't merged; success means the change is LIVE. The message reports
	// this real status instead of telling the user to go check GitLab.
	applyPipelineStatus: Annotation<string>({ reducer: last, default: () => "" }),
	applyPipelineId: Annotation<number | null>({ reducer: last, default: () => null }),
	applyPipelineUrl: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-878: when the pipeline failed, a human-readable cause hint (e.g. a Terraform
	// state-lock on the shared deployments stack) derived from the plan job log.
	failureHint: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-1185: the failure taxonomy class behind failureHint, driving the
	// class-specific closing line. Typed so invalid classes cannot enter state.
	failureClass: Annotation<PipelineFailureClass | "">({ reducer: last, default: () => "" }),
	// SIO-880: when an ilm-rollout reduces delete.min_age, the from/to surfaced as a
	// HIGH-risk line in the review card + MR body (data deletion is irreversible).
	retentionChange: Annotation<{ from: string; to: string } | null>({ reducer: last, default: () => null }),
	// SIO-899: an ilm-rollout created a previously-untracked policy file (404 -> onboard);
	// surfaced in the review card / MR body / final message so the human reviews a CREATE.
	policyCreated: Annotation<boolean>({ reducer: last, default: () => false }),
	// SIO-1012: the target (deployment, stack) has no provisioned stack instance -- i.e. no
	// environments/<dep>/<stack>/terraform.tfvars, which is what the repo's CI uses to discover
	// applyable combos (find ... -name terraform.tfvars). Without it CI emits a no-op and the merge
	// will NOT apply. Surfaced as a HIGH risk on the review card so a no-op apply is not a silent
	// surprise. The agent NEVER writes the tfvars -- provisioning is a repo/CI/human responsibility.
	stackInstanceMissing: Annotation<boolean>({ reducer: last, default: () => false }),
	// SIO-983: rendered live-parity advisory (the drafted change diffed against the LIVE cluster) --
	// surfaced on the plan-review card. Empty when no live equivalent was read or the draft matches
	// live. Set by the proposer (which holds both the live read and the drafted object).
	liveParity: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-914: a fleet-integration bump crossed a major version (leading integer increased) --
	// surfaced as a higher-risk line in the review card / MR body (can break dashboards/mappings).
	integrationMajorBump: Annotation<boolean>({ reducer: last, default: () => false }),
	// SIO-915: a slo-edit LOWERED the objective target (looser SLO) -- surfaced as a risk line
	// so the reviewer knows the reliability bar was relaxed.
	sloTargetLowered: Annotation<boolean>({ reducer: last, default: () => false }),
	// SIO-916: an alerting-edit DISABLED a rule (enabled:false) -- surfaced as a HIGH risk line
	// because it silences the rule's alerts.
	alertDisabled: Annotation<boolean>({ reducer: last, default: () => false }),
	// SIO-917: a cluster-default-edit LOWERED total_shards_per_node -- surfaced as a risk line
	// (concentrates shards on fewer nodes, can unbalance allocation).
	shardsLowered: Annotation<boolean>({ reducer: last, default: () => false }),
	// SIO-933: an ilm-rollout re-pointed a component-template's settings.index.lifecycle.name at a
	// policy -- surfaced as a risk line (data streams switch ILM policy as new indices roll over).
	lifecycleRetargeted: Annotation<boolean>({ reducer: last, default: () => false }),
	// SIO-918: a security-edit granted cluster-level / superuser privileges -- surfaced as the
	// HIGHEST risk line + "recommend human security review".
	privilegeEscalation: Annotation<boolean>({ reducer: last, default: () => false }),
	planReport: Annotation<IacPlanReport | null>({ reducer: last, default: () => null }),
	approvalState: Annotation<IacApprovalState | null>({ reducer: last, default: () => null }),
	// false when the unified mcp-server-elastic-iac is not connected; surfaced to the UI.
	connected: Annotation<boolean>({ reducer: last, default: () => true }),
	// terminal blocked reason from the guard (e.g. prod not named, .alerts unmanaged).
	blockedReason: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-1020: a no-op "change" -- the requested config already matches current state. Distinct
	// from blockedReason (a real guard rejection) so the turn renders as a neutral "No change
	// needed" instead of an amber "Blocked". Set by every GitOps proposer's no-op guard.
	noopReason: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-1196: version-upgrade live-drift detection. Set ONLY by proposeVersionUpgrade in the
	// turn it detects repo==target but live!=target (a merged-but-never-applied change); routes
	// draftChange -> explainDrift (the drift-reconcile lane) instead of END. Turn-scoped: reset
	// by bootstrapIac's TURN_START_RESET so a prior turn's drift never re-routes a follow-up.
	versionDrift: Annotation<{
		cluster: string;
		targetVersion: string;
		liveVersion: string;
		mrRef?: string;
		applyJobUrl?: string;
	} | null>({ reducer: last, default: () => null }),
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
	// SIO-913: Fleet agent binary-upgrade sub-flow. fleetUpgradeReport holds the parsed preview
	// (or a planError stub); fleetUpgradeApproved is the operator's apply decision (read by the
	// gate->worker edge); fleetUpgradeResult is the single apply outcome. targetDeployment (above)
	// is reused for the resolved deployment.
	fleetUpgradeReport: Annotation<FleetUpgradeReport | null>({ reducer: last, default: () => null }),
	fleetUpgradeApproved: Annotation<boolean | null>({ reducer: last, default: () => null }),
	fleetUpgradeResult: Annotation<FleetUpgradeResult | null>({ reducer: last, default: () => null }),
	// SIO-926: the in-flight apply pipeline id, persisted so a later "how's the upgrade going?"
	// (pipeline-status intent) re-polls THIS imperative pipeline -- there is no MR for a binary
	// upgrade, so watchPipeline's MR-recovery path can't find it. Set when the apply is dispatched.
	fleetApplyPipelineId: Annotation<number | null>({ reducer: last, default: () => null }),
	// SIO-930: set by the request (UI message-count signal). Gates whether the conversational
	// "converse" intent is selectable -- a first turn cannot be a follow-up about a prior answer.
	isFollowUp: Annotation<boolean>({ reducer: last, default: () => false }),
	// SIO-954: rendered knowledge-graph context for the target deployment (recent change
	// history), produced by graphEnrichIac and surfaced in the plan-review payload. Empty
	// when KNOWLEDGE_GRAPH_ENABLED is off or the deployment has no recorded history.
	iacGraphContext: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-969: the most-recent prior change's outcome for the targeted (deployment, stack)
	// cell, from the knowledge graph. Lets reviewPlan raise a HIGH risk when the last
	// attempt on this exact stack-instance FAILED. undefined when the graph is off/empty or
	// the stack can't be resolved from the proposed paths.
	lastStackInstanceOutcome: Annotation<{ outcome: string; mrUrl: string; summary: string } | undefined>({
		reducer: last,
		default: () => undefined,
	}),
	// SIO-970: rendered agent-memory recall (prior learnings/decisions for the targeted
	// (deployment, stack) cell), produced by memoryEnrichIac and surfaced in the plan-review
	// payload. Empty when LIVE_MEMORY_BACKEND != agent-memory or recall returns no hits.
	priorLearnings: Annotation<string>({ reducer: last, default: () => "" }),
	// SIO-990: the durable per-session "active change context" -- the change this conversation is
	// working on. Set at PROPOSE time by draftChange (so it survives a rejected/propose-only turn),
	// enriched with {mrUrl, mrIid} by openMr and {pipelineId, pipelineStatus} by watchPipeline. Read
	// by classifyIacIntent (to route a correction to amendChange) and amendChange (to re-commit on the
	// same branch). null until the first proposal of the session.
	activeChange: Annotation<IacActiveChange | null>({ reducer: last, default: () => null }),
});

export type IacStateType = typeof IacState.State;
