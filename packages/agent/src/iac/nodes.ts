// agent/src/iac/nodes.ts

import { createHash } from "node:crypto";
import { buildSystemPrompt } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import type { AnnotationMap } from "@devops-agent/shared";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { isMap, parseDocument } from "yaml";
import { z } from "zod";
import { createLlm, createLlmWithTools } from "../llm.ts";
import { getConnectedServers, getToolsForDataSource } from "../mcp-bridge.ts";
import {
	dedupeHitsBy,
	dedupePreferring,
	type MemorySearchHit,
	recallInFlightFleetUpgrades,
	searchAgentMemory,
	selectedBackend,
} from "../memory-backend.ts";
import { appendDailyLog, recordKeyDecision } from "../memory-writer.ts";
import { getAgentByName } from "../prompt-context.ts";
// SIO-1072: the pure fleet-apply parsers/classifiers moved to fleet-apply-result.ts (dependency-free
// leaf, mirroring SIO-1047's mr-live-state.ts extraction) so reconcile.ts's fleet-settlement pass
// shares the SAME classification without importing nodes.ts (nodes.ts imports reconcile.ts -- a
// cycle). Re-exported below for existing external importers (pipeline-status.test.ts).
import {
	classifyFleetApplyResult,
	classifyPipelineFailure,
	isTerminalPipelineStatus,
	parseDriftCheckResult,
	parseFleetApplyOutcome,
	parseSinglePipeline,
} from "./fleet-apply-result.ts";
import { evaluateGuards, validateIlmPhaseOrdering } from "./guards.ts";
import { classifyLiveState, lifecycleRank, lifecycleTag } from "./lifecycle.ts";
import {
	computeIlmLiveParity,
	esIlmPolicyToFlatDsl,
	parseEsIlmPolicyResponse,
	renderLiveParity,
} from "./live-parity.ts";
import { createSearchMemoryTool } from "./local-tools.ts";
// SIO-1047: parseMrState/parseApplyResult moved to mr-live-state.ts (kept it a dependency-free leaf,
// breaking the nodes.ts <-> reconcile.ts import cycle). watchPipeline below still calls both; they
// are also re-exported near the bottom of this file for pipeline-status.test.ts, which imports both
// from "./nodes.ts".
import { mrIidFromConflictMessage, parseApplyResult, parseMrState } from "./mr-live-state.ts";

export type { FleetApplyOutcome, FleetFailedAgent } from "./fleet-apply-result.ts";
export {
	classifyFleetApplyResult,
	classifyPipelineFailure,
	isTerminalPipelineStatus,
	parseDriftCheckResult,
	parseFleetApplyOutcome,
	parseSinglePipeline,
} from "./fleet-apply-result.ts";

import { iacProposalFactTtlSeconds, reconcileAll } from "./reconcile.ts";
import type {
	DriftReport,
	FleetUpgradeReport,
	FleetUpgradeResult,
	IacActiveChange,
	IacApprovalState,
	IacPlanReport,
	IacPlanReview,
	IacRequest,
	IacStateType,
	LeafChange,
	ReconcileDirection,
	ReconcileResult,
	StackDrift,
	SyntheticsDriftMonitor,
	SyntheticsDriftReport,
	SyntheticsPushResult,
} from "./state.ts";
import { WORKFLOW_VALUES } from "./state.ts";

const log = getLogger("agent:iac");
const AGENT = "elastic-iac";
const IAC_SERVER = "elastic-iac-mcp";

// SIO-1038: exported so graph-knowledge.ts reuses the exact same verbatim, no-truncation
// extraction for the prompt-capture node instead of duplicating it.
export function lastHumanText(state: IacStateType): string {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const m = state.messages[i];
		if (m?.getType() === "human") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
	}
	return "";
}

// SIO-1001: the deployment already established earlier in this session, in priority order. Lets a
// terse gitops follow-up (a pasted policy JSON, "set it to 60d") inherit the cluster instead of the
// parser re-asking "which deployment?" when the latest message names none. Mirrors the fallback
// cascade already used by watchPipeline and the drift flow. Empty string on a fresh session, so a
// genuinely first-turn no-cluster request still clarifies (no stale cluster leaks in).
// (Exported for unit testing.)
export function knownSessionDeployment(state: IacStateType): string {
	return (
		state.activeChange?.deployment?.trim() || state.targetDeployment?.trim() || state.iacRequest?.cluster?.trim() || ""
	);
}

// SIO-1001: true when a clarification question is asking specifically for the deployment/cluster.
// Only THAT clarification is suppressed when we can inherit the session deployment; clarifications
// about other genuinely-missing fields (a version, a tier) still fire. (Pure; unit-tested.)
export function isMissingClusterClarification(clarification: string): boolean {
	return /\b(which|what)\b[\s\S]*\b(deployment|cluster)\b/i.test(clarification);
}

// SIO-981: a turn is a real follow-up when the agent has already answered at least once this
// thread (a prior AIMessage exists). The classifier derives the converse gate from this rather than
// trusting only the UI-supplied state.isFollowUp flag (which the client can omit on a reload).
// (Pure; unit-testable via classifyIacIntent.)
function hasPriorAgentTurn(state: IacStateType): boolean {
	return state.messages.some((m) => m?.getType() === "ai");
}

// SIO-981: the last N messages, so the classifier LLM can SEE the prior proposal a follow-up
// refers to ("why that value?", "what changed?") instead of only the latest human line. Bounded to
// keep token cost flat on long threads. System messages are dropped (the classifier has its own).
function recentMessages(state: IacStateType, limit = 8): BaseMessage[] {
	return state.messages.filter((m) => m?.getType() !== "system").slice(-limit);
}

function findTool(name: string): StructuredToolInterface | undefined {
	return getToolsForDataSource(AGENT).find((t) => t.name === name);
}

// Best-effort single-tool call. Returns a placeholder when the unified server (and
// therefore the tool) is not connected so the graph degrades instead of throwing.
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
	const tool = findTool(name);
	if (!tool) return `[${name} unavailable - elastic-iac server not connected]`;
	try {
		const res = await tool.invoke(args);
		return typeof res === "string" ? res : JSON.stringify(res);
	} catch (err) {
		return `[${name} error: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

// SIO-1003: the instruction-string fragment listing the legal workflow values, e.g.
// "'tier-resize'|'ilm-rollout'|...", built from the same WORKFLOW_VALUES (imported from state.ts) that
// the zod enum uses -- so the planner instruction can never drift from what the parser accepts.
export const WORKFLOW_ENUM_PROSE = WORKFLOW_VALUES.map((w) => `'${w}'`).join("|");

// The planner commonly emits explicit `null` for absent optional fields; z.optional()
// rejects null and would silently fail the whole parse (-> the clarify fallback), so
// every optional field is .nullish() and nulls are normalized to undefined below.
const IntentSchema = z.object({
	workflow: z.enum(WORKFLOW_VALUES).default("other"),
	cluster: z.string().nullish(),
	tier: z.string().nullish(),
	resource: z.string().nullish(),
	newSizeGb: z.number().nullish(),
	newMaxGb: z.number().nullish(),
	policyName: z.string().nullish(),
	sourcePolicy: z.string().nullish(),
	phasesPatch: z.record(z.string(), z.unknown()).nullish(),
	// SIO-932: multiple ILM policy files in one request. Each entry mirrors the singular
	// policyName/phasesPatch/sourcePolicy. parseIntentJson folds a 0/1-entry array back to the
	// singular fields so the single-policy path (and its tests) are unchanged.
	ilmPolicies: z
		.array(
			z.object({
				policyName: z.string(),
				phasesPatch: z.record(z.string(), z.unknown()).nullish(),
				sourcePolicy: z.string().nullish(),
				// SIO-1011: per-entry authoritative full body, the multi-file analogue of the singular
				// ilmFullPolicy -- lets a >=2 NEW-policy onboard (full bodies, "do not copy") parse.
				ilmFullPolicy: z.record(z.string(), z.unknown()).nullish(),
			}),
		)
		.nullish(),
	// SIO-1001: the AUTHORITATIVE complete policy body for a from-scratch onboard (the user pasted
	// the whole `{ name, hot, delete }` and said "exactly these keys"). Used verbatim as the file
	// instead of deep-merging a partial patch onto a sibling/canonical base, so absent phases stay
	// absent. Distinct from phasesPatch (partial overlay) and sourcePolicy (copy a sibling).
	ilmFullPolicy: z.record(z.string(), z.unknown()).nullish(),
	version: z.string().nullish(),
	integration: z.string().nullish(),
	integrationVersion: z.string().nullish(),
	force: z.boolean().nullish(),
	// SIO-1032: fleet-upgrade host scoping. selectedHostnames = the plain host list the user named
	// (the agent builds the KQL); fleetSelector = a raw KQL selector the user wrote (passthrough,
	// wins over the host list); expectedAgentCount = "must resolve to exactly N" gate-warning guard.
	selectedHostnames: z.array(z.string()).nullish(),
	fleetSelector: z.string().nullish(),
	expectedAgentCount: z.number().nullish(),
	sloName: z.string().nullish(),
	sloTarget: z.number().nullish(),
	sloWindow: z.string().nullish(),
	sloTags: z.array(z.string()).nullish(),
	ruleName: z.string().nullish(),
	alertThreshold: z.number().nullish(),
	alertWindowSize: z.number().nullish(),
	alertWindowUnit: z.string().nullish(),
	alertEnabled: z.boolean().nullish(),
	alertInterval: z.string().nullish(),
	dataviewName: z.string().nullish(),
	runtimeFieldName: z.string().nullish(),
	runtimeFieldType: z.string().nullish(),
	runtimeFieldScript: z.string().nullish(),
	dataviewTitle: z.string().nullish(),
	dataviewDisplayName: z.string().nullish(),
	templateName: z.string().nullish(),
	totalShardsPerNode: z.number().nullish(),
	// SIO-979: freeform cluster-defaults index settings patch (relative to settings.index, e.g.
	// `{ refresh_interval: "30s" }`). Any index setting -- validity is enforced by CI's terraform
	// plan, not a closed field list. Mirrors phasesPatch. clusterDefaults[] is the multi-file form
	// (one MR over several templates), mirroring ilmPolicies[].
	settingsPatch: z.record(z.string(), z.unknown()).nullish(),
	clusterDefaults: z
		.array(
			z.object({
				templateName: z.string(),
				settingsPatch: z.record(z.string(), z.unknown()),
			}),
		)
		.nullish(),
	// SIO-1022: cluster-default-delete -- one or more cluster-defaults override files to REMOVE
	// (delete the whole file, not edit its settings). templateName is the file basename VERBATIM.
	clusterDefaultDeletes: z.array(z.object({ templateName: z.string() })).nullish(),
	// SIO-1037: ilm-delete -- one or more ILM policy files to REMOVE (delete the whole file, not edit
	// its phases). policyName is the file basename VERBATIM, INCLUDING any leading dot.
	ilmDeletes: z.array(z.object({ policyName: z.string() })).nullish(),
	// SIO-994: cluster-settings-edit flat dotted-key patches for the persistent/transient blocks.
	persistentPatch: z.record(z.string(), z.unknown()).nullish(),
	transientPatch: z.record(z.string(), z.unknown()).nullish(),
	// SIO-996: cluster-settings-edit key REMOVAL -- dotted names to delete (revert), NOT set to null.
	removeKeysPersistent: z.array(z.string()).nullish(),
	removeKeysTransient: z.array(z.string()).nullish(),
	// SIO-933: ilm-rollout optional component-template bind (cluster-defaults file basename, no .json).
	bindTemplate: z.string().nullish(),
	spaceName: z.string().nullish(),
	spaceDisplayName: z.string().nullish(),
	spaceDescription: z.string().nullish(),
	spaceColor: z.string().nullish(),
	roleName: z.string().nullish(),
	grantCluster: z.array(z.string()).nullish(),
	grantIndexNames: z.array(z.string()).nullish(),
	grantIndexPrivileges: z.array(z.string()).nullish(),
	grantKibanaApplication: z.string().nullish(),
	grantKibanaPrivileges: z.array(z.string()).nullish(),
	autoscaleEnabled: z.boolean().nullish(),
	topologyTier: z.string().nullish(),
	tierZoneCount: z.number().nullish(),
	tierAutoscale: z.boolean().nullish(),
	userSettingsTarget: z.enum(["elasticsearch_config", "kibana"]).nullish(),
	userSettingsYaml: z.string().nullish(),
	// SIO-997: surgical single-key merge into the existing user_settings_yaml (non-SSO settings).
	userSettingsMergeTarget: z.enum(["elasticsearch_config", "kibana"]).nullish(),
	userSettingsMergeKey: z.string().nullish(),
	userSettingsMergeValue: z.string().nullish(),
	// SIO-999: surgical key REMOVAL from the existing user_settings_yaml (mirrors removeKeysPersistent).
	userSettingsRemoveKeys: z.array(z.string()).nullish(),
	sizeComponent: z.enum(["integrations_server", "kibana"]).nullish(),
	componentSize: z.string().nullish(),
	componentZoneCount: z.number().nullish(),
	dashboardSpace: z.string().nullish(),
	dashboardName: z.string().nullish(),
	dashboardNdjson: z.string().nullish(),
	dashboardAction: z.enum(["add", "replace", "delete"]).nullish(),
	// SIO-978: index-template-create -- one or more NEW index templates committed to ONE MR.
	indexTemplates: z
		.array(
			z.object({
				name: z.string(),
				indexPatterns: z.array(z.string()),
				composedOf: z.array(z.string()).nullish(),
				ignoreMissingComponentTemplates: z.array(z.string()).nullish(),
				priority: z.number().nullish(),
				lifecycleName: z.string().nullish(),
				dataStreamHidden: z.boolean().nullish(),
				dataStreamAllowCustomRouting: z.boolean().nullish(),
			}),
		)
		.nullish(),
	// SIO-1019: ingest-pipeline-create -- one or more NEW @custom ingest-pipeline files committed to ONE
	// MR. body is the COMPLETE pipeline document (name + processors) written VERBATIM, so it is an opaque
	// object (two-arg z.record, matching phasesPatch/settingsPatch). Always an array (no singular form).
	ingestPipelines: z.array(z.object({ name: z.string(), body: z.record(z.string(), z.unknown()) })).nullish(),
	// SIO-1024: ingest-pipeline-edit -- one or more EXISTING @custom ingest-pipeline files whose body is
	// REPLACED in ONE MR. Same shape as ingestPipelines, but `name` is the FILE BASENAME from the path the
	// user names (not the body's name field). body is the COMPLETE replacement document, written VERBATIM.
	ingestPipelineEdits: z.array(z.object({ name: z.string(), body: z.record(z.string(), z.unknown()) })).nullish(),
	reason: z.string().nullish(),
	isProd: z.boolean().default(false),
	clarification: z.string().nullish(),
});

// Extract the planner's JSON object into a validated IacRequest, falling back to a
// safe clarify-default on malformed output. (Exported for unit testing.)
export function parseIntentJson(raw: string): IacRequest {
	const match = raw.match(/\{[\s\S]*\}/);
	if (match) {
		try {
			const parsed = IntentSchema.safeParse(JSON.parse(match[0]));
			if (parsed.success) {
				const p = parsed.data;
				// Normalize the planner's explicit nulls to undefined for the IacRequest shape.
				const nn = <T>(v: T | null | undefined): T | undefined => v ?? undefined;
				// SIO-932: the ilm template ends in `${policy}.json`, so policyName must be the basename
				// WITHOUT the extension. Users naturally name the file with it ("set X in metrics.json"),
				// and the planner echoes it verbatim -> a doubled `metrics.json.json` path that 404s and
				// onboards a bogus policy. Strip a single trailing `.json` defensively (covers both the
				// singular path and every ilmPolicies entry). A policy literally named with a trailing
				// ".json" segment is not a real ILM policy filename, so this is always safe.
				const stripJsonExt = (v: string | undefined): string | undefined =>
					v === undefined ? undefined : v.replace(/\.json$/i, "");
				// SIO-932: fold the ilmPolicies array. >=2 entries -> keep the array and leave the
				// singular policyName/phasesPatch/sourcePolicy as the planner set them (draftChange
				// dispatches on ilmPolicies.length). 0/1 entries -> drop the array and let the single
				// entry's fields populate the singular path (back-compat: a 1-file request behaves
				// exactly as before). Entries are mapped to undefined-normalized phasesPatch/sourcePolicy.
				const ilmEntries = (nn(p.ilmPolicies) ?? []).map((e) => ({
					policyName: stripJsonExt(e.policyName) ?? e.policyName,
					phasesPatch: nn(e.phasesPatch),
					sourcePolicy: stripJsonExt(nn(e.sourcePolicy)),
					// SIO-1011: preserve the per-entry authoritative body through the fold so a multi-file
					// from-scratch onboard reaches proposeIlmChanges with each full body intact.
					ilmFullPolicy: nn(e.ilmFullPolicy),
				}));
				const multiIlm = ilmEntries.length >= 2;
				const soleIlm = ilmEntries.length === 1 ? ilmEntries[0] : undefined;
				// SIO-979: fold the clusterDefaults array exactly like ilmPolicies. The cluster-defaults
				// template ends in `${template}.json`, so strip a trailing .json from the basename (the
				// planner echoes "metrics.json" -> a doubled metrics.json.json path that 404s). >=2 entries
				// keep the array (proposer commits all files atomically); 0/1 fold to the singular
				// templateName + settingsPatch (back-compat with the single-file path).
				const cdEntries = (nn(p.clusterDefaults) ?? []).map((e) => ({
					templateName: stripJsonExt(e.templateName) ?? e.templateName,
					settingsPatch: e.settingsPatch,
				}));
				const multiCd = cdEntries.length >= 2;
				const soleCd = cdEntries.length === 1 ? cdEntries[0] : undefined;
				// SIO-1022: cluster-default-delete entries -- strip a trailing .json from each basename
				// (the planner may echo "logs-elasticsearch.querylog@settings.json"); the @custom-style
				// suffix is part of the basename and is preserved. Always an array (no singular fold).
				const cdDeletes = (nn(p.clusterDefaultDeletes) ?? []).map((e) => ({
					templateName: stripJsonExt(e.templateName) ?? e.templateName,
				}));
				// SIO-1037: ilm-delete entries -- strip only a trailing .json from each basename (the
				// planner may echo ".alerts-ilm-policy.json"); a LEADING dot is part of the basename and
				// is preserved (stripJsonExt only touches the trailing extension). Always an array.
				const ilmDeletes = (nn(p.ilmDeletes) ?? []).map((e) => ({
					policyName: stripJsonExt(e.policyName) ?? e.policyName,
				}));
				// SIO-932: only strip .json for the ilm-rollout workflow; other workflows' name fields
				// (sloName, ruleName, dataviewName, ...) are basenames the planner already gives bare,
				// and a couple legitimately could carry other meanings.
				const isIlm = p.workflow === "ilm-rollout";
				return {
					workflow: p.workflow,
					isProd: p.isProd,
					cluster: nn(p.cluster),
					tier: nn(p.tier),
					resource: nn(p.resource),
					newSizeGb: nn(p.newSizeGb),
					newMaxGb: nn(p.newMaxGb),
					policyName: soleIlm?.policyName ?? (isIlm ? stripJsonExt(nn(p.policyName)) : nn(p.policyName)),
					sourcePolicy: soleIlm?.sourcePolicy ?? (isIlm ? stripJsonExt(nn(p.sourcePolicy)) : nn(p.sourcePolicy)),
					phasesPatch: soleIlm?.phasesPatch ?? nn(p.phasesPatch),
					ilmPolicies: multiIlm ? ilmEntries : undefined,
					// SIO-1001: authoritative full-body onboard for the singular path. SIO-1011: a 1-entry
					// array folds to the singular path, so carry that sole entry's full body too (the multi-
					// file path keeps its own per-entry ilmFullPolicy on ilmEntries when multiIlm).
					ilmFullPolicy: multiIlm ? undefined : (soleIlm?.ilmFullPolicy ?? nn(p.ilmFullPolicy)),
					version: nn(p.version),
					integration: nn(p.integration),
					integrationVersion: nn(p.integrationVersion),
					force: nn(p.force),
					// SIO-1032: fleet-upgrade host scoping + count guard (all optional; absent = unscoped).
					selectedHostnames: nn(p.selectedHostnames),
					fleetSelector: nn(p.fleetSelector),
					expectedAgentCount: nn(p.expectedAgentCount),
					sloName: nn(p.sloName),
					sloTarget: nn(p.sloTarget),
					sloWindow: nn(p.sloWindow),
					sloTags: nn(p.sloTags),
					ruleName: nn(p.ruleName),
					alertThreshold: nn(p.alertThreshold),
					alertWindowSize: nn(p.alertWindowSize),
					alertWindowUnit: nn(p.alertWindowUnit),
					alertEnabled: nn(p.alertEnabled),
					alertInterval: nn(p.alertInterval),
					dataviewName: nn(p.dataviewName),
					runtimeFieldName: nn(p.runtimeFieldName),
					runtimeFieldType: nn(p.runtimeFieldType),
					runtimeFieldScript: nn(p.runtimeFieldScript),
					dataviewTitle: nn(p.dataviewTitle),
					dataviewDisplayName: nn(p.dataviewDisplayName),
					templateName: soleCd?.templateName ?? nn(p.templateName),
					totalShardsPerNode: nn(p.totalShardsPerNode),
					// SIO-979: a single clusterDefaults entry folds its patch into the singular field.
					settingsPatch: soleCd?.settingsPatch ?? nn(p.settingsPatch),
					clusterDefaults: multiCd ? cdEntries : undefined,
					// SIO-1022: cluster-default-delete -- the files to remove (always an array).
					clusterDefaultDeletes: cdDeletes.length > 0 ? cdDeletes : undefined,
					// SIO-1037: ilm-delete -- the ILM policy files to remove (always an array).
					ilmDeletes: ilmDeletes.length > 0 ? ilmDeletes : undefined,
					// SIO-994: cluster-settings-edit persistent/transient patches.
					persistentPatch: nn(p.persistentPatch),
					transientPatch: nn(p.transientPatch),
					// SIO-996: cluster-settings-edit key removals (revert), per block.
					removeKeysPersistent: nn(p.removeKeysPersistent),
					removeKeysTransient: nn(p.removeKeysTransient),
					// SIO-933: bindTemplate is a cluster-defaults file basename; users write it with .json
					// ("bind logs-generic.otel.json"), so strip a trailing .json for ilm-rollout (mirrors
					// policyName/sourcePolicy). The @custom suffix lives in the file's `name`, NOT the
					// basename, so it is never stripped.
					bindTemplate: isIlm ? stripJsonExt(nn(p.bindTemplate)) : nn(p.bindTemplate),
					spaceName: nn(p.spaceName),
					spaceDisplayName: nn(p.spaceDisplayName),
					spaceDescription: nn(p.spaceDescription),
					spaceColor: nn(p.spaceColor),
					roleName: nn(p.roleName),
					grantCluster: nn(p.grantCluster),
					grantIndexNames: nn(p.grantIndexNames),
					grantIndexPrivileges: nn(p.grantIndexPrivileges),
					grantKibanaApplication: nn(p.grantKibanaApplication),
					grantKibanaPrivileges: nn(p.grantKibanaPrivileges),
					autoscaleEnabled: nn(p.autoscaleEnabled),
					topologyTier: nn(p.topologyTier),
					tierZoneCount: nn(p.tierZoneCount),
					tierAutoscale: nn(p.tierAutoscale),
					userSettingsTarget: nn(p.userSettingsTarget),
					userSettingsYaml: nn(p.userSettingsYaml),
					// SIO-997: surgical user_settings_yaml key merge (non-SSO).
					userSettingsMergeTarget: nn(p.userSettingsMergeTarget),
					userSettingsMergeKey: nn(p.userSettingsMergeKey),
					userSettingsMergeValue: nn(p.userSettingsMergeValue),
					// SIO-999: surgical user_settings_yaml key removal.
					userSettingsRemoveKeys: nn(p.userSettingsRemoveKeys),
					sizeComponent: nn(p.sizeComponent),
					componentSize: nn(p.componentSize),
					componentZoneCount: nn(p.componentZoneCount),
					dashboardSpace: nn(p.dashboardSpace),
					dashboardName: nn(p.dashboardName),
					dashboardNdjson: nn(p.dashboardNdjson),
					dashboardAction: nn(p.dashboardAction),
					// SIO-978: normalize each index-template entry's nullish fields to undefined.
					indexTemplates: nn(p.indexTemplates)?.map((e) => ({
						name: e.name,
						indexPatterns: e.indexPatterns,
						composedOf: nn(e.composedOf),
						ignoreMissingComponentTemplates: nn(e.ignoreMissingComponentTemplates),
						priority: nn(e.priority),
						lifecycleName: nn(e.lifecycleName),
						dataStreamHidden: nn(e.dataStreamHidden),
						dataStreamAllowCustomRouting: nn(e.dataStreamAllowCustomRouting),
					})),
					// SIO-1019: ingest-pipeline file basename WITHOUT .json (the path template ends in
					// `${name}.json`; users naturally write "logs-cisco_ftd.log@custom.json" -> stripping
					// avoids a doubled `.json.json` path, mirroring the ILM/cluster-defaults strip). body is
					// the verbatim pipeline document, carried opaque.
					ingestPipelines: nn(p.ingestPipelines)?.map((e) => ({
						name: stripJsonExt(e.name) ?? e.name,
						body: e.body,
					})),
					// SIO-1024: ingest-pipeline-edit -- same .json strip as the create fold. `name` is the file
					// basename from the path the user named (the planner is told to use the path basename, not
					// the body's name field), so the edit proposer reads the EXISTING file at that exact path.
					ingestPipelineEdits: nn(p.ingestPipelineEdits)?.map((e) => ({
						name: stripJsonExt(e.name) ?? e.name,
						body: e.body,
					})),
					reason: nn(p.reason),
					clarification: nn(p.clarification),
				};
			}
		} catch {
			// fall through to the safe default below
		}
	}
	return { workflow: "other", isProd: false, clarification: "Which cluster and what change should I make?" };
}

// SIO-912: the agent is a propose-only GitOps maker -- it edits config and opens an MR;
// CI computes the plan and a human merges/applies (deck slide 18 "Agent proposes, GitOps
// disposes"). A request that resolves to workflow "other" is one this maker has no proposer
// for yet (e.g. a Fleet agent BINARY upgrade, which is an imperative Fleet API call, not a
// Terraform config edit -- SIO-913). It must NOT fall through to the legacy local-terraform
// path; instead we surface what the maker can do today. Returns the user-facing message.
// (Pure; unit-tested.)
export function capabilityMessage(): string {
	return (
		"I can't make that change yet. I'm an Elastic Cloud IaC *config* maker: I edit the deployment " +
		"configuration and open a GitLab merge request for your review -- CI computes the Terraform plan " +
		"on the MR and a human merges and applies. I never run Terraform myself.\n\n" +
		"Today I can propose:\n" +
		'- **Version upgrades** -- e.g. "upgrade ap-cld to 9.4.2"\n' +
		'- **Tier resizes** -- e.g. "downsize eu-b2b warm to 8 GB"\n' +
		'- **ILM lifecycle changes** -- e.g. "set us-cld 30-day retention to 60 days"\n' +
		'- **ILM policy removal** -- delete a whole ILM policy FILE, e.g. "remove the duplicate .alerts-ilm-policy.json on eu-b2b" (opens a delete MR; I report whether the plan is a no-op cleanup or a destroy you must sign off before merge)\n' +
		'- **Fleet integration version pins** -- e.g. "bump the aws integration on eu-cld to 6.15.0"\n' +
		'- **SLO target/window edits** -- e.g. "set the ds-authentication SLO target to 99.5% on ap-cld"\n' +
		'- **Alert rule edits** -- e.g. "raise the MarTech cart-failed alert threshold to 5 on eu-cld"\n' +
		'- **Data view edits** -- e.g. "add a service runtime field to the logs data view on us-cld"\n' +
		'- **Cluster-defaults edits** -- edit the index settings on a template, e.g. "set total_shards_per_node to 3 on the logs@custom template on ap-cld" or "bump refresh_interval to 30s on logs, metrics and traces-apm on eu-b2b" (any index setting; one MR can span several templates)\n' +
		'- **Cluster-defaults override removal** -- delete a whole cluster-defaults override FILE, e.g. "remove the logs-elasticsearch.querylog@settings override on eu-b2b" (opens a delete MR; I report whether the plan is a no-op cleanup or a destroy you must sign off before merge)\n' +
		'- **Cluster-settings edits** -- set, change, or REMOVE the cluster-level persistent/transient settings (the PUT _cluster/settings surface), e.g. "set xpack.monitoring.collection.interval to 60s on eu-b2b", "raise cluster.max_shards_per_node to 2000", or "remove xpack.monitoring.collection.interval from the persistent block on eu-b2b" (any cluster setting in environments/<dep>/cluster-settings/settings.json; distinct from per-template cluster-defaults)\n' +
		'- **Space edits** -- e.g. "change the developer-experience space description on eu-cld"\n' +
		'- **Security role privilege grants** -- e.g. "grant the developer role read on logs-* on eu-b2b" (HIGH risk; additive only)\n' +
		'- **Deployment topology** -- autoscale, a tier zone_count/autoscale, SSO user_settings_yaml, or integrations_server/kibana sizing; e.g. "turn on autoscaling for eu-onboarding", "set the hot tier zone_count to 3 on eu-b2b" (HIGH risk; single shared state, long apply; SSO edits can lock out login)\n' +
		'- **Dashboards** -- add or replace a whole Kibana dashboard NDJSON in a space; e.g. "add this dashboard to the developer-experience space on eu-b2b" (paste the Kibana export) (MEDIUM risk; whole-file only, no panel edits)\n' +
		'- **Index templates** -- add a high-priority index template so an index pattern lands on a short-retention ILM policy; e.g. "route dev/staging metrics and traces to their short-retention policies on eu-b2b" (new-file create; composes component templates + binds the ILM policy via the template settings)\n' +
		'- **Ingest pipelines** -- add a NEW @custom ingest pipeline, e.g. "create an ingest pipeline logs-cisco_ftd.log@custom that drops flow-expiration events on us-cld", or REPLACE the body of an EXISTING one, e.g. "replace the entire contents of environments/ap-cld/ingest-pipelines/drop-cisco-meraki-ip-session.json with exactly {...}" (paste the complete pipeline JSON; committed verbatim, one MR; the file must already exist for an edit)\n\n' +
		'A Fleet **agent binary** upgrade ("upgrade the agents to 9.4.2") is an imperative Fleet API ' +
		"action, not a Terraform config change, so it goes through a different path that isn't wired up " +
		"yet. The Fleet upgrade trigger is on the roadmap."
	);
}

// Map a raw classifier reply to an intent. "gitops", "pipeline-status", "synthetics-drift",
// "fleet-upgrade", and "drift" are explicit; anything else defaults to "info". (Pure; unit-tested.)
export function intentFromText(
	raw: string,
): "info" | "gitops" | "pipeline-status" | "drift" | "synthetics-drift" | "fleet-upgrade" | "converse" {
	const r = raw.toLowerCase();
	if (r.includes("pipeline-status") || r.includes("pipeline_status")) return "pipeline-status";
	// SIO-913: a Fleet agent BINARY upgrade (imperative bulk_upgrade) is distinct from a cluster
	// version-upgrade config edit. The classifier emits "fleet-upgrade"; this also catches direct
	// phrasings. Checked before synthetics/drift but it does not overlap their keywords.
	if (r.includes("fleet-upgrade") || r.includes("fleet_upgrade") || r.includes("fleet upgrade")) return "fleet-upgrade";
	// SIO-902: synthetics drift must be checked BEFORE plain drift -- a synthetics request also
	// contains "drift"/"reconcile" (e.g. "reconcile the synthetics monitors"), so "synthetic"
	// has to win the tiebreak.
	if (r.includes("synthetic") || r.includes("synthetics-drift") || r.includes("monitor drift") || r.includes("uptime"))
		return "synthetics-drift";
	// SIO-882: "drift" enters the drift-detection + per-stack reconcile sub-flow.
	if (r.includes("drift") || r.includes("reconcile")) return "drift";
	if (r.includes("gitops")) return "gitops";
	// SIO-930: conversational follow-up about the agent's own prior answer.
	if (r.includes("converse")) return "converse";
	return "info";
}

// SIO-928: is this follow-up a status check on an already-dispatched fleet apply (NOT a fresh
// upgrade)? Used by classifyIacIntent as a deterministic guard: a fleet binary apply has no MR, so
// the LLM's MR-scoped "pipeline-status" never fired for "how is the rollout?"-style messages and they
// fell through to info. We only call this when a pipeline is already in flight, so the bar is just
// "does this look like a progress/status question rather than a new upgrade". A message that names a
// target version (e.g. "...to 9.4.2") is a NEW upgrade and must NOT be swallowed as a status check.
export function looksLikeFleetStatusCheck(text: string): boolean {
	const r = text.toLowerCase();
	// A fresh upgrade names a version (X.Y or X.Y.Z) -- never treat that as a status check.
	if (/\b\d+\.\d+(\.\d+)?\b/.test(r)) return false;
	const STATUS_CUES = [
		"how is",
		"how's",
		"hows",
		"how are",
		"how far",
		"status",
		"progress",
		"check on",
		"check it",
		"watch the pipeline",
		"watch it",
		"going",
		"done yet",
		"is it done",
		"finished",
		"complete",
		"any update",
		"update on",
		"still running",
		"rollout",
	];
	return STATUS_CUES.some((cue) => r.includes(cue));
}

// SIO-983: is this an explicit imperative request to OPEN THE MR / MAKE THE CHANGE? After a proposal
// is rejected, the user often re-asks as a reaction to the rejected proposal ("no, follow my prompt
// and open the MR") and the classifier LLM mis-emits "converse" -- routing to the read-only
// converseIac node, which cannot open an MR. classifyIacIntent calls this as a deterministic guard
// (mirrors looksLikeFleetStatusCheck) to force the gitops lane regardless of LLM judgment. An
// INTERROGATIVE framing ("why didn't you open the mr?") is a question, not an imperative, so a
// leading question word disqualifies the match. (Pure; unit-tested.)
export function looksLikeChangeRequest(text: string): boolean {
	const r = text.toLowerCase().trim();
	// A question about the change (not an imperative to make it) stays on the conversational path.
	if (
		/^(why|what|how|when|where|who|did|didn't|do|does|can|can't|could|couldn't|should|would|is|are|was|were)\b/.test(r)
	)
		return false;
	const CUES = [
		"create the mr",
		"open the mr",
		"open an mr",
		"open a mr",
		"raise the mr",
		"raise an mr",
		"create the merge request",
		"open the merge request",
		"open an merge request",
		"open a merge request",
		"raise the merge request",
		"make the change",
		"make that change",
		"apply the change",
		"go ahead and open",
		"go ahead and create",
		"create the branch and",
	];
	return CUES.some((cue) => r.includes(cue));
}

// SIO-990: does this message correct / adjust the change the agent just proposed this session
// (so the amend lane should re-commit onto the SAME branch instead of proposing from scratch)?
// Only meaningful when an activeChange already exists (the caller gates on that). Matches short
// adjust/objection phrasings and bare proceed/confirm cues; deliberately NOT explicit fresh-MR
// imperatives (those are a new change -> looksLikeChangeRequest -> gitops). (Pure; unit-tested.)
export function looksLikeCorrection(text: string): boolean {
	const r = text.toLowerCase().trim();
	const CUES = [
		"do as instructed",
		"as instructed",
		"follow my prompt",
		"follow the prompt",
		"use the prompt",
		"is wrong",
		"that's wrong",
		"thats wrong",
		"is incorrect",
		"should be",
		"change it to",
		"change that to",
		"make it",
		"set it to",
		"instead of",
		"not ",
		"actually",
		"correction",
		"fix it",
		"fix that",
		"redo",
		"amend",
		"update the mr",
		"update the change",
		"adjust",
	];
	// Bare confirmations after a proposal ("proceed", "go ahead", "yes do it") also re-enter the
	// active change rather than starting a new one. Matched as whole words to avoid false hits.
	const PROCEED = /^(proceed|go ahead|yes,? do it|do it|confirm|continue|carry on)\b/.test(r);
	return PROCEED || CUES.some((cue) => r.includes(cue));
}

// SIO-982: does the user want watchPipeline to keep polling until the pipeline reaches a terminal
// status (vs the default one-shot bounded poll)? A cold CI runner can take >90s, so "watch until
// done"/"wait for it to finish" extends the poll budget for THIS call only. (Pure; unit-tested.)
function looksLikeWatchUntilDone(text: string): boolean {
	const r = text.toLowerCase();
	const CUES = [
		"until done",
		"until it's done",
		"until its done",
		"until complete",
		"until it's complete",
		"until its complete",
		"until it finishes",
		"until finished",
		"to completion",
		"wait for it to finish",
		"wait for it to complete",
		"wait until it",
		"wait for the pipeline",
		"watch it finish",
		"watch to the end",
	];
	return CUES.some((cue) => r.includes(cue));
}

// SIO-982: resolve watchPipeline's poll budget for one call. Default (short) keeps the turn snappy;
// when the user asks to wait for completion it extends to the longer budget. (Pure; unit-tested.)
export function resolvePipelinePollBudgetMs(text: string, defaultMs: number, extendedMs: number): number {
	return looksLikeWatchUntilDone(text) ? extendedMs : defaultMs;
}

// SIO-984: pick watchPipeline's budget by HOW it was entered. Straight after openMr (isPostMr, the
// turn's intent is "gitops") it must poll to terminal so the card shows triggered->...->succeeded in
// one turn -- the cold-runner CI pipeline (~130s) outlasts the snappy default -- so use the extended
// budget unconditionally. A "check my MR" follow-up (pipeline-status) stays snappy and only extends
// on "watch until done". (Pure; unit-tested. The loop still returns early on a terminal status, so
// the extended budget is a ceiling, not a fixed wait.)
export function resolveWatchPipelineBudgetMs(
	isPostMr: boolean,
	text: string,
	defaultMs: number,
	extendedMs: number,
): number {
	return isPostMr ? extendedMs : resolvePipelinePollBudgetMs(text, defaultMs, extendedMs);
}

// SIO-930: "converse" answers a follow-up ABOUT the agent's own prior answer, so it is only
// meaningful when there IS a prior turn. The classifier LLM can occasionally emit "converse" on a
// first message (mistaking a fresh question for a follow-up); coerce it back to the safe read-only
// "info" path in that case. This is the deterministic guard half of the converse gate (the LLM is
// still told converse exists). (Pure; unit-tested.)
export function coerceConverseIntent<T extends string>(intent: T, isFollowUp: boolean): T | "info" {
	if (intent === "converse" && !isFollowUp) return "info";
	return intent;
}

// Classify the request: read-only info, a gitops change, or a follow-up about in-flight work
// (an MR's pipeline/plan/approval, OR a dispatched fleet bulk_upgrade -- SIO-928). Ambiguous
// "should I…/recommend…" biases to gitops (HITL-gated, never applies).
export async function classifyIacIntent(state: IacStateType): Promise<Partial<IacStateType>> {
	const query = lastHumanText(state);
	// SIO-928: deterministic guard BEFORE the LLM. A dispatched fleet binary apply has no MR, so the
	// LLM's (MR-scoped) pipeline-status never fired for "how is the rollout?"-style follow-ups and they
	// fell through to info -> answerInfo, which cannot re-poll the live pipeline. When this thread has a
	// fleet apply in flight AND the message reads like a progress check (not a new upgrade), route
	// straight to pipeline-status -> watchPipeline -> checkFleetApplyStatus. Independent of LLM judgment.
	if (state.fleetApplyPipelineId != null && looksLikeFleetStatusCheck(query)) {
		log.info(
			{ query, fleetApplyPipelineId: state.fleetApplyPipelineId },
			"iac intent: fleet-status guard -> pipeline-status",
		);
		return { intent: "pipeline-status" };
	}
	// SIO-990: a CORRECTION to the change already proposed this session enters the amend lane, which
	// re-commits onto the SAME branch (updating the existing MR in place) instead of proposing from
	// scratch. Gated on an existing activeChange.branch so a first-turn message can never be an amend.
	// Pre-LLM and BEFORE looksLikeChangeRequest so "make it 14d" / "do as instructed" on a live draft
	// amends rather than cutting a new branch+MR. An explicit NEW-target change still reaches gitops
	// below when it doesn't read like a correction of the active change.
	if (state.activeChange?.branch && looksLikeCorrection(query)) {
		log.info(
			{ query, branch: state.activeChange.branch, mrIid: state.activeChange.mrIid ?? null },
			"iac intent: correction guard -> gitops-amend",
		);
		return { intent: "gitops-amend" };
	}
	// SIO-983: an explicit imperative MR/change request must enter the gitops proposal lane even on a
	// follow-up turn. Without this, a post-rejection "no, follow my prompt and open the MR" is often
	// classified "converse" by the LLM (it reads as a reaction to the rejected proposal) and routes to
	// the read-only converseIac node, which physically cannot open an MR. Deterministic, pre-LLM.
	if (looksLikeChangeRequest(query)) {
		log.info({ query }, "iac intent: change-request guard -> gitops");
		return { intent: "gitops" };
	}
	const llm = createLlm("iacClassifier", AGENT);
	const sys =
		"Classify the user's Elastic Cloud request into exactly one word:\n" +
		"- 'info': a read-only question answerable by reading state (versions, topology, plan history, " +
		"ILM, health, 'what is X running', 'list deployments', 'is X healthy').\n" +
		"- 'gitops': a request to CHANGE one specific thing (resize, downsize, add/modify ILM, upgrade a cluster/stack " +
		"VERSION, open an MR) -- a single targeted config edit. NOTE: 'upgrade eu-b2b to 9.4.2' (the DEPLOYMENT/cluster " +
		"version) is gitops, NOT fleet-upgrade.\n" +
		"- 'fleet-upgrade': upgrade the Fleet AGENT BINARIES (the elastic-agents enrolled on hosts) to a version -- " +
		"'upgrade the agents on X to 9.4.2', 'upgrade all Elastic agents for X', 'bulk-upgrade fleet agents'. This is an " +
		"imperative Fleet bulk_upgrade (NOT Terraform, NOT a cluster version change). The tell is the words 'agent(s)' " +
		"or 'fleet' being what is upgraded.\n" +
		"- 'drift': a request to DETECT or RECONCILE Terraform configuration drift for a deployment -- 'check X for drift', " +
		"'what has drifted', 'reconcile X with live', 'compare the repo with the live cluster', 'show drift by stack'. " +
		"This audits ALL Terraform stacks of one deployment and offers a per-stack reconcile choice.\n" +
		"- 'synthetics-drift': detect or push SYNTHETICS/UPTIME MONITOR drift between the source YAML and live Kibana " +
		"for a deployment -- 'check synthetics drift for X', 'are the monitors in sync', 'push monitors to Kibana', " +
		"'reconcile synthetics', 'check uptime monitors'. This compares source vs live Kibana monitors and offers an " +
		"operator-approved push (NOT a per-stack Terraform reconcile).\n" +
		"- 'pipeline-status': a follow-up about work the agent already kicked off -- EITHER a merge request " +
		"it opened ('did the pipeline pass/fail', 'check my MR', 'show me the plan', 'is it approved', 'what's " +
		"the CI status') OR a Fleet agent bulk_upgrade it already dispatched ('how is the rollout', 'how's the " +
		"upgrade going', 'check on it', 'watch the pipeline', 'is the upgrade done', 'any progress on the agents'). " +
		"Use this for ANY 'how is it going / check on it / is it done' follow-up to an in-flight change, even with " +
		"no merge request.\n" +
		"- 'converse': a CONVERSATIONAL follow-up about the agent's OWN previous answer or proposal -- " +
		"asking why it did something, to explain or justify it, to critique it, or reacting to it -- NOT a " +
		"request to change infrastructure. Examples: 'why was that wrong?', 'explain that', 'what would you " +
		"change about that policy?', 'I don't think that config is complete'. If the user instead asks for a " +
		"NEW change (even right after a proposal), that is 'gitops', not 'converse'.\n" +
		"Reply with ONLY one word: 'info', 'gitops', 'fleet-upgrade', 'drift', 'synthetics-drift', 'pipeline-status', or 'converse'. " +
		"If the user asks for a recommendation or 'should I…' that implies a single change, answer 'gitops'.";
	// SIO-981: pass recent history (not just the latest line) so the LLM can recognise a follow-up
	// against the prior proposal it refers to. On a first turn this is just the one human message.
	const res = await llm.invoke([new SystemMessage(sys), ...recentMessages(state)]);
	// SIO-930/SIO-981: gate converse on a real follow-up turn. Derive that from the conversation (a
	// prior AIMessage exists) OR the UI flag, so a follow-up still routes to converse when the client
	// omits isFollowUp on a reload. The LLM can still mis-emit converse on a first message -> coerce.
	const isFollowUp = state.isFollowUp || hasPriorAgentTurn(state);
	const intent = coerceConverseIntent(intentFromText(String(res.content)), isFollowUp);
	// SIO-877: pipeline-status resolves even without a thread-local mrIid -- watchPipeline
	// falls back to the latest open agent MR (so "check my MR" survives a page reload).
	log.info({ intent, query, hasMr: state.mrIid !== null }, "classified IaC intent");
	return { intent };
}

// Verify the unified IaC server is connected before any user-facing action (hooks/bootstrap.md).
// SIO-960: on a FRESH session's first turn, proactively surface in-flight work (a dispatched
// fleet upgrade recovered from durable memory) so the user doesn't have to ask "how's it going?".
// Implements the hooks/bootstrap.md "Open in-flight items" startup line. Injects a SystemMessage
// SIO-1020: terminal short-circuit fields are checkpointed per-thread, but parseIntent/amendChange/
// draftChange route to END the moment either is truthy -- and those edges run BEFORE guardNode (which
// is the only node that clears blockedReason). So a prior turn's blockedReason/noopReason would
// short-circuit the next unrelated follow-up. Reset both at turn start (bootstrap runs first on every
// turn) so each turn re-derives its own terminal state. (guardNode still clears blockedReason mid-lane.)
const TURN_START_RESET = { blockedReason: "", noopReason: "" } as const;

// (context the turn's response weaves in), once per session, best-effort, never blocking.
export async function bootstrapIac(state: IacStateType, config?: RunnableConfig): Promise<Partial<IacStateType>> {
	// SIO-965: capture the checkpointer thread id for the knowledge-graph Session
	// node. It is only in the runnable config (configurable.thread_id), not the
	// state input; checkpointing it here on leg 1 makes it survive the resume leg.
	const threadId = typeof config?.configurable?.thread_id === "string" ? config.configurable.thread_id : "";

	const connected = getConnectedServers().includes(IAC_SERVER);
	if (!connected) {
		log.warn({ server: IAC_SERVER }, "elastic-iac server not connected");
		return {
			connected: false,
			...(threadId && { threadId }),
			messages: [
				new AIMessage(
					"The Elastic IaC server is not connected. Start mcp-server-elastic-iac (:9086) and set ELASTIC_IAC_MCP_URL, then retry.",
				),
			],
		};
	}

	// First turn of a fresh session iff the thread has no prior assistant turn yet.
	const firstTurn = !state.messages.some((m) => m.getType() === "ai");
	if (firstTurn) {
		// SIO-1005: opportunistically reconcile a small handful of recent proposed MRs to their true
		// terminal state BEFORE building the in-flight note, so a returning user sees current state
		// (applied/failed) rather than the stale "proposed". Bounded + best-effort so session start
		// stays fast; the Bun.cron sweep does the exhaustive pass. No-op unless agent-memory backend.
		try {
			// reconcileAll logs its own "reconcile sweep complete" summary (tagged source:"bootstrap").
			await reconcileAll({ source: "bootstrap", limit: 8 });
		} catch (error) {
			log.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"bootstrapIac reconcile failed; continuing",
			);
		}
		const note = await buildInFlightSessionNote();
		if (note) {
			log.info({ note }, "bootstrapIac: surfacing in-flight work at session start");
			return {
				connected: true,
				...TURN_START_RESET,
				...(threadId && { threadId }),
				messages: [new SystemMessage(note)],
			};
		}
	}
	return { connected: true, ...TURN_START_RESET, ...(threadId && { threadId }) };
}

// SIO-960: a one-line "you have work in flight" note from durable memory, or "" when
// nothing is in flight / recall is unavailable. Best-effort: never throws.
async function buildInFlightSessionNote(): Promise<string> {
	try {
		const items: string[] = [];
		// In-flight fleet binary upgrades (no MR; re-pollable imperative pipelines).
		const inFlight = await recallInFlightFleetUpgrades("elastic-iac");
		for (const u of inFlight) {
			const dep = u.deployment ?? "a deployment";
			const ver = u.version ? ` to ${u.version}` : "";
			const pid = u.pipelineId ? ` (pipeline #${u.pipelineId})` : "";
			items.push(`${dep} fleet upgrade${ver}${pid}`);
		}
		// SIO-990: the most recent gitops MR this agent opened (durable iac-change fact), so a fresh
		// thread after a clear/reload knows the MR exists and a "check my MR" resolves it without
		// asking "which MR?". One line; the live status is re-fetched on demand by watchPipeline.
		const lastChange = await recallLastIacChange();
		if (lastChange?.mrUrl) {
			const dep = lastChange.deployment ? `${lastChange.deployment} ` : "";
			const iid = lastChange.mrIid ? ` (MR !${lastChange.mrIid})` : "";
			items.push(`${dep}config change${iid} -> ${lastChange.mrUrl}`);
		}
		if (items.length === 0) return "";
		return (
			`In-flight / recent work from a previous session: ${items.join("; ")}. ` +
			"If relevant, tell the user and offer to check on it (ask you to 'check my MR' or the rollout)."
		);
	} catch {
		return "";
	}
}

// Translate the plain-English request into a structured IacRequest. Asks one direct
// clarifying question via interrupt when the cluster/change is ambiguous.
export async function parseIntent(state: IacStateType): Promise<Partial<IacStateType>> {
	const query = lastHumanText(state);
	const llm = createLlm("iacPlanner", AGENT);
	const sys = buildSystemPrompt(getAgentByName(AGENT));
	const instruction =
		"Extract the requested Elastic Cloud IaC change as a single strict JSON object with keys: " +
		// SIO-1003: built from WORKFLOW_VALUES so the instruction enum can never drift from the zod enum.
		`workflow (${WORKFLOW_ENUM_PROSE}), ` +
		"cluster, tier, " +
		"resource, newSizeGb, " +
		"newMaxGb, policyName, phasesPatch, ilmPolicies, ilmDeletes, version, integration, integrationVersion, force, " +
		"selectedHostnames, fleetSelector, expectedAgentCount, sloName, sloTarget, sloWindow, " +
		"sloTags, ruleName, alertThreshold, alertWindowSize, alertWindowUnit, alertEnabled, alertInterval, dataviewName, " +
		"runtimeFieldName, runtimeFieldType, runtimeFieldScript, dataviewTitle, dataviewDisplayName, templateName, " +
		"totalShardsPerNode, spaceName, spaceDisplayName, spaceDescription, spaceColor, roleName, grantCluster, " +
		"grantIndexNames, grantIndexPrivileges, grantKibanaApplication, grantKibanaPrivileges, autoscaleEnabled, " +
		"topologyTier, tierZoneCount, tierAutoscale, userSettingsTarget, userSettingsYaml, userSettingsMergeTarget, " +
		"userSettingsMergeKey, userSettingsMergeValue, userSettingsRemoveKeys, sizeComponent, componentSize, " +
		"componentZoneCount, dashboardSpace, dashboardName, dashboardNdjson, dashboardAction, indexTemplates, ingestPipelines, ingestPipelineEdits, reason, isProd (true only if " +
		"the user explicitly named a production " +
		"cluster), and clarification. " +
		"Extract `cluster` ONLY from the deployment the user names in this request; NEVER default to a cluster that " +
		"appears only in these instruction examples. If the user names no cluster, set clarification to ask which " +
		"deployment. " +
		"For an Elasticsearch version upgrade ('upgrade X to 9.4.2', 'bump Y to 8.15'), set workflow to " +
		"'version-upgrade', cluster to the named deployment, and version to the explicit target version string. " +
		"For a tier resize ('downsize eu-b2b warm to 8 GB', 'set ap-cld cold max to 8GB'), set workflow to " +
		"'tier-resize', cluster, tier (hot|warm|cold|frozen|...), and newSizeGb and/or newMaxGb as plain GB integers. " +
		"For an ILM lifecycle-policy change ('set us-cld 30-days retention to 60 days', 'forcemerge warm to 1 " +
		"segment on eu-cld logs', 'add a delete phase to .alerts-ilm-policy'), set workflow to 'ilm-rollout', cluster " +
		"to the named deployment, policyName to the policy filename VERBATIM (e.g. '30-days@lifecycle', 'logs@lifecycle', " +
		"'.alerts-ilm-policy'). If the user asks to COPY / clone / mirror / 'same as' / 'exact copy of' an existing " +
		"policy, set sourcePolicy to that reference policy's filename VERBATIM and put ONLY the explicit overrides (if " +
		"any) in phasesPatch. Otherwise set phasesPatch to the fields to change. " +
		"AUTHORITATIVE WHOLE-FILE onboard: if the user pastes a COMPLETE policy body (a JSON object with `name` and one " +
		"or more phase keys) AND wants exactly that shape -- tells used: 'onboard ... with ONLY these phases', 'exactly " +
		"these keys', 'the file must contain exactly ...', 'do NOT add warm/cold/frozen', 'do not copy <policy>' -- set " +
		"`ilmFullPolicy` to that object VERBATIM (the nested phase shape below) and leave phasesPatch AND sourcePolicy " +
		"null. ilmFullPolicy means 'write exactly these phases, nothing else': any phase the user omitted is intentionally " +
		"absent and MUST NOT be added. Use ilmFullPolicy ONLY for a from-scratch onboard where the user gave the full file; " +
		"for an edit to fields of an existing policy use phasesPatch, and for a copy use sourcePolicy. The TOP-LEVEL " +
		"ilmFullPolicy is a SINGLE-policy form -- do not set it AND a multi-entry ilmPolicies array. For onboarding " +
		"MORE THAN ONE new policy in one request, do NOT use the top-level ilmFullPolicy; put a per-file ilmFullPolicy on " +
		"each ilmPolicies entry instead (see below). " +
		"policyName is the policy file BASENAME WITHOUT the .json extension: 'metrics.json' -> policyName 'metrics', " +
		"'30-days@lifecycle.json' -> '30-days@lifecycle'. Never include the .json suffix. " +
		"If the user names MORE THAN ONE policy file in a single request (e.g. 'in metrics.json AND logs.json set warm " +
		"replicas to 0', 'on eu-b2b set X on policies A, B and C', 'onboard metricbeat AND elastic-cloud-logs with these " +
		"exact bodies'), DO NOT pick one and drop the rest: set `ilmPolicies` " +
		"to an ARRAY with one object per file -- each { policyName: '<basename, no .json>', phasesPatch: { ... same nested " +
		"shape ... } } (or sourcePolicy for a copy, or ilmFullPolicy for a from-scratch onboard) -- applying the requested " +
		"change to EACH named file, and leave the top-level policyName/phasesPatch/sourcePolicy/ilmFullPolicy null. Each " +
		"entry uses the SAME field rules as a single policy: ilmFullPolicy (the COMPLETE nested body VERBATIM) when the " +
		"user pasted the whole file and said 'exactly these keys' / 'do not copy'; phasesPatch for an edit; sourcePolicy " +
		"for a copy. All entries share the single top-level `cluster`. For a " +
		"SINGLE policy use the top-level policyName/phasesPatch (or ilmFullPolicy) and omit ilmPolicies. " +
		"phasesPatch uses the repo's NESTED phase shape (top-level keys hot|warm|cold|frozen|delete), matching the " +
		"existing policy JSON files EXACTLY -- e.g. " +
		'{ "hot": { "priority": 100, "max_age": "7d", "max_primary_shard_size": "10gb", "rollover": true }, ' +
		'"warm": { "min_age": "6h", "priority": 50, "allocate": { "number_of_replicas": 0 }, "forcemerge": ' +
		'{ "max_num_segments": 1 }, "shrink": { "number_of_shards": 1 } }, "cold": { "min_age": "2d", "priority": 25, ' +
		'"allocate": { "number_of_replicas": 0 } }, "frozen": { "min_age": "7d", "searchable_snapshot": ' +
		'{ "snapshot_repository": "found-snapshots", "force_merge_index": true } }, "delete": { "min_age": "60d", ' +
		'"delete_searchable_snapshot": true, "wait_for_snapshot": { "policy": "cloud-snapshot-policy" } } }. ' +
		"CRITICAL nesting rules (the module rejects the flat forms): use `priority` (a number on the phase), NEVER " +
		"`set_priority`; replicas go in `allocate: { number_of_replicas }`, never a bare number_of_replicas; use " +
		"nested `forcemerge: { max_num_segments }`, `shrink: { number_of_shards }`, `searchable_snapshot: " +
		"{ snapshot_repository, force_merge_index }`, and `wait_for_snapshot: { policy }` -- never the flattened " +
		"underscore forms. Durations are strings like '60d'; retention is delete.min_age. Patch ONLY the fields to " +
		"change for an existing policy; for a copy, prefer sourcePolicy over restating every field. " +
		"If the user ALSO asks to POINT / BIND / SET / ATTACH a component template (or index template / cluster-defaults " +
		"template) to the new or changed policy -- e.g. 'create logs@lifecycle and bind the logs-generic.otel template to " +
		"it', 'point the traces-generic.otel component template at this policy' -- set `bindTemplate` to that template file " +
		"BASENAME WITHOUT the .json extension and WITHOUT the '@custom' suffix (e.g. 'logs-generic.otel', " +
		"'traces-generic.otel'). This binds settings.index.lifecycle.name in that one template file to the policy, " +
		"committed in the SAME merge request. Set bindTemplate ONLY when the user explicitly asks to bind/point/attach a " +
		"template's lifecycle; a plain policy edit leaves it null. bindTemplate works with a SINGLE policy only -- if the " +
		"user names multiple policy files AND a bind, do NOT set bindTemplate. " +
		"To REMOVE/DELETE an ILM policy FILE entirely ('remove the duplicate .alerts-ilm-policy.json on eu-b2b', 'delete " +
		"the ILM policy file logs-old on us-cld', 'drop the .alerts-ilm-policy lifecycle policy file') -- removing the whole " +
		"file, NOT editing its phases -- set workflow to 'ilm-delete', cluster to the named deployment, and ilmDeletes to an " +
		"array of { policyName } where policyName is the ILM policy file basename VERBATIM, the part before .json, INCLUDING " +
		"any LEADING dot (e.g. '.alerts-ilm-policy'). One MR removes all listed files. This is DISTINCT from 'ilm-rollout' " +
		"(which edits a policy's phases in a file that stays): deletion drops the whole policy file (its Terraform for_each key). " +
		"For a Fleet INTEGRATION PACKAGE version pin ('bump the aws integration on eu-cld to 6.15.0', 'pin kafka to " +
		"1.28.0 on eu-cld', 'update the system integration package to 2.18.0') -- note this is the integration PACKAGE " +
		"version, NOT a Fleet AGENT binary upgrade and NOT a cluster version -- set workflow to 'fleet-integration', cluster " +
		"to the named deployment, integration to the integration alias key VERBATIM (e.g. 'aws', 'kafka', 'system', 'apm', " +
		"'elastic-defend'), integrationVersion to the explicit target package version string, and force to true ONLY if the " +
		"user explicitly asks to force/reinstall it. " +
		"For a Fleet AGENT BINARY upgrade ('upgrade the Fleet agents on eu-cld to 9.4.2', 'bulk-upgrade the agents on X') -- " +
		"upgrading the elastic-agent binaries enrolled on hosts, NOT an integration package and NOT a cluster version -- " +
		"set workflow to 'fleet-upgrade', cluster to the named deployment, and version to the target agent version string. " +
		"OPTIONAL host scoping (all three fields are optional; when the user names no hosts and no count, leave them null and " +
		"the upgrade covers all outdated agents): if the user NAMES specific hosts/agents and scopes to them ('upgrade ONLY " +
		"these agents: hostA, hostB, ...', 'scope to exactly these hosts', 'just hostA and hostB'), set selectedHostnames to " +
		"the array of host names VERBATIM (one string per host, preserving case). If the user instead pastes a RAW Fleet KQL " +
		"selector ('SELECTOR = local_metadata.host.hostname:(\"a\" or \"b\")', 'use this kuery: ...'), set fleetSelector to that " +
		"query string VERBATIM (do NOT also fill selectedHostnames). If the user states an EXPECTED COUNT the preview must " +
		"resolve to ('it must resolve to 25 agents', 'expect exactly 25', 'stop if it resolves to any other count'), set " +
		"expectedAgentCount to that integer. These scope ONLY the fleet-upgrade workflow; ignore them for every other workflow. " +
		"For an SLO change ('set the DS API Health SLO target to 99.5% on ap-cld', 'change the ap-cld ds-authentication SLO " +
		"window to 60 days') -- editing an EXISTING SLO's target/time-window/tags, NOT creating one -- set workflow to " +
		"'slo-edit', cluster to the named deployment, sloName to the SLO file basename VERBATIM (e.g. 'ds-authentication', " +
		"'cci-sftpgo'; the part before .json), sloTarget to the numeric target the user gave (a percent like 99.5 or a " +
		"fraction like 0.995 -- pass it as the user said it), sloWindow to a duration string ('60d', '90d') ONLY if they " +
		"change the window, and sloTags to the full new tag array ONLY if they change tags. Set at least one of sloTarget/" +
		"sloWindow/sloTags. " +
		"For an ALERT RULE change ('raise the MarTech Add-To-Wallet threshold to 5 on eu-cld', 'disable the cart-failed " +
		"alert on eu-cld', 'change the X rule window to 10 minutes') -- editing an EXISTING rule's threshold/window/enabled/" +
		"interval, NOT creating one -- set workflow to 'alerting-edit', cluster to the named deployment, ruleName to the " +
		"rule file basename VERBATIM (it is '<space>__<rule-name>', e.g. 'default__martech_add_to_wallet_transactions_" +
		"failed_status_prd'; if the user gives only a friendly name, construct the basename with the space prefix, " +
		"defaulting the space to 'default' when unstated), and the field(s) to change: alertThreshold (number), " +
		"alertWindowSize (number) + alertWindowUnit ('m'|'h'|'s'|'d'), alertEnabled (false to disable / silence the rule, " +
		"true to enable), alertInterval (a check-interval string like '5m'). Set at least one of those alert* fields. " +
		"For a DATA VIEW change ('add a service runtime field to the logs data view on us-cld', 'rename the logs data " +
		"view title to logs-*') -- editing an EXISTING data view, NOT creating one -- set workflow to 'dataview-edit', " +
		"cluster to the named deployment, dataviewName to the data-view file basename VERBATIM (e.g. 'logs', 'metrics'; the " +
		"part before .json). To add/replace a runtime field set runtimeFieldName, runtimeFieldType (default 'keyword'), and " +
		"runtimeFieldScript (the painless source, ONLY when the user gives a script). To change the index pattern set " +
		"dataviewTitle; to change the display name set dataviewDisplayName. Set at least one of those. " +
		"For a CLUSTER-DEFAULTS index-template change ('set total_shards_per_node to 3 on the logs@custom template on " +
		"ap-cld', 'bump refresh_interval to 30s on logs/metrics/traces-apm') -- editing the index SETTINGS of an EXISTING " +
		"template, NOT creating one -- set workflow to 'cluster-default-edit', cluster to the named deployment, and " +
		"templateName to the template file basename VERBATIM (e.g. 'logs', 'metrics', 'metrics-system.cpu'; the part " +
		"before .json, NOT the '@custom' suffix). Express the settings to change as settingsPatch, a JSON object RELATIVE " +
		'to settings.index (e.g. { "refresh_interval": "30s" }, or { "routing": { "allocation": ' +
		'{ "total_shards_per_node": 3 } } }); any index setting is allowed -- CI\'s terraform plan validates it. For the ' +
		"common total_shards_per_node case you MAY instead set totalShardsPerNode to the integer (back-compat). When the " +
		"user names SEVERAL templates with the SAME change ('refresh_interval 30s on logs, metrics AND traces-apm'), set " +
		"clusterDefaults to an array of { templateName, settingsPatch } -- one MR edits all of them. For a SINGLE template " +
		"use the top-level templateName + settingsPatch and OMIT clusterDefaults; use clusterDefaults ONLY for 2+ templates " +
		"(mirrors ilmPolicies for ILM). If the user instead " +
		"wants to bind a template's ILM lifecycle to a policy, that is 'ilm-rollout' with bindTemplate, NOT " +
		"cluster-default-edit. " +
		"To REMOVE/DELETE a cluster-defaults override FILE entirely ('remove the logs-elasticsearch.querylog@settings " +
		"override on eu-b2b', 'delete the cluster-defaults override file for X', 'revert/drop the X@settings override') -- " +
		"removing the whole file, NOT editing its settings -- set workflow to 'cluster-default-delete', cluster to the named " +
		"deployment, and clusterDefaultDeletes to an array of { templateName } where templateName is the override file " +
		"basename VERBATIM (e.g. 'logs-elasticsearch.querylog@settings'; the part before .json, INCLUDING any @settings/@custom " +
		"suffix that is part of the filename). One MR removes all listed files. This is DISTINCT from cluster-default-edit " +
		"(which edits settings.index in a file that stays): deletion drops the whole override file (its Terraform for_each key). " +
		"For a CLUSTER-SETTINGS change ('set xpack.monitoring.collection.interval to 60s on eu-b2b', 'raise " +
		"cluster.max_shards_per_node to 2000', 'set the high disk watermark to 90% on ap-cld', 'add/change a setting in the " +
		"persistent block of cluster-settings/settings.json') -- editing the CLUSTER-LEVEL persistent/transient settings (the " +
		"PUT _cluster/settings surface: keys like xpack.*, cluster.*, indices.breaker.*, search.*, cluster.routing.allocation.* " +
		"disk watermarks), which live in environments/<dep>/cluster-settings/settings.json -- set workflow to " +
		"'cluster-settings-edit', cluster to the named deployment, and persistentPatch (and/or transientPatch) to a FLAT JSON " +
		'object of dotted-key -> value (e.g. { "xpack.monitoring.collection.interval": "60s" }, { "cluster.max_shards_per_node": ' +
		'"2000" }). The keys are FLAT dotted strings, NOT nested objects. To REMOVE/revert a setting (\'remove ' +
		"xpack.monitoring.collection.interval from the persistent block', 'drop that setting', 'revert it') list the dotted key " +
		"name(s) in removeKeysPersistent (and/or removeKeysTransient), e.g. removeKeysPersistent: " +
		'["xpack.monitoring.collection.interval"]. NEVER express a removal by setting the key to null -- that writes a literal ' +
		"null into the file; use the removeKeys arrays. You MAY combine sets and removes in one request. This is DISTINCT from cluster-default-edit: " +
		"cluster-default-edit changes the index settings of ONE index TEMPLATE (settings.index on a cluster-defaults/<template>.json " +
		"file); cluster-settings-edit changes the WHOLE CLUSTER's persistent/transient settings (one settings.json per deployment). " +
		"If the user names a `persistent`/`transient` block or a cluster-level setting (xpack/cluster/indices.breaker/search/disk " +
		"watermark), it is cluster-settings-edit, NOT cluster-default-edit. " +
		"For a SPACE change ('rename the developer-experience space description on eu-cld', 'change the apps space color') " +
		"-- editing an EXISTING space's display name/description/color, NOT creating one -- set workflow to 'space-edit', " +
		"cluster to the named deployment, spaceName to the space file basename VERBATIM (e.g. 'developer-experience', " +
		"'apps'; the part before .json), and spaceDisplayName (the human name), spaceDescription, and/or spaceColor (a hex " +
		"like '#88B9A8'). Set at least one of those. " +
		"For a SECURITY ROLE privilege grant ('grant the developer role read on logs-*', 'give the X role the monitor " +
		"cluster privilege on eu-b2b') -- ADDING privileges to an EXISTING role, NOT creating a role or editing role " +
		"mappings or anything secret -- set workflow to 'security-edit', cluster to the named deployment, roleName to the " +
		"role name VERBATIM, and the grant: grantCluster (array of cluster privileges like ['monitor']), grantIndexNames " +
		"(array of index patterns like ['logs-*']) + grantIndexPrivileges (array like ['read','view_index_metadata']), " +
		"and/or grantKibanaApplication (e.g. 'kibana-.kibana') + grantKibanaPrivileges (array like ['feature_discover.read']). " +
		"Set at least one grant. NEVER include users, api_keys, or any secret. " +
		"For a DEPLOYMENT TOPOLOGY change ('turn on autoscaling for eu-onboarding', 'set the hot tier zone_count to 3 on " +
		"eu-b2b', 'disable autoscale on the warm tier of ap-cld') -- toggling autoscale or setting a tier's zone_count, NOT " +
		"a version upgrade (use version-upgrade) and NOT a tier size/max resize (use tier-resize) -- set workflow to " +
		"'topology-edit', cluster to the named deployment, autoscaleEnabled (true/false for the GLOBAL elasticsearch " +
		"autoscale toggle), and/or topologyTier (hot|warm|cold|frozen|master|ml|coordinating) with tierZoneCount (integer " +
		"1-3) and/or tierAutoscale (true/false for that tier). " +
		"topology-edit ALSO covers more surfaces of the same _deployments JSON. (a) user_settings_yaml -- the raw YAML the " +
		"EC orchestrator applies with OPERATOR privileges (so it can set operator-only keys the cluster-settings stack 403s " +
		"on, e.g. xpack.monitoring.collection.interval). There are THREE ways to edit it: " +
		"(a1) a SINGLE-KEY merge (PREFERRED for an operational setting like 'set xpack.monitoring.collection.interval to 60s " +
		"on eu-b2b via user_settings_yaml', 'add xpack.indices.recovery.max_bytes_per_sec ...') -- set userSettingsMergeTarget " +
		"('elasticsearch_config' for ES settings, 'kibana' for Kibana settings), userSettingsMergeKey to the FLAT dotted key " +
		"(e.g. 'xpack.monitoring.collection.interval'), and userSettingsMergeValue to the string value (e.g. '60s'). The agent " +
		"merges just that key in place and preserves every other subtree (incl. the xpack.security/OIDC SSO realm) " +
		"byte-for-byte -- you do NOT reproduce the existing YAML. (a2) a WHOLE-BLOCK replace -- ONLY when the user supplies a " +
		"complete new SSO/OIDC realm or Kibana auth-providers block to swap in -- set userSettingsTarget + userSettingsYaml to " +
		"the raw YAML string verbatim. Use (a1) for adding/changing one setting; use (a2) only to replace an entire SSO block. " +
		"(a3) a SINGLE-KEY REMOVAL (to REMOVE/revert an operational user_settings_yaml setting, e.g. 'remove the appended " +
		"monitoring.collection.interval' or 'drop the xpack.monitoring subtree on eu-b2b') -- set userSettingsMergeTarget " +
		"('elasticsearch_config'|'kibana') and list the FLAT dotted key name(s) in userSettingsRemoveKeys (e.g. " +
		"['monitoring.collection.interval'] or ['xpack.monitoring'] to drop the whole subtree). Do NOT set a value, do NOT " +
		"mention null -- the leaf (and any now-empty parent) is deleted; every sibling subtree (incl. xpack.security/OIDC) is " +
		"preserved byte-for-byte. Use (a3) to remove a key, (a1) to add/change one. " +
		"(a1), (a2), and (a3) are MUTUALLY EXCLUSIVE -- use EXACTLY ONE per request; never set the merge fields " +
		"(userSettingsMergeKey/Value) together with userSettingsRemoveKeys or userSettingsYaml. For the target block in " +
		"(a1) and (a3): a key under xpack.*/cluster.*/indices.*/search.* (an Elasticsearch setting) is 'elasticsearch_config'; " +
		"a Kibana setting (xpack.fleet, server.*, Kibana feature) is 'kibana'; when unstated, default to 'elasticsearch_config'. " +
		"And (b) component sizing -- to resize the integrations_server or kibana node, set " +
		"sizeComponent ('integrations_server'|'kibana') with componentSize (e.g. '2g') and/or componentZoneCount. Set at " +
		"least one topology field. NEVER propose deleting a deployment. " +
		"For a DASHBOARD change ('add this dashboard to the developer-experience space on eu-b2b', 'replace the kong " +
		"dashboard on eu-b2b' followed by a pasted Kibana export) -- adding or replacing a WHOLE Kibana dashboard NDJSON " +
		"saved-object export, NOT editing panels inside an existing one -- set workflow to 'dashboard-edit', cluster to the " +
		"named deployment, dashboardSpace to the Kibana space the dashboard belongs to (e.g. 'default', " +
		"'developer-experience'; it becomes the '<space>__' filename prefix and MUST be an existing space), dashboardName to " +
		"the dashboard file slug (the part after '<space>__' and before .ndjson, e.g. 'amazon_bedrock_token_usage'), " +
		"dashboardAction ('add' for a new file, 'replace' for an existing one; 'delete' is not supported yet), and " +
		"dashboardNdjson to the user-pasted/Kibana-exported NDJSON payload VERBATIM (newline-delimited; do NOT reformat, " +
		"re-indent, or wrap it -- pass the exact text). Take the NDJSON as an opaque multi-line string; never merge or " +
		"rewrite individual panels. " +
		"For an INDEX-TEMPLATE creation ('add an index template so dev/staging metrics route to the short-retention " +
		"policy', 'create a dev-staging-traces-ilm-override index template on eu-b2b', 'route metrics-*.dev-* and " +
		"metrics-*.stg-* to dev-staging-metrics') -- adding a NEW elasticstack_elasticsearch_index_template (NOT editing " +
		"an existing template, NOT a cluster-defaults total_shards_per_node change, NOT binding an existing component " +
		"template) -- set workflow to 'index-template-create', cluster to the named deployment, and indexTemplates to an " +
		"ARRAY with one object per template the user asks for (multiple templates commit to ONE merge request). Each entry: " +
		"name (the index-template resource name, e.g. 'dev-staging-metrics-ilm-override'), indexPatterns (array of patterns " +
		"like ['metrics-*.dev-*','metrics-*.stg-*']), composedOf (array of component-template names to compose, in order, " +
		"e.g. ['metrics@mappings','data-streams@mappings','metrics@settings','metrics@custom']), " +
		"ignoreMissingComponentTemplates (subset of composedOf that may be absent, e.g. ['metrics@custom']), priority (the " +
		"integer template priority, e.g. 350), lifecycleName (the ILM policy this template binds via its settings, e.g. " +
		"'dev-staging-metrics'), and the data-stream flags dataStreamHidden and dataStreamAllowCustomRouting (booleans; " +
		"default both false -- set dataStreamAllowCustomRouting true ONLY if the user explicitly asks for custom routing). " +
		"Pass the user's fields VERBATIM; do not invent component templates or add tsdb/time_series settings unless asked. " +
		"For an INGEST-PIPELINE creation ('create an ingest pipeline logs-cisco_ftd.log@custom.json on us-cld', 'add a " +
		"@custom ingest pipeline that drops flow-expiration events', 'add these two ingest-pipeline files') -- adding one " +
		"or more NEW @custom ingest-pipeline files (NOT editing an existing pipeline) -- set workflow to " +
		"'ingest-pipeline-create', cluster to the named deployment, and ingestPipelines to an ARRAY with one object per " +
		"pipeline file the user asks for (multiple files commit to ONE merge request). Each entry: name (the pipeline file " +
		"basename, e.g. 'logs-cisco_ftd.log@custom' -- the part before .json; keep the '@custom' suffix, it is part of the " +
		"name) and body (the COMPLETE pipeline document the user pasted, VERBATIM -- a JSON object with `name` and " +
		"`processors`). Pass body exactly as given: do NOT reshape, add, or drop processors, and do NOT invent a body the " +
		"user did not provide. " +
		"For an INGEST-PIPELINE EDIT ('replace the entire contents of environments/ap-cld/ingest-pipelines/" +
		"drop-cisco-meraki-ip-session.json with exactly {...}', 'update the existing ingest pipeline ... change the drop " +
		"processor's if', 'edit the @custom ingest pipeline on us-cld') -- REPLACING the body of one or more EXISTING " +
		"@custom ingest-pipeline files (the user names a file that already exists, or says replace/update/edit) -- set " +
		"workflow to 'ingest-pipeline-edit', cluster to the named deployment, and ingestPipelineEdits to an ARRAY with one " +
		"object per file (multiple files commit to ONE merge request). Each entry: name (the FILE BASENAME the user names " +
		"in the path -- e.g. for environments/ap-cld/ingest-pipelines/drop-cisco-meraki-ip-session.json the name is " +
		"'drop-cisco-meraki-ip-session', the part before .json; this is the FILENAME, which can DIFFER from the body's " +
		"`name` field, so use the path, NOT the body) and body (the COMPLETE replacement document the user pasted, " +
		"VERBATIM -- a JSON object). Pass body exactly as given: do NOT reshape, add, or drop processors. Choose " +
		"'ingest-pipeline-create' ONLY for a NEW file and 'ingest-pipeline-edit' when the file already exists or the user " +
		"says replace/update/edit. " +
		"Set clarification (a single direct question) ONLY when a required field is genuinely missing -- e.g. no " +
		"cluster named, an upgrade with no concrete target version ('upgrade to latest'), or a resize with no tier or " +
		"no size/max. Do NOT ask for information the user already provided. Respond with ONLY the JSON object.";

	// SIO-1001: when a deployment is already established this session, tell the planner so a terse
	// follow-up (a pasted policy body, "set it to 60d") inherits the cluster instead of re-asking.
	// Only added when known is non-empty, so a genuine first-turn no-cluster request still clarifies.
	const known = knownSessionDeployment(state);
	const sessionContext = known
		? `\n\nSession context: a deployment is already established for this conversation: '${known}'. ` +
			`If THIS message does not name a different cluster, set \`cluster\` to '${known}' and do NOT set a ` +
			`clarification asking which deployment. Only use a different cluster if the user explicitly names one ` +
			`in this message.`
		: "";
	const sysWithContext = `${sys}\n\n${instruction}${sessionContext}`;

	const res = await llm.invoke([new SystemMessage(sysWithContext), new HumanMessage(query)]);
	let request = parseIntentJson(String(res.content));

	// SIO-1001: belt-and-braces -- if the planner still left the cluster empty but this session
	// already targets a deployment, inherit it rather than interrupting to re-ask. Suppress ONLY a
	// missing-cluster clarification; clarifications about other missing fields (version, tier) stand.
	if (!request.cluster?.trim() && known) {
		request.cluster = known;
		if (request.clarification && isMissingClusterClarification(request.clarification)) {
			request.clarification = undefined;
		}
	}

	if (request.clarification) {
		const answer = interrupt({
			type: "iac_clarify",
			question: request.clarification,
			message: request.clarification,
		}) as { answer?: string };
		const reply = answer?.answer ?? "";
		const res2 = await llm.invoke([
			new SystemMessage(sysWithContext),
			new HumanMessage(query),
			new AIMessage(request.clarification),
			new HumanMessage(reply),
		]);
		request = { ...parseIntentJson(String(res2.content)), clarification: undefined };
		// SIO-1001: the user's clarification reply may itself omit the cluster ("yes, do it") -- keep
		// inheriting the established deployment on the re-parse too.
		if (!request.cluster?.trim() && known) request.cluster = known;
		// SIO-912: a re-parse that still lands on "other" has no proposer -- surface capabilities.
		if (request.workflow === "other") {
			return {
				iacRequest: request,
				blockedReason: "No proposer for this request (workflow 'other').",
				messages: [new HumanMessage(reply), new AIMessage(capabilityMessage())],
			};
		}
		return { iacRequest: request, messages: [new HumanMessage(reply)] };
	}

	// SIO-912: "other" is a request this config maker has no proposer for. Stop here with a
	// capability message instead of falling through to draftChange -> reviewPlan's dead
	// local-terraform branch (which shelled out to a `terraform` binary absent at runtime).
	if (request.workflow === "other") {
		return {
			iacRequest: request,
			blockedReason: "No proposer for this request (workflow 'other').",
			messages: [new AIMessage(capabilityMessage())],
		};
	}

	return { iacRequest: request };
}

// Read-only tools the info path may call. Binding only this subset means the LLM
// physically cannot reach git_create_branch / gitlab_create_merge_request etc.
const INFO_TOOL_NAMES = [
	"elastic_cloud_list_deployment_versions",
	"elastic_cloud_list_deployments",
	"elastic_cloud_get_deployment",
	"elastic_cloud_get_plan_history",
	"elastic_get_cluster_health",
	"elastic_get_index_template",
	"elastic_ilm_get_lifecycle",
] as const;

// SIO-967: the read path's knowledge-graph access now comes through the STANDARD MCP
// surface -- the curated kg_* tools served by the in-process knowledge-graph-mcp server
// (supersedes SIO-966's local createQueryKnowledgeGraphTool). They are read-only by
// construction, so the whole kg_* set is bound (no allowlist needed). Durable-memory
// recall stays a LOCAL tool (search_memory): agent memory is REST infrastructure, not
// MCP-exposed. Built per call (the memory tool closes over the agent name) -- cheap, and
// keeps infoTools() pure. Exported for tests: asserts kg_* + search_memory are bound.
export function infoTools(): StructuredToolInterface[] {
	const allowed = new Set<string>(INFO_TOOL_NAMES);
	const elasticReads = getToolsForDataSource(AGENT).filter((t) => allowed.has(t.name));
	const kgTools = getToolsForDataSource("knowledge-graph");
	return [...elasticReads, ...kgTools, createSearchMemoryTool(AGENT)];
}

// SIO-966: invoke a tool the LLM called, resolving it from the in-scope tools array
// (which holds BOTH MCP and local tools) -- callTool() only resolves MCP tools, so a
// name lookup there would miss the local query tools. Unknown names are rejected.
async function dispatchInfoToolCall(
	tools: StructuredToolInterface[],
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	const tool = tools.find((t) => t.name === name);
	if (!tool) return `[${name} is not an allowed read tool]`;
	try {
		const res = await tool.invoke(args);
		return typeof res === "string" ? res : JSON.stringify(res);
	} catch (err) {
		return `[${name} error: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

// Answer a read-only question via a bounded tool-calling loop over the read subset.
// Never drafts, never opens an MR -- this is the terminal node for info intent.
export async function answerInfo(state: IacStateType): Promise<Partial<IacStateType>> {
	const query = lastHumanText(state);
	const tools = infoTools();
	if (tools.length === 0) {
		return { messages: [new AIMessage("Elastic IaC read tools are unavailable; cannot answer right now.")] };
	}
	const llm = createLlmWithTools("iacReader", tools, AGENT);
	const sys =
		`${buildSystemPrompt(getAgentByName(AGENT))}\n\n` +
		"This is a READ-ONLY question. Use the elastic read tools to answer it precisely. " +
		"Never draft Terraform, never open an MR, never create a branch. Answer concisely with the facts.";
	const convo: BaseMessage[] = [new SystemMessage(sys), new HumanMessage(query)];

	const MAX_STEPS = 5;
	for (let step = 0; step < MAX_STEPS; step++) {
		const ai = (await llm.invoke(convo)) as AIMessage;
		convo.push(ai);
		const calls = ai.tool_calls ?? [];
		if (calls.length === 0) return { messages: [new AIMessage(String(ai.content))] };
		for (const call of calls) {
			const result = await dispatchInfoToolCall(tools, call.name, (call.args ?? {}) as Record<string, unknown>);
			convo.push(new ToolMessage({ content: result, tool_call_id: call.id ?? call.name }));
		}
	}
	// Step budget exhausted: one final no-tool synthesis of what was gathered.
	const final = await createLlm("iacReader", AGENT).invoke([
		...convo,
		new HumanMessage("Summarize the answer now using what you've gathered."),
	]);
	return { messages: [new AIMessage(String(final.content))] };
}

// SIO-930: conversational follow-up lane. Unlike every other IaC node (which reads only the latest
// human message via lastHumanText), this passes the FULL conversation history so it can explain or
// justify the agent's own prior answer -- mirroring the incident graph's responder.ts. Explain-only:
// it binds ONLY the read-only INFO_TOOL_NAMES subset (physically cannot draft/branch/open an MR). If
// the user wants a change made, it tells them to ask directly (which re-enters the gitops gate).
// Reuses the iacReader LLM role (same read-only bounded-loop semantics as answerInfo).
const CONVERSE_GUARDRAIL =
	"This is a conversational follow-up about your previous answer in the conversation above. Explain, " +
	"justify, or critique it directly and concisely. You MAY use the read-only Elastic tools to ground " +
	"your answer in live state. You must NOT draft Terraform, edit configuration, create a branch, or open " +
	"a merge request. If the user wants a change made, tell them to ask for it directly and it will go " +
	"through the normal review-gated proposal flow.";

export async function converseIac(state: IacStateType): Promise<Partial<IacStateType>> {
	const tools = infoTools();
	const sys = `${buildSystemPrompt(getAgentByName(AGENT))}\n\n${CONVERSE_GUARDRAIL}`;

	// No read tools available: answer from history alone (still useful -- it's an explanation).
	if (tools.length === 0) {
		const res = await createLlm("iacReader", AGENT).invoke([new SystemMessage(sys), ...state.messages]);
		return { messages: [new AIMessage(String(res.content))] };
	}

	const llm = createLlmWithTools("iacReader", tools, AGENT);
	const convo: BaseMessage[] = [new SystemMessage(sys), ...state.messages];

	const MAX_STEPS = 5;
	for (let step = 0; step < MAX_STEPS; step++) {
		const ai = (await llm.invoke(convo)) as AIMessage;
		convo.push(ai);
		const calls = ai.tool_calls ?? [];
		if (calls.length === 0) return { messages: [new AIMessage(String(ai.content))] };
		for (const call of calls) {
			const result = await dispatchInfoToolCall(tools, call.name, (call.args ?? {}) as Record<string, unknown>);
			convo.push(new ToolMessage({ content: result, tool_call_id: call.id ?? call.name }));
		}
	}
	const final = await createLlm("iacReader", AGENT).invoke([
		...convo,
		new HumanMessage("Answer the user's follow-up now using what you've gathered."),
	]);
	return { messages: [new AIMessage(String(final.content))] };
}

// Parse the "[status] {json}" body callTool returns from elastic_cloud_list_deployments
// and resolve a human cluster name to its Elastic Cloud deployment id. Exact name match
// wins over case-insensitive; "" when not found / unparseable. (Pure; unit-tested.)
export function parseDeploymentId(listText: string, clusterName: string): string {
	if (!clusterName) return "";
	const jsonStart = listText.indexOf("{");
	if (jsonStart < 0) return "";
	try {
		const parsed: unknown = JSON.parse(listText.slice(jsonStart));
		const rows =
			typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { deployments?: unknown }).deployments)
				? (parsed as { deployments: Array<{ id?: string; name?: string }> }).deployments
				: [];
		const exact = rows.find((r) => r.name === clusterName);
		if (exact?.id) return exact.id;
		const ci = rows.find((r) => (r.name ?? "").toLowerCase() === clusterName.toLowerCase());
		return ci?.id ?? "";
	} catch {
		return "";
	}
}

async function resolveDeploymentId(clusterName: string): Promise<string> {
	if (!clusterName) return "";
	return parseDeploymentId(await callTool("elastic_cloud_list_deployments", {}), clusterName);
}

// SIO-1000: parse the live effective user_settings_yaml out of an elastic_cloud_get_deployment
// "[status] {json}" body. EC carries it at
// resources.<kind>[0].info.plan_info.current.plan.<kind>.user_settings_yaml, where <kind> is
// "elasticsearch" for the elasticsearch_config target and "kibana" for the kibana target. Returns
// the YAML string, or undefined if the body is unparseable / the path is absent (so the caller can
// fall back to repo-only). EC applies user_settings operator-side and DROPS non-allowlisted keys, so
// a key present in the repo can legitimately be absent here -- that is the drift signal. (Pure; unit-tested.)
export function parseLiveUserSettingsYaml(
	deploymentBody: string,
	target: "elasticsearch_config" | "kibana",
): string | undefined {
	const jsonStart = deploymentBody.indexOf("{");
	if (jsonStart < 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(deploymentBody.slice(jsonStart));
	} catch {
		return undefined;
	}
	const kind = target === "kibana" ? "kibana" : "elasticsearch";
	// Walk the nested path defensively -- any missing hop means "no live value" (undefined), not a throw.
	const resources = (parsed as { resources?: Record<string, unknown> }).resources;
	const arr = resources?.[kind];
	const first = Array.isArray(arr) ? arr[0] : undefined;
	const yaml = (first as { info?: { plan_info?: { current?: { plan?: Record<string, unknown> } } } } | undefined)?.info
		?.plan_info?.current?.plan?.[kind];
	const usy = (yaml as { user_settings_yaml?: unknown } | undefined)?.user_settings_yaml;
	return typeof usy === "string" ? usy : undefined;
}

// SIO-1000: classify repo-vs-live drift for ONE dotted key on a user_settings_yaml target. Resolves
// the key (exact + suffix) independently against the repo YAML and the live YAML, so a shorthand like
// "monitoring.collection.interval" is checked at its real nested path in both. liveUnknown=true when
// the live read failed (caller falls back to repo-only + says so). (Pure; unit-tested.)
export function classifyUserSettingsDrift(
	repoYaml: string,
	liveYaml: string | undefined,
	dottedKey: string,
): { inRepo: boolean; inLive: boolean; liveUnknown: boolean } {
	const present = (yaml: string): boolean => {
		const res = resolveUserSettingsKey(parseDocument(yaml || ""), dottedKey);
		return res.kind === "exact" || res.kind === "suffix" || res.kind === "ambiguous";
	};
	const inRepo = present(repoYaml);
	if (liveYaml === undefined) return { inRepo, inLive: false, liveUnknown: true };
	return { inRepo, inLive: present(liveYaml), liveUnknown: false };
}

// SIO-1000: read the live effective user_settings_yaml for a deployment (best-effort). Resolves the
// alias to an EC deployment id, fetches the plan, extracts the target block YAML. Returns undefined on
// any failure so callers degrade to repo-only. (Async; thin wrapper, unit-tested via its pure parts.)
async function fetchLiveUserSettingsYaml(
	clusterName: string,
	target: "elasticsearch_config" | "kibana",
): Promise<string | undefined> {
	const id = await resolveDeploymentId(clusterName);
	if (!id) return undefined;
	// The elastic-iac MCP tool takes `deploymentId` (camelCase) and does a plain GET
	// /api/v1/deployments/{id} -- which already includes plan_info.current.plan.<kind>.user_settings_yaml
	// (no show_plans flag exists on this tool). Passing snake_case / show_plans fails Zod validation and
	// the live read silently degrades to repo-only, so the arg name must match the tool exactly.
	const body = await callTool("elastic_cloud_get_deployment", { deploymentId: id });
	return parseLiveUserSettingsYaml(body, target);
}

// Read live cluster state (topology, plan history, ILM, health) before drafting.
export async function readClusterState(state: IacStateType): Promise<Partial<IacStateType>> {
	const req = state.iacRequest;
	const cluster = req?.cluster ?? "";
	const deploymentId = await resolveDeploymentId(cluster);
	const summary = deploymentId
		? await callTool("elastic_cloud_get_deployment", { deploymentId })
		: `[could not resolve an Elastic Cloud deployment id for cluster '${cluster}']`;
	const alerts = await callTool("elastic_ilm_get_lifecycle", { policy: ".alerts" });
	const alertsManaged = !alerts.startsWith("[") && alerts.toLowerCase().includes("alerts");
	return {
		clusterState: { cluster, summary, alertsManaged, raw: summary },
	};
}

// Apply the mechanical safety guards. Blocked requests terminate before any write.
export function guardNode(state: IacStateType): Partial<IacStateType> {
	const req = state.iacRequest;
	if (!req) return { blockedReason: "No request parsed." };
	const result = evaluateGuards(req, state.clusterState);
	if (result.blocked) {
		return {
			blockedReason: result.reason ?? "Blocked by guard.",
			messages: [new AIMessage(`Cannot proceed: ${result.reason}`)],
		};
	}
	return { blockedReason: "" };
}

// Read-modify-write the per-deployment JSON: set the top-level `version` field to
// the target. GitLab's commit "update" action needs the full file body, not a diff.
// Preserves 2-space indent + a trailing newline (repo house style). Throws on
// invalid JSON. (Pure; unit-tested.)
export function setDeploymentVersion(json: string, version: string): { content: string; previous?: string } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("deployment JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	const previous = typeof obj.version === "string" ? obj.version : undefined;
	obj.version = version;
	return { content: `${JSON.stringify(obj, null, 2)}\n`, previous };
}

// SIO-879: read-modify-write a tier's size/max_size in the deployment JSON. Tier sizes
// are strings like "8g" (GB); the request carries GB integers. Only sets the fields the
// caller provides (a tier may be autoscaling-only: max_size set, size absent). Preserves
// other tier fields (zone_count, instance_configuration_id) + trailing newline. Throws on
// bad JSON or an unknown/absent tier. (Pure; unit-tested.)
export function setDeploymentTierSize(
	json: string,
	tier: string,
	sizeGb?: number,
	maxGb?: number,
): { content: string; previousSize?: string; previousMax?: string } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("deployment JSON is not an object");
	}
	const obj = parsed as { elasticsearch?: Record<string, unknown> };
	const es = obj.elasticsearch;
	if (!es || typeof es !== "object") throw new Error("deployment JSON has no elasticsearch block");
	const t = es[tier];
	if (!t || typeof t !== "object") throw new Error(`unknown or unsized tier '${tier}'`);
	const tierObj = t as Record<string, unknown>;
	const previousSize = typeof tierObj.size === "string" ? tierObj.size : undefined;
	const previousMax = typeof tierObj.max_size === "string" ? tierObj.max_size : undefined;
	if (sizeGb != null) tierObj.size = `${sizeGb}g`;
	if (maxGb != null) tierObj.max_size = `${maxGb}g`;
	return { content: `${JSON.stringify(obj, null, 2)}\n`, previousSize, previousMax };
}

// SIO-919: read-modify-write topology fields in the _deployments JSON beyond version/size (which
// version-upgrade/tier-resize already own): the global elasticsearch.autoscale toggle, and a tier's
// zone_count and/or per-tier autoscale. Preserves size/max_size/instance_configuration + the raw
// user_settings_yaml block byte-for-byte. Captures previous values for the diff. Throws on bad JSON,
// a missing elasticsearch block, or an unknown tier (when a tier field is requested). The
// deployments stack is a single shared state across all 10 clusters -- the proposer always flags
// that + the long apply window. (Pure; unit-tested.)
export function setDeploymentTopology(
	json: string,
	changes: { autoscale?: boolean; tier?: string; zoneCount?: number; tierAutoscale?: boolean },
): {
	content: string;
	previousAutoscale?: boolean;
	previousZoneCount?: number;
	previousTierAutoscale?: boolean;
	changed: boolean;
} {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("deployment JSON is not an object");
	}
	const obj = parsed as { elasticsearch?: Record<string, unknown> };
	const es = obj.elasticsearch;
	if (!es || typeof es !== "object") throw new Error("deployment JSON has no elasticsearch block");
	let changed = false;

	const previousAutoscale = typeof es.autoscale === "boolean" ? es.autoscale : undefined;
	if (changes.autoscale !== undefined) {
		es.autoscale = changes.autoscale;
		changed = true;
	}

	let previousZoneCount: number | undefined;
	let previousTierAutoscale: boolean | undefined;
	if (changes.tier !== undefined && (changes.zoneCount !== undefined || changes.tierAutoscale !== undefined)) {
		const t = es[changes.tier];
		if (!t || typeof t !== "object") throw new Error(`unknown or unsized tier '${changes.tier}'`);
		const tierObj = t as Record<string, unknown>;
		previousZoneCount = typeof tierObj.zone_count === "number" ? tierObj.zone_count : undefined;
		previousTierAutoscale = typeof tierObj.autoscale === "boolean" ? tierObj.autoscale : undefined;
		if (changes.zoneCount !== undefined) {
			tierObj.zone_count = changes.zoneCount;
			changed = true;
		}
		if (changes.tierAutoscale !== undefined) {
			tierObj.autoscale = changes.tierAutoscale;
			changed = true;
		}
	}

	return {
		content: `${JSON.stringify(obj, null, 2)}\n`,
		previousAutoscale,
		previousZoneCount,
		previousTierAutoscale,
		changed,
	};
}

// SIO-919: set elasticsearch_config.user_settings_yaml OR kibana.user_settings_yaml to a new raw
// YAML string (SSO/OIDC realms, Kibana auth providers). The value is a JSON-escaped string -- we
// replace it wholesale with the caller's string and NEVER reformat or parse it. Captures the
// previous string for the MR (length only is surfaced upstream; the value never enters the diff,
// since SSO config can contain idp/sp identifiers). Preserves every sibling field + trailing
// newline. Throws on bad JSON or a missing target block. (Pure; unit-tested.)
export function setDeploymentUserSettings(
	json: string,
	target: "elasticsearch_config" | "kibana",
	yaml: string,
): { content: string; previousYaml?: string; changed: boolean } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("deployment JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	const block = obj[target];
	if (!block || typeof block !== "object") throw new Error(`deployment JSON has no ${target} block`);
	const blockObj = block as Record<string, unknown>;
	const previousYaml = typeof blockObj.user_settings_yaml === "string" ? blockObj.user_settings_yaml : undefined;
	const changed = previousYaml !== yaml;
	blockObj.user_settings_yaml = yaml;
	return { content: `${JSON.stringify(obj, null, 2)}\n`, previousYaml, changed };
}

// SIO-997: a single dotted-key SET into an EXISTING user_settings_yaml block, distinct from
// setDeploymentUserSettings' whole-block replace. The non-SSO common case ("set
// xpack.monitoring.collection.interval to 60s") must add ONE leaf without the planner reproducing the
// rest of the YAML -- a wrong reproduction of the xpack.security/OIDC subtree can lock out login. We
// parse the existing string with `yaml`'s parseDocument (which preserves every untouched node's
// formatting verbatim) and setIn the dotted path, creating only the missing intermediate maps. Every
// sibling subtree -- crucially xpack.security -- is left byte-for-byte. (Pure; unit-tested.)
export function mergeUserSettingsKey(
	currentYaml: string,
	dottedKey: string,
	value: string,
): { yaml: string; previousValue?: string; changed: boolean; touchesSecurity: boolean } {
	const path = dottedKey.split(".");
	const doc = parseDocument(currentYaml || "");
	// getIn returns the existing scalar (its .value) or undefined; capture for the diff + no-op guard.
	const prev = doc.getIn(path, true);
	const previousValue =
		prev && typeof prev === "object" && "value" in prev ? String((prev as { value: unknown }).value) : undefined;
	doc.setIn(path, value);
	const yaml = doc.toString();
	return {
		yaml,
		previousValue,
		changed: yaml !== currentYaml,
		// xpack.security is the SSO/OIDC realm subtree; flag when the edit lands inside it so the risk
		// message can warn about login lock-out only when it actually applies.
		touchesSecurity: path[0] === "xpack" && path[1] === "security",
	};
}

// SIO-997: read-modify-write a _deployments JSON: merge ONE dotted key into the target block's
// user_settings_yaml (mergeUserSettingsKey), leaving every other subtree byte-for-byte. Mirrors
// setDeploymentUserSettings' wrapper (preserves siblings + 2-space JSON indent + trailing newline);
// throws on bad JSON or a missing target block. (Pure; unit-tested.)
export function mergeDeploymentUserSettingsKey(
	json: string,
	target: "elasticsearch_config" | "kibana",
	dottedKey: string,
	value: string,
): { content: string; previousValue?: string; changed: boolean; touchesSecurity: boolean } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("deployment JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	const block = obj[target];
	if (!block || typeof block !== "object") throw new Error(`deployment JSON has no ${target} block`);
	const blockObj = block as Record<string, unknown>;
	const currentYaml = typeof blockObj.user_settings_yaml === "string" ? blockObj.user_settings_yaml : "";
	const merged = mergeUserSettingsKey(currentYaml, dottedKey, value);
	blockObj.user_settings_yaml = merged.yaml;
	return {
		content: `${JSON.stringify(obj, null, 2)}\n`,
		previousValue: merged.previousValue,
		changed: merged.changed,
		touchesSecurity: merged.touchesSecurity,
	};
}

// SIO-999: enumerate every node path in a user_settings_yaml doc as dotted-segment arrays (each
// segment a real map key, which may itself be a flat dotted key like "rp.client_id"). Used by the
// suffix-match fallback below. (Pure.)
function allUserSettingsPaths(doc: ReturnType<typeof parseDocument>): string[][] {
	const out: string[][] = [];
	const walk = (node: unknown, prefix: string[]): void => {
		if (!isMap(node)) return;
		for (const item of node.items) {
			const rawKey = (item.key as { value?: unknown } | null)?.value ?? item.key;
			const path = [...prefix, String(rawKey)];
			out.push(path);
			walk(item.value, path);
		}
	};
	walk(doc.contents, []);
	return out;
}

// SIO-999: exact greedy longest-flat-prefix resolution -- at each level match the LONGEST remaining
// join that is a direct key on the current node, descend, repeat. Handles flat dotted keys (a.b.c:),
// nested maps, and mixes. Returns the concrete node-path or undefined. (Pure.)
function resolveExactUserSettingsKeyPath(
	doc: ReturnType<typeof parseDocument>,
	dottedKey: string,
): string[] | undefined {
	const parts = dottedKey.split(".");
	const path: string[] = [];
	let idx = 0;
	while (idx < parts.length) {
		const node = path.length === 0 ? doc.contents : doc.getIn(path, true);
		if (!isMap(node)) return undefined;
		let matched = false;
		for (let end = parts.length; end > idx; end--) {
			const candidate = parts.slice(idx, end).join(".");
			if (node.has(candidate)) {
				path.push(candidate);
				idx = end;
				matched = true;
				break;
			}
		}
		if (!matched) return undefined;
	}
	return path;
}

// SIO-999: resolve a user-supplied dotted key for REMOVAL. Exact path wins. If it misses, fall back
// to a SUFFIX match: a doc path whose flattened dotted form ENDS WITH the requested key (so a user who
// types "monitoring.collection.interval" still hits "xpack.monitoring.collection.interval"). A unique
// suffix match resolves; >1 is ambiguous (never guess); 0 is absent. (Pure; unit-tested via
// removeUserSettingsKeys.)
type UserSettingsKeyResolution =
	| { kind: "exact" | "suffix"; path: string[]; resolved: string }
	| { kind: "ambiguous"; candidates: string[] }
	| { kind: "absent" };
function resolveUserSettingsKey(doc: ReturnType<typeof parseDocument>, dottedKey: string): UserSettingsKeyResolution {
	const exact = resolveExactUserSettingsKeyPath(doc, dottedKey);
	if (exact) return { kind: "exact", path: exact, resolved: exact.join(".") };
	const matches = allUserSettingsPaths(doc).filter((path) => {
		const dotted = path.join(".");
		return dotted === dottedKey || dotted.endsWith(`.${dottedKey}`);
	});
	const first = matches[0];
	if (first === undefined) return { kind: "absent" };
	const uniq = Array.from(new Set(matches.map((m) => m.join("."))));
	if (uniq.length === 1) return { kind: "suffix", path: first, resolved: first.join(".") };
	return { kind: "ambiguous", candidates: uniq };
}

// SIO-999: delete the named keys from a user_settings_yaml string, mirroring removeFlat for the
// cluster-settings stack. Uses `yaml`'s parseDocument so every untouched node is preserved byte-for-byte
// (incl. the xpack.security/OIDC SSO realm). Each key is resolved exact-first then by unique suffix
// (resolveUserSettingsKey), so "monitoring.collection.interval" reaches "xpack.monitoring...". `removed`
// holds the FULL resolved dotted paths (what was actually deleted); `ambiguous` holds keys that matched
// >1 subtree (NOT removed -- never guess) with their candidates; `absent` holds keys found nowhere.
// touchesSecurity flags when any RESOLVED path lands inside xpack.security. (Pure; unit-tested.)
export function removeUserSettingsKeys(
	currentYaml: string,
	dottedKeys: string[],
): {
	yaml: string;
	removed: string[];
	ambiguous: { key: string; candidates: string[] }[];
	absent: string[];
	changed: boolean;
	touchesSecurity: boolean;
} {
	const doc = parseDocument(currentYaml || "");
	const removed: string[] = [];
	const ambiguous: { key: string; candidates: string[] }[] = [];
	const absent: string[] = [];
	let touchesSecurity = false;
	for (const dottedKey of dottedKeys) {
		const res = resolveUserSettingsKey(doc, dottedKey);
		if (res.kind === "absent") {
			absent.push(dottedKey);
			continue;
		}
		if (res.kind === "ambiguous") {
			// More than one subtree ends with this key -- do NOT guess which to delete.
			ambiguous.push({ key: dottedKey, candidates: res.candidates });
			continue;
		}
		const path = res.path;
		doc.deleteIn(path);
		// Prune now-empty ancestor maps so removing a leaf drops the whole inert subtree instead of
		// leaving `collection: {}` residue. Stops at the first ancestor that still holds a sibling key,
		// and never prunes the document root.
		for (let i = path.length - 1; i >= 1; i--) {
			const parentPath = path.slice(0, i);
			const parent = doc.getIn(parentPath, true);
			if (!isMap(parent) || parent.items.length > 0) break;
			doc.deleteIn(parentPath);
		}
		removed.push(res.resolved);
		// Base the security signal on the RESOLVED path (a flat realm key or a suffix-resolved key would
		// make the user-typed key miss the "xpack.security" prefix check).
		if (res.resolved === "xpack.security" || res.resolved.startsWith("xpack.security.")) touchesSecurity = true;
	}
	const yaml = doc.toString();
	return { yaml, removed, ambiguous, absent, changed: yaml !== currentYaml, touchesSecurity };
}

// SIO-999: read-modify-write a _deployments JSON: delete the named dotted key(s) from the target
// block's user_settings_yaml (removeUserSettingsKeys), leaving every other subtree byte-for-byte.
// Mirrors mergeDeploymentUserSettingsKey's wrapper (2-space JSON indent + trailing newline); throws
// on bad JSON or a missing target block. (Pure; unit-tested.)
export function removeDeploymentUserSettingsKeys(
	json: string,
	target: "elasticsearch_config" | "kibana",
	dottedKeys: string[],
): {
	content: string;
	removed: string[];
	ambiguous: { key: string; candidates: string[] }[];
	absent: string[];
	changed: boolean;
	touchesSecurity: boolean;
} {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("deployment JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	const block = obj[target];
	if (!block || typeof block !== "object") throw new Error(`deployment JSON has no ${target} block`);
	const blockObj = block as Record<string, unknown>;
	const currentYaml = typeof blockObj.user_settings_yaml === "string" ? blockObj.user_settings_yaml : "";
	const result = removeUserSettingsKeys(currentYaml, dottedKeys);
	blockObj.user_settings_yaml = result.yaml;
	return {
		content: `${JSON.stringify(obj, null, 2)}\n`,
		removed: result.removed,
		ambiguous: result.ambiguous,
		absent: result.absent,
		changed: result.changed,
		touchesSecurity: result.touchesSecurity,
	};
}

// SIO-999: read the current user_settings_yaml of a _deployments JSON block (read-only; for the
// idempotent no-op confirmation -- showing the user the live repo state when a removal found nothing
// to remove). Returns "" when the block or field is absent; throws only on bad JSON.
export function readDeploymentUserSettings(json: string, target: "elasticsearch_config" | "kibana"): string {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("deployment JSON is not an object");
	}
	const block = (parsed as Record<string, unknown>)[target];
	if (!block || typeof block !== "object") return "";
	const yaml = (block as Record<string, unknown>).user_settings_yaml;
	return typeof yaml === "string" ? yaml : "";
}

// SIO-919: set the size / zone_count of a non-data component (integrations_server or kibana) in the
// _deployments JSON. Captures previous values, preserves other fields + trailing newline. Throws on
// bad JSON or a missing component. (Pure; unit-tested.)
export function setComponentSize(
	json: string,
	component: "integrations_server" | "kibana",
	changes: { size?: string; zoneCount?: number },
): { content: string; previousSize?: string; previousZoneCount?: number; changed: boolean } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("deployment JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	const block = obj[component];
	if (!block || typeof block !== "object") throw new Error(`deployment JSON has no ${component} block`);
	const blockObj = block as Record<string, unknown>;
	const previousSize = typeof blockObj.size === "string" ? blockObj.size : undefined;
	const previousZoneCount = typeof blockObj.zone_count === "number" ? blockObj.zone_count : undefined;
	let changed = false;
	if (changes.size !== undefined && blockObj.size !== changes.size) {
		blockObj.size = changes.size;
		changed = true;
	}
	if (changes.zoneCount !== undefined && blockObj.zone_count !== changes.zoneCount) {
		blockObj.zone_count = changes.zoneCount;
		changed = true;
	}
	return { content: `${JSON.stringify(obj, null, 2)}\n`, previousSize, previousZoneCount, changed };
}

// reconcile-to-live: rewrite the deployment JSON's elasticsearch block to match the live cluster's
// per-tier sizing. Sets max_size ("<N>g") + zone_count for each tier present in BOTH the JSON and
// `topo`; never invents a tier the repo doesn't manage. The live "size" is the autoscaling ceiling
// -> max_size; the repo's current "size" is left untouched (the drift signal is too coarse to tell
// size from max_size, so the empty-diff guard upstream catches no-op rewrites). Captures a per-tier
// previous mirror for the MR summary. Preserves other tier fields + trailing newline. Throws on bad
// JSON / missing elasticsearch block. (Pure; unit-tested.)
export function applyLiveTopology(
	json: string,
	topo: Record<string, { sizeGb?: number; zoneCount?: number }>,
): { content: string; previous: Record<string, { maxSize?: string; zoneCount?: number }> } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("deployment JSON is not an object");
	}
	const obj = parsed as { elasticsearch?: Record<string, unknown> };
	const es = obj.elasticsearch;
	if (!es || typeof es !== "object") throw new Error("deployment JSON has no elasticsearch block");
	const previous: Record<string, { maxSize?: string; zoneCount?: number }> = {};
	for (const [tier, live] of Object.entries(topo)) {
		const t = es[tier];
		if (!t || typeof t !== "object") continue; // never invent a tier the repo doesn't manage
		const tierObj = t as Record<string, unknown>;
		const prev: { maxSize?: string; zoneCount?: number } = {};
		let touched = false;
		// Only count a field as touched when the live value actually differs from the repo value;
		// otherwise a no-op (live already matches) would record a phantom edit in `previous`, which
		// the MR summary then reports as a change that was never written.
		if (live.sizeGb !== undefined) {
			const next = `${live.sizeGb}g`;
			if (tierObj.max_size !== next) {
				if (typeof tierObj.max_size === "string") prev.maxSize = tierObj.max_size;
				tierObj.max_size = next;
				touched = true;
			}
		}
		if (live.zoneCount !== undefined) {
			if (tierObj.zone_count !== live.zoneCount) {
				if (typeof tierObj.zone_count === "number") prev.zoneCount = tierObj.zone_count;
				tierObj.zone_count = live.zoneCount;
				touched = true;
			}
		}
		if (touched) previous[tier] = prev;
	}
	return { content: `${JSON.stringify(obj, null, 2)}\n`, previous };
}

// SIO-880: read-modify-write an ILM lifecycle-policy JSON by deep-merging a nested phase
// patch (top-level keys are phases: hot/warm/cold/delete). Recurses into nested objects
// (e.g. warm.forcemerge), replaces scalars/arrays/null. Captures the pre-merge value of
// every touched leaf into `previous` (a sparse mirror of the patch) for the diff +
// retention check; a leaf the policy lacked records `undefined`. Preserves 2-space indent
// + trailing newline. Throws on non-object JSON. (Pure; unit-tested.)
export function mergeIlmPhases(
	json: string,
	patch: Record<string, unknown>,
): { content: string; previous: Record<string, unknown> } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("ILM policy JSON is not an object");
	}
	const isPlainObject = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null && !Array.isArray(v);

	const previous: Record<string, unknown> = {};
	const merge = (target: Record<string, unknown>, p: Record<string, unknown>, prev: Record<string, unknown>): void => {
		for (const [key, value] of Object.entries(p)) {
			const current = target[key];
			if (isPlainObject(value)) {
				// A phase value changing from scalar->object would drop the old scalar from
				// `previous`; ILM phases are always objects, so this clobber path is unreachable.
				if (!isPlainObject(current)) target[key] = {};
				const prevChild: Record<string, unknown> = {};
				prev[key] = prevChild;
				merge(target[key] as Record<string, unknown>, value, prevChild);
			} else {
				prev[key] = current; // may be undefined if the policy lacked this leaf
				target[key] = value;
			}
		}
	};
	merge(parsed as Record<string, unknown>, patch, previous);
	return { content: `${JSON.stringify(parsed, null, 2)}\n`, previous };
}

// SIO-931: a canonical correctly-shaped policy skeleton, mirroring the repo's
// us-default-lifecycle-logs-prod.json. Used as the from-scratch base ONLY when no sibling
// policy exists in the cluster's lifecycle-policies/ dir to copy the shape from.
export const CANONICAL_ILM_SHAPE = {
	hot: { priority: 100, max_age: "7d", max_primary_shard_size: "10gb", rollover: true },
	warm: {
		min_age: "1d",
		priority: 50,
		allocate: { number_of_replicas: 0 },
		forcemerge: { max_num_segments: 1 },
		shrink: { number_of_shards: 1, allow_write_after_shrink: false },
	},
	cold: { min_age: "2d", priority: 25, allocate: { number_of_replicas: 0 } },
	frozen: { min_age: "7d", searchable_snapshot: { snapshot_repository: "found-snapshots", force_merge_index: true } },
	delete: { min_age: "60d", delete_searchable_snapshot: true, wait_for_snapshot: { policy: "cloud-snapshot-policy" } },
} as const;

// SIO-931: structural schema mirroring modules/lifecycle/variables.tf. Each phase is optional;
// within a present phase the nested objects are required where the module requires them, and
// .strict() rejects unknown keys so the agent's old flat shape (searchable_snapshot_repository,
// set_priority, bare number_of_replicas, ...) is caught here rather than by CI terraform plan.
const IlmPolicySchema = z
	.object({
		name: z.string(),
		metadata: z.string().optional(),
		hot: z
			.object({
				min_age: z.string().optional(),
				max_age: z.string().optional(),
				max_size: z.string().optional(),
				max_primary_shard_size: z.string().optional(),
				min_docs: z.number().optional(),
				priority: z.number().optional(),
				rollover: z.boolean().optional(),
			})
			.strict()
			.optional(),
		warm: z
			.object({
				min_age: z.string().optional(),
				priority: z.number().optional(),
				allocate: z.object({ number_of_replicas: z.number() }).strict().optional(),
				forcemerge: z.object({ max_num_segments: z.number() }).strict().optional(),
				shrink: z
					.object({ number_of_shards: z.number(), allow_write_after_shrink: z.boolean().optional() })
					.strict()
					.optional(),
				readonly: z.boolean().optional(),
			})
			.strict()
			.optional(),
		cold: z
			.object({
				min_age: z.string().optional(),
				priority: z.number().optional(),
				allocate: z.object({ number_of_replicas: z.number() }).strict().optional(),
				readonly: z.boolean().optional(),
			})
			.strict()
			.optional(),
		frozen: z
			.object({
				min_age: z.string().optional(),
				searchable_snapshot: z
					.object({ snapshot_repository: z.string(), force_merge_index: z.boolean().optional() })
					.strict(),
			})
			.strict()
			.optional(),
		delete: z
			.object({
				min_age: z.string().optional(),
				delete_searchable_snapshot: z.boolean().optional(),
				wait_for_snapshot: z.object({ policy: z.string() }).strict().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

// Translate the most common flat-shape mistakes into a targeted nested-fix hint, so the blocked
// message tells the user EXACTLY what to change instead of a raw Zod path.
function flatShapeHint(policy: Record<string, unknown>): string | null {
	const phase = (k: string): Record<string, unknown> =>
		(typeof policy[k] === "object" && policy[k] !== null ? policy[k] : {}) as Record<string, unknown>;
	if ("set_priority" in phase("hot") || "set_priority" in phase("warm") || "set_priority" in phase("cold"))
		return "use `priority` (a number) on the phase, not `set_priority`.";
	if ("number_of_replicas" in phase("warm") || "number_of_replicas" in phase("cold"))
		return "set replicas via `allocate: { number_of_replicas }`, not a bare number_of_replicas on the phase.";
	if ("forcemerge_max_num_segments" in phase("warm"))
		return "use nested `forcemerge: { max_num_segments }`, not flat forcemerge_max_num_segments.";
	if ("shrink_number_of_shards" in phase("warm"))
		return "use nested `shrink: { number_of_shards }`, not flat shrink_number_of_shards.";
	if ("searchable_snapshot_repository" in phase("frozen") || "force_merge_index" in phase("frozen"))
		return "use nested `searchable_snapshot: { snapshot_repository, force_merge_index }`, not flat searchable_snapshot_repository / force_merge_index.";
	if ("wait_for_snapshot_policy" in phase("delete"))
		return "use nested `wait_for_snapshot: { policy }`, not flat wait_for_snapshot_policy.";
	return null;
}

// SIO-931: validate a built ILM policy against the repo/module schema BEFORE commit. (Pure.)
export function validateIlmPolicy(policy: unknown): { ok: true } | { ok: false; reason: string } {
	const parsed = IlmPolicySchema.safeParse(policy);
	if (parsed.success) return { ok: true };
	const hint = typeof policy === "object" && policy !== null ? flatShapeHint(policy as Record<string, unknown>) : null;
	const first = parsed.error.issues[0];
	const where = first ? first.path.join(".") || "(root)" : "(unknown)";
	const detail = first ? `${where}: ${first.message}` : "invalid policy structure";
	return { ok: false, reason: hint ? `${detail}. ${hint}` : detail };
}

// SIO-880: parse an Elastic time string ("30d", "48h", "90m", "30s") to seconds. Returns
// null for an unrecognized unit/format. ms/micros/nanos are not ILM min_age units.
function durationToSeconds(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const m = value.match(/^(\d+)\s*(d|h|m|s)$/);
	if (!m) return null;
	const n = Number(m[1]);
	const unit = m[2];
	const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
	return n * mult;
}

// SIO-880: compare old vs new delete.min_age. Returns the from/to descriptor when the new
// retention is strictly shorter (irreversible data loss = HIGH risk), else null. (Pure.)
export function detectRetentionReduction(
	previous: Record<string, unknown>,
	patch: Record<string, unknown>,
): { from: string; to: string } | null {
	const prevDelete = previous.delete;
	const patchDelete = patch.delete;
	if (typeof prevDelete !== "object" || prevDelete === null) return null;
	if (typeof patchDelete !== "object" || patchDelete === null) return null;
	const from = (prevDelete as { min_age?: unknown }).min_age;
	const to = (patchDelete as { min_age?: unknown }).min_age;
	const fromS = durationToSeconds(from);
	const toS = durationToSeconds(to);
	if (fromS === null || toS === null) return null;
	return toS < fromS ? { from: from as string, to: to as string } : null;
}

// Resolve a per-deployment/per-policy JSON path from a configured template. ${cluster}
// and ${policy} are literal placeholders (config, not JS template literals). The policy
// filename is substituted verbatim (it legitimately contains '@' and '.').
export function deploymentJsonPath(template: string, cluster: string, policy?: string): string {
	let out = template.replace(/\$\{cluster\}/g, cluster);
	if (policy !== undefined) out = out.replace(/\$\{policy\}/g, policy);
	return out;
}

// Pure branch slug from the request descriptor: cluster-<descriptor>-workflow.
// For a version-upgrade the descriptor is the target version (e.g. "9-4-2").
// (Exported for unit testing; branchName appends agent/ + the date.)
export function branchSlug(req: IacRequest): string {
	const descriptor =
		req.workflow === "version-upgrade"
			? req.version
			: req.workflow === "ilm-rollout"
				? // SIO-932: a multi-file ilm request joins the policy names (e.g. metrics-logs); the
					// 40-char slug cap truncates a long list. A single policy keeps the existing slug.
					req.ilmPolicies && req.ilmPolicies.length >= 2
					? req.ilmPolicies.map((e) => e.policyName).join("-")
					: req.policyName
				: req.workflow === "fleet-integration"
					? req.integration
					: req.workflow === "slo-edit"
						? req.sloName
						: req.workflow === "alerting-edit"
							? req.ruleName
							: req.workflow === "dataview-edit"
								? req.dataviewName
								: req.workflow === "cluster-default-edit"
									? // SIO-979: a multi-file clusterDefaults request joins the template names (40-char cap
										// truncates a long list); a single-file request keeps templateName.
										req.clusterDefaults && req.clusterDefaults.length >= 2
										? req.clusterDefaults.map((e) => e.templateName).join("-")
										: req.templateName
									: req.workflow === "cluster-default-delete"
										? // SIO-1022: revert/remove the named override file(s) (40-char cap truncates a long list).
											`revert-${(req.clusterDefaultDeletes ?? []).map((e) => e.templateName).join("-")}`
										: req.workflow === "ilm-delete"
											? // SIO-1037: remove the named ILM policy file(s) (40-char cap truncates a long list).
												`remove-${(req.ilmDeletes ?? []).map((e) => e.policyName).join("-")}`
											: req.workflow === "space-edit"
												? req.spaceName
												: req.workflow === "security-edit"
													? req.roleName
													: req.workflow === "topology-edit"
														? req.topologyTier
														: req.workflow === "dashboard-edit"
															? // SIO-920: dashboard slugs repeat across spaces (default__foo vs observability__foo);
																// include space + action so same-day edits don't collide on one branch.
																[req.dashboardSpace, req.dashboardName, req.dashboardAction].filter(Boolean).join("-")
															: req.workflow === "index-template-create"
																? // SIO-978: a multi-template create joins template names; the 40-char cap truncates a long list.
																	(req.indexTemplates ?? []).map((e) => e.name).join("-")
																: req.workflow === "ingest-pipeline-create"
																	? // SIO-1019: a multi-pipeline create joins pipeline names; the 40-char cap truncates a long list.
																		(req.ingestPipelines ?? []).map((e) => e.name).join("-")
																	: req.workflow === "ingest-pipeline-edit"
																		? // SIO-1024: a multi-pipeline edit joins file basenames; the 40-char cap truncates a long list.
																			(req.ingestPipelineEdits ?? []).map((e) => e.name).join("-")
																		: (req.tier ?? req.resource);
	return [req.cluster, descriptor, req.workflow]
		.filter(Boolean)
		.join("-")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 40);
}

function branchName(req: IacRequest): string {
	const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
	return `agent/${branchSlug(req)}-${date}`;
}

// SIO-990: the branch a proposer should commit to. On a correction turn (intent "gitops-amend")
// it pins to the branch the active change already lives on, so the new commit lands on the SAME
// branch and the EXISTING MR updates in place -- no second branch, no duplicate MR. On a fresh
// gitops turn it is just branchName(req). branchName is date+slug-derived, so a same-day same-slug
// correction already resolves here even without an activeChange; the pin makes it deterministic
// (cross-midnight, or a value change that shifts the slug). (Pure.)
export function resolveBranch(state: IacStateType, req: IacRequest): string {
	if (state.intent === "gitops-amend" && state.activeChange?.branch) return state.activeChange.branch;
	return branchName(req);
}

// SIO-965: every agent-opened MR carries these GitLab labels. The MCP tool defaults
// to the same pair, but the callers pass them explicitly so the contract is visible
// at the call site and cannot silently regress if the tool default ever changes. The
// gitlab_list_agent_merge_requests recovery tool filters on "agent-generated".
export const AGENT_MR_LABELS = ["agent-generated", "iac"] as const;

// SIO-965: derive the stack name from an edited repo path. The elastic-iac repo
// keeps per-deployment config at environments/<deployment>/<stack>/..., so the
// segment after the deployment is the stack. environments/_deployments/<cluster>.json
// (the `deployments` stack's cluster JSON) maps to the "deployments" stack. Lives
// here (not graph-knowledge.ts) so both the KG nodes AND the memory-annotation
// builder can share it without a circular import (graph-knowledge.ts -> nodes.ts).
export function stackFromPaths(paths: string[] | undefined): string {
	for (const p of paths ?? []) {
		const parts = p.split("/").filter((s) => s.length > 0);
		const envIdx = parts.indexOf("environments");
		if (envIdx === -1) continue;
		const next = parts[envIdx + 1];
		if (next === "_deployments") return "deployments";
		const stack = parts[envIdx + 2];
		if (next && !next.startsWith("_") && stack) return stack;
	}
	return "";
}

// SIO-985: the INVERSE of stackFromPaths -- the repo stack a given gitops workflow writes under.
// Needed so the (deployment, stack) recall key can be derived from the PARSED request BEFORE
// draftChange populates proposedFiles (the enrich/recall nodes run pre-draft). Verified against each
// proposer's path template: every value here equals what stackFromPaths returns for that proposer's
// committed file. version-upgrade/tier-resize/topology-edit edit environments/_deployments/<c>.json
// -> "deployments". "other" has no proposer (short-circuited in parseIntent) -> "". (Pure.)
const WORKFLOW_STACK: Record<string, string> = {
	"version-upgrade": "deployments",
	"tier-resize": "deployments",
	"topology-edit": "deployments",
	"ilm-rollout": "lifecycle-policies",
	"ilm-delete": "lifecycle-policies",
	"fleet-integration": "fleet-integrations",
	"slo-edit": "slos",
	"alerting-edit": "alerting",
	"dataview-edit": "dataviews",
	"cluster-default-edit": "cluster-defaults",
	"cluster-settings-edit": "cluster-settings",
	"space-edit": "spaces",
	"security-edit": "security",
	"dashboard-edit": "dashboards",
	"index-template-create": "index-templates",
	"ingest-pipeline-create": "ingest-pipelines",
	"ingest-pipeline-edit": "ingest-pipelines",
};

export function stackForWorkflow(workflow: string | undefined): string {
	return workflow ? (WORKFLOW_STACK[workflow] ?? "") : "";
}

// SIO-873: the agent owns the per-deployment JSON path -- it knows the cluster and
// passes the resolved filePath to the MCP gitlab_* tools, which only own the repo
// target (base URL + project). Literal "${cluster}" placeholder. The agent edits
// JSON config only; it never runs terraform or git.
// Read lazily via process.env (works under both Bun and the web app's Vite SSR
// runtime, where a top-level `Bun.env` reference throws "Bun is not defined").
function deploymentJsonTemplate(): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster} is a literal path placeholder substituted by deploymentJsonPath's .replace
	return process.env.ELASTIC_IAC_DEPLOYMENT_JSON_TEMPLATE ?? "environments/_deployments/${cluster}.json";
}

// SIO-880: agent-side path template for ILM lifecycle-policy JSON. ${cluster}/${policy}
// are literal placeholders. Lazy process.env read (no module-scope Bun.env; the web app
// runs Vite SSR where a top-level Bun.env reference throws "Bun is not defined").
function ilmPolicyTemplate(): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster}/${policy} are literal path placeholders substituted by .replace
	return process.env.ELASTIC_IAC_ILM_POLICY_TEMPLATE ?? "environments/${cluster}/lifecycle-policies/${policy}.json";
}

// SIO-914: agent-side path for the per-deployment fleet-integrations aggregate JSON.
// ${cluster} is the literal placeholder. One aggregate file keyed by integration alias.
function fleetIntegrationsTemplate(): string {
	return (
		process.env.ELASTIC_IAC_FLEET_INTEGRATIONS_TEMPLATE ??
		// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster} is a literal path placeholder substituted by .replace
		"environments/${cluster}/fleet-integrations/integrations.json"
	);
}

// SIO-914: read-modify-write the fleet-integrations aggregate JSON: set one integration
// alias's `version` (and optionally `force`). The file is flat -- keyed by alias, each value
// an object { name, version, force }. Preserves 2-space indent + trailing newline (repo house
// style) and every other alias/field. Captures the previous version/force for the diff. Throws
// on bad JSON or an unknown alias (so the proposer surfaces a clarifying message rather than
// silently adding a bogus key). (Pure; unit-tested.)
export function setIntegrationVersion(
	json: string,
	alias: string,
	version: string,
	force?: boolean,
): { content: string; previousVersion?: string; previousForce?: boolean } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("integrations.json is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	const entry = obj[alias];
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		throw new Error(`unknown integration '${alias}'`);
	}
	const e = entry as Record<string, unknown>;
	const previousVersion = typeof e.version === "string" ? e.version : undefined;
	const previousForce = typeof e.force === "boolean" ? e.force : undefined;
	e.version = version;
	if (force !== undefined) e.force = force;
	return { content: `${JSON.stringify(obj, null, 2)}\n`, previousVersion, previousForce };
}

// SIO-914: a major-version bump (leading integer increases) is the higher-risk case for an
// integration package (can break dashboards/pipelines/mappings). Compares the leading numeric
// segment; returns false when either side is unparseable. (Pure; unit-tested.)
export function isMajorVersionBump(from: string | undefined, to: string): boolean {
	if (!from) return false;
	const lead = (v: string): number | null => {
		const m = v.match(/^(\d+)/);
		return m ? Number(m[1]) : null;
	};
	const a = lead(from);
	const b = lead(to);
	return a !== null && b !== null && b > a;
}

// SIO-915: agent-side path for a per-deployment SLO JSON. ${cluster}/${slo} are literal
// placeholders. One file per SLO under environments/<cluster>/slos/.
function sloTemplate(): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster}/${slo} are literal path placeholders substituted by .replace
	return process.env.ELASTIC_IAC_SLO_TEMPLATE ?? "environments/${cluster}/slos/${slo}.json";
}

// SIO-915: normalize an SLO target to the 0-1 fraction the config stores. Users say "99.5"
// (percent) or "0.995" (fraction); a value > 1 is treated as a percent. Rounds to avoid float
// noise (99.95 -> 0.9995). Returns null for a nonsensical target (<=0 or >100). (Pure.)
export function normalizeSloTarget(raw: number): number | null {
	if (!Number.isFinite(raw) || raw <= 0 || raw > 100) return null;
	const frac = raw > 1 ? raw / 100 : raw;
	return Math.round(frac * 1e6) / 1e6;
}

// SIO-915: read-modify-write a per-SLO JSON to OVERRIDE nested-block fields the SLO otherwise
// inherits from _shared/slo-defaults.json. The module shallow-merges per block
// (merge(defaults.objective, file.objective)), so setting objective.target replaces only the
// objective block -- which holds just target (+ optional timeslice fields), so nothing is lost.
// time_window keeps its type ("rolling" default) when only duration changes. tags REPLACE the
// file-level tags (the module then concats the managed-by:terraform default). Captures previous
// values for the diff. Throws on bad JSON. Only sets the fields the caller provides. (Pure.)
export function setSloOverrides(
	json: string,
	changes: { target?: number; windowDuration?: string; tags?: string[] },
): {
	content: string;
	previousTarget?: number;
	previousWindow?: string;
	previousTags?: string[];
	changed: boolean;
} {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("SLO JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	let changed = false;

	const objective = (obj.objective ?? {}) as Record<string, unknown>;
	const previousTarget = typeof objective.target === "number" ? objective.target : undefined;
	if (changes.target !== undefined) {
		objective.target = changes.target;
		obj.objective = objective;
		changed = true;
	}

	const timeWindow = (obj.time_window ?? {}) as Record<string, unknown>;
	const previousWindow = typeof timeWindow.duration === "string" ? timeWindow.duration : undefined;
	if (changes.windowDuration !== undefined) {
		timeWindow.duration = changes.windowDuration;
		if (typeof timeWindow.type !== "string") timeWindow.type = "rolling";
		obj.time_window = timeWindow;
		changed = true;
	}

	const previousTags = Array.isArray(obj.tags)
		? (obj.tags as unknown[]).filter((t): t is string => typeof t === "string")
		: undefined;
	if (changes.tags !== undefined) {
		obj.tags = changes.tags;
		changed = true;
	}

	return { content: `${JSON.stringify(obj, null, 2)}\n`, previousTarget, previousWindow, previousTags, changed };
}

// SIO-916: agent-side path for a per-rule alerting JSON. ${cluster}/${rule} are literal
// placeholders. One file per rule under environments/<cluster>/alerting/; the filename is
// <space>__<rule-name>.json (the rule basename the caller supplies VERBATIM).
function alertingTemplate(): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster}/${rule} are literal path placeholders substituted by .replace
	return process.env.ELASTIC_IAC_ALERTING_TEMPLATE ?? "environments/${cluster}/alerting/${rule}.json";
}

// SIO-916: read-modify-write an alert-rule JSON. Sets only the safe scalar fields: top-level
// `enabled`/`interval` and params.threshold/windowSize/windowUnit. Leaves actions[] (connector
// wiring), params.body (notification template), params.searchConfiguration, and every other
// field untouched. Preserves 2-space indent + trailing newline. Captures the previous values for
// the diff + the disabling-risk check. Only sets the fields the caller provides. Throws on bad
// JSON. (Pure; unit-tested.)
export function setAlertingFields(
	json: string,
	changes: {
		threshold?: number;
		windowSize?: number;
		windowUnit?: string;
		enabled?: boolean;
		interval?: string;
	},
): {
	content: string;
	previousThreshold?: number;
	previousWindowSize?: number;
	previousWindowUnit?: string;
	previousEnabled?: boolean;
	previousInterval?: string;
	changed: boolean;
} {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("alert rule JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	const params = (obj.params ?? {}) as Record<string, unknown>;
	let changed = false;

	const previousThreshold = typeof params.threshold === "number" ? params.threshold : undefined;
	const previousWindowSize = typeof params.windowSize === "number" ? params.windowSize : undefined;
	const previousWindowUnit = typeof params.windowUnit === "string" ? params.windowUnit : undefined;
	const previousEnabled = typeof obj.enabled === "boolean" ? obj.enabled : undefined;
	const previousInterval = typeof obj.interval === "string" ? obj.interval : undefined;

	if (changes.threshold !== undefined) {
		params.threshold = changes.threshold;
		obj.params = params;
		changed = true;
	}
	if (changes.windowSize !== undefined) {
		params.windowSize = changes.windowSize;
		obj.params = params;
		changed = true;
	}
	if (changes.windowUnit !== undefined) {
		params.windowUnit = changes.windowUnit;
		obj.params = params;
		changed = true;
	}
	if (changes.enabled !== undefined) {
		obj.enabled = changes.enabled;
		changed = true;
	}
	if (changes.interval !== undefined) {
		obj.interval = changes.interval;
		changed = true;
	}

	return {
		content: `${JSON.stringify(obj, null, 2)}\n`,
		previousThreshold,
		previousWindowSize,
		previousWindowUnit,
		previousEnabled,
		previousInterval,
		changed,
	};
}

// SIO-917: agent-side path for a per-deployment data-view JSON. ${cluster}/${dataview} are
// literal placeholders. One file per data view under environments/<cluster>/dataviews/.
function dataviewTemplate(): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster}/${dataview} are literal path placeholders substituted by .replace
	return process.env.ELASTIC_IAC_DATAVIEW_TEMPLATE ?? "environments/${cluster}/dataviews/${dataview}.json";
}

// SIO-917: agent-side path for a per-deployment cluster-defaults index-template JSON.
// ${cluster}/${template} are literal placeholders. One file per template under
// environments/<cluster>/cluster-defaults/.
function clusterDefaultTemplate(): string {
	return (
		// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster}/${template} are literal path placeholders substituted by .replace
		process.env.ELASTIC_IAC_CLUSTER_DEFAULT_TEMPLATE ?? "environments/${cluster}/cluster-defaults/${template}.json"
	);
}

// SIO-994: agent-side path for the per-deployment cluster-SETTINGS JSON (the cluster persistent/
// transient settings, the PUT _cluster/settings surface). One fixed `settings.json` per deployment
// under environments/<cluster>/cluster-settings/ -- distinct from cluster-defaults' per-template
// files. ${cluster} is a literal placeholder. Lazy process.env read (no module-scope Bun.env).
function clusterSettingsTemplate(): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster} is a literal path placeholder substituted by deploymentJsonPath's .replace
	return process.env.ELASTIC_IAC_CLUSTER_SETTINGS_TEMPLATE ?? "environments/${cluster}/cluster-settings/settings.json";
}

// SIO-917: read-modify-write a data-view JSON. Adds/replaces a runtime field in
// runtime_field_map (in the repo's CONFIG form: a flat `script_source`, NOT the state form
// `script: { source }` -- copying state-form is the §6 footgun), and/or sets title / name.
// Preserves every other field + 2-space indent + trailing newline. Captures previous values
// for the diff. Only sets the fields the caller provides. Throws on bad JSON. (Pure; unit-tested.)
export function setDataviewFields(
	json: string,
	changes: {
		runtimeField?: { name: string; type: string; script?: string };
		title?: string;
		displayName?: string;
	},
): {
	content: string;
	runtimeFieldExisted?: boolean;
	previousTitle?: string;
	previousName?: string;
	changed: boolean;
} {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("data view JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	let changed = false;

	let runtimeFieldExisted: boolean | undefined;
	if (changes.runtimeField) {
		const map = (obj.runtime_field_map ?? {}) as Record<string, unknown>;
		runtimeFieldExisted = changes.runtimeField.name in map;
		// CONFIG form: { type, script_source }. A script-less keyword runtime field is valid
		// (Optional+Computed adopt-live) -- omit script_source rather than write an empty one.
		const field: Record<string, unknown> = { type: changes.runtimeField.type };
		if (changes.runtimeField.script !== undefined) field.script_source = changes.runtimeField.script;
		map[changes.runtimeField.name] = field;
		obj.runtime_field_map = map;
		changed = true;
	}

	const previousTitle = typeof obj.title === "string" ? obj.title : undefined;
	if (changes.title !== undefined) {
		obj.title = changes.title;
		changed = true;
	}

	const previousName = typeof obj.name === "string" ? obj.name : undefined;
	if (changes.displayName !== undefined) {
		obj.name = changes.displayName;
		changed = true;
	}

	return { content: `${JSON.stringify(obj, null, 2)}\n`, runtimeFieldExisted, previousTitle, previousName, changed };
}

// SIO-917: read-modify-write a cluster-defaults index-template JSON: set the nested
// settings.index.routing.allocation.total_shards_per_node. Creates the nested path if absent.
// Preserves every other setting + 2-space indent + trailing newline. Captures the previous value
// for the diff + the lowering-risk check. Throws on bad JSON. (Pure; unit-tested.)
export function setClusterDefaultShards(
	json: string,
	totalShardsPerNode: number,
): { content: string; previous?: number; changed: boolean } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("cluster-defaults JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	const settings = (obj.settings ?? {}) as Record<string, unknown>;
	const index = (settings.index ?? {}) as Record<string, unknown>;
	const routing = (index.routing ?? {}) as Record<string, unknown>;
	const allocation = (routing.allocation ?? {}) as Record<string, unknown>;
	const previous = typeof allocation.total_shards_per_node === "number" ? allocation.total_shards_per_node : undefined;
	allocation.total_shards_per_node = totalShardsPerNode;
	routing.allocation = allocation;
	index.routing = routing;
	settings.index = index;
	obj.settings = settings;
	return { content: `${JSON.stringify(obj, null, 2)}\n`, previous, changed: previous !== totalShardsPerNode };
}

// SIO-979: read-modify-write a cluster-defaults index-template JSON with a FREEFORM settings patch.
// The patch is relative to settings.index (the LLM emits `{ refresh_interval: "30s" }`), so any
// index setting can be set without hard-coding a field per setting -- validity is left to CI's
// terraform plan (the elasticstack provider passes settings through to ES verbatim). Deep-merges
// like mergeIlmPhases, capturing the previous leaves for the diff, and preserves every other key +
// 2-space indent + trailing newline. `changed` is false when the merge is a no-op (empty diff).
// Throws on bad JSON. (Pure; unit-tested.)
export function mergeClusterDefaultSettings(
	json: string,
	settingsPatch: Record<string, unknown>,
): { content: string; previous: Record<string, unknown>; changed: boolean } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("cluster-defaults JSON is not an object");
	}
	const original = `${JSON.stringify(parsed, null, 2)}\n`;
	const obj = parsed as Record<string, unknown>;
	const settings = (obj.settings ?? {}) as Record<string, unknown>;
	const index = (settings.index ?? {}) as Record<string, unknown>;

	const isPlainObject = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null && !Array.isArray(v);
	const previous: Record<string, unknown> = {};
	const merge = (target: Record<string, unknown>, p: Record<string, unknown>, prev: Record<string, unknown>): void => {
		for (const [key, value] of Object.entries(p)) {
			const current = target[key];
			if (isPlainObject(value)) {
				if (!isPlainObject(current)) target[key] = {};
				const prevChild: Record<string, unknown> = {};
				prev[key] = prevChild;
				merge(target[key] as Record<string, unknown>, value, prevChild);
			} else {
				prev[key] = current; // may be undefined if the file lacked this leaf
				target[key] = value;
			}
		}
	};
	merge(index, settingsPatch, previous);
	settings.index = index;
	obj.settings = settings;
	const content = `${JSON.stringify(obj, null, 2)}\n`;
	return { content, previous, changed: content !== original };
}

// SIO-994: read-modify-write the cluster-SETTINGS JSON (top-level `persistent`/`transient` blocks,
// the PUT _cluster/settings surface). Unlike cluster-defaults, the keys are FLAT dotted strings at
// the top of each block (e.g. "xpack.monitoring.collection.interval": "60s"), so this is a flat
// key-set merge, not a deep nested merge. Sets each patch key on its block, capturing the previous
// value (undefined if absent) for the diff; preserves every other key + 2-space indent + trailing
// newline. `changed` is false on a no-op. Throws on bad JSON. (Pure; unit-tested.)
export function mergeClusterSettings(
	json: string,
	patches: {
		persistentPatch?: Record<string, unknown>;
		transientPatch?: Record<string, unknown>;
		// SIO-996: explicit key removal (revert), dotted names per block. Distinct from a set-to-null
		// patch (a JSON null literal stays in the file); these DELETE the leaf. A remove of an absent
		// key is a no-op, so a remove-only request that touches nothing reports changed=false.
		removeKeysPersistent?: string[];
		removeKeysTransient?: string[];
	},
): {
	content: string;
	previous: { persistent: Record<string, unknown>; transient: Record<string, unknown> };
	changed: boolean;
} {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("cluster-settings JSON is not an object");
	}
	const original = `${JSON.stringify(parsed, null, 2)}\n`;
	const obj = parsed as Record<string, unknown>;
	const persistent = (obj.persistent ?? {}) as Record<string, unknown>;
	const transient = (obj.transient ?? {}) as Record<string, unknown>;

	// Flat key-set: cluster settings are stored as dotted-key leaves, never nested objects.
	const applyFlat = (
		block: Record<string, unknown>,
		patch: Record<string, unknown> | undefined,
		prev: Record<string, unknown>,
	): void => {
		if (!patch) return;
		for (const [key, value] of Object.entries(patch)) {
			prev[key] = block[key]; // undefined when the block lacked this key (a pure add)
			block[key] = value;
		}
	};
	// SIO-996: delete the named leaves. Records the pre-delete value into `prev`; deleting an absent
	// key leaves both `block` and `prev[key]` untouched (a genuine no-op that does not flip `changed`).
	const removeFlat = (
		block: Record<string, unknown>,
		keys: string[] | undefined,
		prev: Record<string, unknown>,
	): void => {
		if (!keys) return;
		for (const key of keys) {
			if (!(key in block)) continue;
			prev[key] = block[key];
			delete block[key];
		}
	};
	const previous = { persistent: {} as Record<string, unknown>, transient: {} as Record<string, unknown> };
	applyFlat(persistent, patches.persistentPatch, previous.persistent);
	applyFlat(transient, patches.transientPatch, previous.transient);
	removeFlat(persistent, patches.removeKeysPersistent, previous.persistent);
	removeFlat(transient, patches.removeKeysTransient, previous.transient);
	obj.persistent = persistent;
	obj.transient = transient;
	const content = `${JSON.stringify(obj, null, 2)}\n`;
	return { content, previous, changed: content !== original };
}

// SIO-933: read-modify-write a cluster-defaults component-template JSON: set the nested
// settings.index.lifecycle.name (the ILM binding). Creates the nested path if absent (the
// `lifecycle` object often doesn't exist in a sparse template yet). Preserves every other setting +
// 2-space indent + trailing newline. Captures the previous name for the diff + no-op guard. Throws
// on bad JSON. Mirrors setClusterDefaultShards. (Pure; unit-tested.)
export function setComponentTemplateLifecycleName(
	json: string,
	policyName: string,
): { content: string; previous?: string; changed: boolean } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("component-template JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	const settings = (obj.settings ?? {}) as Record<string, unknown>;
	const index = (settings.index ?? {}) as Record<string, unknown>;
	const lifecycle = (index.lifecycle ?? {}) as Record<string, unknown>;
	const previous = typeof lifecycle.name === "string" ? lifecycle.name : undefined;
	lifecycle.name = policyName;
	index.lifecycle = lifecycle;
	settings.index = index;
	obj.settings = settings;
	return { content: `${JSON.stringify(obj, null, 2)}\n`, previous, changed: previous !== policyName };
}

// SIO-978: agent-side path for a per-deployment index-template JSON. ${cluster}/${template} are
// literal placeholders. One file per index template under environments/<cluster>/index-templates/
// (consumed by the dedicated index-templates stack -> modules/index-template).
function indexTemplateTemplate(): string {
	return (
		// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-978 - ${cluster}/${template} are literal path placeholders substituted by .replace
		process.env.ELASTIC_IAC_INDEX_TEMPLATE_TEMPLATE ?? "environments/${cluster}/index-templates/${template}.json"
	);
}

// SIO-1019: agent-side path for a per-deployment @custom ingest-pipeline JSON. ${cluster}/${name} are
// literal placeholders. One file per pipeline under environments/<cluster>/ingest-pipelines/ (consumed
// by the dedicated ingest-pipelines stack, which auto-discovers *.json in its config_path).
function ingestPipelineTemplate(): string {
	return (
		// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-1019 - ${cluster}/${name} are literal path placeholders substituted by .replace
		process.env.ELASTIC_IAC_INGEST_PIPELINE_TEMPLATE ?? "environments/${cluster}/ingest-pipelines/${name}.json"
	);
}

// SIO-978: build the index-template config JSON file content from a parsed request entry, in the
// shape modules/index-template consumes. settings/mappings are TOP-LEVEL object keys (the module's
// index_templates object type reads each.value.settings and wraps it in the resource's template{}
// block itself -- a `template`-nested key here would be dropped by Terraform's object type
// conversion and the ILM binding silently lost; confirmed in the SIO-977 wiring MR !180). ILM binding
// rides in settings.index.lifecycle.name (the provider has no separate ILM argument on the
// index_template resource). The data_stream block is emitted only when a data-stream flag is present;
// allow_custom_routing is an 8.x-only provider field, so it is included ONLY when explicitly true
// (eu-b2b is 9.x; false is the ES default). 2-space indent + trailing newline match the repo house
// style. (Pure; unit-tested.)
export function buildIndexTemplateConfig(entry: {
	name: string;
	indexPatterns: string[];
	composedOf?: string[];
	ignoreMissingComponentTemplates?: string[];
	priority?: number;
	lifecycleName?: string;
	dataStreamHidden?: boolean;
	dataStreamAllowCustomRouting?: boolean;
}): string {
	const config: Record<string, unknown> = {
		name: entry.name,
		index_patterns: entry.indexPatterns,
		composed_of: entry.composedOf ?? [],
		priority: entry.priority ?? 100,
	};
	if (entry.ignoreMissingComponentTemplates && entry.ignoreMissingComponentTemplates.length > 0) {
		config.ignore_missing_component_templates = entry.ignoreMissingComponentTemplates;
	}
	// Emit data_stream only when a flag is set. allow_custom_routing is 8.x-only -> only when true.
	if (entry.dataStreamHidden !== undefined || entry.dataStreamAllowCustomRouting === true) {
		const dataStream: Record<string, unknown> = { hidden: entry.dataStreamHidden ?? false };
		if (entry.dataStreamAllowCustomRouting === true) dataStream.allow_custom_routing = true;
		config.data_stream = dataStream;
	}
	if (entry.lifecycleName) {
		// SIO-978: settings live at the TOP LEVEL of the object (the module reads each.value.settings,
		// not each.value.template.settings). A `template`-nested key would be silently dropped by
		// Terraform's object type conversion -> the ILM binding would be lost (caught in SIO-977 MR !180).
		config.settings = { index: { lifecycle: { name: entry.lifecycleName } } };
	}
	return `${JSON.stringify(config, null, 2)}\n`;
}

// SIO-918: agent-side path for a per-deployment per-space JSON. ${cluster}/${space} are literal
// placeholders. One file per space under environments/<cluster>/spaces/.
function spaceTemplate(): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster}/${space} are literal path placeholders substituted by .replace
	return process.env.ELASTIC_IAC_SPACE_TEMPLATE ?? "environments/${cluster}/spaces/${space}.json";
}

// SIO-918: agent-side path for a per-deployment security aggregate JSON. ${cluster} is the
// literal placeholder. ONE aggregate file (roles + role_mappings + api_keys) per deployment.
function securityTemplate(): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster} is a literal path placeholder substituted by .replace
	return process.env.ELASTIC_IAC_SECURITY_TEMPLATE ?? "environments/${cluster}/security/security.json";
}

// SIO-920: agent-side path for a Kibana dashboard NDJSON export. ${cluster}/${space}/${name} are
// literal placeholders. One NDJSON file per dashboard; the filename is <space>__<name>.ndjson.
// Lazy process.env read (no module-scope Bun.env; the web app runs Vite SSR where a top-level
// Bun.env reference throws "Bun is not defined").
function dashboardNdjsonTemplate(): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster}/${space}/${name} are literal path placeholders substituted by .replace
	return process.env.ELASTIC_IAC_DASHBOARD_TEMPLATE ?? "environments/${cluster}/dashboards/${space}__${name}.ndjson";
}

// SIO-920: resolve the dashboard NDJSON path. Substitutes ${cluster} via deploymentJsonPath, then
// the ${space}/${name} placeholders (mirrors proposeSpaceChange's ${space} replace). (Pure.)
function dashboardNdjsonPath(template: string, cluster: string, space: string, name: string): string {
	return deploymentJsonPath(template, cluster)
		.replace(/\$\{space\}/g, space)
		.replace(/\$\{name\}/g, name);
}

// SIO-918: read-modify-write a per-space JSON: set name / description / color. Preserves
// disabled_features, solution, initials, and every other field + 2-space indent + trailing
// newline. Captures previous values for the diff. Only sets the fields the caller provides.
// Throws on bad JSON. (Pure; unit-tested.)
export function setSpaceFields(
	json: string,
	changes: { displayName?: string; description?: string; color?: string },
): { content: string; previousName?: string; previousDescription?: string; previousColor?: string; changed: boolean } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("space JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	let changed = false;

	const previousName = typeof obj.name === "string" ? obj.name : undefined;
	if (changes.displayName !== undefined) {
		obj.name = changes.displayName;
		changed = true;
	}
	const previousDescription = typeof obj.description === "string" ? obj.description : undefined;
	if (changes.description !== undefined) {
		obj.description = changes.description;
		changed = true;
	}
	const previousColor = typeof obj.color === "string" ? obj.color : undefined;
	if (changes.color !== undefined) {
		obj.color = changes.color;
		changed = true;
	}

	return { content: `${JSON.stringify(obj, null, 2)}\n`, previousName, previousDescription, previousColor, changed };
}

// SIO-918: cluster-level / superuser privileges that escalate access -- granting any of these
// (or "all" / "*") is always surfaced as the HIGHEST-risk change. Match is conservative: any
// cluster privilege at all, plus the "all"/superuser keywords anywhere. (Pure; unit-tested.)
export function isPrivilegeEscalation(grant: {
	cluster?: string[];
	indexPrivileges?: string[];
	kibanaPrivileges?: string[];
}): boolean {
	const hi = (xs?: string[]) => (xs ?? []).some((p) => p === "all" || p === "*" || p.toLowerCase() === "superuser");
	// Any cluster-level grant is privileged by definition; "all"/superuser anywhere is escalation.
	return (
		(grant.cluster?.length ?? 0) > 0 || hi(grant.cluster) || hi(grant.indexPrivileges) || hi(grant.kibanaPrivileges)
	);
}

// SIO-918: read-modify-write the security aggregate JSON to ADD privileges to ONE existing role.
// ADDITIVE ONLY: unions new cluster privileges, index privileges (onto matching index entries or
// a new entry), and Kibana application privileges (onto a matching application or a new entry).
// CRITICAL: role_mappings and api_keys are left BYTE-FOR-BYTE untouched (the api_keys block holds
// secrets and must never be read into the diff). Never removes a privilege. Preserves 2-space
// indent + trailing newline. Throws on bad JSON or an unknown role (so the proposer surfaces a
// clarify rather than inventing a role). (Pure; unit-tested.)
export function addRolePrivileges(
	json: string,
	roleName: string,
	grant: {
		cluster?: string[];
		index?: { names: string[]; privileges: string[] };
		kibana?: { application: string; privileges: string[]; resources?: string[] };
	},
): { content: string; addedCluster: string[]; addedIndex: string[]; addedKibana: string[]; changed: boolean } {
	const parsed: unknown = JSON.parse(json);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("security JSON is not an object");
	}
	const obj = parsed as Record<string, unknown>;
	const roles = (obj.roles ?? {}) as Record<string, unknown>;
	const role = roles[roleName];
	if (!role || typeof role !== "object" || Array.isArray(role)) {
		throw new Error(`unknown role '${roleName}'`);
	}
	const r = role as Record<string, unknown>;
	const addedCluster: string[] = [];
	const addedIndex: string[] = [];
	const addedKibana: string[] = [];

	if (grant.cluster && grant.cluster.length > 0) {
		const cur = Array.isArray(r.cluster)
			? (r.cluster as unknown[]).filter((x): x is string => typeof x === "string")
			: [];
		for (const p of grant.cluster) if (!cur.includes(p)) addedCluster.push(p);
		r.cluster = [...cur, ...addedCluster];
	}

	const indexGrant = grant.index;
	if (indexGrant && indexGrant.privileges.length > 0) {
		const indices = Array.isArray(r.indices) ? (r.indices as Array<Record<string, unknown>>) : [];
		// Find an index entry with the same `names` set; else append a new one.
		const sameNames = (a: unknown): boolean =>
			Array.isArray(a) && a.length === indexGrant.names.length && indexGrant.names.every((n) => a.includes(n));
		let entry = indices.find((e) => sameNames(e.names));
		if (!entry) {
			entry = { names: [...indexGrant.names], privileges: [] };
			indices.push(entry);
		}
		const cur = Array.isArray(entry.privileges)
			? (entry.privileges as unknown[]).filter((x): x is string => typeof x === "string")
			: [];
		for (const p of indexGrant.privileges) if (!cur.includes(p)) addedIndex.push(p);
		entry.privileges = [...cur, ...addedIndex];
		r.indices = indices;
	}

	const kibanaGrant = grant.kibana;
	if (kibanaGrant && kibanaGrant.privileges.length > 0) {
		const apps = Array.isArray(r.applications) ? (r.applications as Array<Record<string, unknown>>) : [];
		let entry = apps.find((e) => e.application === kibanaGrant.application);
		if (!entry) {
			entry = { application: kibanaGrant.application, privileges: [], resources: kibanaGrant.resources ?? ["*"] };
			apps.push(entry);
		}
		const cur = Array.isArray(entry.privileges)
			? (entry.privileges as unknown[]).filter((x): x is string => typeof x === "string")
			: [];
		for (const p of kibanaGrant.privileges) if (!cur.includes(p)) addedKibana.push(p);
		entry.privileges = [...cur, ...addedKibana];
		r.applications = apps;
	}

	const changed = addedCluster.length > 0 || addedIndex.length > 0 || addedKibana.length > 0;
	return { content: `${JSON.stringify(obj, null, 2)}\n`, addedCluster, addedIndex, addedKibana, changed };
}

// Strip callTool's "[status] body" prefix and, for the GitLab files API, decode the
// base64 `content` field into the raw file text.
function extractFileContent(toolResult: string): string {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return toolResult;
	try {
		const parsed: unknown = JSON.parse(toolResult.slice(jsonStart));
		if (typeof parsed === "object" && parsed !== null && "content" in parsed) {
			const c = (parsed as { content?: unknown; encoding?: unknown }).content;
			if (typeof c === "string") {
				const enc = (parsed as { encoding?: unknown }).encoding;
				return enc === "base64" ? Buffer.from(c, "base64").toString("utf8") : c;
			}
		}
	} catch {
		// fall through
	}
	return toolResult;
}

// No-op guard: true when re-serializing the edited object yields the same bytes as the
// current file -- i.e. the proposed change would produce an empty diff. All three GitOps
// proposers emit content via JSON.stringify(obj, null, 2) + "\n", so normalize the
// original the same way before comparing (formatting/whitespace must not read as a
// change). Lets a proposer short-circuit before opening a pointless MR. (Pure.)
export function isUnchangedConfig(updatedContent: string, originalJson: string): boolean {
	try {
		return updatedContent === `${JSON.stringify(JSON.parse(originalJson), null, 2)}\n`;
	} catch {
		return false;
	}
}

// SIO-921: classify a callTool() result for a GitLab call. callTool returns "[<status>] <json>"
// on a real API call and "[gitlab token not configured ...]" / "[<tool> error: ...]" /
// "[<tool> unavailable - ...]" placeholders on failure (none of which start with "[4"/"[5").
// A read must be a clean 2xx (file present) or 404 (absent); anything else (token/timeout/5xx/
// placeholder) is an UNKNOWN result that must block -- never silently treated as "exists" or
// "committed". (Pure; unit-tested. Mirrors proposeDashboardChange, SIO-920.)
export function isGitlabSuccess(result: string): boolean {
	return /^\[2\d\d\]/.test(result);
}

export function isGitlabNotFound(result: string): boolean {
	return result.startsWith("[404");
}

// SIO-1012: the repo's CI (scripts/ci-generate-pipeline.sh) discovers applyable combos by
// `find environments/<dep>/<stack>/terraform.tfvars`. A (deployment, stack) with config JSON but
// NO terraform.tfvars is NOT a provisioned stack instance: CI emits a no-op and the merge does not
// apply. This checks for that tfvars so the proposer can flag it (warn-only -- the agent never
// writes the tfvars; provisioning is a repo/CI/human responsibility). Returns true ONLY on a
// definitive 404; a token/auth/other read error returns false (treated as "present/unknown") so a
// GitLab fault never false-alarms as "unprovisioned". (Pure aside from the one read.)
async function isStackInstanceMissing(cluster: string, stack: string): Promise<boolean> {
	if (!cluster || !stack) return false;
	const tfvarsPath = `environments/${cluster}/${stack}/terraform.tfvars`;
	const raw = await callTool("gitlab_get_file_content", { filePath: tfvarsPath });
	return isGitlabNotFound(raw);
}

// version-upgrade: propose the change as a GitLab config edit + branch + commit via
// the API (no clone, no terraform, no local git). CI computes the plan on the MR.
async function proposeVersionUpgrade(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const version = req.version ?? "";
	const filePath = deploymentJsonPath(deploymentJsonTemplate(), cluster);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// SIO-921: an UNKNOWN read (neither 2xx nor 404 -- token/timeout/5xx/error placeholder) blocks
	// with a clear message rather than failing as a confusing "did not parse as JSON" downstream.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	let updated: { content: string; previous?: string };
	try {
		updated = setDeploymentVersion(extractFileContent(raw), version);
	} catch {
		return {
			blockedReason: `Could not read ${filePath} as JSON (got: ${raw.slice(0, 120)}).`,
			messages: [new AIMessage(`Cannot propose the change: ${filePath} did not parse as JSON.`)],
		};
	}

	// No-op guard: already at the target version, so an MR would have an empty diff.
	// Surface immediate feedback and open nothing (no branch, no commit, no review gate).
	if (updated.previous === version) {
		return {
			noopReason: `${cluster} is already on ${version}; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: ${cluster} is already on Elasticsearch ${version}, so there is nothing to merge.`,
				),
			],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: upgrade Elasticsearch ${updated.previous ?? "?"} -> ${version}`,
	});
	// SIO-921: a clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]")
	// or non-2xx must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}
	const committed = true;

	const diff = `${filePath}\n- "version": "${updated.previous ?? "?"}"\n+ "version": "${version}"`;
	return {
		branch,
		proposedFilePath: filePath,
		proposedFiles: [filePath],
		previousVersion: updated.previous ?? "",
		proposedDiff: diff,
		precheckPassed: committed,
	};
}

// SIO-879: tier-resize via the GitOps proposer -- edit elasticsearch.<tier>.size/max_size
// in the deployment JSON and open an MR via the API. Mirrors proposeVersionUpgrade.
async function proposeTierResize(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const tier = req.tier ?? "";
	const filePath = deploymentJsonPath(deploymentJsonTemplate(), cluster);
	const branch = branchName(req);

	if (!tier || (req.newSizeGb == null && req.newMaxGb == null)) {
		return {
			blockedReason: "Tier-resize needs a tier and a new size and/or max.",
			messages: [new AIMessage("Cannot propose the change: name the tier and a new size and/or max (GB).")],
		};
	}

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// SIO-921: an UNKNOWN read (neither 2xx nor 404 -- token/timeout/5xx/error placeholder) blocks
	// with a clear message rather than failing as a confusing "did not parse as JSON" downstream.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	let updated: { content: string; previousSize?: string; previousMax?: string };
	try {
		updated = setDeploymentTierSize(extractFileContent(raw), tier, req.newSizeGb, req.newMaxGb);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			blockedReason: `Could not edit ${tier} tier in ${filePath}: ${reason}.`,
			messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
		};
	}

	// No-op guard: requested sizing already matches the deployment JSON (empty diff).
	if (isUnchangedConfig(updated.content, extractFileContent(raw))) {
		return {
			noopReason: `${tier} tier already has the requested sizing; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: the ${tier} tier already has the requested sizing, so there is nothing to merge.`,
				),
			],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const target = [
		req.newSizeGb != null ? `size ${req.newSizeGb}g` : "",
		req.newMaxGb != null ? `max ${req.newMaxGb}g` : "",
	]
		.filter(Boolean)
		.join(", ");
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: resize ${tier} tier (${target})`,
	});
	// SIO-921: a clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]")
	// or non-2xx must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}
	const committed = true;

	const diffLines = [`${filePath} (elasticsearch.${tier})`];
	if (req.newSizeGb != null)
		diffLines.push(`- "size": "${updated.previousSize ?? "?"}"\n+ "size": "${req.newSizeGb}g"`);
	if (req.newMaxGb != null)
		diffLines.push(`- "max_size": "${updated.previousMax ?? "?"}"\n+ "max_size": "${req.newMaxGb}g"`);
	return {
		branch,
		proposedFilePath: filePath,
		proposedFiles: [filePath],
		proposedDiff: diffLines.join("\n"),
		precheckPassed: committed,
	};
}

// SIO-880: ilm-rollout via the GitOps proposer -- deep-merge a phase patch into the
// cluster's lifecycle-policy JSON and open an MR via the API. Mirrors proposeTierResize.
// SIO-932: result of committing ONE ILM policy file onto an already-created branch. A discriminated
// union so the caller (single- or multi-policy) handles a block uniformly. On ok=true the file is
// already committed to `branch`; the caller aggregates filePath/diffLines/retentionChange/policyCreated.
type IlmCommitResult =
	// SIO-933: `noop` marks the "already has the requested values" block specifically (vs a real
	// failure like a read/parse/commit error). The single-file proposer treats a noop policy + a
	// pending bindTemplate as "skip the policy, still do the bind"; every other false is a hard block.
	| { ok: false; blockedReason: string; message: string; noop?: boolean }
	| {
			ok: true;
			filePath: string;
			diffLines: string[];
			retentionChange: { from: string; to: string } | null;
			policyCreated: boolean;
			// SIO-983: rendered live-parity advisory (draft vs LIVE cluster). "" when the live policy
			// could not be read (deployment not connected to this MCP) or the draft matches live.
			liveParity?: string;
	  };

// SIO-932: read -> merge/create -> structural-validate -> commit one ILM policy file onto `branch`,
// returning the per-file diff + risk flags (or a block reason). Extracted verbatim from the original
// single-file proposeIlmChange body so the single path is byte-identical and the multi-file
// orchestrator can loop it onto ONE shared branch. The branch is created by the CALLER (once),
// never here, so N policies share one branch -> one MR.
async function commitOneIlmPolicy(
	cluster: string,
	branch: string,
	policy: string,
	patch: Record<string, unknown> | undefined,
	sourcePolicy: string | undefined,
	// SIO-1001: when set, this is the AUTHORITATIVE complete policy body for a from-scratch (404)
	// onboard -- used verbatim as the file instead of copying a sibling/canonical base, so absent
	// phases stay absent. Ignored for the copy (sourcePolicy) and modify-existing paths.
	fullPolicy?: Record<string, unknown>,
): Promise<IlmCommitResult> {
	const filePath = deploymentJsonPath(ilmPolicyTemplate(), cluster, policy);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			ok: false,
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			message: "Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.",
		};
	}
	// SIO-899: a 404 means the policy file is not tracked in IaC yet (the policy may exist
	// live but was never onboarded). Instead of dead-ending, CREATE it: a brand-new policy
	// is the flat DSL `{ name, ...phases }` -- the same shape phasesPatch already uses -- so
	// merging the patch onto a `{ name }` stub yields the full new file. `previous` then has
	// undefined leaves, so the diff renders every field as an addition and
	// detectRetentionReduction returns null (no prior retention to reduce). Match 404 only so
	// a 401/403 (auth/scope) is NOT treated as "untracked"; those fall through to the modify
	// path and surface as a JSON-parse edit failure, exactly as before.
	let updated: { content: string; previous: Record<string, unknown> };
	let policyCreated = false;
	// SIO-921: an UNKNOWN read (neither 2xx nor 404 -- token/timeout/5xx/error placeholder) must
	// block rather than fall through; only a real 404 carries the per-stack handling below.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			ok: false,
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			message: "Cannot propose the change: I could not read the target file from the GitOps repo.",
		};
	}
	const patchObj = (patch ?? {}) as Record<string, unknown>;

	// SIO-931 copy-from-reference: the base is the source policy (already correctly shaped). The
	// source must be readable -- a copy of a policy we can't read is never silently downgraded.
	if (sourcePolicy) {
		const srcPath = deploymentJsonPath(ilmPolicyTemplate(), cluster, sourcePolicy);
		const srcRaw = await callTool("gitlab_get_file_content", { filePath: srcPath });
		if (!isGitlabSuccess(srcRaw)) {
			return {
				ok: false,
				blockedReason: `Could not read reference policy '${sourcePolicy}' on '${cluster}': ${srcRaw.slice(0, 80)}.`,
				message: `I couldn't read reference policy '${sourcePolicy}' on '${cluster}' (${srcRaw.slice(0, 40)}). Name an existing policy to copy, or specify the phases directly.`,
			};
		}
		let srcObj: Record<string, unknown>;
		try {
			srcObj = JSON.parse(extractFileContent(srcRaw)) as Record<string, unknown>;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				blockedReason: `Reference policy '${sourcePolicy}' on '${cluster}' is not valid JSON: ${reason}.`,
				message: `Cannot propose the change: reference policy '${sourcePolicy}' on '${cluster}' did not parse as JSON.`,
			};
		}
		srcObj.name = policy;
		policyCreated = !isGitlabSuccess(raw); // target is new if it 404s
		updated = mergeIlmPhases(JSON.stringify(srcObj), patchObj);
	} else if (raw.startsWith("[404")) {
		policyCreated = true;
		// SIO-1001 authoritative full-body: the user supplied the COMPLETE file, so use it verbatim --
		// the committed phase set is exactly what they gave, with NO sibling/canonical phases bleeding
		// in. `name` is forced to the policy basename (the file's name must match its filename). We
		// still run mergeIlmPhases (with patchObj, normally empty here) so `previous` is populated and
		// the structural/retention gates below see a normal {content, previous} pair.
		if (fullPolicy) {
			const base: Record<string, unknown> = { ...fullPolicy, name: policy };
			updated = mergeIlmPhases(JSON.stringify(base), patchObj);
		} else {
			// SIO-931 from-scratch: learn the shape from a sibling policy in this cluster's dir; fall
			// back to the canonical skeleton when the cluster has no lifecycle-policies/ files yet.
			const dirPath = `environments/${cluster}/lifecycle-policies`;
			const siblings = parseRepoTreeFiles(await callTool("gitlab_get_repository_tree", { path: dirPath })).filter(
				(f) => f.endsWith(".json") && f !== `${policy}.json`,
			);
			const preferred = process.env.ELASTIC_IAC_ILM_TEMPLATE_POLICY
				? `${process.env.ELASTIC_IAC_ILM_TEMPLATE_POLICY}.json`
				: "basic-lifecycle-logs.json";
			const templateFile = siblings.includes(preferred) ? preferred : siblings[0];
			let base: Record<string, unknown> = { name: policy, ...structuredClone(CANONICAL_ILM_SHAPE) };
			if (templateFile) {
				const tplRaw = await callTool("gitlab_get_file_content", { filePath: `${dirPath}/${templateFile}` });
				if (isGitlabSuccess(tplRaw)) {
					try {
						const tplObj = JSON.parse(extractFileContent(tplRaw)) as Record<string, unknown>;
						tplObj.name = policy;
						base = tplObj;
					} catch {
						log.warn({ cluster, templateFile }, "ilm template sibling is not valid JSON; using canonical shape");
					}
				} else {
					log.warn({ cluster, templateFile }, "ilm template sibling unreadable; using canonical shape");
				}
			} else {
				log.warn({ cluster }, "no sibling ILM policy to template from; using canonical shape");
			}
			updated = mergeIlmPhases(JSON.stringify(base), patchObj);
		}
	} else {
		// SIO-1001: an authoritative full-body request that targets an ALREADY-TRACKED policy is
		// treated as a patch of the named phases onto the existing file (additive merge). We do NOT
		// destructively drop phases the body omits on a live policy -- the verbatim-replace path is
		// the from-scratch (404) onboard above; on an existing policy this stays conservative.
		const effectivePatch = fullPolicy ? { ...fullPolicy, name: policy } : patchObj;
		try {
			updated = mergeIlmPhases(extractFileContent(raw), effectivePatch);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				blockedReason: `Could not edit ${filePath}: ${reason}.`,
				message: `Cannot propose the change: ${reason}.`,
			};
		}

		// No-op guard: the phase patch matches the current policy (empty diff). Only a
		// modify can be a no-op; a freshly created file is always a change.
		if (isUnchangedConfig(updated.content, extractFileContent(raw))) {
			return {
				ok: false,
				noop: true, // SIO-933: distinguishes "nothing to change" from a real failure (bind-only path).
				blockedReason: `Policy '${policy}' on '${cluster}' already has the requested phase values; no change needed.`,
				message: `No change needed: policy '${policy}' on '${cluster}' already has the requested phase values, so there is nothing to merge.`,
			};
		}
	}

	// SIO-931: structural gate -- never commit a policy CI's terraform plan would reject.
	const updatedObj = JSON.parse(updated.content) as Record<string, unknown>;
	const valid = validateIlmPolicy(updatedObj);
	if (!valid.ok) {
		return {
			ok: false,
			blockedReason: `Proposed ILM policy '${policy}' is structurally invalid: ${valid.reason}`,
			message: `I won't open an MR: the proposed '${policy}' policy doesn't match the repo schema. ${valid.reason}`,
		};
	}

	// SIO-990: semantic gate on the MERGED policy -- phase min_age must not decrease across
	// hot -> warm -> cold -> frozen -> delete. Catches a typo like delete.min_age=4d below
	// frozen.min_age=7d that the structural schema and the danger denylist both miss, BEFORE
	// the commit (so no branch is left with an un-appliable policy). validateIlmPolicy ran first,
	// so updatedObj is schema-shaped here.
	const ordering = validateIlmPhaseOrdering(updatedObj);
	if (!ordering.ok) {
		return {
			ok: false,
			blockedReason: `Proposed ILM policy '${policy}' has an invalid phase ordering: ${ordering.reason}`,
			message: `I won't open an MR: the proposed '${policy}' policy has an invalid phase ordering. ${ordering.reason}`,
		};
	}

	const retentionChange = detectRetentionReduction(updated.previous, patchObj);

	const fields = Object.keys(patchObj).join(", ") || (sourcePolicy ? `copy of ${sourcePolicy}` : "copy");
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: ${policyCreated ? "create " : ""}ILM ${policy} (${fields})`,
		// SIO-899: gitlab_commit_file upserts (flips update<->create on a file-exists
		// mismatch), but pass the right action up front to skip the wasted first attempt.
		action: policyCreated ? "create" : "update",
	});
	// SIO-921: a clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]")
	// or non-2xx must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			ok: false,
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			message: "Cannot propose the change: the GitLab commit failed.",
		};
	}

	// Human diff: one -/+ pair per touched leaf, walking the previous mirror against patch.
	// A created policy has no prior values, so every leaf renders as an addition ("?"->value).
	const diffLines: string[] = [`${filePath} (${policyCreated ? "NEW ILM policy" : "ILM"} ${policy})`];
	const walk = (prev: Record<string, unknown>, p: Record<string, unknown>, prefix: string): void => {
		for (const [key, value] of Object.entries(p)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				const prevChild = (prev[key] ?? {}) as Record<string, unknown>;
				walk(prevChild, value as Record<string, unknown>, path);
			} else {
				// Prefix the dotted phase path, then the JSON field name verbatim so the diff
				// reads as a real JSON edit (e.g. `[delete] - "min_age": "30d" + "min_age": "60d"`).
				// A brand-new field has no prior value; render "?" to match proposeTierResize.
				const before = prev[key] === undefined ? '"?"' : JSON.stringify(prev[key]);
				diffLines.push(
					`[${path.includes(".") ? path.slice(0, path.lastIndexOf(".")) : path}] - "${key}": ${before}\n+ "${key}": ${JSON.stringify(value)}`,
				);
			}
		}
	};
	// SIO-933: a CREATE (copy or from-scratch) has no prior values, and on a copy the committed file
	// is mostly inherited fields that are NOT in patchObj (the diff used to show only the overrides,
	// hiding the renamed `name` and every inherited phase -- so the reviewer couldn't confirm the
	// copy). Walk the FULL resulting policy with an empty `prev` so every leaf renders as an addition.
	// A MODIFY keeps the terse per-override walk (its prior values are real and only the patch changed).
	if (policyCreated) {
		walk({}, updatedObj, "");
	} else {
		walk(updated.previous, patchObj, "");
	}

	// SIO-983: live-parity advisory. The committed file is the repo source copied forward; if that
	// source has drifted from the LIVE cluster (e.g. extra forcemerge/shrink/wait_for_snapshot phases
	// the user never asked for), surface it on the review card. Read the live policy and diff the
	// normalised live shape against the drafted object. Best-effort: a deployment that isn't connected
	// to this MCP returns a placeholder -> parseEsIlmPolicyResponse yields null -> no advisory (we do
	// NOT block; this is a non-blocking nudge). Never throws.
	const liveParity = await computeIlmLiveParityFromTool(cluster, policy, sourcePolicy, updatedObj);

	return { ok: true, filePath, diffLines, retentionChange, policyCreated, liveParity };
}

// SIO-983: read the live ILM policy via the elastic-iac MCP and render the parity advisory against a
// drafted policy object. For a copy/rename the TARGET name isn't live yet, so the meaningful live
// comparison is the SOURCE policy (the draft is meant to be a like-for-like copy of what the source
// is LIVE). For a modify, the target's own live state is the right comparison. Returns "" when the
// live policy can't be read (deployment not connected / 404) or the draft matches live.
// (Best-effort; never throws -- isolates the live read + normalise + diff from the proposer.)
async function computeIlmLiveParityFromTool(
	cluster: string,
	policy: string,
	sourcePolicy: string | undefined,
	draftObj: Record<string, unknown>,
): Promise<string> {
	try {
		const livePolicyName = sourcePolicy ?? policy;
		const raw = await callTool("elastic_ilm_get_lifecycle", { policy: livePolicyName, deployment: cluster });
		const live = parseEsIlmPolicyResponse(raw);
		if (!live) return "";
		const parity = computeIlmLiveParity(esIlmPolicyToFlatDsl(live), draftObj);
		return renderLiveParity(parity);
	} catch {
		return "";
	}
}

// SIO-933: bind a cluster-defaults component-template to a policy by setting its nested
// settings.index.lifecycle.name, committed onto the SAME caller-created branch as the ILM policy
// (one branch -> one MR). Returns the IlmCommitResult shape so the proposer aggregates it exactly
// like a policy commit. A 404 on the template BLOCKS the whole turn (atomic -- never open a half
// MR). A no-op (already bound to this policy) returns ok:true + skipped so the caller keeps a real
// policy change while skipping only this commit. The bound template is NOT structurally validated
// (validateIlmPolicy is for ILM policy files); consistent with proposeClusterDefaultChange.
async function commitBoundTemplate(
	cluster: string,
	branch: string,
	bindTemplate: string,
	policyName: string,
): Promise<IlmCommitResult & { skipped?: boolean }> {
	// clusterDefaultTemplate() carries a ${template} placeholder that deploymentJsonPath does not
	// substitute (it only does ${cluster}/${policy}), so replace it here exactly as
	// proposeClusterDefaultChange does.
	const filePath = deploymentJsonPath(clusterDefaultTemplate(), cluster).replace(/\$\{template\}/g, bindTemplate);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			ok: false,
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			message: "Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.",
		};
	}
	// A real 404 means the bind target isn't tracked in IaC -- block the whole turn (atomic; no MR).
	if (isGitlabNotFound(raw)) {
		return {
			ok: false,
			blockedReason: `Bind target component-template '${bindTemplate}' not found on '${cluster}' (${filePath}).`,
			message: `I won't open a partial MR: the component-template to bind ('${bindTemplate}') does not exist on '${cluster}' (${filePath}). Check the template basename, or create it first.`,
		};
	}
	// SIO-921 idiom: an UNKNOWN read (neither 2xx nor 404) must block, not fall through.
	if (!isGitlabSuccess(raw)) {
		return {
			ok: false,
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			message: "Cannot propose the change: I could not read the bind-target template from the GitOps repo.",
		};
	}

	let updated: ReturnType<typeof setComponentTemplateLifecycleName>;
	try {
		updated = setComponentTemplateLifecycleName(extractFileContent(raw), policyName);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			message: `Cannot propose the change: ${reason}.`,
		};
	}

	// No-op: the template already points at this policy. Skip ONLY this commit so a real policy
	// change in the same turn still opens its MR.
	if (!updated.changed || isUnchangedConfig(updated.content, extractFileContent(raw))) {
		return { ok: true, skipped: true, filePath, diffLines: [], retentionChange: null, policyCreated: false };
	}

	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: bind ${bindTemplate} lifecycle -> ${policyName}`,
		action: "update",
	});
	if (!isGitlabSuccess(commit)) {
		return {
			ok: false,
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			message: "Cannot propose the change: the GitLab commit failed.",
		};
	}

	const diffLines = [
		`${filePath} (component-template ${bindTemplate})`,
		`[settings.index.lifecycle] - "name": ${JSON.stringify(updated.previous ?? "?")}\n+ "name": ${JSON.stringify(policyName)}`,
	];
	return { ok: true, filePath, diffLines, retentionChange: null, policyCreated: false };
}

export async function proposeIlmChange(state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	// SIO-933: a component-template's settings.index.lifecycle.name is a single scalar -- it binds to
	// exactly one policy. A request naming >=2 policies AND a bind target is ambiguous; block early
	// (before the multi-file fan-out) with guidance rather than silently picking one.
	if (req.bindTemplate && req.ilmPolicies && req.ilmPolicies.length >= 2) {
		return {
			blockedReason: "Cannot bind a component-template to multiple ILM policies in one request.",
			messages: [
				new AIMessage(
					"A component-template's lifecycle binds to exactly one policy. You named multiple policies and a bind target -- split this into one request per policy, or drop the bind.",
				),
			],
		};
	}
	// SIO-932: a request naming >=2 policy files fans out to the multi-file orchestrator
	// (one branch, one MR, all files). parseIntentJson only sets ilmPolicies for >=2 entries.
	if (req.ilmPolicies && req.ilmPolicies.length >= 2) {
		return proposeIlmChanges(state, req);
	}

	const cluster = req.cluster ?? "";
	const policy = req.policyName ?? "";
	const patch = req.phasesPatch;

	if (!policy) {
		return {
			blockedReason: "ILM change needs a policy name.",
			messages: [new AIMessage("Cannot propose the change: name the policy to change or create.")],
		};
	}
	// SIO-933: a bind-only request (point a template at an already-correct policy) carries no phase
	// patch and no sourcePolicy, so the mandatory-phase guard must not fire when bindTemplate is set.
	// SIO-1001: an authoritative full-body onboard (ilmFullPolicy) also carries no phasesPatch; it is
	// itself the change, so it must not trip this guard.
	if (!req.sourcePolicy && !req.bindTemplate && !req.ilmFullPolicy && (!patch || Object.keys(patch).length === 0)) {
		return {
			blockedReason: "ILM change needs at least one phase field to change (or a sourcePolicy to copy).",
			messages: [new AIMessage("Cannot propose the change: name a phase field to change, or a policy to copy from.")],
		};
	}

	// SIO-990: pin to the active change's branch on an amend so the corrected commit updates the
	// EXISTING MR in place; branchName(req) on a fresh proposal.
	const branch = resolveBranch(state, req);
	// SIO-899: gitlab_create_branch is idempotent (a re-run reuses the branch); create it before
	// the commit. Kept here (not in the helper) so the multi-file path creates one shared branch.
	await callTool("gitlab_create_branch", { branch, ref: "main" });

	// Commit the policy file. SIO-933: a NO-OP policy (already has the requested values) does NOT
	// block when a bind is pending -- we skip the policy commit and still open the MR for the bind.
	// Any other policy failure (read/parse/commit error) is a hard block. A bind-only request (no
	// patch, no sourcePolicy) is itself a no-op against the unchanged file, so it lands here too.
	const policyFiles: string[] = [];
	const policyDiffs: string[] = [];
	let retentionChange: { from: string; to: string } | null = null;
	let policyCreated = false;
	let liveParity = ""; // SIO-983: draft-vs-live advisory from the single committed policy.
	if (patch || req.sourcePolicy || req.ilmFullPolicy) {
		const result = await commitOneIlmPolicy(cluster, branch, policy, patch, req.sourcePolicy, req.ilmFullPolicy);
		if (!result.ok && !(result.noop && req.bindTemplate)) {
			// SIO-1020: a no-op policy (already has the requested values) with no pending bind is a
			// neutral "no change needed", not a real block (read/parse/commit error).
			const key = result.noop ? "noopReason" : "blockedReason";
			return { [key]: result.blockedReason, messages: [new AIMessage(result.message)] };
		}
		if (result.ok) {
			policyFiles.push(result.filePath);
			policyDiffs.push(result.diffLines.join("\n"));
			retentionChange = result.retentionChange;
			policyCreated = result.policyCreated;
			liveParity = result.liveParity ?? "";
		}
	}

	// SIO-933: optional component-template bind onto the SAME branch (one MR). A 404/read/commit
	// failure here blocks atomically (no MR opened); a no-op bind is skipped (no file added).
	const boundFiles: string[] = [];
	const boundDiffs: string[] = [];
	let lifecycleRetargeted = false;
	if (req.bindTemplate) {
		const bind = await commitBoundTemplate(cluster, branch, req.bindTemplate, policy);
		if (!bind.ok) {
			return { blockedReason: bind.blockedReason, messages: [new AIMessage(bind.message)] };
		}
		if (!bind.skipped) {
			boundFiles.push(bind.filePath);
			boundDiffs.push(bind.diffLines.join("\n"));
			lifecycleRetargeted = true;
		}
	}

	const files = [...policyFiles, ...boundFiles];
	// Nothing changed: the policy was a no-op AND the bind was a no-op (or absent). Surface the
	// standard "no change needed" block rather than opening an empty MR.
	if (files.length === 0) {
		return {
			noopReason: `Policy '${policy}' on '${cluster}' already has the requested values; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: '${policy}' on '${cluster}' is already as requested, so there is nothing to merge.`,
				),
			],
		};
	}

	// SIO-1012: warn (not block) when the target combo has no provisioned stack instance, so the
	// review card flags that CI will emit a no-op apply. lifecycle-policies is the ILM stack.
	const stackInstanceMissing = await isStackInstanceMissing(cluster, stackForWorkflow("ilm-rollout"));

	return {
		branch,
		proposedFilePath: files[0] ?? "",
		proposedFiles: files,
		proposedDiff: [...policyDiffs, ...boundDiffs].join("\n\n"),
		precheckPassed: true,
		retentionChange,
		policyCreated,
		lifecycleRetargeted,
		liveParity,
		stackInstanceMissing,
	};
}

// SIO-932: multi-file ILM orchestrator. The user named >=2 policy files in one request; commit
// each onto ONE shared branch so a single MR carries them all. ATOMIC: if ANY file blocks
// (unreadable / invalid / no-op), fail the whole turn naming that file -- never open a partial MR
// (the user said "change nothing else"). Aggregates the per-file diffs into one proposedDiff and
// OR-reduces the risk flags (retentionChange/policyCreated) so the review card still surfaces them.
export async function proposeIlmChanges(state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const entries = req.ilmPolicies ?? [];

	// Per-entry validation mirrors the singular guards, but names the offending file so the user
	// knows which one is underspecified.
	for (const e of entries) {
		if (!e.policyName) {
			return {
				blockedReason: "ILM change needs a policy name for every file.",
				messages: [new AIMessage("Cannot propose the change: every named policy needs a filename.")],
			};
		}
		// SIO-1011: a per-entry ilmFullPolicy IS the change (an authoritative from-scratch body), so it
		// must not trip the mandatory-phase guard -- mirrors the singular guard at proposeIlmChange.
		if (!e.sourcePolicy && !e.ilmFullPolicy && (!e.phasesPatch || Object.keys(e.phasesPatch).length === 0)) {
			return {
				blockedReason: `ILM change for '${e.policyName}' needs at least one phase field to change (or a sourcePolicy to copy, or a full policy body to onboard).`,
				messages: [
					new AIMessage(
						`Cannot propose the change: policy '${e.policyName}' has no phase field to change, no policy to copy from, and no full body to onboard.`,
					),
				],
			};
		}
	}

	// SIO-990: pin to the active change's branch on an amend (multi-file too); branchName otherwise.
	const branch = resolveBranch(state, req);
	// Create the shared branch ONCE; every policy commits onto it.
	await callTool("gitlab_create_branch", { branch, ref: "main" });

	const files: string[] = [];
	const diffBlocks: string[] = [];
	const parityBlocks: string[] = []; // SIO-983: per-policy live-parity advisories, labelled by file.
	let anyRetention: { from: string; to: string } | null = null;
	let anyCreated = false;
	for (const e of entries) {
		// SIO-1011: pass the per-entry full body through (6th arg) so a multi-file from-scratch onboard
		// writes each authoritative body verbatim, exactly as the singular path does via req.ilmFullPolicy.
		const result = await commitOneIlmPolicy(
			cluster,
			branch,
			e.policyName,
			e.phasesPatch,
			e.sourcePolicy,
			e.ilmFullPolicy,
		);
		if (!result.ok) {
			// Atomic: one file's failure blocks the whole MR. Any files already committed to the
			// branch are harmless -- no MR is opened, so the branch is never reviewed or merged.
			return {
				blockedReason: `Multi-file ILM change blocked on '${e.policyName}': ${result.blockedReason}`,
				messages: [new AIMessage(`${result.message} No merge request was opened (the batch is all-or-nothing).`)],
			};
		}
		files.push(result.filePath);
		diffBlocks.push(result.diffLines.join("\n"));
		if (result.retentionChange) anyRetention = result.retentionChange;
		if (result.policyCreated) anyCreated = true;
		if (result.liveParity) parityBlocks.push(`_${e.policyName}_\n\n${result.liveParity}`);
	}

	// SIO-1012: warn (not block) when the target combo has no provisioned stack instance -- one check
	// for the whole batch (all entries share the one cluster + the lifecycle-policies stack).
	const stackInstanceMissing = await isStackInstanceMissing(cluster, stackForWorkflow("ilm-rollout"));

	return {
		branch,
		// proposedFilePath stays populated (first file) so any single-file consumer keeps working;
		// proposedFiles is the authoritative list the MR body + review descriptor read.
		proposedFilePath: files[0] ?? "",
		proposedFiles: files,
		proposedDiff: diffBlocks.join("\n\n"),
		precheckPassed: files.length > 0,
		retentionChange: anyRetention,
		policyCreated: anyCreated,
		liveParity: parityBlocks.join("\n\n"),
		stackInstanceMissing,
	};
}

// SIO-914: propose a Fleet integration PACKAGE version pin -- read-modify-write the one
// alias's version (+ optional force) in the per-deployment integrations.json aggregate, then
// commit + (caller) open the MR. Mirrors proposeIlmChange but simpler: a single flat file, no
// 404-create (the aggregate always exists for a content-bearing deployment), no phase-merge.
async function proposeFleetIntegration(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const alias = req.integration ?? "";
	const version = req.integrationVersion ?? "";

	if (!alias || !version) {
		return {
			blockedReason: "Fleet integration change needs an integration name and a target version.",
			messages: [
				new AIMessage("Cannot propose the change: name the integration (e.g. aws) and the target package version."),
			],
		};
	}

	const filePath = deploymentJsonPath(fleetIntegrationsTemplate(), cluster);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// A 404 means this deployment has no integrations.json (not a content-bearing deployment for
	// Fleet). Don't invent the aggregate file -- ask the user to confirm the deployment.
	// SIO-921: an UNKNOWN read (neither 2xx nor 404 -- token/timeout/5xx/error placeholder) must
	// block rather than fall through; only a real 404 carries the per-stack handling below.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	if (raw.startsWith("[404")) {
		return {
			blockedReason: `No fleet-integrations file for '${cluster}' (${filePath} not found).`,
			messages: [
				new AIMessage(
					`I couldn't find a Fleet integrations file for '${cluster}' (${filePath}). Confirm the deployment manages Fleet integrations.`,
				),
			],
		};
	}

	let updated: { content: string; previousVersion?: string; previousForce?: boolean };
	try {
		updated = setIntegrationVersion(extractFileContent(raw), alias, version, req.force);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		// An unknown alias is a user-facing clarify, not an internal failure.
		const isUnknown = reason.startsWith("unknown integration");
		return {
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			messages: [
				new AIMessage(
					isUnknown
						? `'${alias}' is not a managed integration in ${cluster}'s integrations.json. Check the integration alias and try again.`
						: `Cannot propose the change: ${reason}.`,
				),
			],
		};
	}

	// No-op guard: the requested version already matches (empty diff).
	if (isUnchangedConfig(updated.content, extractFileContent(raw))) {
		return {
			noopReason: `Integration '${alias}' on '${cluster}' is already at ${version}; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: integration '${alias}' on '${cluster}' is already pinned to ${version}, so there is nothing to merge.`,
				),
			],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: pin ${alias} integration to ${version}`,
		action: "update",
	});
	// SIO-921: a clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]")
	// or non-2xx must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}
	const committed = true;

	const forceLine =
		req.force !== undefined && req.force !== updated.previousForce
			? `\n[${alias}] - "force": ${JSON.stringify(updated.previousForce ?? false)}\n+ "force": ${JSON.stringify(req.force)}`
			: "";
	const proposedDiff =
		`${filePath} (fleet integration ${alias})\n` +
		`[${alias}] - "version": ${JSON.stringify(updated.previousVersion ?? "?")}\n+ "version": ${JSON.stringify(version)}${forceLine}`;

	return {
		branch,
		proposedFilePath: filePath,
		proposedFiles: [filePath],
		proposedDiff,
		precheckPassed: committed,
		integrationMajorBump: isMajorVersionBump(updated.previousVersion, version),
	};
}

async function proposeSloChange(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const slo = req.sloName ?? "";

	const normalized = req.sloTarget !== undefined ? normalizeSloTarget(req.sloTarget) : undefined;
	if (normalized === null) {
		return {
			blockedReason: `Invalid SLO target ${req.sloTarget}.`,
			messages: [
				new AIMessage(
					`Cannot propose the change: '${req.sloTarget}' is not a valid SLO target (use e.g. 99.5 or 0.995).`,
				),
			],
		};
	}
	const target: number | undefined = normalized;
	const hasChange = target !== undefined || req.sloWindow !== undefined || req.sloTags !== undefined;
	if (!slo || !hasChange) {
		return {
			blockedReason: "SLO change needs an SLO name and at least one of target / window / tags.",
			messages: [
				new AIMessage("Cannot propose the change: name the SLO and what to change (target, time window, or tags)."),
			],
		};
	}

	const filePath = deploymentJsonPath(sloTemplate(), cluster).replace(/\$\{slo\}/g, slo);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// SIO-921: an UNKNOWN read (neither 2xx nor 404 -- token/timeout/5xx/error placeholder) must
	// block rather than fall through; only a real 404 carries the per-stack handling below.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	if (raw.startsWith("[404")) {
		return {
			blockedReason: `SLO '${slo}' not found on '${cluster}' (${filePath}).`,
			messages: [
				new AIMessage(
					`I couldn't find an SLO file '${slo}' on '${cluster}' (${filePath}). Check the SLO file name (creating a new SLO is not supported yet).`,
				),
			],
		};
	}

	let updated: ReturnType<typeof setSloOverrides>;
	try {
		updated = setSloOverrides(extractFileContent(raw), {
			target,
			windowDuration: req.sloWindow,
			tags: req.sloTags,
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
		};
	}

	if (isUnchangedConfig(updated.content, extractFileContent(raw))) {
		return {
			noopReason: `SLO '${slo}' on '${cluster}' already has the requested values; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: SLO '${slo}' on '${cluster}' already has the requested values, so there is nothing to merge.`,
				),
			],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message:
			`${cluster}: SLO ${slo} ${target !== undefined ? `target -> ${target}` : ""}${req.sloWindow ? ` window -> ${req.sloWindow}` : ""}`.trim(),
		action: "update",
	});
	// SIO-921: a clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]")
	// or non-2xx must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}
	const committed = true;

	// A target LOWERING (looser SLO) is worth flagging -- it relaxes the reliability bar.
	const targetLowered = target !== undefined && updated.previousTarget !== undefined && target < updated.previousTarget;

	const diffLines: string[] = [`${filePath} (SLO ${slo})`];
	if (target !== undefined) {
		diffLines.push(
			`[objective] - "target": ${JSON.stringify(updated.previousTarget ?? "?")}\n+ "target": ${JSON.stringify(target)}`,
		);
	}
	if (req.sloWindow !== undefined) {
		diffLines.push(
			`[time_window] - "duration": ${JSON.stringify(updated.previousWindow ?? "?")}\n+ "duration": ${JSON.stringify(req.sloWindow)}`,
		);
	}
	if (req.sloTags !== undefined) {
		diffLines.push(`[tags] - ${JSON.stringify(updated.previousTags ?? "?")}\n+ ${JSON.stringify(req.sloTags)}`);
	}

	return {
		branch,
		proposedFilePath: filePath,
		proposedFiles: [filePath],
		proposedDiff: diffLines.join("\n"),
		precheckPassed: committed,
		sloTargetLowered: targetLowered,
	};
}

async function proposeAlertingChange(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const rule = req.ruleName ?? "";

	const hasChange =
		req.alertThreshold !== undefined ||
		req.alertWindowSize !== undefined ||
		req.alertWindowUnit !== undefined ||
		req.alertEnabled !== undefined ||
		req.alertInterval !== undefined;
	if (!rule || !hasChange) {
		return {
			blockedReason: "Alert rule change needs a rule name and at least one of threshold / window / enabled / interval.",
			messages: [
				new AIMessage(
					"Cannot propose the change: name the alert rule and what to change (threshold, window, enabled, or interval).",
				),
			],
		};
	}

	const filePath = deploymentJsonPath(alertingTemplate(), cluster).replace(/\$\{rule\}/g, rule);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// SIO-921: an UNKNOWN read (neither 2xx nor 404 -- token/timeout/5xx/error placeholder) must
	// block rather than fall through; only a real 404 carries the per-stack handling below.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	if (raw.startsWith("[404")) {
		return {
			blockedReason: `Alert rule '${rule}' not found on '${cluster}' (${filePath}).`,
			messages: [
				new AIMessage(
					`I couldn't find an alert rule file '${rule}' on '${cluster}' (${filePath}). Check the rule file name (it is <space>__<rule-name>; creating a new rule is not supported yet).`,
				),
			],
		};
	}

	let updated: ReturnType<typeof setAlertingFields>;
	try {
		updated = setAlertingFields(extractFileContent(raw), {
			threshold: req.alertThreshold,
			windowSize: req.alertWindowSize,
			windowUnit: req.alertWindowUnit,
			enabled: req.alertEnabled,
			interval: req.alertInterval,
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
		};
	}

	if (isUnchangedConfig(updated.content, extractFileContent(raw))) {
		return {
			noopReason: `Alert rule '${rule}' on '${cluster}' already has the requested values; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: alert rule '${rule}' on '${cluster}' already has the requested values, so there is nothing to merge.`,
				),
			],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: alert ${rule}${req.alertThreshold !== undefined ? ` threshold -> ${req.alertThreshold}` : ""}${req.alertEnabled === false ? " (disabled)" : req.alertEnabled === true ? " (enabled)" : ""}`,
		action: "update",
	});
	// SIO-921: a clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]")
	// or non-2xx must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}
	const committed = true;

	// Disabling a rule silences its alerts -- the higher-risk change.
	const alertDisabled = req.alertEnabled === false && updated.previousEnabled !== false;

	const diffLines: string[] = [`${filePath} (alert rule ${rule})`];
	if (req.alertThreshold !== undefined) {
		diffLines.push(
			`[params] - "threshold": ${JSON.stringify(updated.previousThreshold ?? "?")}\n+ "threshold": ${JSON.stringify(req.alertThreshold)}`,
		);
	}
	if (req.alertWindowSize !== undefined) {
		diffLines.push(
			`[params] - "windowSize": ${JSON.stringify(updated.previousWindowSize ?? "?")}\n+ "windowSize": ${JSON.stringify(req.alertWindowSize)}`,
		);
	}
	if (req.alertWindowUnit !== undefined) {
		diffLines.push(
			`[params] - "windowUnit": ${JSON.stringify(updated.previousWindowUnit ?? "?")}\n+ "windowUnit": ${JSON.stringify(req.alertWindowUnit)}`,
		);
	}
	if (req.alertEnabled !== undefined) {
		diffLines.push(
			`[rule] - "enabled": ${JSON.stringify(updated.previousEnabled ?? "?")}\n+ "enabled": ${JSON.stringify(req.alertEnabled)}`,
		);
	}
	if (req.alertInterval !== undefined) {
		diffLines.push(
			`[rule] - "interval": ${JSON.stringify(updated.previousInterval ?? "?")}\n+ "interval": ${JSON.stringify(req.alertInterval)}`,
		);
	}

	return {
		branch,
		proposedFilePath: filePath,
		proposedFiles: [filePath],
		proposedDiff: diffLines.join("\n"),
		precheckPassed: committed,
		alertDisabled,
	};
}

// SIO-917: propose a data-view change -- add/replace a runtime field (config-form
// script_source) and/or edit title/name on an EXISTING data-view file. Mirrors proposeSloChange:
// single file, read-modify-write, edits only (no data-view create).
async function proposeDataviewChange(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const dataview = req.dataviewName ?? "";

	const runtimeField =
		req.runtimeFieldName !== undefined
			? { name: req.runtimeFieldName, type: req.runtimeFieldType ?? "keyword", script: req.runtimeFieldScript }
			: undefined;
	const hasChange =
		runtimeField !== undefined || req.dataviewTitle !== undefined || req.dataviewDisplayName !== undefined;
	if (!dataview || !hasChange) {
		return {
			blockedReason: "Data-view change needs a data-view name and at least one of runtime field / title / name.",
			messages: [
				new AIMessage(
					"Cannot propose the change: name the data view and what to change (runtime field, title, or name).",
				),
			],
		};
	}

	const filePath = deploymentJsonPath(dataviewTemplate(), cluster).replace(/\$\{dataview\}/g, dataview);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// SIO-921: an UNKNOWN read (neither 2xx nor 404 -- token/timeout/5xx/error placeholder) must
	// block rather than fall through; only a real 404 carries the per-stack handling below.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	if (raw.startsWith("[404")) {
		return {
			blockedReason: `Data view '${dataview}' not found on '${cluster}' (${filePath}).`,
			messages: [
				new AIMessage(
					`I couldn't find a data-view file '${dataview}' on '${cluster}' (${filePath}). Check the data-view file name (creating a new data view is not supported yet).`,
				),
			],
		};
	}

	let updated: ReturnType<typeof setDataviewFields>;
	try {
		updated = setDataviewFields(extractFileContent(raw), {
			runtimeField,
			title: req.dataviewTitle,
			displayName: req.dataviewDisplayName,
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
		};
	}

	if (isUnchangedConfig(updated.content, extractFileContent(raw))) {
		return {
			noopReason: `Data view '${dataview}' on '${cluster}' already has the requested values; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: data view '${dataview}' on '${cluster}' already has the requested values, so there is nothing to merge.`,
				),
			],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: data view ${dataview}${runtimeField ? ` ${updated.runtimeFieldExisted ? "update" : "add"} runtime field ${runtimeField.name}` : ""}`,
		action: "update",
	});
	// SIO-921: a clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]")
	// or non-2xx must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}
	const committed = true;

	const diffLines: string[] = [`${filePath} (data view ${dataview})`];
	if (runtimeField) {
		diffLines.push(
			`[runtime_field_map] ${updated.runtimeFieldExisted ? "update" : "add"} "${runtimeField.name}" -> { type: ${JSON.stringify(runtimeField.type)}${runtimeField.script !== undefined ? ", script_source: <painless>" : ""} }`,
		);
	}
	if (req.dataviewTitle !== undefined) {
		diffLines.push(
			`[dataview] - "title": ${JSON.stringify(updated.previousTitle ?? "?")}\n+ "title": ${JSON.stringify(req.dataviewTitle)}`,
		);
	}
	if (req.dataviewDisplayName !== undefined) {
		diffLines.push(
			`[dataview] - "name": ${JSON.stringify(updated.previousName ?? "?")}\n+ "name": ${JSON.stringify(req.dataviewDisplayName)}`,
		);
	}

	return {
		branch,
		proposedFilePath: filePath,
		proposedFiles: [filePath],
		proposedDiff: diffLines.join("\n"),
		precheckPassed: committed,
	};
}

// SIO-979: read -> merge a freeform settingsPatch into ONE cluster-defaults file, returning the
// new file content + full-file diff (or a block reason). It does NOT commit -- the orchestrator
// commits every file atomically in one commit (the proven MR !182 shape), so this only prepares
// the content. The diff is the FULL resulting file (every line prefixed `+ `) so the reviewer sees
// the whole settings block, not just the touched keys (mirrors proposeIndexTemplateCreate; the
// SIO-933 lesson that a patch-only diff hides inherited keys).
type ClusterDefaultFilePrep =
	| { ok: false; blockedReason: string; message: string; noop?: boolean }
	| { ok: true; filePath: string; content: string; diffBlock: string };

async function prepareOneClusterDefaultFile(
	cluster: string,
	template: string,
	settingsPatch: Record<string, unknown>,
): Promise<ClusterDefaultFilePrep> {
	const filePath = deploymentJsonPath(clusterDefaultTemplate(), cluster).replace(/\$\{template\}/g, template);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			ok: false,
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			message: "Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.",
		};
	}
	// SIO-921: an UNKNOWN read (neither 2xx nor 404) must block, never silently fall through.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			ok: false,
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			message: "Cannot propose the change: I could not read the target file from the GitOps repo.",
		};
	}
	if (raw.startsWith("[404")) {
		// Editing an EXISTING cluster-defaults template only (create is index-template-create).
		return {
			ok: false,
			blockedReason: `Cluster-defaults template '${template}' not found on '${cluster}' (${filePath}).`,
			message: `I couldn't find a cluster-defaults template file '${template}' on '${cluster}' (${filePath}). Check the template file name (creating a new template is not supported here).`,
		};
	}

	let updated: ReturnType<typeof mergeClusterDefaultSettings>;
	try {
		updated = mergeClusterDefaultSettings(extractFileContent(raw), settingsPatch);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			message: `Cannot propose the change: ${reason}.`,
		};
	}

	if (!updated.changed) {
		return {
			ok: false,
			noop: true,
			blockedReason: `Template '${template}' on '${cluster}' already has the requested settings; no change needed.`,
			message: `No change needed: template '${template}' on '${cluster}' already has the requested settings, so there is nothing to merge.`,
		};
	}

	// Full-file diff: show the entire resulting file so nothing (inherited keys) is hidden at review.
	const diffBlock = `${filePath} (cluster-defaults ${template})\n+ ${updated.content.replace(/\n/g, "\n+ ").trimEnd()}`;
	return { ok: true, filePath, content: updated.content, diffBlock };
}

// SIO-979: propose a FREEFORM cluster-defaults settings change across one or more templates. Unlike
// proposeClusterDefaultChange (total_shards_per_node only, single file), this merges an arbitrary
// settings patch and commits ALL files atomically in ONE commit via gitlab_commit_files -- the
// proven MR !182 mechanism (one commit, three files). Atomic all-or-nothing: any file's prep
// failure blocks the whole batch and no MR is opened. Single-entry requests pass settingsPatch +
// templateName; multi-file requests pass clusterDefaults[].
async function proposeClusterDefaultChanges(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	// Normalize to an entry list: the singular settingsPatch + templateName is a 1-entry batch.
	const entries =
		req.clusterDefaults && req.clusterDefaults.length > 0
			? req.clusterDefaults
			: req.templateName && req.settingsPatch
				? [{ templateName: req.templateName, settingsPatch: req.settingsPatch }]
				: [];

	if (entries.length === 0) {
		return {
			blockedReason: "Cluster-defaults change needs a template name and a settings patch.",
			messages: [new AIMessage("Cannot propose the change: name the index template and the index settings to change.")],
		};
	}
	for (const e of entries) {
		if (!e.templateName) {
			return {
				blockedReason: "Cluster-defaults change needs a template name for every file.",
				messages: [new AIMessage("Cannot propose the change: every named template needs a filename.")],
			};
		}
		if (!e.settingsPatch || Object.keys(e.settingsPatch).length === 0) {
			return {
				blockedReason: `Cluster-defaults change for '${e.templateName}' needs at least one index setting to change.`,
				messages: [new AIMessage(`Cannot propose the change: template '${e.templateName}' has no setting to change.`)],
			};
		}
	}

	const branch = branchName(req);
	// Create the shared branch ONCE; all files commit onto it in a single atomic commit.
	await callTool("gitlab_create_branch", { branch, ref: "main" });

	const prepared: Array<{ filePath: string; content: string }> = [];
	const diffBlocks: string[] = [];
	const settingKeys = new Set<string>();
	const skippedNoops: string[] = [];
	for (const e of entries) {
		const result = await prepareOneClusterDefaultFile(cluster, e.templateName, e.settingsPatch);
		if (!result.ok) {
			// SIO-1020: a no-op file (already has the requested settings) is skipped, NOT a block --
			// in a mixed batch the OTHER (real-change) files must still proceed. A batch-level noop is
			// emitted below only if EVERY file was a no-op (nothing prepared). A real failure
			// (read/parse) still blocks the whole MR atomically (the branch has no commit, no MR opens).
			if (result.noop) {
				skippedNoops.push(e.templateName);
				continue;
			}
			return {
				blockedReason: `Multi-file cluster-defaults change blocked on '${e.templateName}': ${result.blockedReason}`,
				messages: [new AIMessage(`${result.message} No merge request was opened (the batch is all-or-nothing).`)],
			};
		}
		prepared.push({ filePath: result.filePath, content: result.content });
		diffBlocks.push(result.diffBlock);
		for (const k of Object.keys(e.settingsPatch)) settingKeys.add(k);
	}

	// Every requested template already had the requested settings -> neutral no-op, no MR.
	if (prepared.length === 0) {
		return {
			noopReason: `Cluster-defaults templates on '${cluster}' already have the requested settings; no change needed (${skippedNoops.join(", ")}).`,
			messages: [
				new AIMessage(
					`No change needed: the requested cluster-defaults templates on '${cluster}' already have the requested settings, so there is nothing to merge.`,
				),
			],
		};
	}

	const fields = [...settingKeys].join(", ");
	const commit = await callTool("gitlab_commit_files", {
		branch,
		files: prepared.map((f) => ({ file_path: f.filePath, content: f.content, action: "update" })),
		commit_message: `${cluster}: cluster-defaults ${entries.map((e) => e.templateName).join("/")} (${fields})`,
	});
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}

	return {
		branch,
		proposedFilePath: prepared[0]?.filePath ?? "",
		proposedFiles: prepared.map((f) => f.filePath),
		proposedDiff: diffBlocks.join("\n\n"),
		precheckPassed: prepared.length > 0,
	};
}

// SIO-1022: propose a cluster-defaults override DELETE -- remove one or more whole
// environments/<dep>/cluster-defaults/<template>.json files in ONE MR. AGENTS.md s3 treats deleting
// such a file as an ordinary config change (the filename minus .json is the Terraform for_each key,
// so removing the file drops exactly that one resource). Mirrors proposeClusterDefaultChanges:
// probe each file, commit the deletes atomically. A file already absent is a per-file no-op; if
// EVERY target is absent the whole turn is a neutral no-op (no MR). The destroy-vs-no-op verdict
// comes from the CI plan, surfaced post-MR (AGENTS.md s7).
async function proposeClusterDefaultDelete(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const entries = req.clusterDefaultDeletes ?? [];

	if (!cluster) {
		return {
			blockedReason: "Cluster-defaults delete needs a deployment.",
			messages: [
				new AIMessage("Cannot propose the change: name the deployment whose override file should be removed."),
			],
		};
	}
	if (entries.length === 0) {
		return {
			blockedReason: "Cluster-defaults delete needs at least one override file to remove.",
			messages: [
				new AIMessage("Cannot propose the change: name at least one cluster-defaults override file to remove."),
			],
		};
	}
	for (const e of entries) {
		if (!e.templateName) {
			return {
				blockedReason: "Cluster-defaults delete needs a template basename for every file.",
				messages: [new AIMessage("Cannot propose the change: every override to remove needs its file basename.")],
			};
		}
	}

	const toDelete: string[] = [];
	const diffBlocks: string[] = [];
	const skippedAbsent: string[] = [];
	for (const e of entries) {
		const filePath = deploymentJsonPath(clusterDefaultTemplate(), cluster).replace(/\$\{template\}/g, e.templateName);
		const raw = await callTool("gitlab_get_file_content", { filePath });
		if (raw.startsWith("[gitlab token not configured")) {
			return {
				blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
				messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
			};
		}
		if (isGitlabNotFound(raw)) {
			// Already absent -> per-file no-op; nothing to delete for this entry.
			skippedAbsent.push(filePath);
			continue;
		}
		if (!isGitlabSuccess(raw)) {
			return {
				blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
				messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
			};
		}
		toDelete.push(filePath);
		// Show the full current body as a removal block so the review card states what is being removed.
		const body = extractFileContent(raw).trimEnd();
		diffBlocks.push(`${filePath} (remove override file)\n- ${body.replace(/\n/g, "\n- ")}`);
	}

	// Every target was already absent -> neutral no-op, no MR.
	if (toDelete.length === 0) {
		return {
			noopReason: `Cluster-defaults override file(s) on '${cluster}' are already absent; nothing to delete (${skippedAbsent.join(", ")}).`,
			messages: [
				new AIMessage(
					`No change needed: the requested cluster-defaults override file(s) on '${cluster}' are already absent, so there is nothing to merge.`,
				),
			],
		};
	}

	// SIO-1022: create the shared branch only after the probe confirms a real deletion, so a no-op
	// or read/token error leaves no orphan branch behind (which would also make a re-run collide).
	const branch = branchName(req);
	await callTool("gitlab_create_branch", { branch, ref: "main" });

	const commit = await callTool("gitlab_commit_files", {
		branch,
		files: toDelete.map((file_path) => ({ file_path, action: "delete" })),
		commit_message: `${cluster}: remove cluster-defaults override ${entries.map((e) => e.templateName).join("/")}`,
	});
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the deletion via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}

	return {
		branch,
		proposedFilePath: toDelete[0] ?? "",
		proposedFiles: toDelete,
		proposedDiff: diffBlocks.join("\n\n"),
		precheckPassed: toDelete.length > 0,
	};
}

// SIO-1037: propose an ILM policy-file DELETE -- remove one or more whole
// environments/<dep>/lifecycle-policies/<policy>.json files in ONE MR. The filename minus .json is
// the Terraform for_each key, so removing the file drops exactly that one lifecycle-policy resource.
// Mirrors proposeClusterDefaultDelete verbatim; the only difference is the ILM path template. Probe
// each file, commit the deletes atomically. A file already absent is a per-file no-op; if EVERY
// target is absent the whole turn is a neutral no-op (no MR). The destroy-vs-no-op verdict comes
// from the CI plan, surfaced post-MR.
async function proposeIlmDelete(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const entries = req.ilmDeletes ?? [];

	if (!cluster) {
		return {
			blockedReason: "ILM delete needs a deployment.",
			messages: [
				new AIMessage("Cannot propose the change: name the deployment whose ILM policy file should be removed."),
			],
		};
	}
	if (entries.length === 0) {
		return {
			blockedReason: "ILM delete needs at least one policy file to remove.",
			messages: [new AIMessage("Cannot propose the change: name at least one ILM policy file to remove.")],
		};
	}
	for (const e of entries) {
		if (!e.policyName) {
			return {
				blockedReason: "ILM delete needs a policy basename for every file.",
				messages: [new AIMessage("Cannot propose the change: every ILM policy to remove needs its file basename.")],
			};
		}
	}

	const toDelete: string[] = [];
	const diffBlocks: string[] = [];
	const skippedAbsent: string[] = [];
	for (const e of entries) {
		const filePath = deploymentJsonPath(ilmPolicyTemplate(), cluster, e.policyName);
		const raw = await callTool("gitlab_get_file_content", { filePath });
		if (raw.startsWith("[gitlab token not configured")) {
			return {
				blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
				messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
			};
		}
		if (isGitlabNotFound(raw)) {
			// Already absent -> per-file no-op; nothing to delete for this entry.
			skippedAbsent.push(filePath);
			continue;
		}
		if (!isGitlabSuccess(raw)) {
			return {
				blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
				messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
			};
		}
		toDelete.push(filePath);
		// Show the full current body as a removal block so the review card states what is being removed.
		const body = extractFileContent(raw).trimEnd();
		diffBlocks.push(`${filePath} (remove ILM policy file)\n- ${body.replace(/\n/g, "\n- ")}`);
	}

	// Every target was already absent -> neutral no-op, no MR.
	if (toDelete.length === 0) {
		return {
			noopReason: `ILM policy file(s) on '${cluster}' are already absent; nothing to delete (${skippedAbsent.join(", ")}).`,
			messages: [
				new AIMessage(
					`No change needed: the requested ILM policy file(s) on '${cluster}' are already absent, so there is nothing to merge.`,
				),
			],
		};
	}

	// Create the shared branch only after the probe confirms a real deletion, so a no-op or read/token
	// error leaves no orphan branch behind (which would also make a re-run collide).
	const branch = branchName(req);
	await callTool("gitlab_create_branch", { branch, ref: "main" });

	const commit = await callTool("gitlab_commit_files", {
		branch,
		files: toDelete.map((file_path) => ({ file_path, action: "delete" })),
		commit_message: `${cluster}: remove ILM policy ${entries.map((e) => e.policyName).join("/")}`,
	});
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the deletion via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}

	return {
		branch,
		proposedFilePath: toDelete[0] ?? "",
		proposedFiles: toDelete,
		proposedDiff: diffBlocks.join("\n\n"),
		precheckPassed: toDelete.length > 0,
	};
}

// SIO-917: propose a cluster-defaults change -- set total_shards_per_node on an EXISTING
// index-template file. Mirrors proposeSloChange: single file, read-modify-write, edits only.
async function proposeClusterDefaultChange(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const template = req.templateName ?? "";

	if (!template || req.totalShardsPerNode === undefined) {
		return {
			blockedReason: "Cluster-defaults change needs a template name and a total_shards_per_node value.",
			messages: [
				new AIMessage("Cannot propose the change: name the index template and the total_shards_per_node value."),
			],
		};
	}
	if (!Number.isInteger(req.totalShardsPerNode) || req.totalShardsPerNode < 1) {
		return {
			blockedReason: `Invalid total_shards_per_node ${req.totalShardsPerNode}.`,
			messages: [new AIMessage(`Cannot propose the change: total_shards_per_node must be a positive integer.`)],
		};
	}

	const filePath = deploymentJsonPath(clusterDefaultTemplate(), cluster).replace(/\$\{template\}/g, template);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// SIO-921: an UNKNOWN read (neither 2xx nor 404 -- token/timeout/5xx/error placeholder) must
	// block rather than fall through; only a real 404 carries the per-stack handling below.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	if (raw.startsWith("[404")) {
		return {
			blockedReason: `Cluster-defaults template '${template}' not found on '${cluster}' (${filePath}).`,
			messages: [
				new AIMessage(
					`I couldn't find a cluster-defaults template file '${template}' on '${cluster}' (${filePath}). Check the template file name (creating a new template is not supported yet).`,
				),
			],
		};
	}

	let updated: ReturnType<typeof setClusterDefaultShards>;
	try {
		updated = setClusterDefaultShards(extractFileContent(raw), req.totalShardsPerNode);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
		};
	}

	if (!updated.changed || isUnchangedConfig(updated.content, extractFileContent(raw))) {
		return {
			noopReason: `Template '${template}' on '${cluster}' already has total_shards_per_node=${req.totalShardsPerNode}; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: template '${template}' on '${cluster}' already has total_shards_per_node=${req.totalShardsPerNode}, so there is nothing to merge.`,
				),
			],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: cluster-defaults ${template} total_shards_per_node -> ${req.totalShardsPerNode}`,
		action: "update",
	});
	// SIO-921: a clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]")
	// or non-2xx must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}
	const committed = true;

	// Lowering total_shards_per_node concentrates shards on fewer nodes (can unbalance) -- flag.
	const shardsLowered = updated.previous !== undefined && req.totalShardsPerNode < updated.previous;

	const proposedDiff =
		`${filePath} (cluster-defaults ${template})\n` +
		`[settings.index.routing.allocation] - "total_shards_per_node": ${JSON.stringify(updated.previous ?? "?")}\n+ "total_shards_per_node": ${JSON.stringify(req.totalShardsPerNode)}`;

	return {
		branch,
		proposedFilePath: filePath,
		proposedFiles: [filePath],
		proposedDiff,
		precheckPassed: committed,
		shardsLowered,
	};
}

// SIO-994: propose a cluster-SETTINGS change -- flat-merge persistent/transient patches into the
// EXISTING environments/<cluster>/cluster-settings/settings.json (the PUT _cluster/settings surface).
// Single file, read-modify-write, edits only (404 blocks; creating the file is not supported). Mirrors
// the single-file proposeClusterDefaultChange flow: read -> guard -> merge -> no-op -> full-file diff
// -> single commit. Safety (a danger denylist for persistent keys) is enforced upstream in guardNode.
async function proposeClusterSettingsChange(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const persistentPatch = req.persistentPatch;
	const transientPatch = req.transientPatch;
	// SIO-996: a remove-only request carries no patch but must still be accepted.
	const removeKeysPersistent = req.removeKeysPersistent;
	const removeKeysTransient = req.removeKeysTransient;
	const hasPatch = (p?: Record<string, unknown>) => !!p && Object.keys(p).length > 0;
	const hasKeys = (k?: string[]) => !!k && k.length > 0;
	if (
		!hasPatch(persistentPatch) &&
		!hasPatch(transientPatch) &&
		!hasKeys(removeKeysPersistent) &&
		!hasKeys(removeKeysTransient)
	) {
		return {
			blockedReason: "Cluster-settings change needs at least one persistent or transient setting to set or remove.",
			messages: [
				new AIMessage("Cannot propose the change: name a cluster persistent/transient setting to set or remove."),
			],
		};
	}

	const filePath = deploymentJsonPath(clusterSettingsTemplate(), cluster);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	if (raw.startsWith("[404")) {
		return {
			blockedReason: `Cluster-settings file not found on '${cluster}' (${filePath}).`,
			messages: [
				new AIMessage(
					`I couldn't find the cluster-settings file on '${cluster}' (${filePath}). Editing the cluster persistent/transient settings requires that file to already exist (creating it is not supported here).`,
				),
			],
		};
	}

	let updated: ReturnType<typeof mergeClusterSettings>;
	try {
		updated = mergeClusterSettings(extractFileContent(raw), {
			...(hasPatch(persistentPatch) && { persistentPatch }),
			...(hasPatch(transientPatch) && { transientPatch }),
			...(hasKeys(removeKeysPersistent) && { removeKeysPersistent }),
			...(hasKeys(removeKeysTransient) && { removeKeysTransient }),
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
		};
	}

	if (!updated.changed) {
		// SIO-996: covers both "already at the requested value" and "asked to remove a key that's absent".
		return {
			noopReason: `Cluster settings on '${cluster}' already match the request; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: the cluster settings on '${cluster}' already match the request (the keys to set already have those values, and any keys to remove are already absent), so there is nothing to merge.`,
				),
			],
		};
	}

	// SIO-996: removed keys appear in the commit message alongside the set keys (prefixed `-`).
	const keys = [
		...Object.keys(persistentPatch ?? {}),
		...Object.keys(transientPatch ?? {}),
		...(removeKeysPersistent ?? []).map((k) => `-${k}`),
		...(removeKeysTransient ?? []).map((k) => `-${k}`),
	].join(", ");
	// SIO-994 fix: create the branch BEFORE committing (gitlab_commit_file commits onto an existing
	// branch; without this the commit 400s on a missing branch). Created here -- after the no-op/404
	// guards -- so a no-op never leaves a stray branch. Idempotent (a re-run reuses the branch).
	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: cluster-settings (${keys})`,
		action: "update",
	});
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}

	// Full-file diff so nothing (the other untouched persistent keys) is hidden at review.
	const diffBlock = `${filePath} (cluster-settings)\n+ ${updated.content.replace(/\n/g, "\n+ ").trimEnd()}`;
	return {
		branch,
		proposedFilePath: filePath,
		proposedFiles: [filePath],
		proposedDiff: diffBlock,
		precheckPassed: true,
	};
}

// SIO-918: propose a space change -- set name/description/color on an EXISTING per-space file.
// Mirrors proposeSloChange: single file, read-modify-write, edits only (no space create; the
// per-file-vs-aggregate split + disabled_features defaults make creation a separate problem).
async function proposeSpaceChange(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const space = req.spaceName ?? "";

	const hasChange =
		req.spaceDisplayName !== undefined || req.spaceDescription !== undefined || req.spaceColor !== undefined;
	if (!space || !hasChange) {
		return {
			blockedReason: "Space change needs a space name and at least one of display name / description / color.",
			messages: [
				new AIMessage(
					"Cannot propose the change: name the space and what to change (display name, description, or color).",
				),
			],
		};
	}

	const filePath = deploymentJsonPath(spaceTemplate(), cluster).replace(/\$\{space\}/g, space);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// SIO-921: an UNKNOWN read (neither 2xx nor 404 -- token/timeout/5xx/error placeholder) must
	// block rather than fall through; only a real 404 carries the per-stack handling below.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	if (raw.startsWith("[404")) {
		return {
			blockedReason: `Space '${space}' not found on '${cluster}' (${filePath}).`,
			messages: [
				new AIMessage(
					`I couldn't find a per-space file '${space}' on '${cluster}' (${filePath}). Some deployments keep spaces in an aggregate spaces.json instead -- that form, and creating a new space, are not supported yet.`,
				),
			],
		};
	}

	let updated: ReturnType<typeof setSpaceFields>;
	try {
		updated = setSpaceFields(extractFileContent(raw), {
			displayName: req.spaceDisplayName,
			description: req.spaceDescription,
			color: req.spaceColor,
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
		};
	}

	if (isUnchangedConfig(updated.content, extractFileContent(raw))) {
		return {
			noopReason: `Space '${space}' on '${cluster}' already has the requested values; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: space '${space}' on '${cluster}' already has the requested values, so there is nothing to merge.`,
				),
			],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: space ${space} update`,
		action: "update",
	});
	// SIO-921: a clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]")
	// or non-2xx must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}
	const committed = true;

	const diffLines: string[] = [`${filePath} (space ${space})`];
	if (req.spaceDisplayName !== undefined) {
		diffLines.push(
			`[space] - "name": ${JSON.stringify(updated.previousName ?? "?")}\n+ "name": ${JSON.stringify(req.spaceDisplayName)}`,
		);
	}
	if (req.spaceDescription !== undefined) {
		diffLines.push(
			`[space] - "description": ${JSON.stringify(updated.previousDescription ?? "?")}\n+ "description": ${JSON.stringify(req.spaceDescription)}`,
		);
	}
	if (req.spaceColor !== undefined) {
		diffLines.push(
			`[space] - "color": ${JSON.stringify(updated.previousColor ?? "?")}\n+ "color": ${JSON.stringify(req.spaceColor)}`,
		);
	}

	return {
		branch,
		proposedFilePath: filePath,
		proposedFiles: [filePath],
		proposedDiff: diffLines.join("\n"),
		precheckPassed: committed,
	};
}

// SIO-918: propose a security ROLE privilege grant -- ADD privileges to one existing role in the
// security aggregate. role_mappings + api_keys (secrets) are left byte-for-byte untouched. HIGH
// risk by default; cluster-level / superuser grants are flagged HIGHEST (privilege escalation).
// ADDITIVE only (never removes), no role creation, no role_mappings edits.
async function proposeSecurityRoleChange(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const roleName = req.roleName ?? "";

	const grant = {
		cluster: req.grantCluster,
		index:
			req.grantIndexNames && req.grantIndexPrivileges
				? { names: req.grantIndexNames, privileges: req.grantIndexPrivileges }
				: undefined,
		kibana:
			req.grantKibanaApplication && req.grantKibanaPrivileges
				? { application: req.grantKibanaApplication, privileges: req.grantKibanaPrivileges }
				: undefined,
	};
	const hasGrant = (grant.cluster?.length ?? 0) > 0 || grant.index !== undefined || grant.kibana !== undefined;
	if (!roleName || !hasGrant) {
		return {
			blockedReason:
				"Security role change needs a role name and at least one privilege grant (cluster / index / Kibana).",
			messages: [
				new AIMessage(
					"Cannot propose the change: name the role and the privileges to grant (cluster, index names + privileges, or Kibana application + privileges).",
				),
			],
		};
	}

	const filePath = deploymentJsonPath(securityTemplate(), cluster);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// SIO-921: an UNKNOWN read (neither 2xx nor 404 -- token/timeout/5xx/error placeholder) must
	// block rather than fall through; only a real 404 carries the per-stack handling below.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	if (raw.startsWith("[404")) {
		return {
			blockedReason: `No security file for '${cluster}' (${filePath}).`,
			messages: [
				new AIMessage(
					`I couldn't find a security file for '${cluster}' (${filePath}). Confirm the deployment manages security roles.`,
				),
			],
		};
	}

	let updated: ReturnType<typeof addRolePrivileges>;
	try {
		updated = addRolePrivileges(extractFileContent(raw), roleName, grant);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		const isUnknown = reason.startsWith("unknown role");
		return {
			blockedReason: `Could not edit ${filePath}: ${reason}.`,
			messages: [
				new AIMessage(
					isUnknown
						? `'${roleName}' is not a managed role in ${cluster}'s security.json. Check the role name and try again.`
						: `Cannot propose the change: ${reason}.`,
				),
			],
		};
	}

	if (!updated.changed) {
		return {
			noopReason: `Role '${roleName}' on '${cluster}' already has the requested privileges; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: role '${roleName}' on '${cluster}' already has the requested privileges, so there is nothing to merge.`,
				),
			],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content: updated.content,
		commit_message: `${cluster}: security role ${roleName} grant privileges`,
		action: "update",
	});
	// SIO-921: a clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]")
	// or non-2xx must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}
	const committed = true;

	const escalation = isPrivilegeEscalation({
		cluster: grant.cluster,
		indexPrivileges: grant.index?.privileges,
		kibanaPrivileges: grant.kibana?.privileges,
	});

	// Diff lists ONLY the newly-added privileges; never echoes role_mappings or api_keys.
	const diffLines: string[] = [
		`${filePath} (security role ${roleName}) -- ADD privileges only; role_mappings + api_keys untouched`,
	];
	if (updated.addedCluster.length > 0)
		diffLines.push(`[roles.${roleName}.cluster] + ${JSON.stringify(updated.addedCluster)}`);
	if (updated.addedIndex.length > 0)
		diffLines.push(
			`[roles.${roleName}.indices (${JSON.stringify(grant.index?.names ?? [])})] + ${JSON.stringify(updated.addedIndex)}`,
		);
	if (updated.addedKibana.length > 0)
		diffLines.push(
			`[roles.${roleName}.applications (${grant.kibana?.application})] + ${JSON.stringify(updated.addedKibana)}`,
		);

	return {
		branch,
		proposedFilePath: filePath,
		proposedFiles: [filePath],
		proposedDiff: diffLines.join("\n"),
		precheckPassed: committed,
		privilegeEscalation: escalation,
	};
}

// SIO-919: propose a deployments-topology change -- toggle elasticsearch.autoscale and/or set a
// tier's zone_count / per-tier autoscale in the _deployments JSON (version + size are owned by
// version-upgrade / tier-resize). Mirrors proposeVersionUpgrade (same _deployments file path) but
// edits topology scalars. ALWAYS HIGH risk: the deployments stack is one shared state across all 10
// clusters and applies can take hours. Never proposes a deployment delete.
async function proposeTopologyChange(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";

	const hasChange =
		req.autoscaleEnabled !== undefined ||
		(req.topologyTier !== undefined && (req.tierZoneCount !== undefined || req.tierAutoscale !== undefined)) ||
		(req.userSettingsTarget !== undefined && req.userSettingsYaml !== undefined) ||
		// SIO-997: the surgical user_settings_yaml key merge (non-SSO) is also a valid topology change.
		(req.userSettingsMergeTarget !== undefined &&
			req.userSettingsMergeKey !== undefined &&
			req.userSettingsMergeValue !== undefined) ||
		// SIO-999: a surgical user_settings_yaml key removal (non-SSO revert) is also a valid topology change.
		(req.userSettingsMergeTarget !== undefined &&
			req.userSettingsRemoveKeys !== undefined &&
			req.userSettingsRemoveKeys.length > 0) ||
		(req.sizeComponent !== undefined && (req.componentSize !== undefined || req.componentZoneCount !== undefined));
	if (!cluster || !hasChange) {
		return {
			blockedReason:
				"Topology change needs a cluster and at least one of autoscale / tier zone_count / tier autoscale / user_settings_yaml / component size.",
			messages: [
				new AIMessage(
					"Cannot propose the change: name the deployment and what to change (autoscale, a tier's zone_count/autoscale, an SSO user_settings_yaml block, adding/changing OR REMOVING a user_settings_yaml key, or integrations_server/kibana sizing).",
				),
			],
		};
	}
	if (
		req.tierZoneCount !== undefined &&
		(!Number.isInteger(req.tierZoneCount) || req.tierZoneCount < 1 || req.tierZoneCount > 3)
	) {
		return {
			blockedReason: `Invalid zone_count ${req.tierZoneCount}.`,
			messages: [new AIMessage("Cannot propose the change: zone_count must be an integer 1-3.")],
		};
	}

	const filePath = deploymentJsonPath(deploymentJsonTemplate(), cluster);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	// SIO-921: an UNKNOWN read (neither 2xx nor 404 -- token/timeout/5xx/error placeholder) must
	// block rather than fall through; only a real 404 carries the per-stack handling below.
	if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
		return {
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	if (raw.startsWith("[404")) {
		return {
			blockedReason: `Deployment '${cluster}' not found (${filePath}).`,
			messages: [
				new AIMessage(`I couldn't find a deployment file for '${cluster}' (${filePath}). Check the deployment name.`),
			],
		};
	}

	// Apply the requested surfaces in sequence over the same file content. Each pure helper is a
	// read-modify-write; we thread `content` through so a request can touch autoscale + a tier + SSO
	// + sizing in one MR. The diff lists only changed scalars (and for SSO, only the target + a
	// "updated" marker -- the YAML value never enters the diff, since it can carry idp/sp identifiers).
	let content = extractFileContent(raw);
	let anyChange = false;
	const diffLines: string[] = [`${filePath} (deployment topology ${cluster})`];
	// SIO-1000: repo-vs-live drift annotations for a user_settings_yaml removal (best-effort live read).
	// driftNotes feed the success message; liveRemovalYaml/Target are reused by the no-op branch so we
	// read the live plan at most once.
	const driftNotes: string[] = [];
	let liveRemovalYaml: string | undefined;
	let liveRemovalTarget: "elasticsearch_config" | "kibana" | undefined;

	if (
		req.autoscaleEnabled !== undefined ||
		(req.topologyTier !== undefined && (req.tierZoneCount !== undefined || req.tierAutoscale !== undefined))
	) {
		let topo: ReturnType<typeof setDeploymentTopology>;
		try {
			topo = setDeploymentTopology(content, {
				autoscale: req.autoscaleEnabled,
				tier: req.topologyTier,
				zoneCount: req.tierZoneCount,
				tierAutoscale: req.tierAutoscale,
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			const isUnknownTier = reason.startsWith("unknown or unsized tier");
			return {
				blockedReason: `Could not edit ${filePath}: ${reason}.`,
				messages: [
					new AIMessage(
						isUnknownTier
							? `'${req.topologyTier}' is not a managed tier on ${cluster}. Check the tier (hot|warm|cold|frozen|master|ml|coordinating) and try again.`
							: `Cannot propose the change: ${reason}.`,
					),
				],
			};
		}
		content = topo.content;
		anyChange = anyChange || topo.changed;
		if (req.autoscaleEnabled !== undefined) {
			diffLines.push(
				`[elasticsearch] - "autoscale": ${JSON.stringify(topo.previousAutoscale ?? "?")}\n+ "autoscale": ${JSON.stringify(req.autoscaleEnabled)}`,
			);
		}
		if (req.topologyTier && req.tierZoneCount !== undefined) {
			diffLines.push(
				`[elasticsearch.${req.topologyTier}] - "zone_count": ${JSON.stringify(topo.previousZoneCount ?? "?")}\n+ "zone_count": ${JSON.stringify(req.tierZoneCount)}`,
			);
		}
		if (req.topologyTier && req.tierAutoscale !== undefined) {
			diffLines.push(
				`[elasticsearch.${req.topologyTier}] - "autoscale": ${JSON.stringify(topo.previousTierAutoscale ?? "?")}\n+ "autoscale": ${JSON.stringify(req.tierAutoscale)}`,
			);
		}
	}

	if (req.userSettingsTarget !== undefined && req.userSettingsYaml !== undefined) {
		let sso: ReturnType<typeof setDeploymentUserSettings>;
		try {
			sso = setDeploymentUserSettings(content, req.userSettingsTarget, req.userSettingsYaml);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				blockedReason: `Could not edit ${filePath}: ${reason}.`,
				messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
			};
		}
		content = sso.content;
		anyChange = anyChange || sso.changed;
		// NEVER echo the YAML (SSO/OIDC can contain idp/sp identifiers); show only the target + size delta.
		diffLines.push(
			`[${req.userSettingsTarget}] user_settings_yaml updated (SSO/login config; ${sso.previousYaml?.length ?? 0} -> ${req.userSettingsYaml.length} chars; value withheld)`,
		);
	}

	// SIO-997: surgical single-key merge into the existing user_settings_yaml (the non-SSO case). Adds
	// ONLY the named dotted key; every sibling subtree (incl. xpack.security/OIDC) is preserved
	// byte-for-byte by mergeUserSettingsKey. Unlike the whole-block replace above, the key + value ARE
	// safe to echo (a non-SSO operational setting), UNLESS the edit lands inside xpack.security.
	if (
		req.userSettingsMergeTarget !== undefined &&
		req.userSettingsMergeKey !== undefined &&
		req.userSettingsMergeValue !== undefined
	) {
		let merge: ReturnType<typeof mergeDeploymentUserSettingsKey>;
		try {
			merge = mergeDeploymentUserSettingsKey(
				content,
				req.userSettingsMergeTarget,
				req.userSettingsMergeKey,
				req.userSettingsMergeValue,
			);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				blockedReason: `Could not edit ${filePath}: ${reason}.`,
				messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
			};
		}
		content = merge.content;
		anyChange = anyChange || merge.changed;
		// A security edit can contain secrets / lock out login -- withhold its value; a non-security
		// operational key (xpack.monitoring, indices, ...) is safe to show in the diff.
		const valueShown = merge.touchesSecurity ? "value withheld (xpack.security)" : `"${req.userSettingsMergeValue}"`;
		const prevShown = merge.previousValue !== undefined ? ` (was "${merge.previousValue}")` : " (new key)";
		diffLines.push(
			`[${req.userSettingsMergeTarget}] user_settings_yaml ${req.userSettingsMergeKey} -> ${valueShown}${merge.touchesSecurity ? "" : prevShown}`,
		);
	}

	// SIO-999: surgical key REMOVAL from the existing user_settings_yaml (the non-SSO revert case).
	// Deletes ONLY the named dotted key(s) + any now-empty ancestor maps; every sibling subtree (incl.
	// xpack.security/OIDC) is preserved byte-for-byte by removeUserSettingsKeys. An absent key is a
	// no-op. The removed key NAMES are safe to echo unless a removal lands inside xpack.security.
	if (
		req.userSettingsMergeTarget !== undefined &&
		req.userSettingsRemoveKeys !== undefined &&
		req.userSettingsRemoveKeys.length > 0
	) {
		let removal: ReturnType<typeof removeDeploymentUserSettingsKeys>;
		try {
			removal = removeDeploymentUserSettingsKeys(content, req.userSettingsMergeTarget, req.userSettingsRemoveKeys);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				blockedReason: `Could not edit ${filePath}: ${reason}.`,
				messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
			};
		}
		// An ambiguous key (its tail matches more than one subtree) must NOT be guessed -- block and show
		// the candidates so the user can re-issue with the full path.
		if (removal.ambiguous.length > 0) {
			const lines = removal.ambiguous.map((a) => `- "${a.key}" matches: ${a.candidates.join(", ")}`).join("\n");
			return {
				blockedReason: `Ambiguous user_settings_yaml key(s) on '${cluster}': more than one subtree matches.`,
				messages: [
					new AIMessage(
						`Cannot propose the change: these key(s) match more than one place in [${req.userSettingsMergeTarget}].user_settings_yaml, so I won't guess which to remove. Re-issue naming the full path.\n\n${lines}`,
					),
				],
			};
		}
		content = removal.content;
		anyChange = anyChange || removal.changed;
		// SIO-1000: read the LIVE effective user_settings_yaml (best-effort) so we can annotate the MR
		// with the drift direction. EC applies user_settings operator-side and drops non-allowlisted
		// keys, so a key in the repo can be absent live. Captured here (repo `content` pre-removal) and
		// reused by the no-op branch below. A failed read => liveYaml undefined => repo-only fallback.
		const repoYamlBeforeRemoval = (() => {
			try {
				return readDeploymentUserSettings(extractFileContent(raw), req.userSettingsMergeTarget);
			} catch {
				return "";
			}
		})();
		liveRemovalYaml = await fetchLiveUserSettingsYaml(cluster, req.userSettingsMergeTarget);
		liveRemovalTarget = req.userSettingsMergeTarget;
		// Removing a key under xpack.security can lock out login -- withhold the names; a non-security
		// operational key (xpack.monitoring, ...) is safe to list. `removed` carries the FULL resolved
		// paths (e.g. a "monitoring.collection.interval" request resolves to "xpack.monitoring...").
		// An empty `removed` means every named key was already absent (a no-op the guard below catches).
		if (removal.removed.length > 0) {
			const removedShown = removal.touchesSecurity
				? `${removal.removed.length} key(s) (names withheld: xpack.security)`
				: removal.removed.join(", ");
			diffLines.push(`[${req.userSettingsMergeTarget}] user_settings_yaml removed ${removedShown}`);
			// Annotate the drift direction per removed key (skip security keys to avoid echoing names).
			if (!removal.touchesSecurity) {
				for (const key of removal.removed) {
					const drift = classifyUserSettingsDrift(repoYamlBeforeRemoval, liveRemovalYaml, key);
					if (drift.liveUnknown) {
						driftNotes.push(`${key}: could not read the live cluster -- this MR edits the repo only.`);
					} else if (drift.inRepo && !drift.inLive) {
						driftNotes.push(`${key}: aligns the repo with the live cluster (EC already dropped this key).`);
					} else if (drift.inRepo && drift.inLive) {
						driftNotes.push(`${key}: present in both repo and live; the apply will remove it from the cluster.`);
					}
				}
			}
		}
	}

	if (req.sizeComponent !== undefined && (req.componentSize !== undefined || req.componentZoneCount !== undefined)) {
		if (
			req.componentZoneCount !== undefined &&
			(!Number.isInteger(req.componentZoneCount) || req.componentZoneCount < 1 || req.componentZoneCount > 3)
		) {
			return {
				blockedReason: `Invalid zone_count ${req.componentZoneCount}.`,
				messages: [new AIMessage("Cannot propose the change: component zone_count must be an integer 1-3.")],
			};
		}
		let comp: ReturnType<typeof setComponentSize>;
		try {
			comp = setComponentSize(content, req.sizeComponent, {
				size: req.componentSize,
				zoneCount: req.componentZoneCount,
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				blockedReason: `Could not edit ${filePath}: ${reason}.`,
				messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
			};
		}
		content = comp.content;
		anyChange = anyChange || comp.changed;
		if (req.componentSize !== undefined) {
			diffLines.push(
				`[${req.sizeComponent}] - "size": ${JSON.stringify(comp.previousSize ?? "?")}\n+ "size": ${JSON.stringify(req.componentSize)}`,
			);
		}
		if (req.componentZoneCount !== undefined) {
			diffLines.push(
				`[${req.sizeComponent}] - "zone_count": ${JSON.stringify(comp.previousZoneCount ?? "?")}\n+ "zone_count": ${JSON.stringify(req.componentZoneCount)}`,
			);
		}
	}

	if (!anyChange || isUnchangedConfig(content, extractFileContent(raw))) {
		// SIO-999: a removal whose key(s) are ALREADY absent is an idempotent no-op -- but rather than a
		// terse "no change", show the user the current user_settings_yaml so they can confirm the subtree
		// is genuinely gone (the repo state, not a silent "nothing to see here"). Withhold the body when
		// the removal targeted xpack.security (could carry secrets). NOTE: this confirms the REPO file
		// only; it does not check the live cluster -- live drift is tracked separately.
		if (
			req.userSettingsMergeTarget !== undefined &&
			req.userSettingsRemoveKeys !== undefined &&
			req.userSettingsRemoveKeys.length > 0
		) {
			const keys = req.userSettingsRemoveKeys;
			const touchesSecurity = keys.some((k) => k === "xpack.security" || k.startsWith("xpack.security."));
			let currentYaml = "";
			try {
				currentYaml = readDeploymentUserSettings(content, req.userSettingsMergeTarget);
			} catch {
				currentYaml = "";
			}
			// Render the current YAML as a fenced code block so the chat renderer keeps indentation + does
			// not auto-link the OIDC URLs into an unreadable wall. Withhold the body for an xpack.security
			// target (could carry secrets); show "(empty)" when there is no user_settings_yaml at all.
			const yamlBlock = touchesSecurity
				? "(current user_settings_yaml withheld: the removal targeted xpack.security)"
				: currentYaml.trim() === ""
					? `[${req.userSettingsMergeTarget}].user_settings_yaml is empty / unset.`
					: `Current \`[${req.userSettingsMergeTarget}].user_settings_yaml\`:\n\n\`\`\`yaml\n${currentYaml.trimEnd()}\n\`\`\``;
			const keyList = keys.join(", ");
			// SIO-1000: the repo has no matching key. Check the LIVE cluster (read in the removal block above)
			// to tell a genuine no-op from real drift. liveRemovalYaml is undefined if the live read failed.
			const liveLine = ((): string => {
				if (liveRemovalTarget === undefined) return "";
				if (liveRemovalYaml === undefined) {
					return "I could not read the live cluster, so I can only confirm the repo state. If the running cluster still applies this setting, tell me and I can investigate.";
				}
				// Drift only matters for non-security keys we can name; report any key still present live.
				const stillLive = touchesSecurity
					? []
					: keys.filter((k) => classifyUserSettingsDrift(currentYaml, liveRemovalYaml, k).inLive);
				if (stillLive.length > 0) {
					return `DRIFT: the repo no longer has ${stillLive.join(", ")}, but the LIVE cluster still applies ${stillLive.length > 1 ? "them" : "it"}. A repo edit will not remove ${stillLive.length > 1 ? "them" : "it"} -- this needs a plan re-apply against the deployment. Tell me if you want me to dig into the live plan.`;
				}
				return "I also checked the live cluster: it does not apply this setting either, so there is genuinely nothing to reconcile.";
			})();
			return {
				noopReason: `Deployment '${cluster}' user_settings_yaml has no key matching ${keyList}; no change needed.`,
				messages: [
					new AIMessage(
						`No change needed: I found no key matching ${keyList} in '${cluster}' user_settings_yaml (searched exact + suffix paths), so there was nothing to remove.\n\n` +
							`${yamlBlock}\n\nThere is nothing to merge.${liveLine ? ` ${liveLine}` : ""}`,
					),
				],
			};
		}
		return {
			noopReason: `Deployment '${cluster}' already has the requested topology values; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: deployment '${cluster}' already has the requested topology values, so there is nothing to merge.`,
				),
			],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		content,
		commit_message: `${cluster}: deployment topology edit`,
		action: "update",
	});
	// SIO-921: a clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]")
	// or non-2xx must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}
	const committed = true;

	// SIO-1000: append the repo-vs-live drift notes (if any) under the diff so the reviewer sees which
	// direction this removal reconciles.
	const diffWithDrift =
		driftNotes.length > 0
			? `${diffLines.join("\n")}\n\nLive cluster (drift):\n${driftNotes.map((n) => `- ${n}`).join("\n")}`
			: diffLines.join("\n");
	return {
		branch,
		proposedFilePath: filePath,
		proposedFiles: [filePath],
		proposedDiff: diffWithDrift,
		precheckPassed: committed,
	};
}

// SIO-920: validate a Kibana dashboard NDJSON payload WITHOUT parsing the whole file as one JSON
// object -- it is newline-delimited (N saved-object lines + a trailing export-summary line). We
// split on \n, drop blank lines, and JSON.parse EACH line independently (validation only -- the
// caller commits the ORIGINAL string verbatim, never a re-serialized one). objectCount is the
// number of saved-object lines (every non-blank line except the trailing export-summary line, which
// is the object carrying excludedObjects/exportedCount and no `type`). Returns ok:false with the
// 1-based line number of the first unparseable line. (Pure; unit-tested.)
export function validateNdjsonLines(
	ndjson: string,
): { ok: true; objectCount: number } | { ok: false; badLine: number } {
	const lines = ndjson.split("\n");
	let nonBlank = 0;
	let summaryLines = 0;
	for (const [i, rawLine] of lines.entries()) {
		const line = rawLine.trim();
		if (line === "") continue;
		nonBlank++;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return { ok: false, badLine: i + 1 };
		}
		// The export-summary line has no `type` and carries the exportedCount/excludedObjects keys.
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!("type" in parsed) &&
			("exportedCount" in parsed || "excludedObjects" in parsed)
		) {
			summaryLines++;
		}
	}
	return { ok: true, objectCount: Math.max(0, nonBlank - summaryLines) };
}

// SIO-920: propose a WHOLE-FILE Kibana dashboard NDJSON add/replace -- commit the user's exported
// NDJSON verbatim to environments/<dep>/dashboards/<space>__<name>.ndjson and open an MR. MEDIUM
// risk (dashboards are display-only; a malformed NDJSON fails CI's saved-objects import job, not
// production). The NDJSON is treated as an opaque multi-line string -- never JSON.parsed as one
// object, never panel-edited. `delete` is parsed but not supported yet (the GitLab MCP exposes no
// delete-file tool; gitlab_commit_file is a create/update upsert) -- it blocks as a follow-up.
async function proposeDashboardChange(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const space = req.dashboardSpace ?? "";
	const name = req.dashboardName ?? "";
	const action = req.dashboardAction;

	if (!cluster || !space || !name || !action) {
		return {
			blockedReason: "Dashboard change needs a deployment, a space, a dashboard name, and an action (add|replace).",
			messages: [
				new AIMessage(
					"Cannot propose the change: name the deployment, the space, the dashboard, and whether to add or replace it.",
				),
			],
		};
	}

	// SIO-920: cluster/space/name are LLM-derived and get interpolated into a GitLab file path.
	// Reject path separators and dot segments so a dashboard-edit can only ever target
	// environments/<dep>/dashboards/<space>__<name>.ndjson, never escape the dashboards dir.
	const isSafePathSegment = (value: string): boolean =>
		value.length > 0 && !value.includes("\0") && !/[\\/]/.test(value) && value !== "." && value !== "..";
	if (!isSafePathSegment(cluster) || !isSafePathSegment(space) || !isSafePathSegment(name)) {
		return {
			blockedReason: "Dashboard change contains an invalid deployment, space, or dashboard path segment.",
			messages: [
				new AIMessage(
					"Cannot propose the change: the deployment, space, and dashboard name must be plain file-name segments (no path separators or '.' / '..').",
				),
			],
		};
	}

	// delete is not supported yet: there is no delete-file tool, and gitlab_commit_file only
	// creates/updates. Surface it as a follow-up rather than silently doing nothing.
	if (action === "delete") {
		return {
			blockedReason: "Dashboard delete is not supported yet (follow-up).",
			messages: [
				new AIMessage(
					"I can't delete a dashboard yet -- I can only add or replace one. Removing a dashboard NDJSON is a planned follow-up; for now delete it in Kibana / the repo directly.",
				),
			],
		};
	}

	const ndjson = req.dashboardNdjson ?? "";
	if (ndjson.trim() === "") {
		return {
			blockedReason: "Dashboard add/replace needs the exported NDJSON payload.",
			messages: [
				new AIMessage("Cannot propose the change: paste the Kibana dashboard export (the NDJSON) to add or replace."),
			],
		};
	}

	// Validate per-line (NEVER whole-file JSON.parse -- NDJSON is line-delimited). A malformed
	// payload blocks with a clarifying message rather than committing a broken file.
	const validated = validateNdjsonLines(ndjson);
	if (!validated.ok) {
		return {
			blockedReason: `Dashboard NDJSON is malformed (line ${validated.badLine} is not valid JSON).`,
			messages: [
				new AIMessage(
					`Cannot propose the change: the NDJSON payload is malformed (line ${validated.badLine} is not valid JSON). Re-export the dashboard from Kibana and paste the full file.`,
				),
			],
		};
	}

	const filePath = dashboardNdjsonPath(dashboardNdjsonTemplate(), cluster, space, name);
	const branch = branchName(req);

	// SIO-920: classify GitLab tool responses. callTool returns "[<status>] <json>" on a real API
	// call and "[gitlab ...]"/"[<tool> error: ...]" placeholders on failure. A read must be a clean
	// 2xx (file present) or 404 (absent); anything else (token/timeout/5xx/placeholder) is an
	// UNKNOWN read and must block -- never silently treated as "exists" or "absent".
	const isGitlabSuccess = (result: string): boolean => /^\[2\d\d\]/.test(result);
	const isGitlabNotFound = (result: string): boolean => result.startsWith("[404");

	// Cross-check the space exists (the <space>__ prefix must match a real space on this deployment).
	const spacePath = deploymentJsonPath(spaceTemplate(), cluster).replace(/\$\{space\}/g, space);
	const spaceRaw = await callTool("gitlab_get_file_content", { filePath: spacePath });
	if (spaceRaw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
		};
	}
	if (!isGitlabSuccess(spaceRaw) && !isGitlabNotFound(spaceRaw)) {
		return {
			blockedReason: `Could not verify space '${space}' on '${cluster}' (${spacePath}): ${spaceRaw.slice(0, 120)}.`,
			messages: [
				new AIMessage("Cannot propose the change: I could not read the target Kibana space from the GitOps repo."),
			],
		};
	}
	if (isGitlabNotFound(spaceRaw)) {
		return {
			blockedReason: `'${space}' is not a space on '${cluster}' (${spacePath}).`,
			messages: [
				new AIMessage(
					`'${space}' is not a Kibana space on '${cluster}'. A dashboard's '<space>__' prefix must match an existing space; check the space name and try again.`,
				),
			],
		};
	}

	// Check the target file: add expects it absent (404 ok), replace expects it present. An UNKNOWN
	// read (neither 2xx nor 404) blocks -- we must not guess existence from an error placeholder.
	const fileRaw = await callTool("gitlab_get_file_content", { filePath });
	if (!isGitlabSuccess(fileRaw) && !isGitlabNotFound(fileRaw)) {
		return {
			blockedReason: `Could not check dashboard '${space}__${name}' on '${cluster}' (${filePath}): ${fileRaw.slice(0, 120)}.`,
			messages: [
				new AIMessage("Cannot propose the change: I could not verify whether the dashboard file already exists."),
			],
		};
	}
	const fileExists = isGitlabSuccess(fileRaw);
	if (action === "add" && fileExists) {
		return {
			blockedReason: `Dashboard '${space}__${name}' already exists on '${cluster}'; use replace to overwrite it.`,
			messages: [
				new AIMessage(
					`A dashboard '${space}__${name}.ndjson' already exists on '${cluster}'. Ask to "replace" it if you want to overwrite it; I won't silently clobber it on an "add".`,
				),
			],
		};
	}
	if (action === "replace" && !fileExists) {
		return {
			blockedReason: `No dashboard '${space}__${name}' on '${cluster}' to replace (${filePath}).`,
			messages: [
				new AIMessage(
					`There's no dashboard '${space}__${name}.ndjson' on '${cluster}' to replace. Use "add" to create it.`,
				),
			],
		};
	}

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const commit = await callTool("gitlab_commit_file", {
		branch,
		file_path: filePath,
		// Commit the ORIGINAL NDJSON string verbatim -- no re-serialization, no reformatting.
		content: ndjson,
		commit_message: `${cluster}: ${action} dashboard ${space}__${name}`,
		action: action === "add" ? "create" : "update",
	});
	// A clean 2xx is the only success; a tool-error placeholder ("[<tool> error: ...]") or non-2xx
	// must NOT reach the review gate as a committed change.
	if (!isGitlabSuccess(commit)) {
		return {
			blockedReason: `Could not commit dashboard '${space}__${name}' to ${filePath}: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the dashboard file commit failed.")],
		};
	}

	// Diff is a SUMMARY (filename + action + object count + byte size) -- NEVER the NDJSON body
	// (a dashboard export can be 1.9 MB). objectCount counts saved-object lines (excludes the
	// trailing export-summary line).
	const proposedDiff = `${filePath} (dashboard ${action}): ${validated.objectCount} saved object${validated.objectCount === 1 ? "" : "s"} + export summary, ${Buffer.byteLength(ndjson, "utf8")} bytes`;

	// The commit returned 2xx (non-2xx returned early above), so the change is on the branch.
	return { branch, proposedFilePath: filePath, proposedFiles: [filePath], proposedDiff, precheckPassed: true };
}

// SIO-978: propose creating one or more NEW index-template JSON files under
// environments/<cluster>/index-templates/, committed to ONE branch / ONE MR (mirrors the multi-file
// ILM batch). This is a CREATE: each file is probed first; an entry whose file already exists is
// SKIPPED (no overwrite -- editing is a separate, unsupported workflow). If every requested file
// already exists, the whole request is a no-op and is blocked (no empty MR). The MR is opened later
// by the resume path, not here -- this returns the committed branch + the full-file diffs.
async function proposeIndexTemplateCreate(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const entries = req.indexTemplates ?? [];

	if (entries.length === 0) {
		return {
			blockedReason: "Index-template change needs at least one index template to create.",
			messages: [new AIMessage("Cannot propose the change: name at least one index template to create.")],
		};
	}
	// Per-entry validation: a template needs a name and at least one index pattern (the two provider-
	// required fields). Naming the offending entry helps the user fix the right one.
	for (const e of entries) {
		if (!e.name || !e.indexPatterns || e.indexPatterns.length === 0) {
			return {
				blockedReason: "Each index template needs a name and at least one index pattern.",
				messages: [
					new AIMessage("Cannot propose the change: every index template needs a name and at least one index pattern."),
				],
			};
		}
	}

	const branch = branchName(req);
	// Create the shared branch ONCE; every new template commits onto it.
	await callTool("gitlab_create_branch", { branch, ref: "main" });

	const files: string[] = [];
	const diffBlocks: string[] = [];
	const skipped: string[] = [];
	for (const e of entries) {
		const filePath = deploymentJsonPath(indexTemplateTemplate(), cluster).replace(/\$\{template\}/g, e.name);

		// Probe: a real 404 means the file is new -> create it; a 2xx means it already exists -> skip
		// (this workflow does not overwrite). Any other read (token/timeout/5xx) blocks the batch.
		const raw = await callTool("gitlab_get_file_content", { filePath });
		if (raw.startsWith("[gitlab token not configured")) {
			return {
				blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
				messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
			};
		}
		if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
			return {
				blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
				messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
			};
		}
		if (isGitlabSuccess(raw)) {
			// Already exists -- skip rather than overwrite (edit is a separate, unsupported workflow).
			skipped.push(filePath);
			continue;
		}

		const content = buildIndexTemplateConfig(e);
		const commit = await callTool("gitlab_commit_file", {
			branch,
			file_path: filePath,
			content,
			commit_message: `${cluster}: add index template ${e.name}`,
			action: "create",
		});
		if (!isGitlabSuccess(commit)) {
			// Atomic: one file's failure blocks the whole MR. Any files already committed are harmless
			// (no MR is opened, so the branch is never reviewed or merged).
			return {
				blockedReason: `Could not commit ${filePath} via the GitLab API: ${commit.slice(0, 120)}.`,
				messages: [new AIMessage(`Cannot propose the change: the GitLab commit for '${e.name}' failed.`)],
			};
		}
		files.push(filePath);
		// Full-file diff on create (the whole file is new -- there is no prior version to diff against).
		diffBlocks.push(`${filePath} (new index template ${e.name})\n+ ${content.replace(/\n/g, "\n+ ").trimEnd()}`);
	}

	if (files.length === 0) {
		// Everything requested already exists -- nothing to create, so no MR.
		return {
			noopReason: `Index template(s) already exist on '${cluster}'; nothing to create (${skipped.join(", ")}).`,
			messages: [
				new AIMessage(
					`No change needed: the requested index template file(s) already exist on '${cluster}', so there is nothing to merge.`,
				),
			],
		};
	}

	return {
		branch,
		proposedFilePath: files[0] ?? "",
		proposedFiles: files,
		proposedDiff: diffBlocks.join("\n\n"),
		precheckPassed: files.length > 0,
	};
}

// SIO-1020: interpret an elastic_simulate_ingest_pipeline result string (the `[<status>] <body>`
// convention the elastic-iac cluster tools return). A 2xx means the pipeline + every processor
// COMPILED (the propose-time signal we want); a 4xx/5xx is a real ES rejection -> block. Anything
// else (deployment not configured, request failed, tool unavailable) is unavailability, NOT a
// validation failure -> skip (warn-and-proceed): simulate is a best-effort guard and a working
// feature must not hard-depend on optional cluster connectivity. (Pure; unit-tested.)
export function interpretSimulateResult(
	raw: string,
): { ok: true } | { ok: false; reason: string } | { skipped: true; note: string } {
	const status = raw.match(/^\[(\d{3})\]/);
	if (status) {
		const code = Number(status[1]);
		if (code >= 200 && code < 300) return { ok: true };
		// A 4xx/5xx from ES is a genuine compile/parse rejection of the pipeline body.
		return { ok: false, reason: raw.slice(0, 300) };
	}
	// Non-status placeholders: "[cluster '...' not configured...]", "[cluster request failed...]",
	// "[<tool> unavailable - elastic-iac server not connected]".
	return { skipped: true, note: raw.slice(0, 200) };
}

// SIO-1019: ingest-pipeline-create -- write one or more NEW @custom ingest-pipeline JSON files VERBATIM
// to environments/<cluster>/ingest-pipelines/, on ONE branch / ONE MR. Mirrors proposeIndexTemplateCreate
// but with no config-shaping step: `body` is the document the user pasted, serialized as-is. Additive
// create only -- a file that already exists is skipped (edit is a separate, unsupported workflow); if
// every requested file already exists there is nothing to do and no MR is opened.
// SIO-1020: each body is SIMULATED against the deployment's _ingest/pipeline/_simulate before any
// commit -- a real ES rejection blocks (no MR); an unreachable/unconfigured cluster is a best-effort
// skip (the change still proceeds).
async function proposeIngestPipelineCreate(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const entries = req.ingestPipelines ?? [];

	if (entries.length === 0) {
		return {
			blockedReason: "Ingest-pipeline change needs at least one pipeline file to create.",
			messages: [new AIMessage("Cannot propose the change: name at least one ingest pipeline to create.")],
		};
	}
	// Per-entry validation: a pipeline needs a name and a body that is a JSON OBJECT (the verbatim
	// pipeline document). An array/scalar body is not a valid pipeline definition. Naming the offending
	// entry helps the user fix the right one.
	for (const e of entries) {
		const validBody = typeof e.body === "object" && e.body !== null && !Array.isArray(e.body);
		if (!e.name || !validBody) {
			return {
				blockedReason: "Each ingest pipeline needs a name and a JSON-object body.",
				messages: [
					new AIMessage("Cannot propose the change: every ingest pipeline needs a name and a JSON-object body."),
				],
			};
		}
	}

	// SIO-1020: simulate each body against the deployment BEFORE creating the branch, so an invalid
	// pipeline is rejected with the real ES error at propose-time instead of at CI apply-time. The body
	// is the COMPLETE pipeline doc, but _simulate wants only the runnable shape (processors/on_failure),
	// so the top-level `name` (an IaC-file field, not a _simulate field) is dropped from the simulated
	// pipeline. A 4xx/5xx ES rejection blocks; an unreachable/unconfigured cluster is a best-effort skip.
	for (const e of entries) {
		const { name: _pipelineName, ...pipelineForSim } = e.body as Record<string, unknown>;
		const raw = await callTool("elastic_simulate_ingest_pipeline", {
			pipeline: pipelineForSim,
			deployment: cluster,
		});
		const verdict = interpretSimulateResult(raw);
		if ("ok" in verdict && verdict.ok === false) {
			log.warn({ cluster, pipeline: e.name, error: verdict.reason }, "ingest-pipeline simulate rejected the body");
			return {
				blockedReason: `Ingest pipeline '${e.name}' failed simulation on '${cluster}': ${verdict.reason}`,
				messages: [
					new AIMessage(
						`Cannot propose the change: ingest pipeline '${e.name}' did not pass simulation against ${cluster}. Elasticsearch rejected it:\n\n${verdict.reason}\n\nFix the pipeline body and try again.`,
					),
				],
			};
		}
		if ("skipped" in verdict) {
			// Best-effort: the cluster is not reachable/configured for simulate. Proceed with the change
			// (CI's plan/apply remains the backstop) but record why the guard did not run.
			log.warn(
				{ cluster, pipeline: e.name, note: verdict.note },
				"ingest-pipeline simulate skipped (cluster unavailable); proceeding",
			);
		}
	}

	const branch = branchName(req);
	// Create the shared branch ONCE; every new pipeline commits onto it.
	await callTool("gitlab_create_branch", { branch, ref: "main" });

	const files: string[] = [];
	const diffBlocks: string[] = [];
	const skipped: string[] = [];
	for (const e of entries) {
		const filePath = deploymentJsonPath(ingestPipelineTemplate(), cluster).replace(/\$\{name\}/g, e.name);

		// Probe: a real 404 means the file is new -> create it; a 2xx means it already exists -> skip
		// (this workflow does not overwrite). Any other read (token/timeout/5xx) blocks the batch.
		const raw = await callTool("gitlab_get_file_content", { filePath });
		if (raw.startsWith("[gitlab token not configured")) {
			return {
				blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
				messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
			};
		}
		if (!isGitlabSuccess(raw) && !isGitlabNotFound(raw)) {
			return {
				blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
				messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
			};
		}
		if (isGitlabSuccess(raw)) {
			// Already exists -- skip rather than overwrite (edit is a separate, unsupported workflow).
			skipped.push(filePath);
			continue;
		}

		// Verbatim body: serialize the pasted pipeline document as-is (2-space indent + trailing newline
		// match the repo house style). No buildXxxConfig shaping -- the user owns the pipeline shape.
		const content = `${JSON.stringify(e.body, null, 2)}\n`;
		const commit = await callTool("gitlab_commit_file", {
			branch,
			file_path: filePath,
			content,
			commit_message: `${cluster}: add ingest pipeline ${e.name}`,
			action: "create",
		});
		if (!isGitlabSuccess(commit)) {
			// Atomic: one file's failure blocks the whole MR. Any files already committed are harmless
			// (no MR is opened, so the branch is never reviewed or merged).
			return {
				blockedReason: `Could not commit ${filePath} via the GitLab API: ${commit.slice(0, 120)}.`,
				messages: [new AIMessage(`Cannot propose the change: the GitLab commit for '${e.name}' failed.`)],
			};
		}
		files.push(filePath);
		// Full-file diff on create (the whole file is new -- there is no prior version to diff against).
		diffBlocks.push(`${filePath} (new ingest pipeline ${e.name})\n+ ${content.replace(/\n/g, "\n+ ").trimEnd()}`);
	}

	if (files.length === 0) {
		// Everything requested already exists -- nothing to create, so no MR.
		return {
			noopReason: `Ingest pipeline(s) already exist on '${cluster}'; nothing to create (${skipped.join(", ")}).`,
			messages: [
				new AIMessage(
					`No change needed: the requested ingest-pipeline file(s) already exist on '${cluster}', so there is nothing to merge.`,
				),
			],
		};
	}

	return {
		branch,
		proposedFilePath: files[0] ?? "",
		proposedFiles: files,
		proposedDiff: diffBlocks.join("\n\n"),
		precheckPassed: files.length > 0,
	};
}

// SIO-1024: ingest-pipeline-edit -- REPLACE the full body of one or more EXISTING @custom ingest-pipeline
// JSON files VERBATIM, on ONE branch / ONE MR. The sibling of proposeIngestPipelineCreate with the
// file-existence rule INVERTED: the target file MUST already exist (a 404 BLOCKS -- it never creates) and
// the commit uses action "update". `name` is the FILE BASENAME the user named in the path (not the body's
// `name` field), so the path is resolved exactly like create but read with the expectation of a 2xx.
// SIO-1020 simulate guard kept verbatim. The diff is a before/after against the existing file content.
async function proposeIngestPipelineEdit(_state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const entries = req.ingestPipelineEdits ?? [];

	if (entries.length === 0) {
		return {
			blockedReason: "Ingest-pipeline edit needs at least one pipeline file to replace.",
			messages: [new AIMessage("Cannot propose the change: name at least one existing ingest pipeline to edit.")],
		};
	}
	for (const e of entries) {
		const validBody = typeof e.body === "object" && e.body !== null && !Array.isArray(e.body);
		if (!e.name || !validBody) {
			return {
				blockedReason: "Each ingest pipeline needs a name and a JSON-object body.",
				messages: [
					new AIMessage("Cannot propose the change: every ingest pipeline needs a name and a JSON-object body."),
				],
			};
		}
	}

	// SIO-1020: simulate each replacement body BEFORE creating the branch (same guard as create).
	for (const e of entries) {
		const { name: _pipelineName, ...pipelineForSim } = e.body as Record<string, unknown>;
		const raw = await callTool("elastic_simulate_ingest_pipeline", {
			pipeline: pipelineForSim,
			deployment: cluster,
		});
		const verdict = interpretSimulateResult(raw);
		if ("ok" in verdict && verdict.ok === false) {
			log.warn({ cluster, pipeline: e.name, error: verdict.reason }, "ingest-pipeline simulate rejected the body");
			return {
				blockedReason: `Ingest pipeline '${e.name}' failed simulation on '${cluster}': ${verdict.reason}`,
				messages: [
					new AIMessage(
						`Cannot propose the change: ingest pipeline '${e.name}' did not pass simulation against ${cluster}. Elasticsearch rejected it:\n\n${verdict.reason}\n\nFix the pipeline body and try again.`,
					),
				],
			};
		}
		if ("skipped" in verdict) {
			log.warn(
				{ cluster, pipeline: e.name, note: verdict.note },
				"ingest-pipeline simulate skipped (cluster unavailable); proceeding",
			);
		}
	}

	const branch = branchName(req);
	await callTool("gitlab_create_branch", { branch, ref: "main" });

	const files: string[] = [];
	const diffBlocks: string[] = [];
	for (const e of entries) {
		const filePath = deploymentJsonPath(ingestPipelineTemplate(), cluster).replace(/\$\{name\}/g, e.name);

		// Probe: an edit REQUIRES the file to exist. A 404 BLOCKS (this is not the create path -- never
		// silently create on edit). Any other non-2xx read (token/timeout/5xx) blocks the batch.
		const raw = await callTool("gitlab_get_file_content", { filePath });
		if (raw.startsWith("[gitlab token not configured")) {
			return {
				blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
				messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
			};
		}
		if (isGitlabNotFound(raw)) {
			return {
				blockedReason: `No ingest-pipeline file '${filePath}' on '${cluster}' to edit.`,
				messages: [
					new AIMessage(
						`Cannot propose the change: there is no ingest-pipeline file '${filePath}' on '${cluster}' to edit. To add a new pipeline, ask me to *create* it instead.`,
					),
				],
			};
		}
		if (!isGitlabSuccess(raw)) {
			return {
				blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
				messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
			};
		}

		// Verbatim replacement body; same serialization as create.
		const content = `${JSON.stringify(e.body, null, 2)}\n`;
		const commit = await callTool("gitlab_commit_file", {
			branch,
			file_path: filePath,
			content,
			commit_message: `${cluster}: edit ingest pipeline ${e.name}`,
			action: "update",
		});
		if (!isGitlabSuccess(commit)) {
			return {
				blockedReason: `Could not commit ${filePath} via the GitLab API: ${commit.slice(0, 120)}.`,
				messages: [new AIMessage(`Cannot propose the change: the GitLab commit for '${e.name}' failed.`)],
			};
		}
		files.push(filePath);
		// Before/after diff: the existing content (from the probe read) vs the replacement body, so the
		// review card shows exactly what changes rather than re-printing the whole new file.
		const before = `${extractFileContent(raw).trimEnd()}\n`;
		diffBlocks.push(
			`${filePath} (replace ingest pipeline ${e.name})\n- ${before.replace(/\n/g, "\n- ").trimEnd()}\n+ ${content.replace(/\n/g, "\n+ ").trimEnd()}`,
		);
	}

	return {
		branch,
		proposedFilePath: files[0] ?? "",
		proposedFiles: files,
		proposedDiff: diffBlocks.join("\n\n"),
		precheckPassed: files.length > 0,
	};
}

// SIO-990: amend lane entry. A correction to the change just proposed this session (intent
// "gitops-amend", set by classifyIacIntent's correction guard) re-parses the corrected request from
// the latest message and routes it through the SAME proposer chain (readClusterState -> guard ->
// draftChange -> reviewPlan -> reviewGate). The chain re-commits onto the active change's branch
// (resolveBranch pins it) so the EXISTING MR updates in place, and reviewGate's approved-exit skips
// the duplicate openMr when activeChange.mrIid is set. This is a thin re-parse wrapper over
// parseIntent: it preserves intent="gitops-amend" (parseIntent only returns iacRequest) so the
// downstream pin/skip see the amend. If parseIntent can't resolve the change (clarification /
// unsupported), it surfaces that exactly as a fresh gitops turn would.
export async function amendChange(state: IacStateType): Promise<Partial<IacStateType>> {
	log.info(
		{ branch: state.activeChange?.branch, mrIid: state.activeChange?.mrIid ?? null, query: lastHumanText(state) },
		"amendChange: re-parsing correction against the active change",
	);
	return parseIntent(state);
}

// Draft the change. Every actionable workflow is a GitOps config edit (JSON edit via the
// GitLab API; CI computes the plan on the MR). SIO-912: the legacy local-terraform-diff
// path for workflow "other" is gone -- parseIntent now short-circuits "other" with a
// capability message before reaching draftChange, so any unmatched workflow here is a bug.
export async function draftChange(state: IacStateType): Promise<Partial<IacStateType>> {
	const req = state.iacRequest;
	if (!req) return {};
	if (req.workflow === "version-upgrade") return proposeVersionUpgrade(state, req);
	if (req.workflow === "tier-resize") return proposeTierResize(state, req);
	if (req.workflow === "ilm-rollout") return proposeIlmChange(state, req);
	if (req.workflow === "fleet-integration") return proposeFleetIntegration(state, req);
	if (req.workflow === "slo-edit") return proposeSloChange(state, req);
	if (req.workflow === "alerting-edit") return proposeAlertingChange(state, req);
	if (req.workflow === "dataview-edit") return proposeDataviewChange(state, req);
	// SIO-979: a freeform settings patch (single template) or a multi-file clusterDefaults[] batch
	// routes to the freeform atomic proposer; a bare total_shards_per_node keeps the original path.
	if (req.workflow === "cluster-default-edit") {
		return req.clusterDefaults || req.settingsPatch
			? proposeClusterDefaultChanges(state, req)
			: proposeClusterDefaultChange(state, req);
	}
	// SIO-1022: remove a whole cluster-defaults override file (delete the for_each key).
	if (req.workflow === "cluster-default-delete") return proposeClusterDefaultDelete(state, req);
	// SIO-1037: remove a whole ILM policy file (delete the for_each key).
	if (req.workflow === "ilm-delete") return proposeIlmDelete(state, req);
	// SIO-994: cluster-level persistent/transient settings (distinct file from cluster-defaults).
	if (req.workflow === "cluster-settings-edit") return proposeClusterSettingsChange(state, req);
	if (req.workflow === "space-edit") return proposeSpaceChange(state, req);
	if (req.workflow === "security-edit") return proposeSecurityRoleChange(state, req);
	if (req.workflow === "topology-edit") return proposeTopologyChange(state, req);
	if (req.workflow === "dashboard-edit") return proposeDashboardChange(state, req);
	if (req.workflow === "index-template-create") return proposeIndexTemplateCreate(state, req);
	if (req.workflow === "ingest-pipeline-create") return proposeIngestPipelineCreate(state, req);
	if (req.workflow === "ingest-pipeline-edit") return proposeIngestPipelineEdit(state, req);

	// Defensive: a workflow value with no proposer must stop before the review gate rather
	// than open an empty MR. parseIntent should already have blocked "other" upstream.
	return {
		blockedReason: `No proposer for workflow '${req.workflow}'.`,
		messages: [new AIMessage(capabilityMessage())],
	};
}

// SIO-989: compact, one-glance per-field summary of a nested phasesPatch/settingsPatch for the
// "Change:" line (the reviewPlan title, which also flows into durable memory + the recalled line).
// Reuses the leaf-walk shape of commitOneIlmPolicy's `walk`: descend objects, emit one token per
// leaf. The top-level key is the group (an ILM phase like `warm`, or the first settings segment);
// sub-keys below it render as a dotted path. Strings are unquoted, other scalars stringified, so
// `{ warm: { forcemerge: { max_num_segments: 1 } } }` -> `warm forcemerge.max_num_segments=1`.
// Pure/deterministic (no LLM, no emojis). Capped to keep the line short; returns "" on an empty
// patch so the caller can fall back to the phase-name form (e.g. an ilm copy with no phasesPatch).
export function summarizeNestedPatch(
	patch: Record<string, unknown> | undefined,
	opts?: { maxLeaves?: number },
): string {
	if (!patch || Object.keys(patch).length === 0) return "";
	const maxLeaves = opts?.maxLeaves ?? 4;
	const fmt = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
	// Collect leaves under each top-level group, preserving insertion order.
	const collectLeaves = (obj: Record<string, unknown>, prefix: string): string[] => {
		const out: string[] = [];
		for (const [key, value] of Object.entries(obj)) {
			const path = prefix ? `${prefix}.${key}` : key;
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				out.push(...collectLeaves(value as Record<string, unknown>, path));
			} else {
				out.push(`${path}=${fmt(value)}`);
			}
		}
		return out;
	};
	// One flat, capped list of "<group> <dotpath>=<value>" tokens to enforce the cap globally, then
	// regroup adjacent same-group leaves so a group's fields read together (`warm a=1 b=2`).
	const flat: Array<{ group: string; leaf: string }> = [];
	for (const [group, value] of Object.entries(patch)) {
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			for (const leaf of collectLeaves(value as Record<string, unknown>, "")) flat.push({ group, leaf });
		} else {
			// A bare top-level scalar (flat settingsPatch leaf) has no group prefix.
			flat.push({ group: "", leaf: `${group}=${fmt(value)}` });
		}
	}
	const kept = flat.slice(0, maxLeaves);
	const more = flat.length - kept.length;
	// Render: walk kept leaves, opening a new comma-separated segment whenever the group changes.
	const segments: string[] = [];
	let curGroup: string | null = null;
	let curLeaves: string[] = [];
	const flush = () => {
		if (curLeaves.length === 0) return;
		segments.push(curGroup ? `${curGroup} ${curLeaves.join(" ")}` : curLeaves.join(" "));
		curLeaves = [];
	};
	for (const { group, leaf } of kept) {
		if (group !== curGroup) {
			flush();
			curGroup = group;
		}
		curLeaves.push(leaf);
	}
	flush();
	let summary = segments.join(", ");
	if (more > 0) summary += `, +${more} more`;
	return summary;
}

// SIO-996: a compact descriptor for a cluster-settings-edit change -- the actual keys being SET
// (k=v tokens, both blocks) and REMOVED (k tokens). This is what makes the plan-review title (and so
// the live "check my MR" card, the durable iac-change fact, and its later recall) say WHAT changed,
// not just "cluster-settings-edit". Falls back to "change" when nothing is named. (Pure.)
export function summarizeClusterSettings(req: IacRequest | undefined): string {
	const setKeys = summarizeNestedPatch({ ...(req?.persistentPatch ?? {}), ...(req?.transientPatch ?? {}) });
	const removed = [...(req?.removeKeysPersistent ?? []), ...(req?.removeKeysTransient ?? [])];
	const parts: string[] = [];
	if (setKeys) parts.push(`set ${setKeys}`);
	if (removed.length > 0) parts.push(`removed ${removed.join(", ")}`);
	return parts.join("; ") || "change";
}

// Assemble the review payload. Every workflow is a GitOps config edit: the change is
// already committed to a branch via the GitLab API and CI computes the authoritative plan
// on the MR (deck slide 18). SIO-912: the legacy local-terraform validate/plan branch is
// gone -- the agent never runs terraform; "other" is short-circuited in parseIntent.
export async function reviewPlan(state: IacStateType): Promise<Partial<IacStateType>> {
	const req = state.iacRequest;
	const branch = state.branch;
	const isUpgrade = req?.workflow === "version-upgrade";

	// The commit succeeded in draftChange; CI renders the authoritative plan on the MR.
	const plan = "CI computes the Terraform plan on the merge request. No local plan is run for config edits.";
	const precheckPassed = state.precheckPassed;

	const risks: string[] = [];
	if (req?.tier === "hot") risks.push("Hot-tier change can trigger shard relocation; apply off-peak.");
	// SIO-969: if the knowledge graph says the LAST change to this exact (deployment, stack)
	// failed, surface it as a HIGH risk (first) so the reviewer knows they may be repeating a
	// failed attempt. Best-effort: only when KG enrichment ran and recorded a terminal outcome.
	if (state.lastStackInstanceOutcome?.outcome === "failed") {
		const mr = state.lastStackInstanceOutcome.mrUrl ? ` (${state.lastStackInstanceOutcome.mrUrl})` : "";
		risks.unshift(
			`The previous change to this stack FAILED${mr}: "${state.lastStackInstanceOutcome.summary}". ` +
				"Confirm what failed and whether this proposal addresses it before approving.",
		);
	}
	if (req?.workflow === "ilm-rollout") {
		risks.push(
			"ILM phase change can trigger force-merge load / frozen pull-in; transitions take effect as each index rolls over, not immediately.",
		);
		// SIO-899: creating a previously-untracked policy file is a CREATE in CI's plan.
		if (state.policyCreated) {
			risks.push(
				"Creates a NEW managed ILM policy file not currently tracked in IaC; CI's plan will show a create. Verify all required phases (e.g. hot rollover + a delete/retention phase) are present, and that adopting the existing live policy will not need a Terraform import.",
			);
		}
		// SIO-1012: the target (deployment, stack) has no provisioned stack instance (no
		// environments/<dep>/<stack>/terraform.tfvars), which is how the repo's CI discovers applyable
		// combos. Without it the merge produces a NO-OP apply -- the policy files land in git but never
		// reach Elasticsearch. HIGH + first (unshift) so even a collapsed card flags it. The agent does
		// NOT provision the stack (it writes config only); provisioning is a repo/CI/human step.
		if (state.stackInstanceMissing) {
			risks.unshift(
				`No provisioned stack instance for ${req?.cluster ?? "this deployment"}/lifecycle-policies ` +
					"(no terraform.tfvars). CI discovers applyable combos from that file, so this MR will merge but " +
					"the apply will be a NO-OP -- the policies will NOT reach the cluster. Provision the stack instance " +
					"on the repo side (terraform.tfvars + plan/apply wiring) before relying on this change taking effect.",
			);
		}
		// SIO-933: re-pointing a component-template's lifecycle.name switches which ILM policy governs
		// that template's data streams as new indices roll over -- a real (MEDIUM) behavior change.
		if (state.lifecycleRetargeted) {
			risks.push(
				`Re-points the '${req?.bindTemplate}' component-template's settings.index.lifecycle.name to '${req?.policyName}'; data streams using that template switch to this ILM policy as new indices roll over -- confirm the policy's retention/rollover is correct for that data.`,
			);
		}
		// SIO-880: a retention REDUCTION is irreversible data loss -- surface as HIGH (first).
		if (state.retentionChange) {
			risks.unshift(
				`Retention REDUCED ${state.retentionChange.from}->${state.retentionChange.to}; data deleted at apply is irrecoverable -- confirm the IR/issue reference before merge.`,
			);
		}
	}
	// SIO-983: the draft differs from the LIVE cluster (the proposer read live and diffed it). A field
	// present in the draft but NOT live is usually a stale repo source copied forward -- surface as
	// HIGH (first) so even a collapsed card flags it. The full diff is in the review's liveParity block.
	if ((state.liveParity ?? "").includes("not in live")) {
		risks.unshift(
			"Draft introduces field(s) not present in the LIVE cluster policy (likely copied from a stale repo source). " +
				"Review the 'Differs from live cluster' section and confirm the source is current before merge.",
		);
	}
	if (isUpgrade) {
		risks.push(
			"Version upgrades are rolling and irreversible; confirm the target is a valid forward step and apply off-peak.",
		);
		risks.push("CCS/CCR: the local cluster must stay <= 1 minor ahead of every remote -- audit before merge.");
	}
	if (req?.workflow === "tier-resize")
		risks.push("Tier resize triggers a plan change; a downsize relocates shards -- apply off-peak.");
	if (req?.workflow === "fleet-integration") {
		risks.push(
			"Integration package bump is a Fleet EPM install; it can change ingest pipelines, mappings, and dashboards. Verify the target version is compatible with the deployment's stack version.",
		);
		// SIO-914: a major-version bump is the higher-risk case -- surface first.
		if (state.integrationMajorBump) {
			risks.unshift(
				`MAJOR version bump for the '${req?.integration}' integration; major upgrades can introduce breaking schema/pipeline changes -- review the integration changelog before merge.`,
			);
		}
		if (req?.force) {
			risks.push("force:true forces a package REINSTALL even if already installed -- confirm this is intended.");
		}
	}
	if (req?.workflow === "slo-edit") {
		risks.push(
			"SLO change adjusts an error-budget target/window; it does not delete data, but it changes alerting/burn-rate behavior as the new objective takes effect.",
		);
		// SIO-915: lowering the target relaxes the reliability bar -- surface first.
		if (state.sloTargetLowered) {
			risks.unshift(
				"Target LOWERED (looser SLO); this relaxes the reliability bar and widens the error budget -- confirm this is intended.",
			);
		}
	}
	if (req?.workflow === "alerting-edit") {
		risks.push(
			"Alert-rule change adjusts detection sensitivity (threshold/window) or scheduling; verify it does not mute a real failure mode. The actions/connector wiring is untouched.",
		);
		// SIO-916: disabling a rule silences its alerts -- the higher-risk change, surface first.
		if (state.alertDisabled) {
			risks.unshift(
				"Rule DISABLED (enabled:false); this SILENCES the rule's alerts -- confirm the alerting gap is intended and time-bounded.",
			);
		}
	}
	if (req?.workflow === "dataview-edit") {
		risks.push(
			"Data-view change is additive/metadata (runtime field, title, name); it does not touch indices or data. A runtime field is computed at query time -- verify the painless script against the live mappings.",
		);
	}
	if (req?.workflow === "cluster-default-edit") {
		risks.push(
			"total_shards_per_node change affects shard allocation as new indices roll over (not retroactively). Setting it too low can block allocation when a node count drops.",
		);
		// SIO-917: lowering concentrates shards on fewer nodes -- surface first.
		if (state.shardsLowered) {
			risks.unshift(
				"total_shards_per_node LOWERED; this concentrates shards on fewer nodes and can unbalance allocation or block shard placement -- confirm the node count supports it.",
			);
		}
	}
	// SIO-1022: deleting an override file is in-remit (AGENTS.md s3), but the destroy-vs-no-op verdict
	// comes from the CI plan. Lead with the s7 contract so the reviewer reads the plan before merge.
	if (req?.workflow === "cluster-default-delete") {
		risks.unshift(
			"This MR DELETES a cluster-defaults override file. CI computes the plan: 0 add / 0 change / 0 destroy means a safe no-op cleanup (the override never converged); ANY destroy means the resource is live and merging removes it -- do NOT merge an unintended destroy without data-owner sign-off.",
		);
	}
	// SIO-1037: deleting an ILM policy file is in-remit, but a destroy removes a live lifecycle policy.
	// Same s7 contract: lead with the plan-read requirement so the reviewer checks add/change/destroy.
	if (req?.workflow === "ilm-delete") {
		risks.unshift(
			"This MR DELETES an ILM policy file. CI computes the plan: 0 add / 0 change / 0 destroy means a safe no-op cleanup (a duplicate/never-converged policy); ANY destroy means the lifecycle policy is live and merging removes it -- do NOT merge an unintended destroy without data-owner sign-off (indices bound to the policy lose their lifecycle management).",
		);
	}
	if (req?.workflow === "space-edit") {
		risks.push(
			"Space metadata change (name/description/color); it does not touch data, dashboards, or feature access. The space's disabled_features and solution are untouched.",
		);
	}
	if (req?.workflow === "security-edit") {
		// SIO-918: a privilege grant is HIGH risk by default; cluster/superuser escalation leads.
		if (state.privilegeEscalation) {
			risks.unshift(
				"PRIVILEGE ESCALATION: grants cluster-level / superuser-class privileges -- this materially widens access. RECOMMEND HUMAN SECURITY REVIEW before merge.",
			);
		} else {
			risks.unshift(
				"Security role privilege GRANT (additive); widens what this role can do. Confirm the privileges are least-privilege and the role's members should have them. role_mappings + api_keys are untouched.",
			);
		}
	}
	if (req?.workflow === "topology-edit") {
		// SIO-919: the deployments stack is one SHARED state across all 10 clusters; applies can take
		// hours. Always HIGH -- surface the blast radius + apply window first.
		risks.unshift(
			"DEPLOYMENTS STACK: this is a SINGLE shared Terraform state across all 10 clusters -- CI's plan evaluates every deployment, and a deployments apply can take hours (up to 4-8h on the largest). Apply off-peak and confirm no other deployment change is in flight.",
		);
		// SSO/login config is the most acute failure mode here -- a bad realm/provider block can lock
		// every user out of Kibana. Lead the risk list with it (unshift AFTER the shared-state line so
		// it sorts above), and recommend a human review the YAML.
		if (req?.userSettingsYaml !== undefined) {
			risks.unshift(
				"COULD LOCK OUT LOGIN: this edits the SSO/OIDC user_settings_yaml (SAML realm / Kibana auth providers). A malformed or wrong block can break authentication for ALL users. RECOMMEND HUMAN REVIEW of the YAML before merge; have a break-glass path ready.",
			);
		}
		// SIO-997: the surgical merge preserves every sibling subtree byte-for-byte, so the lock-out
		// risk applies ONLY when the dotted key itself lands inside xpack.security. A non-security key
		// (xpack.monitoring, indices, slm, ...) is a benign operational edit on the shared state.
		if (req?.userSettingsMergeKey !== undefined) {
			const mergeTouchesSecurity = req.userSettingsMergeKey.startsWith("xpack.security.");
			risks.unshift(
				mergeTouchesSecurity
					? "COULD LOCK OUT LOGIN: this merges a key INSIDE xpack.security (the SSO/OIDC realm). A wrong value can break authentication for ALL users. RECOMMEND HUMAN REVIEW; have a break-glass path ready."
					: `This sets a single operational user_settings_yaml key (${req.userSettingsMergeKey}); the xpack.security/OIDC subtree is preserved byte-for-byte. Applies on the SHARED deployments state (rolling config change).`,
			);
		}
		// SIO-999: the surgical removal preserves every sibling subtree byte-for-byte, so the lock-out
		// risk applies ONLY when a removed key lands inside xpack.security. Removing a non-security key
		// (the inert xpack.monitoring subtree, ...) is a benign revert on the shared state.
		if (req?.userSettingsRemoveKeys !== undefined && req.userSettingsRemoveKeys.length > 0) {
			const removeTouchesSecurity = req.userSettingsRemoveKeys.some((k) => k.startsWith("xpack.security."));
			risks.unshift(
				removeTouchesSecurity
					? "COULD LOCK OUT LOGIN: this REMOVES a key INSIDE xpack.security (the SSO/OIDC realm). Dropping a realm setting can break authentication for ALL users. RECOMMEND HUMAN REVIEW; have a break-glass path ready."
					: `This removes ${req.userSettingsRemoveKeys.length} operational user_settings_yaml key(s) (${req.userSettingsRemoveKeys.join(", ")}); the xpack.security/OIDC subtree is preserved byte-for-byte. Applies on the SHARED deployments state (rolling config change).`,
			);
		}
		if (req?.autoscaleEnabled === true || req?.tierAutoscale === true) {
			risks.push(
				"Enabling autoscale lets the cluster grow toward its max_size ceiling automatically -- confirm the ceiling and the cost envelope.",
			);
		}
	}
	if (req?.workflow === "dashboard-edit") {
		// SIO-920: dashboards are display-only; a malformed NDJSON fails CI's saved-objects import
		// job, not production. Whole-file replace -- panel-level changes are not reviewed here.
		risks.push(
			"Dashboard NDJSON change (display-only); a malformed export fails CI's saved-objects import job, not production. This is a WHOLE-FILE add/replace -- individual panels are not reviewed; verify the export is the intended dashboard.",
		);
	}
	if (req?.workflow === "index-template-create") {
		// SIO-978: a new index template is a CREATE in CI's plan; it only affects indices created AFTER
		// apply (existing indices keep their current settings/ILM). A higher-priority template that
		// overlaps an existing pattern can shadow it for new indices -- the reviewer should confirm the
		// pattern + priority. composed_of must reference real component templates (those not listed in
		// ignore_missing_component_templates must already exist on the cluster, or the apply fails).
		risks.push(
			"Creates NEW index template(s); CI's plan will show a create. They apply only to indices created AFTER apply -- existing indices are unaffected. Confirm the index_patterns + priority do not unintentionally shadow an existing template, and that every composed_of component template (except those in ignore_missing_component_templates) exists on the cluster.",
		);
	}
	if (req?.workflow === "ingest-pipeline-create") {
		// SIO-1019: a new @custom ingest pipeline is a CREATE in CI's plan. An @custom pipeline only takes
		// effect where the corresponding default pipeline references it (the managed integration wires the
		// @custom hook), so it is additive and low-risk; the body is committed verbatim, so a malformed
		// processor would surface in CI's plan/apply, not silently change behavior in production.
		risks.push(
			"Creates NEW @custom ingest pipeline(s); CI's plan will show a create. The body is committed verbatim and was SIMULATED against the deployment (processors compile) before this MR -- but confirm the processors do the intended thing on real data (simulate runs against a synthetic empty document, and is skipped when the cluster is unreachable). An @custom pipeline only runs where its managed default pipeline references it.",
		);
	}
	if (req?.workflow === "ingest-pipeline-edit") {
		// SIO-1024: replacing an existing @custom pipeline body is an UPDATE in CI's plan. The whole body is
		// swapped (no partial patch), so the risk is a behavior change on live ingest -- the new body was
		// simulated before this MR, but confirm the change against real data.
		risks.push(
			"REPLACES the body of EXISTING @custom ingest pipeline(s); CI's plan will show an update-in-place. The whole pipeline body is swapped (verbatim, no partial patch) and was SIMULATED against the deployment before this MR -- but this changes live ingest behavior where the managed default pipeline references the @custom hook, so confirm the new processors do the intended thing on real data (simulate runs against a synthetic empty document, and is skipped when the cluster is unreachable).",
		);
	}

	// Descriptor: upgrade shows the version transition; tier-resize the tier + new sizing.
	const tierTarget = [
		req?.newSizeGb != null ? `${req.newSizeGb}g` : "",
		req?.newMaxGb != null ? `max ${req.newMaxGb}g` : "",
	]
		.filter(Boolean)
		.join("/");
	const descriptor = isUpgrade
		? `${state.previousVersion || "?"} -> ${req?.version ?? "?"}`
		: req?.workflow === "tier-resize"
			? `${req?.tier ?? "?"} -> ${tierTarget || "resize"}`
			: req?.workflow === "ilm-rollout"
				? // SIO-932: a multi-file request reads "N ILM policies: <fields>" (the shared change);
					// a single policy keeps the "<policy>: <fields>" form. SIO-989: summarize the actual
					// per-field edits (warm forcemerge/shrink, cold replicas) instead of just phase names,
					// falling back to the phase-name list / "change" when phasesPatch is empty (e.g. a copy).
					req?.ilmPolicies && req.ilmPolicies.length >= 2
					? `${req.ilmPolicies.length} ILM policies: ${summarizeNestedPatch(req.ilmPolicies[0]?.phasesPatch) || Object.keys(req.ilmPolicies[0]?.phasesPatch ?? {}).join(", ") || "change"}`
					: `${req?.policyName ?? "?"}: ${state.policyCreated ? "create " : ""}${summarizeNestedPatch(req?.phasesPatch) || Object.keys(req?.phasesPatch ?? {}).join(", ") || "change"}`
				: req?.workflow === "fleet-integration"
					? `${req?.integration ?? "?"} -> ${req?.integrationVersion ?? "?"}`
					: req?.workflow === "slo-edit"
						? `${req?.sloName ?? "?"}: ${[req?.sloTarget != null ? `target ${req.sloTarget}` : "", req?.sloWindow ? `window ${req.sloWindow}` : "", req?.sloTags ? "tags" : ""].filter(Boolean).join(", ") || "change"}`
						: req?.workflow === "alerting-edit"
							? `${req?.ruleName ?? "?"}: ${[req?.alertThreshold != null ? `threshold ${req.alertThreshold}` : "", req?.alertEnabled === false ? "disable" : req?.alertEnabled === true ? "enable" : "", req?.alertWindowSize != null ? `window ${req.alertWindowSize}${req?.alertWindowUnit ?? ""}` : "", req?.alertInterval ? `interval ${req.alertInterval}` : ""].filter(Boolean).join(", ") || "change"}`
							: req?.workflow === "dataview-edit"
								? `${req?.dataviewName ?? "?"}: ${[req?.runtimeFieldName ? `runtime ${req.runtimeFieldName}` : "", req?.dataviewTitle ? "title" : "", req?.dataviewDisplayName ? "name" : ""].filter(Boolean).join(", ") || "change"}`
								: req?.workflow === "cluster-default-edit"
									? // SIO-979: a freeform settingsPatch (single or multi-file) titles by templates + the
										// settings keys; a bare total_shards_per_node keeps the original descriptor.
										// SIO-989: summarize each settingsPatch into key=value tokens (handles nested keys like
										// routing.allocation.total_shards_per_node), falling back to the key list when empty.
										req?.clusterDefaults && req.clusterDefaults.length > 0
										? `${req.clusterDefaults.map((e) => e.templateName).join(", ")}: ${
												req.clusterDefaults
													.map((e) => summarizeNestedPatch(e.settingsPatch))
													.filter(Boolean)
													.join(", ") ||
												[...new Set(req.clusterDefaults.flatMap((e) => Object.keys(e.settingsPatch)))].join(", ")
											}`
										: req?.settingsPatch
											? `${req?.templateName ?? "?"}: ${summarizeNestedPatch(req.settingsPatch) || Object.keys(req.settingsPatch).join(", ")}`
											: `${req?.templateName ?? "?"}: total_shards_per_node ${req?.totalShardsPerNode ?? "?"}`
									: req?.workflow === "cluster-default-delete"
										? // SIO-1022: title by the removed override file basename(s).
											`remove ${(req?.clusterDefaultDeletes ?? []).map((e) => e.templateName).join(", ") || "override"}`
										: req?.workflow === "ilm-delete"
											? // SIO-1037: title by the removed ILM policy file basename(s).
												`remove ILM ${(req?.ilmDeletes ?? []).map((e) => e.policyName).join(", ") || "policy"}`
											: req?.workflow === "cluster-settings-edit"
												? // SIO-996: name the set/removed cluster-level keys so the title (and the recalled
													// iac-change fact) describe the change, not just the workflow.
													summarizeClusterSettings(req)
												: req?.workflow === "space-edit"
													? `${req?.spaceName ?? "?"}: ${[req?.spaceDisplayName ? "name" : "", req?.spaceDescription ? "description" : "", req?.spaceColor ? "color" : ""].filter(Boolean).join(", ") || "change"}`
													: req?.workflow === "security-edit"
														? `${req?.roleName ?? "?"}: grant ${[req?.grantCluster?.length ? "cluster" : "", req?.grantIndexNames?.length ? "index" : "", req?.grantKibanaApplication ? "kibana" : ""].filter(Boolean).join(", ") || "privileges"}`
														: req?.workflow === "topology-edit"
															? // SIO-997: no leading cluster -- the title wrapper already prefixes "[<cluster>]" (other
																// descriptors lead with their own id; only topology doubled the cluster).
																`${[req?.autoscaleEnabled !== undefined ? `autoscale ${req.autoscaleEnabled}` : "", req?.topologyTier ? `${req.topologyTier} ${[req?.tierZoneCount != null ? `zones ${req.tierZoneCount}` : "", req?.tierAutoscale !== undefined ? `autoscale ${req.tierAutoscale}` : ""].filter(Boolean).join(" ")}` : "", req?.userSettingsYaml !== undefined ? `${req.userSettingsTarget ?? ""} SSO` : "", req?.userSettingsMergeKey !== undefined ? `${req.userSettingsMergeKey}=${req.userSettingsMergeValue ?? "?"}` : "", req?.userSettingsRemoveKeys !== undefined && req.userSettingsRemoveKeys.length > 0 ? `-${req.userSettingsRemoveKeys.length} key(s)` : "", req?.sizeComponent ? `${req.sizeComponent} ${[req?.componentSize ? req.componentSize : "", req?.componentZoneCount != null ? `zones ${req.componentZoneCount}` : ""].filter(Boolean).join(" ")}` : ""].filter(Boolean).join(", ") || "topology"}`
															: req?.workflow === "dashboard-edit"
																? `${req?.dashboardSpace ?? "?"}__${req?.dashboardName ?? "?"}: ${req?.dashboardAction ?? "change"}`
																: req?.workflow === "index-template-create"
																	? // SIO-978: "create N index templates: <first name>[, +K more]".
																		`create ${req?.indexTemplates?.length ?? 0} index template${(req?.indexTemplates?.length ?? 0) === 1 ? "" : "s"}: ${req?.indexTemplates?.[0]?.name ?? "?"}${(req?.indexTemplates?.length ?? 0) > 1 ? `, +${(req?.indexTemplates?.length ?? 0) - 1} more` : ""}`
																	: req?.workflow === "ingest-pipeline-create"
																		? // SIO-1019: "create N ingest pipelines: <first name>[, +K more]".
																			`create ${req?.ingestPipelines?.length ?? 0} ingest pipeline${(req?.ingestPipelines?.length ?? 0) === 1 ? "" : "s"}: ${req?.ingestPipelines?.[0]?.name ?? "?"}${(req?.ingestPipelines?.length ?? 0) > 1 ? `, +${(req?.ingestPipelines?.length ?? 0) - 1} more` : ""}`
																		: req?.workflow === "ingest-pipeline-edit"
																			? // SIO-1024: "edit N ingest pipelines: <first name>[, +K more]".
																				`edit ${req?.ingestPipelineEdits?.length ?? 0} ingest pipeline${(req?.ingestPipelineEdits?.length ?? 0) === 1 ? "" : "s"}: ${req?.ingestPipelineEdits?.[0]?.name ?? "?"}${(req?.ingestPipelineEdits?.length ?? 0) > 1 ? `, +${(req?.ingestPipelineEdits?.length ?? 0) - 1} more` : ""}`
																			: (req?.tier ?? req?.resource ?? "change");
	const review: IacPlanReview = {
		// SIO-912: every maker workflow is a config edit; the agent never produces a local
		// terraform plan. The "terraform" review kind is retired.
		kind: "config-edit",
		cluster: req?.cluster ?? "",
		branch,
		title: `[${req?.cluster ?? "?"}] ${descriptor}: ${req?.workflow}`,
		diff: state.proposedDiff,
		plan,
		risks,
		precheckPassed,
		// SIO-954: surface the deployment's recent change history (empty when the graph is off).
		recentChanges: state.iacGraphContext || undefined,
		// SIO-970: surface recalled prior learnings/decisions for this stack-instance (empty
		// when the agent-memory backend is off or recall found nothing).
		priorLearnings: state.priorLearnings || undefined,
		// SIO-983: surface the live-parity advisory (draft vs live cluster). Empty when no live
		// equivalent was read (deployment not connected) or the draft matches live.
		liveParity: state.liveParity || undefined,
	};
	// SIO-990: capture the durable active-change context at propose time -- one consolidation point
	// for every proposer (they all land here via draftChange -> reviewPlan). This survives a
	// rejected/propose-only turn (mrUrl/mrIid stay undefined until openMr), so a follow-up correction
	// turn can amend THIS branch in place. openMr/watchPipeline merge in mr*/pipeline* later.
	// On an amend (intent "gitops-amend"), preserve the existing MR identity so reviewGate skips the
	// duplicate openMr and a later "check my MR" still resolves the same MR (the new commit already
	// updated it in place).
	const isAmend = state.intent === "gitops-amend";
	const activeChange: IacActiveChange = {
		deployment: req?.cluster ?? "",
		stack: stackFromPaths(state.proposedFiles) || stackForWorkflow(req?.workflow),
		kind: req?.workflow ?? "other",
		branch,
		proposedFiles: state.proposedFiles,
		title: review.title,
		...(isAmend && state.activeChange
			? {
					mrUrl: state.activeChange.mrUrl,
					mrIid: state.activeChange.mrIid,
					pipelineId: state.activeChange.pipelineId,
				}
			: {}),
		updatedAtTurn: state.requestId,
	};
	return { terraformPlan: plan, precheckPassed, risks, planReview: review, activeChange };
}

// HITL gate: surface the plan for human review. The graph pauses here; the resume
// payload carries the decision. This is the only path to opening an MR.
export function planReviewGate(state: IacStateType): Partial<IacStateType> {
	if (!state.planReview) return { reviewDecision: "rejected" };
	const message =
		state.planReview.kind === "config-edit"
			? "Review the proposed config change. Approve to open a GitLab MR, or reject. CI computes the plan on the MR; merge and apply remain manual in GitLab."
			: "Review the Terraform plan output. Approve to open a GitLab MR, or reject. Apply remains manual in GitLab.";
	const decision = interrupt({
		type: "iac_plan_review",
		review: state.planReview,
		message,
	}) as { decision?: "approved" | "rejected" };
	return { reviewDecision: decision?.decision === "approved" ? "approved" : "rejected" };
}

// Extract the merge_request web_url from callTool's "[status] {json}" response.
// (Not a regex over the whole body -- the JSON also contains avatar URLs.)
// SIO-1062: null when no web_url -- NEVER the raw result. Returning the raw body let a
// "[409] {...}" GitLab error blob be stored as mrUrl (poisoning the KG MergeRequest node
// and the iac-change fact, and breaking every downstream iid derivation).
export function extractMrUrl(toolResult: string): string | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart >= 0) {
		try {
			const parsed: unknown = JSON.parse(toolResult.slice(jsonStart));
			if (typeof parsed === "object" && parsed !== null) {
				const url = (parsed as { web_url?: unknown }).web_url;
				if (typeof url === "string" && url.length > 0) return url;
			}
		} catch {
			// fall through to null
		}
	}
	return null;
}

export type CreateMrResult =
	| { kind: "created"; url: string; iid: number | null }
	| { kind: "conflict"; iid: number | null } // 409: an open MR already exists for this source branch
	| { kind: "failed"; reason: string };

// SIO-1062: classify gitlab_create_merge_request's "[status] body" (or a callTool placeholder).
// A body without a web_url is a failure even without a [4xx/5xx] prefix (token-missing /
// server-unavailable / "[tool error: ...]" placeholders all land there). (Pure; unit-tested.)
export function classifyCreateMrResult(toolResult: string): CreateMrResult {
	if (toolResult.startsWith("[409")) return { kind: "conflict", iid: mrIidFromConflictMessage(toolResult) };
	if (toolResult.startsWith("[4") || toolResult.startsWith("[5"))
		return { kind: "failed", reason: toolResult.slice(0, 200) };
	const url = extractMrUrl(toolResult);
	if (!url) return { kind: "failed", reason: toolResult.slice(0, 200) };
	return { kind: "created", url, iid: extractMrIid(toolResult) };
}

// Minimal deterministic MR body, used as the fallback when the LLM step fails so the
// MR never blocks. Real bodies follow knowledge/reference/mr-template.md (filled by the LLM).
function fallbackMrDescription(review: IacPlanReview | null): string {
	return `${review?.diff ?? ""}\n\n## Plan\n\n${review?.plan ?? ""}\n\n## Risks\n\n${(review?.risks ?? []).map((r) => `- ${r}`).join("\n")}`;
}

// Build the MR description by having the LLM fill the agent's own mr-template.md
// (already in the system prompt) per the open-mr skill, from the gathered context.
// Falls back to the deterministic stub on any error.
async function buildMrDescription(state: IacStateType): Promise<string> {
	const review = state.planReview;
	const req = state.iacRequest;
	try {
		const sys = buildSystemPrompt(getAgentByName(AGENT));
		const context = [
			`Change: ${req?.workflow ?? "other"} on cluster ${req?.cluster ?? "?"}.`,
			req?.workflow === "version-upgrade"
				? `Elasticsearch version ${state.previousVersion || "?"} -> ${req?.version ?? "?"}.`
				: "",
			req?.workflow === "tier-resize"
				? `Tier '${req?.tier}' resize${req?.newSizeGb != null ? ` size -> ${req.newSizeGb}g` : ""}${req?.newMaxGb != null ? ` max -> ${req.newMaxGb}g` : ""}.`
				: "",
			req?.workflow === "ilm-rollout"
				? req?.ilmPolicies && req.ilmPolicies.length >= 2
					? // SIO-932: one MR carrying the SAME phase change across multiple policy files.
						`ILM phase change applied to ${req.ilmPolicies.length} policy files on '${req?.cluster}': ${req.ilmPolicies.map((e) => e.policyName).join(", ")}. Shared overrides: ${JSON.stringify(req.ilmPolicies[0]?.phasesPatch ?? {})}.${state.policyCreated ? " One or more files are CREATEs (new lifecycle-policy files onboarded into IaC)." : ""}${state.retentionChange ? ` At least one file REDUCES retention ${state.retentionChange.from} -> ${state.retentionChange.to} (irreversible).` : ""}`
					: `ILM policy '${req?.policyName}' ${req?.sourcePolicy ? `EXACT COPY of '${req.sourcePolicy}'` : state.policyCreated ? "CREATE (new lifecycle-policy file for an untracked/unmanaged policy, onboarding it into IaC)" : "phase change"}${Object.keys(req?.phasesPatch ?? {}).length > 0 ? ` with overrides: ${JSON.stringify(req?.phasesPatch ?? {})}` : ""}.${state.retentionChange ? ` Retention REDUCED ${state.retentionChange.from} -> ${state.retentionChange.to} (irreversible).` : ""}${state.lifecycleRetargeted ? ` Also binds component-template '${req?.bindTemplate}' settings.index.lifecycle.name -> '${req?.policyName}'.` : ""}`
				: "",
			req?.workflow === "fleet-integration"
				? `Fleet integration '${req?.integration}' package version -> ${req?.integrationVersion}${req?.force ? " (force reinstall)" : ""}.${state.integrationMajorBump ? " MAJOR version bump (potential breaking changes)." : ""}`
				: "",
			req?.workflow === "slo-edit"
				? `SLO '${req?.sloName}' override:${req?.sloTarget != null ? ` objective.target -> ${req.sloTarget}` : ""}${req?.sloWindow ? ` time_window.duration -> ${req.sloWindow}` : ""}${req?.sloTags ? ` tags -> ${JSON.stringify(req.sloTags)}` : ""}.${state.sloTargetLowered ? " Target LOWERED (looser SLO)." : ""}`
				: "",
			req?.workflow === "alerting-edit"
				? `Alert rule '${req?.ruleName}' edit:${req?.alertThreshold != null ? ` params.threshold -> ${req.alertThreshold}` : ""}${req?.alertWindowSize != null ? ` params.windowSize -> ${req.alertWindowSize}${req?.alertWindowUnit ?? ""}` : ""}${req?.alertEnabled !== undefined ? ` enabled -> ${req.alertEnabled}` : ""}${req?.alertInterval ? ` interval -> ${req.alertInterval}` : ""}.${state.alertDisabled ? " Rule DISABLED (silences alerts)." : ""}`
				: "",
			req?.workflow === "dataview-edit"
				? `Data view '${req?.dataviewName}' edit:${req?.runtimeFieldName ? ` runtime_field_map.${req.runtimeFieldName} (config-form script_source)` : ""}${req?.dataviewTitle ? ` title -> ${req.dataviewTitle}` : ""}${req?.dataviewDisplayName ? ` name -> ${req.dataviewDisplayName}` : ""}.`
				: "",
			req?.workflow === "cluster-default-edit"
				? // SIO-979: a freeform settingsPatch (single or multi-file) describes the merged settings per
					// template; a bare total_shards_per_node keeps the original single-field line.
					req?.clusterDefaults && req.clusterDefaults.length > 0
					? `Cluster-defaults settings change on '${req?.cluster}' across ${req.clusterDefaults.length} templates: ${req.clusterDefaults.map((e) => `${e.templateName} (${JSON.stringify(e.settingsPatch)})`).join(", ")}. Merged into settings.index; CI computes the plan.`
					: req?.settingsPatch
						? `Cluster-defaults template '${req?.templateName}' on '${req?.cluster}': settings.index merged with ${JSON.stringify(req.settingsPatch)}. CI computes the plan.`
						: `Cluster-defaults template '${req?.templateName}': settings.index.routing.allocation.total_shards_per_node -> ${req?.totalShardsPerNode}.${state.shardsLowered ? " LOWERED (can unbalance allocation)." : ""}`
				: "",
			req?.workflow === "space-edit"
				? `Space '${req?.spaceName}' edit:${req?.spaceDisplayName ? ` name -> ${req.spaceDisplayName}` : ""}${req?.spaceDescription ? " description (changed)" : ""}${req?.spaceColor ? ` color -> ${req.spaceColor}` : ""}.`
				: "",
			req?.workflow === "security-edit"
				? `Security role '${req?.roleName}' ADDITIVE privilege grant${state.privilegeEscalation ? " (PRIVILEGE ESCALATION -- recommend human security review)" : ""}. role_mappings + api_keys untouched.`
				: "",
			req?.workflow === "topology-edit"
				? `Deployment topology '${req?.cluster}' (SHARED deployments state):${req?.autoscaleEnabled !== undefined ? ` elasticsearch.autoscale -> ${req.autoscaleEnabled}` : ""}${req?.topologyTier ? ` ${req.topologyTier}${req?.tierZoneCount != null ? ` zone_count -> ${req.tierZoneCount}` : ""}${req?.tierAutoscale !== undefined ? ` autoscale -> ${req.tierAutoscale}` : ""}` : ""}${req?.userSettingsYaml !== undefined ? ` ${req?.userSettingsTarget ?? ""}.user_settings_yaml updated (SSO/login; value withheld)` : ""}${req?.userSettingsMergeKey !== undefined ? ` ${req?.userSettingsMergeTarget ?? ""}.user_settings_yaml ${req.userSettingsMergeKey} -> ${req.userSettingsMergeKey.startsWith("xpack.security.") ? "value withheld (xpack.security)" : req.userSettingsMergeValue} (siblings byte-for-byte)` : ""}${req?.userSettingsRemoveKeys !== undefined && req.userSettingsRemoveKeys.length > 0 ? ` ${req?.userSettingsMergeTarget ?? ""}.user_settings_yaml removed ${req.userSettingsRemoveKeys.some((k) => k.startsWith("xpack.security.")) ? `${req.userSettingsRemoveKeys.length} key(s) (names withheld: xpack.security)` : req.userSettingsRemoveKeys.join(", ")} (siblings byte-for-byte)` : ""}${req?.sizeComponent ? ` ${req.sizeComponent}${req?.componentSize ? ` size -> ${req.componentSize}` : ""}${req?.componentZoneCount != null ? ` zone_count -> ${req.componentZoneCount}` : ""}` : ""}.`
				: "",
			req?.workflow === "dashboard-edit"
				? `Dashboard ${req?.dashboardAction ?? "?"} '${req?.dashboardSpace ?? "?"}__${req?.dashboardName ?? "?"}.ndjson' (whole-file Kibana NDJSON export; committed verbatim, no panel edits). ${review?.diff ?? ""}`
				: "",
			req?.workflow === "ingest-pipeline-create"
				? `Creates ${req?.ingestPipelines?.length ?? 0} NEW @custom ingest pipeline file(s) on '${req?.cluster}': ${(req?.ingestPipelines ?? []).map((e) => e.name).join(", ")}. Bodies committed VERBATIM; new files only (existing pipelines are untouched).`
				: "",
			req?.workflow === "ingest-pipeline-edit"
				? `Replaces ${req?.ingestPipelineEdits?.length ?? 0} EXISTING @custom ingest pipeline file(s) on '${req?.cluster}': ${(req?.ingestPipelineEdits ?? []).map((e) => e.name).join(", ")}. Bodies committed VERBATIM (whole-body replace; the file must already exist).`
				: "",
			req?.reason ? `Reason given: ${req.reason}.` : "",
			`Branch: ${state.branch}. Target: main.`,
			// SIO-932: list every committed file so the MR's "Files touched" section is complete for a
			// multi-file change (a single-file change lists the one path, as before).
			state.proposedFiles.length > 0 ? `Files touched: ${state.proposedFiles.join(", ")}.` : "",
			`File diff:\n${review?.diff ?? "(none)"}`,
			`Plan note: ${review?.plan ?? "(none)"}`,
		]
			.filter(Boolean)
			.join("\n");
		// Category + risk follow mr-template.md's own rules: version-bump = LOW;
		// tier size/max_size = tier-resize / MEDIUM.
		const categoryRisk =
			req?.workflow === "ilm-rollout"
				? `Category ilm${state.policyCreated ? " (new policy)" : ""}, Risk ${state.retentionChange ? "HIGH" : "MEDIUM"}`
				: req?.workflow === "tier-resize"
					? "Category tier-resize, Risk MEDIUM"
					: req?.workflow === "fleet-integration"
						? `Category fleet-integration, Risk ${state.integrationMajorBump ? "HIGH" : "MEDIUM"}`
						: req?.workflow === "slo-edit"
							? "Category slo, Risk MEDIUM"
							: req?.workflow === "alerting-edit"
								? `Category alerting, Risk ${state.alertDisabled ? "HIGH" : "MEDIUM"}`
								: req?.workflow === "dataview-edit"
									? "Category dataview, Risk LOW"
									: req?.workflow === "cluster-default-edit"
										? `Category cluster-defaults, Risk ${state.shardsLowered ? "MEDIUM" : "LOW"}`
										: req?.workflow === "space-edit"
											? "Category spaces, Risk MEDIUM"
											: req?.workflow === "security-edit"
												? `Category security, Risk ${state.privilegeEscalation ? "HIGH (escalation)" : "HIGH"}`
												: req?.workflow === "topology-edit"
													? "Category deployment-topology, Risk HIGH"
													: req?.workflow === "dashboard-edit"
														? "Category dashboard, Risk MEDIUM"
														: // SIO-1019: a new @custom ingest pipeline is an additive new-file create (mr-template.md
															// MEDIUM "ingest-pipeline (additive)"); LOW because it only runs where its managed default
															// pipeline references it and existing data is untouched.
															req?.workflow === "ingest-pipeline-edit"
															? "Category ingest-pipelines, Risk MEDIUM"
															: req?.workflow === "ingest-pipeline-create"
																? "Category ingest-pipelines, Risk LOW"
																: "Category version-bump, Risk LOW";
		const instruction =
			"Write the GitLab merge request description using knowledge/reference/mr-template.md's SECTION HEADINGS, but as an " +
			"agent-authored MR: state the single RESOLVED value per section -- do NOT reproduce the human checkbox " +
			"menus. Category, Cluster(s) affected, and Risk are one resolved line each (e.g. 'Category: tier-resize', " +
			"'Cluster(s) affected: eu-b2b', 'Risk: MEDIUM') -- never list the unselected options or empty `- [ ]` boxes. " +
			`This is a config edit committed via the GitLab API (no local terraform): use ${categoryRisk}, and mark the ` +
			"Plan output section 'n/a -- config edit; CI computes the plan on the MR'. Do NOT emit any gl-testing / " +
			'"Tested in gl-testing first?" section; omit it entirely. Fill Summary, ' +
			"Cluster(s) affected, What changed, Why, Files touched, Rollback plan, and Reviewer notes from the context. " +
			"Append the open-mr skill footer. Output ONLY the final markdown.";
		const llm = createLlm("iacDrafter", AGENT);
		const res = await llm.invoke([new SystemMessage(`${sys}\n\n${instruction}`), new HumanMessage(context)]);
		const body = String(res.content).trim();
		return body.length > 0 ? body : fallbackMrDescription(review);
	} catch (err) {
		log.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"MR description generation failed; using fallback",
		);
		return fallbackMrDescription(review);
	}
}

// Open the MR. Never merges, never approves, never applies. The branch + commit already
// exist on the remote (created via the GitLab API in draftChange), so there is no local
// git push. SIO-912: the legacy local-terraform path (which pushed a local branch) is gone.
export async function openMr(state: IacStateType): Promise<Partial<IacStateType>> {
	const review = state.planReview;
	const description = await buildMrDescription(state);
	const mr = await callTool("gitlab_create_merge_request", {
		source_branch: state.branch,
		target_branch: "main",
		title: review?.title ?? "Elastic IaC change",
		description,
		labels: [...AGENT_MR_LABELS],
	});
	const result = classifyCreateMrResult(mr);

	// SIO-1062: a failed create must END the turn (blockedReason short-circuit in graph.ts) --
	// storing the raw error body as mrUrl poisoned the KG MergeRequest node and the iac-change
	// fact, and the turn falsely reported success.
	if (result.kind === "failed") {
		log.error({ branch: state.branch, mr: mr.slice(0, 200) }, "openMr: MR creation failed; ending turn");
		return {
			blockedReason: `MR creation failed: ${result.reason}`,
			messages: [
				new AIMessage(
					`Opening the merge request failed (branch ${state.branch} is committed and pushed, but no MR exists): ${result.reason}. Nothing was recorded; retry, or open the MR manually in GitLab.`,
				),
			],
		};
	}

	let mrUrl: string;
	let mrIid: number | null;
	if (result.kind === "conflict") {
		// SIO-1062: an open MR already exists for this deterministic branch (e.g. a fresh thread
		// re-proposed the same change). draftChange already committed this turn's change onto that
		// branch, so the open MR carries it -- recover it and proceed idempotently (mirrors
		// reconcileStack's [409 -> "reused"] path).
		let iid = result.iid;
		let url = "";
		if (iid != null) url = extractMrUrl(await callTool("gitlab_get_merge_request", { iid })) ?? "";
		if (!url) {
			url = parseAgentMrBySourceBranch(await callTool("gitlab_list_agent_merge_requests", {}), state.branch);
			if (url && iid == null) {
				const m = /\/merge_requests\/(\d+)/.exec(url);
				iid = m ? Number(m[1]) : null;
			}
		}
		if (!url) {
			log.error(
				{ branch: state.branch, mr: mr.slice(0, 200) },
				"openMr: 409 but existing MR unresolvable; ending turn",
			);
			return {
				blockedReason: `MR creation failed: an MR already exists for branch ${state.branch} but could not be resolved.`,
				messages: [
					new AIMessage(
						`An open merge request already exists for branch ${state.branch}, but I could not resolve it. Check GitLab for open agent MRs on that branch.`,
					),
				],
			};
		}
		log.info({ branch: state.branch, iid, url }, "openMr: reusing already-open MR for this branch (409)");
		mrUrl = url;
		mrIid = iid;
	} else {
		mrUrl = result.url;
		mrIid = result.iid;
	}

	// SIO-990: merge the opened MR into the durable active-change context (set at propose time by
	// reviewPlan) so a follow-up "check my MR" and any amend target the right MR. Best-effort: only
	// when reviewPlan populated activeChange this turn (it always does on the gitops path).
	const activeChange = state.activeChange
		? { ...state.activeChange, mrUrl, mrIid: mrIid ?? undefined, updatedAtTurn: state.requestId }
		: state.activeChange;
	return { mrUrl, mrIid, ...(activeChange ? { activeChange } : {}) };
}

// MR iid from callTool's "[status] {json}" create-MR response (for the pipeline watch).
export function extractMrIid(toolResult: string): number | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const parsed = JSON.parse(toolResult.slice(jsonStart)) as { iid?: unknown };
		return typeof parsed.iid === "number" ? parsed.iid : null;
	} catch {
		return null;
	}
}

// Newest pipeline {id,status} from gitlab_get_merge_request_pipelines' "[status] [...]"
// body (the JSON array of pipelines, newest first). callTool prefixes "[<http status>] ".
export function parseNewestPipeline(toolResult: string): { id: number; status: string } | null {
	// Skip the "[200] " status prefix: find the first "[" that opens the JSON array.
	const m = toolResult.match(/\[\s*(?:\{|\])/);
	if (!m || m.index === undefined) return null;
	try {
		const parsed = JSON.parse(toolResult.slice(m.index)) as Array<{ id?: unknown; status?: unknown }>;
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		const p = parsed[0];
		if (typeof p?.id === "number") return { id: p.id, status: typeof p.status === "string" ? p.status : "unknown" };
		return null;
	} catch {
		return null;
	}
}

// SIO-877: newest open agent MR {iid,webUrl} from gitlab_list_agent_merge_requests'
// "[status] [...]" body (open MRs labeled agent-generated, newest first). The fallback
// when the thread no longer holds an mrIid (e.g. after a page reload).
export function parseLatestAgentMr(toolResult: string): { iid: number; webUrl: string } | null {
	const m = toolResult.match(/\[\s*(?:\{|\])/);
	if (!m || m.index === undefined) return null;
	try {
		const parsed = JSON.parse(toolResult.slice(m.index)) as Array<{ iid?: unknown; web_url?: unknown }>;
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		const mr = parsed[0];
		if (typeof mr?.iid === "number") return { iid: mr.iid, webUrl: typeof mr.web_url === "string" ? mr.web_url : "" };
		return null;
	} catch {
		return null;
	}
}

// Parse the terraform report tool result ("[...]"-free; it's the bare report JSON or a
// "[...]" not-ready message). Returns null when not ready.
export function parsePlanReport(toolResult: string): IacPlanReport | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const r = JSON.parse(toolResult.slice(jsonStart)) as Partial<IacPlanReport>;
		if (typeof r.create === "number" && typeof r.update === "number" && typeof r.delete === "number") {
			return { create: r.create, update: r.update, delete: r.delete, resources: r.resources ?? [] };
		}
		return null;
	} catch {
		return null;
	}
}

// Parse the approvals tool result ("[status] {json}").
export function parseApprovalState(toolResult: string): IacApprovalState | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const a = JSON.parse(toolResult.slice(jsonStart)) as {
			approved?: unknown;
			approvals_required?: unknown;
			approved_by?: Array<{ user?: { username?: unknown } }>;
		};
		return {
			approved: a.approved === true,
			required: typeof a.approvals_required === "number" ? a.approvals_required : undefined,
			approvedBy: Array.isArray(a.approved_by)
				? a.approved_by.map((x) => String(x?.user?.username ?? "")).filter(Boolean)
				: undefined,
		};
	} catch {
		return null;
	}
}

// SIO-1072: isTerminalPipelineStatus/parseSinglePipeline/classifyPipelineFailure/
// classifyFleetApplyResult/parseDriftCheckResult/parseFleetApplyOutcome moved verbatim to
// fleet-apply-result.ts (a dependency-free leaf) so reconcile.ts's fleet-settlement pass can share
// them without importing nodes.ts (nodes.ts imports reconcile.ts -- a cycle). Re-exported at the
// import site above for existing external importers (pipeline-status.test.ts).

// SIO-930: the user-facing outcome of one IaC turn, derived from terminal state, so the UI chip
// reflects what actually happened instead of an unconditional "Completed". Precedence: explicit human
// decisions (reject/decline) > a no-op (requested config already matches current state) > a request we
// have no proposer for (unsupported) > a mechanical guard block > a failed CI pipeline > completed.
// (Pure; unit-tested.)
export type IacTurnOutcome =
	| "completed"
	| "rejected"
	| "declined"
	| "no-op"
	| "blocked"
	| "unsupported"
	| "pipeline-failed";

export function iacTurnOutcome(state: IacStateType): IacTurnOutcome {
	if (state.reviewDecision === "rejected") return "rejected";
	if (state.syntheticsPushApproved === false && state.syntheticsDriftReport) return "declined";
	if (state.fleetUpgradeApproved === false && state.fleetUpgradeReport) return "declined";
	// SIO-1020: a no-op is not a failure -- the requested config already matches current state. It
	// renders as a neutral "No change needed", distinct from an amber "Blocked" guard rejection.
	if (state.noopReason) return "no-op";
	if (state.blockedReason) {
		return state.iacRequest?.workflow === "other" ? "unsupported" : "blocked";
	}
	// SIO-961: a partial fleet apply rides on a CI job that exited 1 (so pipelineStatus is
	// "failed"), but the upgrade itself is in-progress with only agent-side failures -- do NOT
	// flag the turn as pipeline-failed. The message carries the honest breakdown.
	if (state.fleetUpgradeResult?.status === "partial") return "completed";
	if (isTerminalPipelineStatus(state.pipelineStatus) && state.pipelineStatus === "failed") return "pipeline-failed";
	return "completed";
}

// One-line plan summary: "0 create / 1 update / 0 destroy".
export function formatPlanSummary(report: IacPlanReport | null): string {
	if (!report) return "plan not available";
	return `${report.create} create / ${report.update} update / ${report.delete} destroy`;
}

// SIO-926: re-poll an already-dispatched fleet-apply pipeline on a follow-up turn. READ-ONLY:
// gitlab_get_pipeline for the live status, and on a terminal run gitlab_get_fleet_upgrade_apply_result
// for the verify-sweep outcome. Never re-triggers. Refreshes fleetUpgradeResult; clears the persisted
// pipeline id once terminal so a later turn does not keep re-checking a finished run.
async function checkFleetApplyStatus(state: IacStateType, pipelineId: number): Promise<Partial<IacStateType>> {
	const prior = state.fleetUpgradeResult;
	const single = parseSinglePipeline(await callTool("gitlab_get_pipeline", { pipelineId }));
	const status = single?.status ?? "unknown";
	const pipelineUrl = single?.webUrl ?? prior?.pipelineUrl;
	log.info({ pipelineId, status }, "iac fleet apply: follow-up status check");

	if (!isTerminalPipelineStatus(status)) {
		// Still in flight -- report current status, keep the id for the next check.
		const result: FleetUpgradeResult = {
			...(prior ?? {}),
			status: "dispatched",
			pipelineId,
			pipelineStatus: status,
			...(pipelineUrl && { pipelineUrl }),
			note: `Still running (status ${status}). Re-check anytime or watch the pipeline.`,
		};
		await emitFleetResult(result);
		return { fleetUpgradeResult: result };
	}

	// Terminal: fetch the apply result for the verify-sweep ground truth (failed_silent).
	const res = parseDriftCheckResult(await callTool("gitlab_get_fleet_upgrade_apply_result", { pipelineId }));
	const outcome = res.report ? parseFleetApplyOutcome(res.report) : null;
	const common = {
		pipelineId,
		pipelineStatus: res.status || status,
		...(pipelineUrl && { pipelineUrl }),
		...(outcome && {
			actionId: outcome.actionId,
			pollStatus: outcome.pollStatus,
			acked: outcome.acked,
			created: outcome.created,
			failedSilent: outcome.failedSilent,
		}),
	};
	// SIO-975: classify via the SAME helper the main apply path uses, so a follow-up "how's it
	// going?" surfaces the full partial breakdown (counts + per-agent disk/download errors) or the
	// report's CI error_reason -- not the bare "failed for another reason" the old branch produced.
	const ciStatus = res.status === "success" || status === "success" ? "success" : res.status || status;
	const classified = classifyFleetApplyResult(ciStatus, outcome, res.failureLog, res.stateLocked);
	const result: FleetUpgradeResult = {
		status: classified.status,
		...common,
		...(classified.note && { note: classified.note }),
	};
	await emitFleetResult(result);
	// Clear the in-flight id now that it reached terminal.
	return { fleetUpgradeResult: result, fleetApplyPipelineId: null };
}

// SIO-875: poll the MR pipeline (bounded), then gather the real plan + approval state.
// Never hangs past the budget; teardownIac renders the result. Read-only. (Live mid-poll
// streaming is a follow-up -- the final state is rendered once here.)
export async function watchPipeline(state: IacStateType): Promise<Partial<IacStateType>> {
	// SIO-926: a fleet-agent BINARY upgrade has no MR -- it dispatches an imperative apply pipeline.
	// If this thread has one in flight, a "how's the upgrade going?" follow-up must re-poll THAT
	// pipeline (read-only), not hunt for an agent MR. Handle it before the MR path.
	if (state.fleetApplyPipelineId != null) {
		return await checkFleetApplyStatus(state, state.fleetApplyPipelineId);
	}

	// SIO-959: the thread has no fleet pipeline id, but the user may have dispatched
	// the upgrade in a DIFFERENT conversation ("how's the us-cld upgrade going?" in a
	// fresh session). A fleet upgrade has no MR, so the MR fallback below can't help.
	// Recover the dispatched pipeline id from durable memory (structured annotations)
	// and re-poll THAT pipeline. Prefer the deployment named in the query/state; else
	// take the sole in-flight upgrade. Best-effort -- no recall -> fall through.
	// SIO-1071: ONLY on a status-check turn with no MR context of its own. On the gitops
	// approve leg openMr just set mrIid/mrUrl and this node must poll THAT plan pipeline;
	// unconditional recovery let a stale dispatched fleet fact (deployment named in the
	// prompt) hijack the turn and poll an old fleet pipeline instead.
	if (state.intent === "pipeline-status" && state.mrIid == null && !state.mrUrl) {
		const inFlight = await recallInFlightFleetUpgrades("elastic-iac");
		const withId = inFlight.filter((u) => u.pipelineId != null);
		if (withId.length > 0) {
			const query = lastHumanText(state).toLowerCase();
			const named = withId.find((u) => u.deployment && query.includes(u.deployment.toLowerCase()));
			const chosen = named ?? (withId.length === 1 ? withId[0] : undefined);
			if (chosen?.pipelineId != null) {
				log.info(
					{ pipelineId: chosen.pipelineId, deployment: chosen.deployment },
					"recovered dispatched fleet pipeline from memory for cross-session status check",
				);
				const recoveredState = chosen.deployment ? { ...state, targetDeployment: chosen.deployment } : state;
				return await checkFleetApplyStatus(recoveredState, chosen.pipelineId);
			}
		}
	}

	// SIO-877/SIO-990: when the thread no longer holds the MR (e.g. a follow-up after a clear/reload
	// minted a fresh threadId), recover it. Order: (1) the thread's own mrIid; (2) SIO-990 the last
	// durable iac-change fact for THIS deployment from agent-memory -- deterministic, names the exact
	// MR the session opened; (3) the latest OPEN agent MR as a last resort (which can be the wrong one
	// when several are open). The recall step is what stops "check my MR" from asking "which MR?".
	let iid = state.mrIid;
	let recoveredUrl = "";
	if (iid === null) {
		// Scope the recall to the deployment this turn resolved (active change / target / parsed
		// cluster); undefined falls back to the most recent iac-change across deployments.
		const dep = state.activeChange?.deployment || state.targetDeployment || state.iacRequest?.cluster || undefined;
		const recalled = await recallLastIacChange(dep);
		if (recalled?.mrIid != null) {
			iid = recalled.mrIid;
			if (recalled.mrUrl) recoveredUrl = recalled.mrUrl;
			log.info(
				{ iid, deployment: recalled.deployment, source: "agent-memory" },
				"recovered MR from durable iac-change fact for cross-thread pipeline-status",
			);
		} else {
			const latest = parseLatestAgentMr(await callTool("gitlab_list_agent_merge_requests", {}));
			if (!latest) {
				return {
					pipelineStatus: "unknown",
					messages: [new AIMessage("No open agent merge request to check. Propose a change first, then ask again.")],
				};
			}
			iid = latest.iid;
			recoveredUrl = latest.webUrl;
			log.info({ iid }, "recovered latest open agent MR for pipeline-status");
		}
	}

	// SIO-982: per-call poll budget. SIO-989: capped at 90s -- both the default and the "extended"
	// budget are now 90s, so a watch turn never blocks longer than the snappy ceiling.
	const defaultBudgetMs = Number(process.env.IAC_PIPELINE_POLL_BUDGET_MS ?? "90000");
	const extendedBudgetMs = Number(process.env.IAC_PIPELINE_POLL_BUDGET_MS_EXTENDED ?? "90000");
	// SIO-984: distinguish the two ways watchPipeline is entered. Straight after openMr (intent
	// "gitops") it polls to TERMINAL so the card shows triggered->running->succeeded in one turn; a
	// "check my MR" follow-up (intent "pipeline-status") only extends when the user asks to "watch
	// until done". SIO-989: the extended budget is now the same 90s as the default, so a cold-runner
	// pipeline (~130s) may not reach terminal within the turn -- the card returns at "running" and the
	// user re-checks with "check my MR". Returns early the instant the pipeline hits terminal, so the
	// budget is a ceiling, not a fixed wait. Override both via IAC_PIPELINE_POLL_BUDGET_MS[_EXTENDED].
	const isPostMrWatch = state.intent === "gitops";
	const budgetMs = resolveWatchPipelineBudgetMs(isPostMrWatch, lastHumanText(state), defaultBudgetMs, extendedBudgetMs);
	const intervalMs = Number(process.env.IAC_PIPELINE_POLL_INTERVAL_MS ?? "10000");
	const deadline = Date.now() + budgetMs;

	let pipelineId: number | null = null;
	let status = "unknown";
	// SIO-984: on the post-MR watch, emit a synthetic "triggered" step BEFORE the first poll so the
	// pipeline-log card always shows >=2 steps (triggered -> running -> ... -> succeeded), mirroring
	// the fleet flow's "fleet apply: started" line. By the first poll GitLab has usually advanced the
	// pipeline past "created" to "running", so without this the card would show only a lone "running".
	// A "check my MR" follow-up did not trigger anything this turn, so it skips the synthetic line.
	if (isPostMrWatch) {
		await dispatchCustomEvent("iac_pipeline_progress", { pipelineId: null, status: "triggered" });
	}
	while (Date.now() < deadline) {
		const newest = parseNewestPipeline(await callTool("gitlab_get_merge_request_pipelines", { iid }));
		if (newest) {
			pipelineId = newest.id;
			if (newest.status !== status) {
				status = newest.status;
				log.info({ iid, pipelineId, status }, "iac pipeline status");
				// SIO-876: stream the transition live (the SSE pump forwards this as
				// iac_pipeline_progress); the final status+plan+approval still arrive as
				// the assistant message.
				// SIO-993: qualify the live step so the panel reads "plan succeeded" (this is the PLAN
				// pipeline on the MR), not a bare "success" that reads as "the change is live". The
				// frontend renders `Pipeline #<id>: <status>` verbatim, so qualifying the status string
				// here is enough -- no frontend change.
				await dispatchCustomEvent("iac_pipeline_progress", {
					pipelineId,
					status: status === "success" ? "plan succeeded" : status,
				});
			}
			if (isTerminalPipelineStatus(status)) break;
		}
		if (Date.now() + intervalMs >= deadline) break;
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	// Persist the (possibly recovered) MR so subsequent turns reuse it; set the link
	// when we recovered it (don't clobber an existing mrUrl from this thread's openMr).
	const recovered: Partial<IacStateType> = { mrIid: iid, ...(recoveredUrl && { mrUrl: recoveredUrl }) };

	// SIO-990: merge the resolved pipeline + (possibly recovered) MR into the durable active-change
	// context so a later "check my MR" / amend reads the latest status. Best-effort: only when this
	// session has an activeChange (it does on the gitops/amend path; a bare cross-session "check my
	// MR" with no prior proposal leaves it null and just relies on mrIid recovery above).
	const withPipeline = (st: string): Partial<IacStateType> => {
		if (!state.activeChange) return recovered;
		const activeChange: IacActiveChange = {
			...state.activeChange,
			mrIid: iid ?? state.activeChange.mrIid,
			...(recoveredUrl && { mrUrl: recoveredUrl }),
			...(pipelineId != null && { pipelineId }),
			pipelineStatus: st,
			updatedAtTurn: state.requestId,
		};
		return { ...recovered, activeChange };
	};

	// Still running at budget: surface the partial result; a follow-up re-checks.
	if (!isTerminalPipelineStatus(status)) {
		return { ...withPipeline(status || "running"), pipelineId, pipelineStatus: status || "running" };
	}

	// Terminal: fetch the real plan + approval state.
	const planReport = pipelineId
		? parsePlanReport(await callTool("gitlab_get_pipeline_terraform_report", { pipelineId }))
		: null;
	const approvalState = parseApprovalState(await callTool("gitlab_get_merge_request_approvals", { iid }));
	// SIO-992: read the MR's lifecycle state so the message distinguishes "MR open, plan ready" from
	// "MR merged, apply runs on main". watchPipeline only sees the pre-merge plan pipeline, so without
	// this a merged MR still reads as "ready to merge". Best-effort: "" when unreadable.
	const mrInfo = parseMrState(await callTool("gitlab_get_merge_request", { iid }));
	const mrState = mrInfo?.state ?? "";

	// SIO-993: once the MR is MERGED, the terraform APPLY runs on main for the merge commit -- read THAT
	// pipeline's real status (running/success/failed) so the message reports applied/applying/failed
	// instead of telling the user to go check GitLab. Best-effort, single read (no in-turn poll-to-
	// terminal): "" when not merged, no merge_commit_sha yet, or the apply pipeline hasn't started.
	// SIO-995: read the APPLY JOB's status (parent -> child -> apply:* job), NOT the parent pipeline's
	// status. The parent reports success transiently before the child apply job runs/fails, so reading
	// it gave a FALSE "applied/live". applyPipelineStatus is "" when the apply job hasn't appeared yet
	// (the caller treats "" as "starting", never success).
	let applyPipelineStatus = "";
	let applyPipelineId: number | null = null;
	let applyPipelineUrl = "";
	if (mrState === "merged" && mrInfo?.mergeCommitSha) {
		const apply = parseApplyResult(
			await callTool("gitlab_get_merge_commit_apply_result", { sha: mrInfo.mergeCommitSha }),
		);
		if (apply) {
			applyPipelineStatus = apply.applyStatus;
			applyPipelineId = apply.pipelineId ?? null;
			applyPipelineUrl = apply.webUrl ?? "";
			log.info(
				{ iid, applyPipelineId, applyPipelineStatus, reason: apply.reason },
				"iac apply job status (post-merge)",
			);
		}
	}

	// SIO-878: on failure, read the plan job log and classify the cause (e.g. state-lock).
	let failureHint = "";
	if (status === "failed" && pipelineId) {
		failureHint = classifyPipelineFailure(await callTool("gitlab_get_pipeline_plan_log", { pipelineId }));
	}
	return {
		...withPipeline(status),
		pipelineId,
		pipelineStatus: status,
		mrState,
		applyPipelineStatus,
		applyPipelineId,
		applyPipelineUrl,
		planReport,
		approvalState,
		failureHint,
	};
}

// ============================================================================
// SIO-882: content-drift detection + per-stack reconcile sub-flow.
// detectDrift audits every stack of one deployment; reconcileGate asks the human for a
// direction per drifted stack (a sequential interrupt loop); reconcileStack opens one
// independent, idempotent MR per chosen stack; advanceDrift walks the index. The agent
// never merges or applies -- a human reviews each MR's plan in GitLab.
// ============================================================================

// Directory names from a GitLab repo-tree response ("[status] [{name,type}...]"). Used to
// enumerate the deployment's stacks (stacks/<stack>/) over the API, no local clone. (Pure.)
export function parseRepoTreeDirs(toolResult: string): string[] {
	const m = toolResult.match(/\[\s*(?:\{|\])/);
	if (!m || m.index === undefined) return [];
	try {
		const arr = JSON.parse(toolResult.slice(m.index)) as Array<{ name?: unknown; type?: unknown }>;
		if (!Array.isArray(arr)) return [];
		return arr.filter((e) => e.type === "tree" && typeof e.name === "string").map((e) => e.name as string);
	} catch {
		return [];
	}
}

// SIO-931: file (blob) names from a gitlab_get_repository_tree response, the sibling-policy
// counterpart to parseRepoTreeDirs. Used to pick a structural template for a from-scratch ILM
// policy. (Pure; unit-tested.)
export function parseRepoTreeFiles(toolResult: string): string[] {
	const m = toolResult.match(/\[\s*(?:\{|\])/);
	if (!m || m.index === undefined) return [];
	try {
		const arr = JSON.parse(toolResult.slice(m.index)) as Array<{ name?: unknown; type?: unknown }>;
		if (!Array.isArray(arr)) return [];
		return arr.filter((e) => e.type === "blob" && typeof e.name === "string").map((e) => e.name as string);
	} catch {
		return [];
	}
}

// Deployment names from elastic_cloud_list_deployments' "[status] {deployments:[{name}]}".
// (Pure; unit-tested.)
export function parseEcDeploymentNames(toolResult: string): string[] {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return [];
	try {
		const parsed = JSON.parse(toolResult.slice(jsonStart)) as { deployments?: Array<{ name?: unknown }> };
		const rows = Array.isArray(parsed.deployments) ? parsed.deployments : [];
		return rows.map((r) => (typeof r.name === "string" ? r.name : "")).filter(Boolean);
	} catch {
		return [];
	}
}

// Pipeline id/status from gitlab_trigger_drift_check's JSON. (Pure; unit-tested.)
export function parseTriggerResult(toolResult: string): { pipelineId: number | null; status: string; note: string } {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return { pipelineId: null, status: "error", note: "unparseable" };
	try {
		const o = JSON.parse(toolResult.slice(jsonStart)) as { pipelineId?: unknown; status?: unknown; note?: unknown };
		return {
			pipelineId: typeof o.pipelineId === "number" ? o.pipelineId : null,
			status: typeof o.status === "string" ? o.status : "unknown",
			note: typeof o.note === "string" ? o.note : "",
		};
	} catch {
		return { pipelineId: null, status: "error", note: "unparseable" };
	}
}

// One resource change from the drift-check `drift-report.json` artifact (DriftReport.
// resources[]; noop entries are already filtered out by the drift-check script).
export interface DriftResourceChange {
	address: string;
	category: string; // create | update | destroy | replace | known-noise
	actions: string[]; // raw terraform actions: ["update"], ["delete","create"] (=replace), ...
	changedKeys: string[];
	reason: string;
	noiseTag?: string; // kibana-churn | stack-monitoring-churn (when known-noise)
	// SIO-889: per-changed-key {before: live, after: declared} from the drift-report `values`
	// field (keys 1:1 with changedKeys). before is the reconcile-to-live source; sentinels
	// "<redacted:sensitive>"/"<omitted:too-large>" must never be written back. Absent on
	// create/destroy/noop and older reports.
	values?: Record<string, { before?: unknown; after?: unknown }>;
	// SIO-900: leaf-level decomposition of the changed attributes (Increment 2 / elastic-iac MR !77).
	changes?: LeafChange[];
	changeCount?: number; // true total leaf changes before the producer's cap
	truncated?: boolean; // true when changes[] was capped
}

// The parsed drift-report.json: the authoritative has_actionable_drift boolean (the single
// field to branch alerts on -- already excludes known-noise + noop), per-category totals,
// and the resource changes.
export interface ParsedDriftReport {
	hasActionableDrift: boolean;
	totals: { create: number; update: number; destroy: number; replace: number; noop: number; knownNoise: number };
	resources: DriftResourceChange[];
}

// Parse the drift-report.json artifact. null on empty/unparseable (caller -> planError, never
// a false "no drift"). (Pure; unit-tested.)
export function parseDriftReport(reportJson: string): ParsedDriftReport | null {
	const jsonStart = reportJson.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const o = JSON.parse(reportJson.slice(jsonStart)) as {
			has_actionable_drift?: unknown;
			totals?: Record<string, unknown>;
			resources?: unknown;
		};
		const t = o.totals ?? {};
		const num = (v: unknown): number => (typeof v === "number" ? v : 0);
		const strs = (v: unknown): string[] =>
			Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
		// SIO-889: parse the drift-report `values` field ({key: {before, after}}); tolerant of
		// absence and non-object entries. before/after kept as unknown (may be sentinel strings).
		const parseValues = (v: unknown): Record<string, { before?: unknown; after?: unknown }> | undefined => {
			if (!v || typeof v !== "object") return undefined;
			const out: Record<string, { before?: unknown; after?: unknown }> = {};
			for (const [k, pair] of Object.entries(v as Record<string, unknown>)) {
				if (pair && typeof pair === "object") {
					const p = pair as { before?: unknown; after?: unknown };
					out[k] = { before: p.before, after: p.after };
				}
			}
			return Object.keys(out).length > 0 ? out : undefined;
		};
		// SIO-900: parse the drift-report `changes[]` field (Increment 2): leaf-level diffs keyed by
		// a dot/identity-bracket path. Tolerant of absence + malformed entries; keeps only entries
		// with a string path and a known op. before/after stay unknown (may be sentinel strings).
		const parseChanges = (v: unknown): LeafChange[] | undefined => {
			if (!Array.isArray(v)) return undefined;
			const out: LeafChange[] = [];
			for (const entry of v) {
				if (!entry || typeof entry !== "object") continue;
				const c = entry as { path?: unknown; op?: unknown; before?: unknown; after?: unknown; unstableIndex?: unknown };
				if (typeof c.path !== "string" || !c.path) continue;
				if (c.op !== "add" && c.op !== "remove" && c.op !== "update") continue;
				out.push({
					path: c.path,
					op: c.op,
					before: c.before,
					after: c.after,
					...(c.unstableIndex === true && { unstableIndex: true }),
				});
			}
			return out.length > 0 ? out : undefined;
		};
		const resources = Array.isArray(o.resources)
			? (o.resources as unknown[])
					.map((r) => {
						const x = r as {
							address?: unknown;
							category?: unknown;
							actions?: unknown;
							changedKeys?: unknown;
							reason?: unknown;
							noiseTag?: unknown;
							values?: unknown;
							changes?: unknown;
							changeCount?: unknown;
							truncated?: unknown;
						};
						const changes = parseChanges(x.changes);
						return {
							address: typeof x.address === "string" ? x.address : "",
							category: typeof x.category === "string" ? x.category : "",
							actions: strs(x.actions),
							changedKeys: strs(x.changedKeys),
							reason: typeof x.reason === "string" ? x.reason : "",
							noiseTag: typeof x.noiseTag === "string" ? x.noiseTag : undefined,
							values: parseValues(x.values),
							...(changes && { changes }),
							...(typeof x.changeCount === "number" && { changeCount: x.changeCount }),
							...(x.truncated === true && { truncated: true }),
						};
					})
					.filter((r) => r.address)
			: [];
		return {
			hasActionableDrift: o.has_actionable_drift === true,
			totals: {
				create: num(t.create),
				update: num(t.update),
				destroy: num(t.destroy),
				replace: num(t.replace),
				noop: num(t.noop),
				knownNoise: num(t["known-noise"]),
			},
			resources,
		};
	} catch {
		return null;
	}
}

// Actionable = a real change to reconcile (category is not known-noise). noop is already
// excluded from resources[] by the script. (Pure.)
export function isActionableDrift(r: DriftResourceChange): boolean {
	return r.category !== "known-noise";
}

// Which stack names own per-deployment JSON the agent can edit. Read lazily (process.env,
// never module-scope Bun.env -- Vite SSR throws). Defaults match the repo map (the
// deployment-config stack + the lifecycle-policies stack). [Assumption A3]
function configDeploymentStacks(): Set<string> {
	return new Set(
		(process.env.ELASTIC_IAC_CONFIG_DEPLOYMENT_STACKS ?? "deployments")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}
function configIlmStacks(): Set<string> {
	return new Set(
		(process.env.ELASTIC_IAC_CONFIG_ILM_STACKS ?? "lifecycle-policies")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}

// SIO-890: report-sourced reconcile (Approach B) is the DEFAULT for every stack that is not a
// deployment/ilm family -- every stack is JSON-config-driven, so there is no allowlist. This is the
// opt-OUT set: stacks to suppress (default none -> whole stack; an escape hatch, not a limit). Lazy
// process.env read (no module-scope Bun.env; the web app's Vite SSR throws).
function reportStacksExcluded(): Set<string> {
	return new Set(
		(process.env.ELASTIC_IAC_REPORT_STACKS_EXCLUDE ?? "")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
	);
}
// Per-resource config-file template for report-sourced stacks. ${cluster}=deployment, ${stack}=stack
// name, ${key}=the resource's for_each index key (README convention; override via env).
function stackConfigPathTemplate(): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${cluster}/${stack}/${key} are literal path placeholders substituted by .replace
	return process.env.ELASTIC_IAC_STACK_CONFIG_TEMPLATE ?? "environments/${cluster}/${stack}/${key}.json";
}
function stackResourcePath(template: string, cluster: string, stack: string, key: string): string {
	return template
		.replace(/\$\{cluster\}/g, cluster)
		.replace(/\$\{stack\}/g, stack)
		.replace(/\$\{key\}/g, key);
}
// The stack's config directory (for the StackDrift.configPath badge), from a probe key.
function stackResourceDir(template: string, cluster: string, stack: string): string {
	const probe = stackResourcePath(template, cluster, stack, "__probe__");
	return probe.includes("/") ? probe.slice(0, probe.lastIndexOf("/")) : probe;
}

// SIO-889/SIO-890: the live-reconcile family model. deployment + ilm are MCP-sourced (live read via
// Elastic/EC APIs). EVERY other stack is report-sourced by DEFAULT (Approach B; live values from the
// drift-report `values.before`) -- there is no allowlist, because every stack is JSON-config-driven.
// Functions (not module consts) so the env-driven config is read lazily (process.env; the web app's
// Vite SSR throws on a module-scope Bun.env reference).
interface LiveReconcileFamily {
	name: string;
	matches: (stack: string) => boolean;
	configPath: (deployment: string) => string;
	// Narrow the STATIC capability to the actual drift: true => offer reconcile-to-live.
	hasReconcilableDrift: (actionable: DriftResourceChange[]) => boolean;
	// Build the reconcile-to-live change (live read + projection -> changed repo files, or blocked).
	build: (deployment: string, stack: StackDrift) => Promise<LiveReconcileBuild | { blocked: string }>;
}

// MCP-sourced families: live state read from Elastic/EC APIs (not the drift-report).
function mcpReconcileFamilies(): LiveReconcileFamily[] {
	return [
		{
			name: "deployment",
			matches: (s) => configDeploymentStacks().has(s),
			configPath: (d) => deploymentJsonPath(deploymentJsonTemplate(), d),
			// "version" -> live ES version; "elasticsearch" -> live tier sizing/zone.
			hasReconcilableDrift: (actionable) =>
				actionable.some((c) => (c.changedKeys ?? []).some((k) => k === "version" || k === "elasticsearch")),
			build: buildLiveDeploymentReconcile,
		},
		{
			name: "ilm",
			matches: (s) => configIlmStacks().has(s),
			configPath: (d) => {
				const probe = deploymentJsonPath(ilmPolicyTemplate(), d, "__probe__");
				return probe.includes("/") ? probe.slice(0, probe.lastIndexOf("/")) : probe;
			},
			// Any resource whose policy name parses from its address -> live ILM policy rewrite.
			hasReconcilableDrift: (actionable) => actionable.some((c) => ilmPolicyFromAddress(c.address) !== ""),
			build: buildLiveIlmReconcile,
		},
	];
}

// Report-sourced family for an arbitrary stack (Approach B). Live values come from the drift-report
// `values.before`; the resource's file is environments/<dep>/<stack>/<for_each-key>.json and provider
// attrs map to top-level JSON keys (override via ELASTIC_IAC_STACK_CONFIG_TEMPLATE). Reconcile-to-live
// is only OFFERED when the drift has writable values; buildReportSourcedReconcile fails safe (blocks on
// an unreadable/mis-resolved file), so a stack that does not fit the convention never writes garbage.
function reportReconcileFamily(stack: string): LiveReconcileFamily {
	return {
		name: stack,
		matches: (s) => s === stack,
		configPath: (d) => stackResourceDir(stackConfigPathTemplate(), d, stack),
		hasReconcilableDrift: (actionable) =>
			actionable.some(
				(c) =>
					(c.category === "update" || c.category === "replace") &&
					// SIO-900: a writable live value at attribute grain (values) OR leaf grain (changes) qualifies.
					(hasWritableBefore(c.values) || hasWritableChanges(c)),
			),
		build: buildReportSourcedReconcile,
	};
}

// The live-reconcile family a stack belongs to, or undefined (unwired). deployment/ilm match by name;
// every other stack is report-sourced by DEFAULT unless suppressed via ELASTIC_IAC_REPORT_STACKS_EXCLUDE.
function liveReconcileFamily(stack: string): LiveReconcileFamily | undefined {
	const s = stack.toLowerCase();
	const mcp = mcpReconcileFamilies().find((f) => f.matches(s));
	if (mcp) return mcp;
	return reportStacksExcluded().has(s) ? undefined : reportReconcileFamily(s);
}

// Pure: the live-reconcile family name a stack belongs to (null = unwired). Exported for unit testing;
// classifyStackByName layers kind/configPath/liveReconcilable on top.
export function configStackFamily(stack: string): string | null {
	return liveReconcileFamily(stack)?.name ?? null;
}

// Classify a stack from its NAME (no repo probe -- the fan-out runs N of these). A stack in a
// live-reconcile family resolves an editable JSON path and is live-reconcilable (STATIC capability;
// driftCheckStack narrows it to the actual drift, and the empty-diff guard in buildLiveReconcile
// blocks a no-op MR). Every other stack is "unwired" -- JSON-config like all stacks, but with no
// live read + projection wired yet, so reconcile-to-live is not offered. (Pure; unit-tested.)
export function classifyStackByName(
	stack: string,
	deployment: string,
): { kind: "config-json" | "unwired"; configPath?: string; liveReconcilable: boolean } {
	const family = liveReconcileFamily(stack);
	if (family) {
		return { kind: "config-json", configPath: family.configPath(deployment), liveReconcilable: true };
	}
	return { kind: "unwired", liveReconcilable: false };
}

// Deterministic, DATE-FREE reconcile branch per (deployment, stack, direction). Date-free
// so re-running on a later day reuses the same branch (idempotent MR). (Pure; unit-tested.)
export function reconcileBranch(deployment: string, stack: string, direction: ReconcileDirection): string {
	const slug = `${deployment}-${stack}-${direction}`
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
	return `agent/reconcile-${slug}`;
}

// The web_url of an OPEN agent MR whose source branch matches, from
// gitlab_list_agent_merge_requests' "[status] [...]" body. "" when none. Powers idempotent
// reuse (re-running never opens a duplicate). (Pure; unit-tested.)
export function parseAgentMrBySourceBranch(toolResult: string, branch: string): string {
	const m = toolResult.match(/\[\s*(?:\{|\])/);
	if (!m || m.index === undefined) return "";
	try {
		const arr = JSON.parse(toolResult.slice(m.index)) as Array<{ source_branch?: unknown; web_url?: unknown }>;
		if (!Array.isArray(arr)) return "";
		const found = arr.find((mr) => mr.source_branch === branch);
		return found && typeof found.web_url === "string" ? found.web_url : "";
	} catch {
		return "";
	}
}

// Stable fingerprint of a stack's drift (sorted resource changes, else the counts). Same
// drift -> same marker content -> same branch (idempotent); changed drift -> new marker
// commit. (Pure; unit-tested.)
export function driftFingerprint(stack: {
	resources: Array<{ address: string; actions: string[] }>;
	create: number;
	update: number;
	delete: number;
}): string {
	const addresses = stack.resources
		.map((r) => `${r.actions.join("+")} ${r.address}`)
		.sort()
		.join("\n");
	const basis = addresses || `${stack.create}/${stack.update}/${stack.delete}`;
	return createHash("sha1").update(basis).digest("hex").slice(0, 12);
}

// The first semver-shaped version in the live Elastic Cloud deployment detail (best-effort;
// used for the deployment-config reconcile-to-live mapping). (Pure; unit-tested.)
export function extractLiveVersion(deploymentDetail: string): string {
	// Prefer the Elasticsearch service version from the structured deployment detail so an
	// unrelated "version" field (Kibana, integrations server, plan metadata) can't be
	// picked up; fall back to the first semver only when parsing fails / the shape differs.
	try {
		const jsonStart = deploymentDetail.indexOf("{");
		if (jsonStart >= 0) {
			const parsed = JSON.parse(deploymentDetail.slice(jsonStart)) as {
				resources?: {
					elasticsearch?: Array<{
						info?: {
							version?: unknown;
							plan_info?: { current?: { plan?: { elasticsearch?: { version?: unknown } } } };
						};
					}>;
				};
			};
			const info = parsed.resources?.elasticsearch?.[0]?.info;
			const v = info?.version ?? info?.plan_info?.current?.plan?.elasticsearch?.version;
			if (typeof v === "string" && v.length > 0) return v;
		}
	} catch {
		// fall through to the regex
	}
	const m = deploymentDetail.match(/"version"\s*:\s*"(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)"/);
	return m?.[1] ?? "";
}

// Per-tier sizing from the live EC deployment GET body (resources.elasticsearch[0].info.plan_info
// .current.plan.cluster_topology[]). Maps EC node-role ids -> repo tier keys (hot_content -> hot;
// warm/cold/frozen pass through) and MB-RAM size.value -> GB. Empty when the body lacks topology.
// (Pure; unit-tested.)
export function extractLiveTopology(deploymentDetail: string): Record<string, { sizeGb?: number; zoneCount?: number }> {
	const out: Record<string, { sizeGb?: number; zoneCount?: number }> = {};
	const jsonStart = deploymentDetail.indexOf("{");
	if (jsonStart < 0) return out;
	try {
		const parsed = JSON.parse(deploymentDetail.slice(jsonStart)) as {
			resources?: {
				elasticsearch?: Array<{
					info?: {
						plan_info?: {
							current?: {
								plan?: {
									cluster_topology?: Array<{
										id?: unknown;
										size?: { value?: unknown; resource?: unknown };
										zone_count?: unknown;
									}>;
								};
							};
						};
					};
				}>;
			};
		};
		const topo = parsed.resources?.elasticsearch?.[0]?.info?.plan_info?.current?.plan?.cluster_topology ?? [];
		for (const el of topo) {
			const id = typeof el.id === "string" ? el.id : "";
			if (!id) continue;
			const tier = id === "hot_content" ? "hot" : id;
			const entry: { sizeGb?: number; zoneCount?: number } = {};
			if (el.size && el.size.resource === "memory" && typeof el.size.value === "number") {
				entry.sizeGb = el.size.value / 1024;
			}
			if (typeof el.zone_count === "number") entry.zoneCount = el.zone_count;
			if (entry.sizeGb !== undefined || entry.zoneCount !== undefined) out[tier] = entry;
		}
	} catch {
		// best-effort: return whatever parsed cleanly
	}
	return out;
}

// Agent-side path template for the reconcile-to-json marker. ${stack}/${deployment} are
// literal placeholders. The IaC repo's CI generator special-cases this exact path (MR !66,
// merged 2026-06-03) so a marker scopes the MR pipeline to ONLY the named (stack, deployment)
// -- plan:<deployment>:<stack> + a manual apply -- instead of fanning out across every
// deployment of the stack (the pre-!66 behavior that over-planned reconcile MRs !62-!65). The
// marker is otherwise plan-neutral: Terraform ignores it (the stack's fileset("*.json") does
// not recurse into the .agent-reconcile/ subdir). Lazy process.env read (no module-scope Bun.env).
function reconcileMarkerTemplate(): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SIO-954 - ${stack}/${deployment} are literal path placeholders substituted by .replace
	return process.env.ELASTIC_IAC_RECONCILE_MARKER_TEMPLATE ?? "stacks/${stack}/.agent-reconcile/${deployment}.json";
}
function reconcileMarkerPath(deployment: string, stack: string): string {
	return reconcileMarkerTemplate()
		.replace(/\$\{stack\}/g, stack)
		.replace(/\$\{deployment\}/g, deployment);
}
function reconcileMarkerContent(deployment: string, stack: StackDrift): string {
	const body = {
		reconcile: "reconcile-to-json",
		deployment,
		stack: stack.stack,
		driftFingerprint: driftFingerprint(stack),
		note: "Agent-generated reconcile marker (Terraform ignores this file). Merging re-runs the stack plan to revert live drift; a human approves and applies.",
	};
	return `${JSON.stringify(body, null, 2)}\n`;
}

function buildReconcileMrBody(
	deployment: string,
	stack: StackDrift,
	direction: ReconcileDirection,
	filePaths: string,
	note?: string,
): string {
	const summary = `${stack.create} create / ${stack.update} update / ${stack.delete} destroy`;
	const lines = [
		`## Reconcile: ${stack.stack} on ${deployment}`,
		"",
		direction === "reconcile-to-live"
			? `Direction: **reconcile to live** -- the repo config is updated to match the live cluster. After merge, the next plan for \`${stack.stack}\` should show no changes.`
			: `Direction: **reconcile to declared config** -- this re-asserts the repo's declared state. The MR pipeline's \`plan:${deployment}:${stack.stack}\` job shows the live drift it will revert. Review the plan, then merge and apply.`,
		"",
		`Detected drift: ${summary}.`,
		stack.resources.length > 0
			? `\nResources:\n${stack.resources
					.slice(0, 20)
					.map((r) => `- ${r.actions.join("+")} ${r.address}`)
					.join("\n")}`
			: "",
		`\nFile(s) touched: \`${filePaths}\``,
		// Caveat (e.g. live ILM actions the repo file shape can't represent) -- shown so a reviewer
		// sees what reconcile-to-live would drop before approving.
		note ? `\n> Note: ${note}` : "",
		"",
		"Agent-generated. I never merge or apply; review the plan and apply manually in GitLab.",
	];
	return lines.filter((l) => l !== "").join("\n");
}

// Pull the last `[...]` index key from a drift resource address (the for_each / count key):
// `...fleet_agent_policy.this["eu-oit-prd"]` -> `eu-oit-prd`. "" when there is no index key.
// (Pure; unit-tested.)
export function addressIndexKey(address: string): string {
	const key = address.match(/\[[^\]]*\]/g)?.pop() ?? "";
	return key.replace(/^\[|\]$/g, "").replace(/^["']|["']$/g, "");
}

// ILM policy name = the address index key (`...index_lifecycle.this["alerts-ilm-policy"]`).
export function ilmPolicyFromAddress(address: string): string {
	return addressIndexKey(address);
}

// SIO-889: redaction/oversize sentinels the elastic-iac drift-report uses for values the agent must
// never write back (a secret was here / the value exceeded the cap). Mirrors scripts/drift-values.ts.
const REDACTED_SENTINEL = "<redacted:sensitive>";
const OVERSIZED_SENTINEL = "<omitted:too-large>";

// True when a resource carries at least one writable live value (a defined, non-sentinel `before`).
function hasWritableBefore(values?: Record<string, { before?: unknown }>): boolean {
	if (!values) return false;
	return Object.values(values).some(
		(v) => v?.before !== undefined && v.before !== REDACTED_SENTINEL && v.before !== OVERSIZED_SENTINEL,
	);
}

// SIO-889: Approach-B projection. Set each writable top-level key of a repo config file to the live
// (`before`) value from the drift-report. Skips undefined + sentinels and keys already equal to live
// (per-key empty-diff). `applied` lists the keys actually changed (empty => no change -> caller skips
// the file). Throws on unparseable JSON. Top-level keys only (provider attrs are top-level in the repo
// JSON, per the README convention). (Pure; unit-tested.)
export function applyReportValuesToConfig(
	fileContent: string,
	values: Record<string, { before?: unknown; after?: unknown }>,
): { content: string; applied: string[] } {
	const obj = JSON.parse(fileContent) as Record<string, unknown>;
	const applied: string[] = [];
	for (const [key, pair] of Object.entries(values)) {
		const before = pair?.before;
		if (before === undefined || before === REDACTED_SENTINEL || before === OVERSIZED_SENTINEL) continue;
		if (JSON.stringify(obj[key]) === JSON.stringify(before)) continue; // per-key empty-diff guard
		obj[key] = before;
		applied.push(key);
	}
	return { content: `${JSON.stringify(obj, null, 2)}\n`, applied };
}

// SIO-900: one parsed segment of a drift-report leaf path. `key` = object property (dot identifier);
// `id` = quoted bracket key (an array element matched by identity, or an object key); `index` =
// numeric bracket index (only on unstable paths, which the applier skips).
type PathSeg = { kind: "key"; key: string } | { kind: "id"; id: string } | { kind: "index"; index: number };

// SIO-900: parse a drift-report `changes[].path` (e.g. `inputs["kubelet/metrics"].period`,
// `policy.hot.actions.rollover.max_age`, `tags[0].value`) into navigable segments. Tolerant of
// quoting; an empty/garbage path yields []. (Pure; unit-tested.)
export function parseLeafPath(path: string): PathSeg[] {
	const segs: PathSeg[] = [];
	let i = 0;
	const n = path.length;
	while (i < n) {
		const ch = path[i];
		if (ch === ".") {
			i++;
			continue;
		}
		if (ch === "[") {
			i++; // consume "["
			const q = path[i];
			if (q === '"' || q === "'") {
				i++; // consume opening quote
				let s = "";
				while (i < n && path[i] !== q) {
					if (path[i] === "\\" && i + 1 < n) i++; // skip the escape, keep the next char literal
					s += path[i++];
				}
				i++; // closing quote
				if (path[i] === "]") i++;
				segs.push({ kind: "id", id: s });
			} else {
				let s = "";
				while (i < n && path[i] !== "]") s += path[i++];
				if (path[i] === "]") i++;
				const num = Number(s);
				segs.push(Number.isInteger(num) && s.trim() !== "" ? { kind: "index", index: num } : { kind: "id", id: s });
			}
			continue;
		}
		let name = "";
		while (i < n && path[i] !== "." && path[i] !== "[") name += path[i++];
		if (name) segs.push({ kind: "key", key: name });
	}
	return segs;
}

// Identity fields used to match an array element to a quoted path key, in priority order. Mirrors
// the producer's identity heuristic (elastic-iac scripts/drift-values.ts).
const IDENTITY_FIELDS = ["name", "id", "monitor_id", "policy_id", "type"];

function findArrayIndexById(arr: unknown[], id: string): number {
	return arr.findIndex(
		(el) =>
			el !== null && typeof el === "object" && IDENTITY_FIELDS.some((f) => (el as Record<string, unknown>)[f] === id),
	);
}

// Walk to the container holding the terminal segment WITHOUT synthesizing structure -- a missing
// intermediate returns undefined so the caller skips the change (never corrupts a file).
function navigateToParent(root: unknown, segs: PathSeg[]): unknown {
	let cur: unknown = root;
	for (let k = 0; k < segs.length - 1; k++) {
		if (cur === null || typeof cur !== "object") return undefined;
		const seg = segs[k];
		if (!seg) continue;
		if (seg.kind === "key") cur = (cur as Record<string, unknown>)[seg.key];
		else if (seg.kind === "id")
			cur = Array.isArray(cur) ? cur[findArrayIndexById(cur, seg.id)] : (cur as Record<string, unknown>)[seg.id];
		else cur = Array.isArray(cur) ? cur[seg.index] : undefined;
	}
	return cur;
}

function getLeaf(parent: unknown, seg: PathSeg): unknown {
	if (parent === null || typeof parent !== "object") return undefined;
	if (seg.kind === "key") return (parent as Record<string, unknown>)[seg.key];
	if (seg.kind === "id")
		return Array.isArray(parent)
			? parent[findArrayIndexById(parent, seg.id)]
			: (parent as Record<string, unknown>)[seg.id];
	return Array.isArray(parent) ? parent[seg.index] : undefined;
}

function setLeaf(parent: unknown, seg: PathSeg, value: unknown): boolean {
	if (parent === null || typeof parent !== "object") return false;
	if (seg.kind === "key") {
		(parent as Record<string, unknown>)[seg.key] = value;
		return true;
	}
	if (seg.kind === "id") {
		if (Array.isArray(parent)) {
			const idx = findArrayIndexById(parent, seg.id);
			if (idx >= 0) parent[idx] = value;
			else parent.push(value); // re-add a missing element (op: remove -> reconcile to live)
			return true;
		}
		(parent as Record<string, unknown>)[seg.id] = value;
		return true;
	}
	if (Array.isArray(parent) && seg.index >= 0 && seg.index <= parent.length) {
		parent[seg.index] = value;
		return true;
	}
	return false;
}

function deleteLeaf(parent: unknown, seg: PathSeg): boolean {
	if (parent === null || typeof parent !== "object") return false;
	if (seg.kind === "key") {
		const o = parent as Record<string, unknown>;
		if (seg.key in o) {
			delete o[seg.key];
			return true;
		}
		return false;
	}
	if (seg.kind === "id") {
		if (Array.isArray(parent)) {
			const idx = findArrayIndexById(parent, seg.id);
			if (idx >= 0) {
				parent.splice(idx, 1);
				return true;
			}
			return false;
		}
		const o = parent as Record<string, unknown>;
		if (seg.id in o) {
			delete o[seg.id];
			return true;
		}
		return false;
	}
	if (Array.isArray(parent) && seg.index >= 0 && seg.index < parent.length) {
		parent.splice(seg.index, 1);
		return true;
	}
	return false;
}

// SIO-900: reconcile-to-live by leaf PATH (Increment 2). Apply each leaf change to the repo config
// so it matches LIVE: `update`/`remove` write the live `before` at the path (`remove` re-adds a
// live-only leaf); `add` deletes a declared-only leaf. Skips sentinels, unstable-index paths
// (caller falls back to attribute-grain `values`), per-leaf no-ops, and paths that don't resolve
// (never synthesizes structure). `applied` lists the paths actually changed. Throws on unparseable
// JSON. (Pure; unit-tested.)
export function applyReportChangesToConfig(
	fileContent: string,
	changes: LeafChange[],
): { content: string; applied: string[] } {
	const obj = JSON.parse(fileContent) as Record<string, unknown>;
	const applied: string[] = [];
	for (const c of changes) {
		if (c.unstableIndex) continue; // unstable numeric index -> reconcile at attribute grain (values)
		const segs = parseLeafPath(c.path);
		if (segs.length === 0) continue;
		const parent = navigateToParent(obj, segs);
		const terminal = segs[segs.length - 1];
		if (!terminal) continue;
		if (c.op === "add") {
			// in declared but not live -> to match live, remove it from the repo config.
			if (deleteLeaf(parent, terminal)) applied.push(c.path);
			continue;
		}
		// update | remove -> write the live (before) value back into the repo config.
		const before = c.before;
		if (before === undefined || before === REDACTED_SENTINEL || before === OVERSIZED_SENTINEL) continue;
		if (JSON.stringify(getLeaf(parent, terminal)) === JSON.stringify(before)) continue; // per-leaf empty-diff
		if (setLeaf(parent, terminal, before)) applied.push(c.path);
	}
	return { content: `${JSON.stringify(obj, null, 2)}\n`, applied };
}

// True when a resource's leaf changes[] is usable for path-precise reconcile-to-live: present,
// not truncated, and carrying at least one writable (non-sentinel) before or a deletable `add`.
function hasWritableChanges(r: { changes?: LeafChange[]; truncated?: boolean }): boolean {
	if (!r.changes || r.changes.length === 0 || r.truncated) return false;
	return r.changes.some(
		(c) =>
			!c.unstableIndex &&
			(c.op === "add" || (c.before !== undefined && c.before !== REDACTED_SENTINEL && c.before !== OVERSIZED_SENTINEL)),
	);
}

// Project a LIVE `_ilm/policy/<name>` response onto the repo's flattened phase-file shape (top-level
// hot/warm/cold/delete + name). LOSSY BY DESIGN: only the fields the repo models survive (the hot
// rollover fields + a rollover:true flag, per-phase forcemerge, warm/cold/delete min_age, and
// delete.delete_searchable_snapshot). Unmodeled live actions (set_priority, allocate, readonly,
// shrink, searchable_snapshot, downsample, ...) have no repo slot and are dropped -- detectLostIlmActions
// surfaces them. null on an unparseable body / missing policy.phases. (Pure; unit-tested.)
export function liveIlmToRepoShape(liveResponse: string, policyName: string): Record<string, unknown> | null {
	const start = liveResponse.indexOf("{");
	if (start < 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(liveResponse.slice(start));
	} catch {
		return null;
	}
	const get = (o: unknown, k: string): unknown =>
		o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
	const phases = get(get(get(parsed, policyName), "policy"), "phases");
	if (!phases || typeof phases !== "object") return null;
	const phasesObj = phases as Record<string, unknown>;

	const out: Record<string, unknown> = { name: policyName };
	for (const phase of ["hot", "warm", "cold", "delete"] as const) {
		const p = phasesObj[phase];
		if (!p || typeof p !== "object") continue;
		const actions = get(p, "actions");
		const repoPhase: Record<string, unknown> = {};
		const minAge = get(p, "min_age");
		// hot.min_age is conventionally "0ms" (rollover phase) -> not a repo field; keep it elsewhere.
		if (phase !== "hot" && typeof minAge === "string") repoPhase.min_age = minAge;
		if (phase === "hot") {
			const rollover = get(actions, "rollover");
			if (rollover) {
				repoPhase.rollover = true;
				for (const f of ["max_age", "max_primary_shard_size", "max_size", "min_docs"]) {
					const v = get(rollover, f);
					if (v !== undefined) repoPhase[f] = v;
				}
			}
		}
		const forcemerge = get(actions, "forcemerge");
		if (forcemerge !== undefined) repoPhase.forcemerge = forcemerge;
		if (phase === "delete") {
			const dss = get(get(actions, "delete"), "delete_searchable_snapshot");
			if (dss !== undefined) repoPhase.delete_searchable_snapshot = dss;
		}
		if (Object.keys(repoPhase).length > 0) out[phase] = repoPhase;
	}
	return out;
}

// Serialize a repo ILM shape with house style (2-space indent + trailing newline). (Pure.)
export function ilmRepoShapeToFile(shape: Record<string, unknown>): string {
	return `${JSON.stringify(shape, null, 2)}\n`;
}

// The live ILM action keys the repo file shape does NOT model, across all phases (set_priority,
// allocate, readonly, shrink, searchable_snapshot, downsample, migrate, ...). Surfaced in the MR
// body so a human sees what reconcile-to-live would drop after apply. (Pure; unit-tested.)
export function detectLostIlmActions(liveResponse: string): string[] {
	const start = liveResponse.indexOf("{");
	if (start < 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(liveResponse.slice(start));
	} catch {
		return [];
	}
	const get = (o: unknown, k: string): unknown =>
		o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
	const modeled = new Set(["rollover", "forcemerge", "delete"]);
	const lost = new Set<string>();
	if (typeof parsed === "object" && parsed !== null) {
		for (const node of Object.values(parsed as Record<string, unknown>)) {
			const phases = get(get(node, "policy"), "phases");
			if (!phases || typeof phases !== "object") continue;
			for (const phase of Object.values(phases as Record<string, unknown>)) {
				const actions = get(phase, "actions");
				if (!actions || typeof actions !== "object") continue;
				for (const key of Object.keys(actions as Record<string, unknown>)) {
					if (!modeled.has(key)) lost.add(key);
				}
			}
		}
	}
	return [...lost].sort();
}

// One repo file a reconcile-to-live MR writes (full new content, not a diff).
interface ReconcileFile {
	path: string;
	content: string;
}
// The result of building a reconcile-to-live change: the changed files (empty-diff files dropped),
// a human summary for the commit/MR, and an optional caveat note (e.g. dropped ILM actions).
interface LiveReconcileBuild {
	files: ReconcileFile[];
	summary: string;
	note?: string;
}

// reconcile-to-live: rewrite the repo config to match the live cluster. Dispatches to the matched
// family's build (deployment: version + tier sizing/zone; ilm: each policy file from the live ILM
// policy; report-sourced: each resource file from the drift-report `values.before`). (Exported for
// unit testing via mocked tools.)
export async function buildLiveReconcile(
	deployment: string,
	stack: StackDrift,
): Promise<LiveReconcileBuild | { blocked: string }> {
	const family = liveReconcileFamily(stack.stack);
	return family ? family.build(deployment, stack) : { blocked: "No live-reconcile family is wired for this stack." };
}

// deployment family: read the live EC deployment once, then apply the live version (when "version"
// drifted) and/or the live tier sizing/zone (when "elasticsearch" drifted) to the per-deployment
// JSON. Empty-diff guard blocks a no-op MR (live already matches the repo).
async function buildLiveDeploymentReconcile(
	deployment: string,
	stack: StackDrift,
): Promise<LiveReconcileBuild | { blocked: string }> {
	const configPath = stack.configPath;
	if (!configPath) return { blocked: "No deployment config path resolved for this stack." };
	const deploymentId = await resolveDeploymentId(deployment);
	if (!deploymentId) return { blocked: `Could not resolve a live Elastic Cloud deployment id for '${deployment}'.` };
	const detail = await callTool("elastic_cloud_get_deployment", { deploymentId });
	const raw = await callTool("gitlab_get_file_content", { filePath: configPath });
	if (!raw.startsWith("[2")) return { blocked: `Could not read ${configPath} from the repo.` };
	const original = extractFileContent(raw);

	const changedKeys = stack.resources.flatMap((r) => r.changedKeys ?? []);
	const summaryParts: string[] = [];
	let content = original;
	try {
		if (changedKeys.includes("version")) {
			const liveVersion = extractLiveVersion(detail);
			if (!liveVersion) return { blocked: "Could not read the live Elasticsearch version to reconcile." };
			const updated = setDeploymentVersion(content, liveVersion);
			content = updated.content;
			summaryParts.push(`version ${updated.previous ?? "?"} -> ${liveVersion}`);
		}
		if (changedKeys.includes("elasticsearch")) {
			const topo = extractLiveTopology(detail);
			if (Object.keys(topo).length === 0) return { blocked: "Could not read the live tier topology to reconcile." };
			const updated = applyLiveTopology(content, topo);
			content = updated.content;
			for (const [tier, prev] of Object.entries(updated.previous)) {
				const live = topo[tier];
				const bits: string[] = [];
				if (live?.sizeGb !== undefined) bits.push(`max_size ${prev.maxSize ?? "?"} -> ${live.sizeGb}g`);
				if (live?.zoneCount !== undefined) bits.push(`zone_count ${prev.zoneCount ?? "?"} -> ${live.zoneCount}`);
				if (bits.length > 0) summaryParts.push(`${tier} ${bits.join(", ")}`);
			}
		}
	} catch (err) {
		return { blocked: `${configPath} could not be rewritten: ${err instanceof Error ? err.message : String(err)}` };
	}
	// Empty-diff guard: never open an MR that changes nothing (live already matches the repo).
	if (content === original) return { blocked: "Repo already matches live for the drifted fields; nothing to write." };
	return { files: [{ path: configPath, content }], summary: summaryParts.join("; ") || "reconcile to live" };
}

// ilm family: for each drifted policy (name parsed from the drift address) read the live ILM policy,
// project it onto the repo file shape, and rewrite the policy file. Per-file empty-diff guard drops
// no-op files; a note lists live actions the repo shape can't represent (dropped after apply).
async function buildLiveIlmReconcile(
	deployment: string,
	stack: StackDrift,
): Promise<LiveReconcileBuild | { blocked: string }> {
	const policies = [...new Set(stack.resources.map((r) => ilmPolicyFromAddress(r.address)).filter(Boolean))];
	if (policies.length === 0) return { blocked: "No ILM policy name could be parsed from the drift addresses." };

	const files: ReconcileFile[] = [];
	const lost = new Set<string>();
	const written: string[] = [];
	for (const policy of policies) {
		const live = await callTool("elastic_ilm_get_lifecycle", { policy, deployment });
		// clusterFetch returns "[<status>] <body>"; only a 2xx is an authoritative live read. A
		// missing cluster config / unreachable cluster / non-2xx all fall here -> block (never a
		// false "no change").
		if (!live.startsWith("[2")) {
			return { blocked: `Could not read live ILM policy '${policy}' on '${deployment}': ${live.slice(0, 120)}` };
		}
		const shape = liveIlmToRepoShape(live, policy);
		if (!shape) return { blocked: `Live ILM policy '${policy}' did not match the expected response shape.` };
		const filePath = deploymentJsonPath(ilmPolicyTemplate(), deployment, policy);
		const fileRaw = await callTool("gitlab_get_file_content", { filePath });
		if (!fileRaw.startsWith("[2")) return { blocked: `Could not read ${filePath} from the repo.` };
		for (const a of detectLostIlmActions(live)) lost.add(a);
		const next = ilmRepoShapeToFile(shape);
		if (next === extractFileContent(fileRaw)) continue; // empty-diff guard: skip no-op files
		files.push({ path: filePath, content: next });
		written.push(policy);
	}
	if (files.length === 0) return { blocked: "Repo files already match the live ILM policies; nothing to write." };
	const note =
		lost.size > 0
			? `Live ILM actions not represented in the repo file shape will be dropped after apply: ${[...lost].sort().join(", ")}.`
			: undefined;
	return { files, summary: `${files.length} policy file(s): ${written.join(", ")}`, ...(note && { note }) };
}

// SIO-889 / SIO-900: Approach-B reconcile-to-live for report-sourced families (e.g. agent-policies).
// Live values come from the drift-report (no MCP live read); the per-resource repo file is
// environments/<dep>/<stack>/<for_each-key>.json. SIO-900: prefer the leaf-level `changes[]` to write
// each drifted LEAF by path (so a nested input/monitor change is reconciled precisely); fall back to
// the attribute-grain `values.before` when changes[] is absent/truncated/unstable or resolves nothing.
// Reads each file, projects the writable live values onto it, and drops no-op files. Blocks (never a
// false no-op) on an unreadable file.
async function buildReportSourcedReconcile(
	deployment: string,
	stack: StackDrift,
): Promise<LiveReconcileBuild | { blocked: string }> {
	const template = stackConfigPathTemplate();
	const files: ReconcileFile[] = [];
	const summaryParts: string[] = [];
	// SIO-901: files we could not read (e.g. a fleet_integration_policy whose repo layout the flat
	// <key>.json template does not match). Skip them and reconcile the rest -- one unreadable file
	// must not sink the whole stack -- but surface them so the human knows what was left out.
	const skipped: string[] = [];
	// SIO-901: count files we actually read, so "every candidate was unreadable" is distinguishable
	// from "readable but already in sync" (which also yields files.length === 0).
	let readableFileCount = 0;
	for (const r of stack.resources) {
		if (r.category !== "update" && r.category !== "replace") continue;
		const useChanges = hasWritableChanges(r);
		if (!useChanges && !hasWritableBefore(r.values)) continue; // nothing writable from this resource
		const key = addressIndexKey(r.address);
		if (!key) continue; // no for_each key -> cannot resolve a file
		const filePath = stackResourcePath(template, deployment, stack.stack, key);
		const raw = await callTool("gitlab_get_file_content", { filePath });
		if (!raw.startsWith("[2")) {
			skipped.push(filePath); // SIO-901: skip-with-note instead of blocking the whole stack
			continue;
		}
		readableFileCount++; // SIO-901: read OK (it may still be a no-op if already in sync)
		const original = extractFileContent(raw);
		let projected: { content: string; applied: string[] };
		try {
			projected = useChanges
				? applyReportChangesToConfig(original, r.changes ?? [])
				: r.values
					? applyReportValuesToConfig(original, r.values)
					: { content: original, applied: [] };
			// Path-precise resolved nothing (paths didn't match the repo shape) -> fall back to the
			// attribute-grain projection so a reconcilable drift never silently no-ops.
			if (useChanges && projected.applied.length === 0 && r.values && hasWritableBefore(r.values)) {
				projected = applyReportValuesToConfig(original, r.values);
			}
		} catch (err) {
			return { blocked: `${filePath} could not be rewritten: ${err instanceof Error ? err.message : String(err)}` };
		}
		if (projected.applied.length === 0) continue; // all redacted/oversized/unresolved or already match
		files.push({ path: filePath, content: projected.content });
		summaryParts.push(`${key}: ${projected.applied.join(", ")}`);
	}
	// SIO-901: a note naming the skipped files (capped) when some -- but not all -- could be read.
	const skipNote =
		skipped.length > 0
			? `Skipped ${skipped.length} unreadable config file(s): ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", ..." : ""}.`
			: undefined;
	if (files.length === 0) {
		// SIO-901: only call it "unreadable" when EVERY candidate file failed to read -- a
		// readable-but-already-in-sync stack (readableFileCount > 0) must not be misreported as
		// unreadable. Otherwise it is the generic no-reconcilable-values case (with the skip note).
		if (readableFileCount === 0 && skipped.length > 0) {
			return { blocked: `Could not read any config file for this stack. ${skipNote}` };
		}
		return {
			blocked: `No reconcilable live values (drift was create-only, redacted, oversized, or already matches the repo).${skipNote ? ` ${skipNote}` : ""}`,
		};
	}
	return { files, summary: summaryParts.join("; "), ...(skipNote && { note: skipNote }) };
}

// Open one independent, idempotent MR for a stack + direction (or block with a reason).
// Reuses an existing open agent MR on the deterministic branch rather than duplicating.
async function openReconcileMr(
	deployment: string,
	stack: StackDrift,
	direction: ReconcileDirection,
): Promise<ReconcileResult> {
	const branch = reconcileBranch(deployment, stack.stack, direction);
	log.info({ deployment, stack: stack.stack, direction, branch }, "iac reconcile: opening MR");

	const existing = parseAgentMrBySourceBranch(await callTool("gitlab_list_agent_merge_requests", {}), branch);
	if (existing) {
		log.info(
			{ deployment, stack: stack.stack, branch, mrUrl: existing },
			"iac reconcile: reusing existing MR (idempotent)",
		);
		return { stack: stack.stack, direction, status: "reused", mrUrl: existing, branch };
	}

	// reconcile-to-live rewrites EXISTING config file(s) (update; one for the deployment stack, one
	// per drifted policy for ILM); reconcile-to-json writes a NEW marker (create). The commit tool
	// upserts either way, but starting with the right action avoids a wasted first request and a
	// spurious "doesn't exist"/"already exists" 400.
	let commits: Array<{ path: string; content: string; action: "create" | "update" }>;
	let commitMessage: string;
	let title: string;
	let mrNote: string | undefined;

	if (direction === "reconcile-to-live") {
		if (!stack.liveReconcilable) {
			log.info(
				{ deployment, stack: stack.stack },
				"iac reconcile: reconcile-to-live blocked (not available for this stack)",
			);
			return {
				stack: stack.stack,
				direction,
				status: "blocked",
				note: "Reconcile to Live Deployment is not available for this stack; use Reconcile to GitLab.",
			};
		}
		const built = await buildLiveReconcile(deployment, stack);
		if ("blocked" in built) return { stack: stack.stack, direction, status: "blocked", note: built.blocked, branch };
		commits = built.files.map((f) => ({ path: f.path, content: f.content, action: "update" as const }));
		commitMessage = `${deployment}: reconcile ${stack.stack} to live (${built.summary})`;
		title = `[${deployment}] reconcile ${stack.stack} to live`;
		mrNote = built.note;
	} else {
		// reconcile-to-json: a deterministic, plan-neutral marker that triggers the stack plan.
		commits = [
			{
				path: reconcileMarkerPath(deployment, stack.stack),
				content: reconcileMarkerContent(deployment, stack),
				action: "create",
			},
		];
		commitMessage = `${deployment}: reconcile ${stack.stack} to declared config`;
		title = `[${deployment}] reconcile ${stack.stack} to declared config`;
	}

	// Create the branch (tolerate "already exists" 4xx, like the proposers) and commit each file.
	await callTool("gitlab_create_branch", { branch, ref: "main" });
	for (const c of commits) {
		const commit = await callTool("gitlab_commit_file", {
			branch,
			file_path: c.path,
			content: c.content,
			commit_message: commitMessage,
			action: c.action,
		});
		// A failed commit (4xx auth/validation/bad-path or 5xx) must block -- otherwise we'd open
		// an MR on a branch with no change. The early MR-reuse check above already short-circuits
		// the idempotent re-run, so a 4xx here is a real failure.
		if (commit.startsWith("[4") || commit.startsWith("[5")) {
			log.error(
				{ deployment, stack: stack.stack, branch, filePath: c.path, commit: commit.slice(0, 200) },
				"iac reconcile: commit failed; blocking",
			);
			return {
				stack: stack.stack,
				direction,
				status: "blocked",
				note: `Commit failed: ${commit.slice(0, 120)}`,
				branch,
			};
		}
	}
	log.info({ deployment, stack: stack.stack, branch, files: commits.length }, "iac reconcile: committed; creating MR");

	const description = buildReconcileMrBody(deployment, stack, direction, commits.map((c) => c.path).join(", "), mrNote);
	const mr = await callTool("gitlab_create_merge_request", {
		source_branch: branch,
		target_branch: "main",
		title,
		description,
		labels: [...AGENT_MR_LABELS],
	});
	// Only a 409 (MR already exists for this branch) is a reuse; any other 4xx/5xx is a real
	// failure and must block (never report a successful reconcile with an empty MR url).
	if (mr.startsWith("[409")) {
		const reuse = parseAgentMrBySourceBranch(await callTool("gitlab_list_agent_merge_requests", {}), branch);
		return reuse
			? { stack: stack.stack, direction, status: "reused", mrUrl: reuse, branch }
			: {
					stack: stack.stack,
					direction,
					status: "blocked",
					note: "MR already exists but could not be resolved.",
					branch,
				};
	}
	if (mr.startsWith("[4") || mr.startsWith("[5")) {
		log.error(
			{ deployment, stack: stack.stack, branch, mr: mr.slice(0, 200) },
			"iac reconcile: MR creation failed; blocking",
		);
		return {
			stack: stack.stack,
			direction,
			status: "blocked",
			note: `MR creation failed: ${mr.slice(0, 120)}`,
			branch,
		};
	}
	const mrUrl = extractMrUrl(mr);
	// SIO-1062: a 2xx body without a web_url (unexpected shape) must block, not report a
	// garbage "opened" url.
	if (!mrUrl) {
		return {
			stack: stack.stack,
			direction,
			status: "blocked",
			note: `MR response had no web_url: ${mr.slice(0, 120)}`,
			branch,
		};
	}
	log.info({ deployment, stack: stack.stack, branch, mrUrl }, "iac reconcile: MR opened");
	return { stack: stack.stack, direction, status: "opened", mrUrl, branch };
}

// SIO-913: extract a target agent version (e.g. "9.4.2", "8.15", "9.4.2-SNAPSHOT") from free
// text for the Fleet upgrade flow. Prefers the request's parsed version when present; else the
// first semver-ish token in the user's message. "" when none found. (Pure; unit-tested.)
export function parseTargetVersion(text: string, requestVersion?: string): string {
	if (requestVersion?.trim()) return requestVersion.trim();
	const m = text.match(/\b\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?\b/);
	return m ? m[0] : "";
}

// Resolve the target deployment for a drift audit from the user's text, matched against the
// live Elastic Cloud deployment names (no local clone).
async function resolveDriftDeployment(state: IacStateType): Promise<string> {
	if (state.targetDeployment) return state.targetDeployment;
	const query = lastHumanText(state).toLowerCase();
	const names = parseEcDeploymentNames(await callTool("elastic_cloud_list_deployments", {}));
	// Exact (case-insensitive) match wins; otherwise accept a partial only when it's the unique
	// candidate -- a naive substring find lets a shorter name (eu-b2b) beat eu-b2b-prod. No
	// unambiguous match -> "" routes to the iac_clarify interrupt.
	const exact = names.find((d) => d.toLowerCase() === query);
	if (exact) return exact;
	const partial = names.filter((d) => {
		const n = d.toLowerCase();
		return query.includes(n) || n.includes(query);
	});
	return partial.length === 1 ? (partial[0] ?? "") : "";
}

function driftedStacks(state: IacStateType): StackDrift[] {
	return (state.driftReport?.stacks ?? []).filter((s) => s.drifted);
}

// Bounded-concurrency map -- the fan-out triggers N drift-check pipelines; cap to be polite
// to CI and the shared deployments-stack state lock.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()));
	return out;
}

// Run the IaC repo's on-demand drift-check for ONE stack: trigger -> poll -> parse the
// drift-report.json into a StackDrift (known-noise/provider-bump filtered out). A trigger
// lock/failure or a missing report becomes planError (never a false "no drift").
async function driftCheckStack(deployment: string, stack: string): Promise<StackDrift> {
	const { kind, configPath } = classifyStackByName(stack, deployment);
	const base: StackDrift = {
		stack,
		drifted: false,
		kind,
		create: 0,
		update: 0,
		delete: 0,
		resources: [],
		// Safe default for the planError / no-drift early returns (the reconcile gate only
		// processes drifted stacks); the drifted return below sets the real, version-aware value.
		liveReconcilable: false,
		...(configPath && { configPath }),
	};

	log.info({ deployment, stack, kind }, "iac drift: triggering drift-check for stack");
	const trig = parseTriggerResult(await callTool("gitlab_trigger_drift_check", { stack, deployment }));
	if (trig.pipelineId === null) {
		// SIO-887: a state lock at trigger means an apply currently holds the stack's state;
		// any other null is a real trigger failure (surface the server note).
		const reason =
			trig.status === "locked"
				? "Apply in progress (state lock); re-check once it clears."
				: `Could not trigger the drift-check${trig.note ? `: ${trig.note}` : "."}`;
		const why = trig.status === "locked" ? "apply in progress (state lock)" : "trigger failed";
		log.warn(
			{ deployment, stack, status: trig.status, note: trig.note },
			"iac drift: trigger did not start a pipeline (planError)",
		);
		await dispatchCustomEvent("iac_pipeline_progress", { pipelineId: null, status: `${stack}: ${why}` });
		return { ...base, planError: true, planErrorReason: reason };
	}
	log.info({ deployment, stack, pipelineId: trig.pipelineId }, "iac drift: pipeline triggered; polling for result");
	const result = parseDriftCheckResult(
		await callTool("gitlab_get_drift_check_result", { pipelineId: trig.pipelineId }),
	);
	// The pipeline must be "success" for the artifact to be authoritative. A "failed" pipeline
	// is a script error (not a drift signal); "canceled" was superseded (interruptible). Either
	// way -> planError, never a false "no drift". (A drifted run still reports pipeline success;
	// allow_failure:[2] keeps it green, with the drift in the artifact.)
	if (result.status !== "success" || !result.report) {
		// SIO-887: distinguish a real failure (classify the job trace tail -- state-lock vs plan
		// error) from a pipeline that simply did not reach terminal within the poll budget. The
		// latter is common on the shared-state deployments stack under lock contention (the IaC
		// guide budgets it at 30 min) -- it is NOT a failure, so point the user at Re-check.
		const reason =
			result.status === "failed" || result.status === "canceled"
				? `Drift-check pipeline ${result.status}. ${classifyPipelineFailure(result.failureLog, result.stateLocked)}`
				: result.status !== "success"
					? "Drift-check did not finish within the poll budget (possible state-lock contention); use Re-check to retry."
					: "The drift-check produced no report.";
		log.warn(
			{ deployment, stack, pipelineId: trig.pipelineId, status: result.status, hasReport: Boolean(result.report) },
			"iac drift: drift-check not authoritative (planError)",
		);
		await dispatchCustomEvent("iac_pipeline_progress", {
			pipelineId: trig.pipelineId,
			status: `${stack}: ${result.status !== "success" ? `check ${result.status}` : "no report"}`,
		});
		return { ...base, planError: true, planErrorReason: reason };
	}

	const parsed = parseDriftReport(result.report);
	if (parsed === null) {
		log.warn({ deployment, stack, pipelineId: trig.pipelineId }, "iac drift: unreadable drift-report.json (planError)");
		await dispatchCustomEvent("iac_pipeline_progress", {
			pipelineId: trig.pipelineId,
			status: `${stack}: unreadable report`,
		});
		return { ...base, planError: true, planErrorReason: "The drift-check report could not be parsed." };
	}
	// has_actionable_drift is the authoritative alert boolean (excludes known-noise + noop);
	// totals drive the counts; the resource list is the actionable (non-known-noise) changes.
	const actionable = parsed.resources.filter(isActionableDrift);
	const noiseCount = parsed.totals.knownNoise;
	await dispatchCustomEvent("iac_pipeline_progress", {
		pipelineId: trig.pipelineId,
		status: `${stack}: ${
			parsed.hasActionableDrift
				? `${actionable.length} change(s)`
				: noiseCount > 0
					? `no drift (${noiseCount} known-noise)`
					: "no drift"
		}`,
	});
	// reconcile-to-live is offered only when the actual drift maps to a clean live->file write; the
	// matched family decides (deployment: version/elasticsearch keys; ilm: a parseable policy address).
	// Unwired stacks never offer it. The empty-diff guard in buildLiveReconcile still blocks a no-op MR
	// when live already equals the repo, so a coarse "elasticsearch" key never opens an empty MR.
	const family = liveReconcileFamily(stack);
	const liveReconcilable = family ? family.hasReconcilableDrift(actionable) : false;
	log.info(
		{
			deployment,
			stack,
			pipelineId: trig.pipelineId,
			drifted: parsed.hasActionableDrift,
			actionable: actionable.length,
			knownNoise: noiseCount,
			liveReconcilable,
			totals: parsed.totals,
		},
		"iac drift: stack assessed",
	);
	return {
		...base,
		drifted: parsed.hasActionableDrift,
		liveReconcilable,
		create: parsed.totals.create,
		update: parsed.totals.update + parsed.totals.replace, // group replace into "update" for the UI counts
		delete: parsed.totals.destroy,
		// SIO-886: keep the per-resource reason + changed keys so the explainer/UI can show
		// WHAT drifted (previously only {address, actions} survived).
		resources: actionable.map((c) => ({
			address: c.address,
			actions: c.actions.length > 0 ? c.actions : [c.category],
			reason: c.reason,
			changedKeys: c.changedKeys,
			category: c.category,
			values: c.values,
			// SIO-900: carry the leaf-level decomposition through for the explainer/UI + reconcile-by-path.
			...(c.changes && { changes: c.changes }),
			...(c.changeCount !== undefined && { changeCount: c.changeCount }),
			...(c.truncated && { truncated: true }),
		})),
	};
}

// Audit ALL stacks of one deployment for drift. Resolves the deployment (asking once via an
// iac_clarify interrupt when unnamed), enumerates stacks from the GitLab `stacks/` tree (no
// clone), fans out the repo's on-demand drift-check per stack, and emits the full report
// once (iac_drift_report) for the UI overview. No writes here.
export async function detectDrift(state: IacStateType): Promise<Partial<IacStateType>> {
	let deployment = await resolveDriftDeployment(state);
	if (!deployment) {
		const answer = interrupt({
			type: "iac_clarify",
			question: "Which deployment should I check for drift? (e.g. eu-b2b)",
			message: "Which deployment should I check for drift? (e.g. eu-b2b)",
		}) as { answer?: string };
		deployment = (answer?.answer ?? "").trim();
	}
	if (!deployment) {
		return {
			messages: [new AIMessage('I need a deployment name to check for drift. Try: "check eu-b2b for drift".')],
		};
	}

	// The deployment's CONFIGURED stacks live under environments/<deployment>/<stack>/ (each
	// with terraform.tfvars); the special `deployments` stack is configured via
	// environments/_deployments/<deployment>.json, so add it explicitly. Fall back to the
	// full stacks/ tree if the environments path doesn't resolve.
	const configured = parseRepoTreeDirs(
		await callTool("gitlab_get_repository_tree", { path: `environments/${deployment}` }),
	);
	const depStack = [...configDeploymentStacks()][0] ?? "deployments";
	const stacks =
		configured.length > 0
			? [...new Set([...configured, depStack])]
			: parseRepoTreeDirs(await callTool("gitlab_get_repository_tree", { path: "stacks" }));
	if (stacks.length === 0) {
		log.warn({ deployment }, "iac drift: no stacks to audit (GitOps repo unreachable or empty environments path)");
		return {
			targetDeployment: deployment,
			messages: [
				new AIMessage(
					`Could not list the stacks to audit for '${deployment}'. Is the GitOps repo reachable (ELASTIC_IAC_GITLAB_TOKEN) with an environments/${deployment}/ directory?`,
				),
			],
		};
	}

	const cap = Number(process.env.ELASTIC_IAC_DRIFT_CONCURRENCY ?? "4");
	log.info({ deployment, stacks, count: stacks.length, concurrency: cap }, "iac drift: auditing stacks for deployment");
	const stackDrifts = await mapWithConcurrency(stacks, cap, (stack) => driftCheckStack(deployment, stack));
	log.info(
		{
			deployment,
			total: stackDrifts.length,
			drifted: stackDrifts.filter((s) => s.drifted).map((s) => s.stack),
			planError: stackDrifts.filter((s) => s.planError).map((s) => s.stack),
		},
		"iac drift: audit complete",
	);

	const driftReport: DriftReport = { deployment, stacks: stackDrifts, generatedAt: new Date().toISOString() };
	// SIO-886: the enriched report is emitted by explainDrift (next node), once, with the
	// per-stack explanations attached -- so the UI gets a single, fully-detailed overview.
	return { targetDeployment: deployment, driftReport, driftIndex: 0, reconcileResults: [] };
}

// SIO-886: drop the terraform module wrapper so the explanation reads in resource terms --
// `module.deployments["us-cld"].ec_deployment.this` -> `ec_deployment.this ["us-cld"]`.
// The index key can sit on the module wrapper (mid-address) or the resource (trailing); keep
// the last one as the human-meaningful key. (Pure; unit-tested.)
export function shortAddress(address: string): string {
	const key = address.match(/\[[^\]]*\]/g)?.pop() ?? "";
	const clean = address.replace(/\[[^\]]*\]/g, "");
	const parts = clean.split(".").filter(Boolean);
	// Keep the resource type + name (the last two dotted segments); the module.<name> wrappers
	// are noise for a human reading the change.
	const tail = parts.slice(-2).join(".") || clean;
	return key ? `${tail} ${key}` : tail;
}

// SIO-900: render a single leaf change as a grounded one-liner (before = live, after = declared).
// Sentinels become short labels; long values are capped so the explanation stays readable. (Pure.)
export function formatLeafChange(c: LeafChange): string {
	const val = (v: unknown): string => {
		if (v === REDACTED_SENTINEL) return "<redacted>";
		if (v === OVERSIZED_SENTINEL) return "<too large>";
		const s = typeof v === "string" ? v : JSON.stringify(v);
		const text = s ?? String(v);
		return text.length > 60 ? `${text.slice(0, 57)}...` : text;
	};
	if (c.op === "add") return `+ ${c.path} = ${val(c.after)}`; // in declared, not live
	if (c.op === "remove") return `- ${c.path} (live: ${val(c.before)})`; // in live, not declared
	return `~ ${c.path}: ${val(c.before)} -> ${val(c.after)}`; // update: live -> declared
}

// SIO-886: a concise, GROUNDED explanation of what a stack's drift is, built straight from
// the drift-report fields (no LLM -> no hallucination). Empty string for a non-drifted stack.
// SIO-900: when a resource carries leaf-level `changes[]`, expand the line into per-leaf detail
// ("showing X of N") instead of the opaque attribute-grain reason. (Pure; unit-tested.)
export function explainStackDrift(stack: StackDrift): string {
	if (!stack.drifted || stack.resources.length === 0) return "";
	const verb = (actions: string[], category?: string): string => {
		const a = actions.length > 0 ? actions.join("+") : (category ?? "change");
		if (a.includes("delete") && a.includes("create")) return "replace";
		if (a === "create") return "create";
		if (a === "delete" || a === "destroy") return "delete";
		return "update";
	};
	const lines = stack.resources.slice(0, 8).map((r) => {
		const head = `- ${verb(r.actions, r.category)} ${shortAddress(r.address)}`;
		if (r.changes && r.changes.length > 0) {
			const total = r.changeCount ?? r.changes.length;
			const shown = r.changes.slice(0, 3).map((c) => `    ${formatLeafChange(c)}`);
			const extra = total > shown.length ? `\n    ...and ${total - shown.length} more change(s)` : "";
			return `${head} (${total} change${total === 1 ? "" : "s"})\n${shown.join("\n")}${extra}`;
		}
		const detail =
			r.reason || (r.changedKeys && r.changedKeys.length > 0 ? `changed: ${r.changedKeys.join(", ")}` : "");
		return `${head}${detail ? ` (${detail})` : ""}`;
	});
	const more = stack.resources.length > 8 ? `\n- ...and ${stack.resources.length - 8} more` : "";
	const counts = `${stack.create} create / ${stack.update} update / ${stack.delete} destroy`;
	return `${counts}\n${lines.join("\n")}${more}`;
}

// SIO-886: dedicated drift-explainer node. Attaches a grounded per-stack explanation to the
// drift report and emits the enriched iac_drift_report once for the UI (the overview card +
// the per-resource detail). No writes; runs between detectDrift and the reconcile loop.
export async function explainDrift(state: IacStateType): Promise<Partial<IacStateType>> {
	const report = state.driftReport;
	if (!report) return {};
	const stacks = report.stacks.map((s) => ({ ...s, explanation: explainStackDrift(s) }));
	log.info(
		{
			deployment: report.deployment,
			explained: stacks.filter((s) => s.explanation).map((s) => s.stack),
		},
		"iac drift: explanations attached",
	);
	// Emit the full, enriched report once (forwarded by the SSE pump to the drift card).
	await dispatchCustomEvent("iac_drift_report", {
		deployment: report.deployment,
		stacks: stacks.map((s) => ({
			stack: s.stack,
			drifted: s.drifted,
			planError: s.planError ?? false,
			...(s.planErrorReason && { planErrorReason: s.planErrorReason }),
			kind: s.kind,
			create: s.create,
			update: s.update,
			delete: s.delete,
			explanation: s.explanation ?? "",
			resources: s.resources,
		})),
	});
	return { driftReport: { ...report, stacks } };
}

// HITL gate for the stack at driftIndex. Pauses (interrupt) asking the human to pick a
// reconcile direction; the resume payload carries { direction }. reconcile-to-live is
// offered only where a clean live->file mapping exists (liveReconcilable).
export function reconcileGate(state: IacStateType): Partial<IacStateType> {
	const drifted = driftedStacks(state);
	const current = drifted[state.driftIndex];
	if (!current) return { currentDirection: "skip" };

	const directions: ReconcileDirection[] = current.liveReconcilable
		? ["reconcile-to-live", "reconcile-to-json", "skip"]
		: ["reconcile-to-json", "skip"];
	const summary = `${current.create} create / ${current.update} update / ${current.delete} destroy`;
	const liveHint = current.liveReconcilable
		? "Reconcile to Live Deployment (write the live values into the config file), "
		: "";
	const choice = interrupt({
		type: "iac_reconcile_choice",
		stack: current.stack,
		kind: current.kind,
		summary,
		// SIO-886: the grounded explanation + per-resource detail so the human can see WHAT
		// drifted before choosing MR-vs-skip. SIO-900: include the leaf-level changes[] + values
		// so the choice card can expand the precise per-leaf detail.
		explanation: current.explanation ?? "",
		resources: current.resources.slice(0, 8).map((r) => ({
			address: r.address,
			actions: r.actions,
			reason: r.reason ?? "",
			changedKeys: r.changedKeys ?? [],
			...(r.values && { values: r.values }),
			...(r.changes && { changes: r.changes }),
			...(r.changeCount !== undefined && { changeCount: r.changeCount }),
			...(r.truncated && { truncated: true }),
		})),
		directions,
		message:
			`Stack '${current.stack}' (${state.driftIndex + 1} of ${drifted.length}) has drifted: ${summary}. ` +
			`${liveHint}Reconcile to GitLab (opens an MR; CI shows the revert), or do nothing.`,
	}) as { direction?: ReconcileDirection };

	const dir = choice?.direction;
	const valid: ReconcileDirection = dir && directions.includes(dir) ? dir : "skip";
	return { currentDirection: valid };
}

// Act on the chosen direction for the stack at driftIndex -- open one independent,
// idempotent MR (reconcile-to-live or reconcile-to-json) or record a skip. Emits a
// per-stack result for the UI as each MR resolves.
export async function reconcileStack(state: IacStateType): Promise<Partial<IacStateType>> {
	const drifted = driftedStacks(state);
	const current = drifted[state.driftIndex];
	const direction = state.currentDirection ?? "skip";
	if (!current) return {};

	const result: ReconcileResult =
		direction === "skip"
			? { stack: current.stack, direction: "skip", status: "skipped" }
			: await openReconcileMr(state.targetDeployment, current, direction);

	await dispatchCustomEvent("iac_reconcile_result", {
		stack: result.stack,
		direction: result.direction,
		status: result.status,
		...(result.mrUrl && { mrUrl: result.mrUrl }),
		...(result.note && { note: result.note }),
	});

	return { reconcileResults: [...state.reconcileResults, result] };
}

// Step to the next drifted stack (the gate->worker->advance loop re-enters reconcileGate
// until every drifted stack is processed). Clears the per-stack direction.
export function advanceDrift(state: IacStateType): Partial<IacStateType> {
	return { driftIndex: state.driftIndex + 1, currentDirection: null };
}

// SIO-892: when EVERY stack failed the drift-check trigger with the same GitLab
// permission wall (the gitlab.com protected-branch rule on `main` after the SIO-891
// migration), that is an infra blocker, not a clean result -- returning a "no drift"
// summary reads like all-clear, the opposite of the truth. Return a blocker message
// only when every stack planError'd for the permission reason; mixed / state-lock /
// other-error runs fall through to the per-stack summary. (Pure; over StackDrift[].)
export function allStacksBlockedReason(deployment: string, stacks: StackDrift[]): string | null {
	if (stacks.length === 0) return null;
	if (!stacks.every((s) => s.planError === true)) return null;
	// The reason text is built from the raw GitLab 400 body (nodes.ts driftCheckStack ->
	// the server `note`), so match the permission phrasing rather than a status code.
	const isPermission = (s: StackDrift): boolean =>
		/sufficient permission to run a pipeline|insufficient permission|not have sufficient permission/i.test(
			s.planErrorReason ?? "",
		);
	if (!stacks.every(isPermission)) return null;
	return (
		`Drift-check could not run for ${deployment}: GitLab denied pipeline creation on 'main' for all ` +
		`${stacks.length} stack(s) (insufficient permission). This is a permissions issue, not a clean result -- ` +
		"no stack was assessed.\n" +
		"Fix: grant the elastic-iac GitLab token user the Maintainer role on the GitOps project " +
		"(or allow it under main's protected-branch rules), then re-run the drift check."
	);
}

// The drift flow's terminal message -- per-stack outcomes (MR opened/reused, skipped,
// blocked) + the apply reminder. (Pure; reads only state.)
export function formatDriftSummary(state: IacStateType): string {
	const dep = state.targetDeployment || "(unknown)";
	const all = state.driftReport?.stacks ?? [];
	// SIO-892: lead with the infra blocker when every stack hit the same GitLab permission
	// wall -- before computing the drift/no-drift headline that would otherwise read as clean.
	const blocker = allStacksBlockedReason(dep, all);
	if (blocker) return blocker;
	const drifted = all.filter((s) => s.drifted);
	const planErrored = all.filter((s) => s.planError);
	// Stacks whose plan could not be read were NOT assessed -- never imply they are clean.
	const errSuffix =
		planErrored.length > 0
			? ` ${planErrored.length} stack(s) could NOT be planned and were not assessed: ${planErrored
					.map((s) => (s.planErrorReason ? `${s.stack} (${s.planErrorReason})` : s.stack))
					.join("; ")}.`
			: "";
	if (drifted.length === 0) {
		const planned = all.length - planErrored.length;
		return `No drift detected for ${dep} across the ${planned} stack(s) I could plan.${errSuffix}`;
	}
	const lines = [`Drift reconcile summary for ${dep} (${drifted.length} drifted stack(s)):`];
	for (const r of state.reconcileResults) {
		if (r.status === "opened") lines.push(`  ${r.stack}: MR opened (${r.direction}) -> ${r.mrUrl}`);
		else if (r.status === "reused") lines.push(`  ${r.stack}: existing MR reused (${r.direction}) -> ${r.mrUrl}`);
		else if (r.status === "skipped") lines.push(`  ${r.stack}: skipped`);
		else lines.push(`  ${r.stack}: blocked -- ${r.note ?? "see logs"}`);
	}
	const handled = new Set(state.reconcileResults.map((r) => r.stack));
	for (const s of drifted) if (!handled.has(s.stack)) lines.push(`  ${s.stack}: not processed`);
	if (errSuffix) lines.push(`Note:${errSuffix}`);
	lines.push("Review each MR's plan in GitLab, then merge and apply. I never merge or apply.");
	return lines.join("\n");
}

// Final message: MR link + pipeline status + the real plan + approval state, then stop.
// SIO-943: fleet-upgrade breadcrumb fields. Pulls the recallable specifics off the report +
// result so the stored message carries version/deployment/counts/pipeline rather than a generic
// "intent=fleet-upgrade". Tolerates a missing report/result (returns whatever is present).
export function buildFleetMemorySummary(state: IacStateType): string[] {
	const report = state.fleetUpgradeReport;
	const result = state.fleetUpgradeResult;
	const dep = state.targetDeployment || state.iacRequest?.cluster;
	const parts = ["intent=fleet-upgrade"];
	if (dep) parts.push(`deployment=${dep}`);
	if (report?.targetVersion) parts.push(`version=${report.targetVersion}`);
	if (result?.status) parts.push(`status=${result.status}`);
	if (report?.crosstab) parts.push(`upgradeable=${report.crosstab.upgradeable}`);
	if (report?.versionCrosstab) parts.push(`already-on-target=${report.versionCrosstab.alreadyOnTarget}`);
	if (report?.crosstab && report.crosstab.notUpgradeable > 0)
		parts.push(`non-upgradeable=${report.crosstab.notUpgradeable}`);
	if (typeof result?.created === "number") parts.push(`acked=${result.acked ?? 0}/${result.created}`);
	if (result?.failedSilent && result.failedSilent > 0) parts.push(`upg-failed=${result.failedSilent}`);
	if (result?.pipelineId) parts.push(`pipeline=${result.pipelineId}`);
	return parts;
}

// SIO-943: the durable Profile-fact statement for a fleet upgrade. Self-contained (no
// requestId/threadId) so it reads on its own in a future session's semantic recall.
// SIO-957: a dispatched (still-running) upgrade also gets a durable fact, worded as
// in-flight ("upgrade DISPATCHED") so recall reflects "you kicked this off, not yet
// confirmed complete" -- a long apply pipeline outlives the turn that dispatched it.
export function buildFleetFactDecision(state: IacStateType, result: FleetUpgradeResult): string {
	const dep = state.targetDeployment || state.iacRequest?.cluster || "unknown deployment";
	const version = state.fleetUpgradeReport?.targetVersion ?? "?";
	const verb =
		result.status === "applied"
			? "upgraded to"
			: result.status === "failed"
				? "upgrade FAILED to"
				: result.status === "partial"
					? "upgrade PARTIALLY applied to"
					: "upgrade DISPATCHED to";
	return `Fleet agents on ${dep} ${verb} ${version}.`;
}

export function buildFleetFactRationale(state: IacStateType, result: FleetUpgradeResult): string {
	const report = state.fleetUpgradeReport;
	const bits: string[] = [];
	if (report?.crosstab) bits.push(`${report.crosstab.upgradeable} upgradeable`);
	if (report?.versionCrosstab) bits.push(`${report.versionCrosstab.alreadyOnTarget} already on target`);
	if (report?.crosstab && report.crosstab.notUpgradeable > 0) {
		bits.push(`${report.crosstab.notUpgradeable} non-upgradeable (Wolfi/container)`);
	}
	if (result.failedSilent && result.failedSilent > 0) bits.push(`${result.failedSilent} reached UPG_FAILED`);
	if (result.note) bits.push(result.note);
	const pipeline = result.pipelineId ? ` Apply pipeline #${result.pipelineId}.` : "";
	return `${bits.join(", ") || "no breakdown available"}.${pipeline}`;
}

// SIO-959: structured labels on the durable fleet fact so a later session can
// retrieve it by filter (recallInFlightFleetUpgrades) instead of parsing prose.
// kind distinguishes an in-flight ("fleet-upgrade-dispatched", re-pollable) record
// from a terminal one ("fleet-upgrade-terminal") -- a terminal status-check writes
// a terminal-kind fact that no longer matches the in-flight filter, superseding the
// dispatched record so a finished upgrade is never reported as still running.
function buildFleetFactAnnotations(state: IacStateType, result: FleetUpgradeResult): AnnotationMap {
	const a: AnnotationMap = {
		kind: result.status === "dispatched" ? "fleet-upgrade-dispatched" : "fleet-upgrade-terminal",
		status: result.status,
	};
	const dep = state.targetDeployment || state.iacRequest?.cluster;
	if (dep) a.deployment = dep;
	if (state.fleetUpgradeReport?.targetVersion) a.version = state.fleetUpgradeReport.targetVersion;
	if (result.pipelineId != null) a.pipeline_id = String(result.pipelineId);
	return a;
}

// SIO-965: structured labels on the durable gitops-change fact. These mirror the
// knowledge-graph node keys so the two durable systems join on the SAME values:
// thread_id == KG Session.threadId, config_change_id == KG ConfigChange.id (the
// requestId), plus deployment/stack/workflow/mr_url/pipeline/outcome. A later
// session can recall "what did we change on eu-b2b/slos" by annotation filter, and
// the same keys resolve the corresponding KG subgraph.
export function buildIacChangeAnnotations(state: IacStateType): AnnotationMap {
	const a: AnnotationMap = { kind: "iac-change", outcome: iacTurnOutcome(state) };
	a.config_change_id = state.requestId;
	if (state.threadId) a.thread_id = state.threadId;
	const dep = state.targetDeployment || state.iacRequest?.cluster;
	if (dep) a.deployment = dep;
	// SIO-1071: same derivation as the recall side (stackInstanceId in graph-knowledge.ts) --
	// without the workflow fallback a proposer that misses proposedFiles writes a fact the
	// deterministic {stack_instance} recall can never find, and "Prior learnings (memory)"
	// silently never renders for that stack.
	const stack = stackFromPaths(state.proposedFiles) || stackForWorkflow(state.iacRequest?.workflow);
	if (stack) a.stack = stack;
	if (dep && stack) a.stack_instance = `${dep}/${stack}`;
	if (state.iacRequest?.workflow) a.workflow = state.iacRequest.workflow;
	if (state.iacRequest?.version) a.version = state.iacRequest.version;
	// SIO-996: persist the rich change descriptor (the plan-review title -- "[eu-b2b] removed
	// xpack.monitoring.collection.interval: cluster-settings-edit") as a VERBATIM annotation. The
	// service paraphrases fact/summary text on ingest, but annotations survive unchanged, so a
	// cross-thread "check my MR" recall reads the exact keys here instead of the reworded prose.
	const changeSummary = state.planReview?.title;
	if (changeSummary) a.change_summary = changeSummary;
	if (state.mrUrl) a.mr_url = state.mrUrl;
	// SIO-990: persist the MR iid too, so a fresh-thread "check my MR" can re-poll the exact MR via
	// recall instead of guessing the "latest open agent MR" (which can be the wrong one).
	if (state.mrIid != null) a.mr_iid = String(state.mrIid);
	if (state.pipelineId != null) a.pipeline_id = String(state.pipelineId);
	if (state.pipelineStatus && state.pipelineStatus !== "unknown") a.pipeline_status = state.pipelineStatus;
	return a;
}

// SIO-965: the durable Profile-fact statement for a gitops config change. Self-
// contained so a future session's semantic recall reads it without context.
export function buildIacChangeDecision(state: IacStateType): string {
	const dep = state.targetDeployment || state.iacRequest?.cluster || "an Elastic deployment";
	const stack = stackFromPaths(state.proposedFiles) || stackForWorkflow(state.iacRequest?.workflow);
	const scope = stack ? `${dep}/${stack}` : dep;
	const title = state.planReview?.title || state.iacRequest?.workflow || "config change";
	const outcome = iacTurnOutcome(state);
	const verb = outcome === "pipeline-failed" ? "change FAILED CI" : "change proposed (MR open)";
	return `Elastic IaC ${verb} on ${scope}: ${title}.`;
}

export function buildIacChangeRationale(state: IacStateType): string {
	const bits: string[] = [];
	if (state.mrUrl) bits.push(`MR ${state.mrUrl}`);
	if (state.pipelineId) bits.push(`pipeline #${state.pipelineId} ${state.pipelineStatus || ""}`.trim());
	if (state.proposedFiles.length > 0) bits.push(`${state.proposedFiles.length} file(s)`);
	return bits.length > 0
		? `${bits.join(", ")}. A human reviews, merges, and applies.`
		: "A human reviews, merges, and applies.";
}

// SIO-988: recall the intent recorded when this MR was opened (buildIacChangeDecision),
// so a later "check my MR" turn -- a fresh classify->pipeline-status turn whose state has
// no iacRequest/planReview (watchPipeline only recovers mrIid + live plan/approval) -- can
// still say WHAT the change was. Keyed on mr_url, the one annotation stable across turns
// (the fact was written with pipeline_status="running", so we never filter on status).
// Best-effort: agent-memory backend only; "" on disable/miss/error.
export async function recallIacChangeIntent(mrUrl: string): Promise<string> {
	if (!mrUrl || selectedBackend() !== "agent-memory") return "";
	try {
		// SIO-998: identifier-keyed (by mr_url) -> deterministic filter-only retrieval, NOT a ranked query
		// (a query string can rank this MR's fact out of the top-k window before the mr_url filter applies).
		const hits = await searchAgentMemory("elastic-iac", "", { kind: "iac-change", mr_url: mrUrl }, 8, {
			deterministic: true,
		});
		// SIO-973: a re-recorded change returns as multiple hits; collapse per MR.
		// SIO-1005: prefer the highest-lifecycle hit per MR (the reconciled "applied"/"apply-failed" fact
		// over the original proposal) so a "check my MR" reads the terminal state, not the stale proposal.
		const deduped = dedupePreferring(
			hits,
			(h) => h.annotations.config_change_id ?? h.annotations.mr_url,
			(h) => lifecycleRank(h.annotations),
		);
		// SIO-996: the same MR yields one fact per turn (config_change_id == per-turn requestId), and only
		// the PROPOSAL turn's fact carries change_summary (a pipeline-status re-check has no planReview).
		// Prefer the hit that actually has the verbatim descriptor over the highest-ranked one, which may
		// be a re-check fact lacking it. Fall back to the top hit (then its text) for legacy facts.
		const top = deduped.find((h) => h.annotations.change_summary) ?? deduped[0];
		// SIO-996: prefer the verbatim change_summary annotation (the rich descriptor "[eu-b2b] removed
		// <key>: cluster-settings-edit") over top.text -- the service LLM-paraphrases fact/summary on
		// ingest, but annotations are stored unchanged, so the annotation is the lossless source of WHAT
		// changed. Fall back to text for facts written before this field existed.
		const intent = top?.annotations.change_summary || top?.text || "";
		// SIO-991: make the recall path observable -- it only runs when the in-turn planReview/iacRequest
		// is empty (a fresh-thread "check my MR"), and previously logged nothing on success. blockId ties
		// the recalled fact to its Couchbase document. (searchAgentMemory also logs the raw search.)
		log.info(
			{
				mrUrl,
				hit: Boolean(top),
				blockId: top?.blockId,
				source: top?.annotations.change_summary ? "annotation" : "text",
			},
			"recallIacChangeIntent",
		);
		return intent;
	} catch {
		return ""; // searchAgentMemory already logs
	}
}

// SIO-992: one step of this MR's recalled progression (proposed -> running -> success).
export interface IacProgressStep {
	pipelineStatus?: string;
	outcome?: string;
}

// SIO-992: rank pipeline statuses so the progression renders in lifecycle order regardless of the
// order the service returns hits. "running" before terminal; the terminal states sort after.
const PIPELINE_STATUS_RANK: Record<string, number> = {
	created: 0,
	pending: 1,
	running: 2,
	success: 3,
	failed: 3,
	canceled: 3,
	skipped: 3,
};

// SIO-992: recall THIS session's own iac-change history for the open MR so a "check my MR" turn can
// show a progression (proposed -> running -> success), not just the live status. Session-scoped
// (allSessions:false) so only this conversation's breadcrumbs return; annotation-keyed (never prose,
// which the service paraphrases on ingest) and deduped on pipeline_status so a re-check doesn't
// multiply steps. Best-effort: agent-memory backend only; [] on disable/miss/error.
export async function recallSessionProgress(mrUrl: string): Promise<IacProgressStep[]> {
	if (!mrUrl || selectedBackend() !== "agent-memory") return [];
	try {
		// SIO-998: identifier-keyed (by mr_url) -> deterministic filter-only retrieval (session-scoped).
		const hits = await searchAgentMemory("elastic-iac", "", { kind: "iac-change", mr_url: mrUrl }, 8, {
			allSessions: false,
			deterministic: true,
		});
		// One step per distinct pipeline_status (the only annotation that advances as the pipeline
		// runs). Hits with no pipeline_status fall back to config_change_id so a single proposal step
		// is kept. Then order by lifecycle rank.
		const deduped = dedupeHitsBy(hits, (h) => h.annotations.pipeline_status ?? h.annotations.config_change_id);
		const steps = deduped.map((h) => ({
			pipelineStatus: h.annotations.pipeline_status,
			outcome: h.annotations.outcome,
		}));
		steps.sort(
			(a, b) =>
				(PIPELINE_STATUS_RANK[a.pipelineStatus ?? ""] ?? 99) - (PIPELINE_STATUS_RANK[b.pipelineStatus ?? ""] ?? 99),
		);
		log.info({ mrUrl, steps: steps.length }, "recallSessionProgress");
		return steps;
	} catch {
		return []; // searchAgentMemory already logs
	}
}

// SIO-990: the structured shape of a recalled gitops-change fact -- the durable cross-thread
// carrier for "which MR / deployment / pipeline did we last touch". Mirrors buildIacChangeAnnotations.
export interface RecalledIacChange {
	mrUrl?: string;
	mrIid?: number;
	pipelineId?: number;
	deployment?: string;
	stack?: string;
	text: string;
}

// SIO-990: recall the most recent durable gitops-change fact (kind:"iac-change"), optionally scoped
// to a deployment. Backs the cross-thread "check my MR" after a clear/reload mints a fresh threadId
// (the per-thread mrIid/mrUrl channels don't survive that boundary, but the teardown-written fact
// does). Reuses the searchAgentMemory + dedupeHitsBy shape of recallIacChangeIntent; dedup on
// mr_url ?? config_change_id so a re-recorded change doesn't surface twice. Best-effort: agent-memory
// backend only; null on disable/miss/error.
export async function recallLastIacChange(deployment?: string): Promise<RecalledIacChange | null> {
	if (selectedBackend() !== "agent-memory") return null;
	try {
		// SIO-998: keyed by kind(+deployment) -> deterministic filter-only retrieval. "Most recent" is
		// resolved by dedupe + the caller's ordering, not by semantic relevance to a query string.
		const filter: AnnotationMap = { kind: "iac-change", ...(deployment ? { deployment } : {}) };
		const hits = await searchAgentMemory("elastic-iac", "", filter, 8, { deterministic: true });
		// SIO-1005: per MR prefer the reconciled (terminal) fact over the proposal so the recovered
		// mr/pipeline ids + text reflect the latest state, not the original proposal.
		const deduped = dedupePreferring(
			hits,
			(h) => h.annotations.mr_url ?? h.annotations.config_change_id,
			(h) => lifecycleRank(h.annotations),
		);
		const top = deduped[0];
		if (!top) return null;
		const a = top.annotations;
		const mrIid = a.mr_iid ? Number(a.mr_iid) : undefined;
		const pipelineId = a.pipeline_id ? Number(a.pipeline_id) : undefined;
		return {
			text: top.text,
			...(a.mr_url ? { mrUrl: a.mr_url } : {}),
			...(mrIid != null && Number.isFinite(mrIid) ? { mrIid } : {}),
			...(pipelineId != null && Number.isFinite(pipelineId) ? { pipelineId } : {}),
			...(a.deployment ? { deployment: a.deployment } : {}),
			...(a.stack ? { stack: a.stack } : {}),
		};
	} catch {
		return null; // searchAgentMemory already logs
	}
}

// SIO-988: status-aware closing line. The agent only ever PROPOSES, so every branch still
// states "I never merge or apply." -- but a clean success reads as good-news + ready-to-merge
// instead of the flat "review and apply manually" that fought the actual state. Non-terminal /
// still-running keeps the original line (a follow-up re-checks).
function iacClosingLine(state: IacStateType): string {
	const merge = "I never merge or apply.";
	if (state.pipelineStatus === "success") {
		// SIO-992: the plan pipeline succeeding only means the CI `terraform plan` job ran clean. The
		// real lifecycle stage is the MR's state. Branch on it FIRST so a MERGED MR never reads as
		// "ready to merge", and we never claim the change is applied (the apply runs on main, which
		// watchPipeline can't see). SIO-991: keep "staged, not applied" for the open case.
		// SIO-1005: derive the lifecycle via the shared classifyLiveState so the closing line and the
		// reconciliation pass (reconcile.ts) describe the SAME taxonomy from the same inputs.
		const lifecycle = classifyLiveState(state.mrState, state.applyPipelineStatus);
		if (state.mrState === "merged") {
			// SIO-993/SIO-995: merged -> the terraform apply runs on main as the apply:* JOB (parent ->
			// child -> job). classifyLiveState reads that JOB's status (NOT the parent pipeline's, which
			// reports success transiently before the apply job runs/fails -- the SIO-995 false-positive).
			// Only a confirmed apply-job SUCCESS (lifecycle "applied") means the change is live.
			const applyLink = state.applyPipelineUrl ? ` (${state.applyPipelineUrl})` : "";
			if (lifecycle === "applied") {
				return `Merged and APPLIED: the apply job on main succeeded${applyLink}, so the change is now live. ${merge}`;
			}
			if (lifecycle === "apply-failed") {
				return `Merged, but the apply on main ${(state.applyPipelineStatus || "did not succeed").toUpperCase()}${applyLink} — the change is NOT live. Review the apply job log on main in GitLab. ${merge}`;
			}
			if (lifecycle === "apply-running") {
				return `Merged — the terraform apply is RUNNING on main${applyLink} (status ${state.applyPipelineStatus}); the change is NOT live until the apply job succeeds. Ask "check my MR" again to see the apply finish. ${merge}`;
			}
			// apply-not-started: the apply job hasn't appeared yet (apply pipeline starting, or it couldn't
			// be resolved). NOT live, and never reported as success.
			return `Merged — the terraform apply on main hasn't started yet (or I couldn't resolve it). The change is NOT live until the apply job succeeds. Ask "check my MR" again shortly. ${merge}`;
		}
		if (lifecycle === "closed") {
			return `The plan CI succeeded but the MR was CLOSED without merging — nothing was applied. ${merge}`;
		}
		// MR still open (state "opened" or unread). The plan is ready; nothing is merged or applied.
		const openNote =
			state.mrState === "opened"
				? "The MR is still OPEN — nothing has been merged or applied."
				: "Nothing has been merged or applied yet.";
		return state.approvalState && !state.approvalState.approved
			? `The plan CI succeeded: the plan is clean but not yet approved. ${openNote} Review, approve, then merge in GitLab to trigger the apply. ${merge}`
			: `The plan CI succeeded: the plan is clean and approved, so the change is staged and ready to merge. ${openNote} Merge in GitLab to trigger the apply. ${merge}`;
	}
	if (isTerminalPipelineStatus(state.pipelineStatus) && state.pipelineStatus === "failed") {
		return `Pipeline failed — review the plan log and fix before merging. ${merge}`;
	}
	return `Review and apply manually in GitLab. ${merge}`;
}

export async function teardownIac(state: IacStateType): Promise<Partial<IacStateType>> {
	// SIO-938: record one durable breadcrumb per completed IaC job under the
	// elastic-iac Agent Memory user (closes the SOUL.md "I write back after every
	// job" gap that had no code path). No-op unless LIVE_MEMORY_ENABLED; routes to
	// the agent-memory backend when selected. Best-effort — never block the turn.
	try {
		const cluster = state.iacRequest?.cluster;
		// SIO-943: a fleet upgrade has no MR/cluster but carries a rich result. Enrich the
		// breadcrumb with version/deployment/counts/pipeline so the stored message (and the
		// embedding the service derives from it) is recallable, not a generic "intent=fleet-upgrade".
		const isFleet =
			state.intent === "fleet-upgrade" || (state.intent === "pipeline-status" && state.fleetUpgradeResult);
		const summaryParts = isFleet
			? buildFleetMemorySummary(state)
			: [
					state.intent ? `intent=${state.intent}` : "",
					state.reviewDecision === "rejected" ? "rejected" : state.mrUrl ? `MR=${state.mrUrl}` : "",
					state.pipelineStatus && state.pipelineStatus !== "unknown" ? `pipeline=${state.pipelineStatus}` : "",
				].filter((p) => p.length > 0);
		const services = cluster ? [cluster] : isFleet && state.targetDeployment ? [state.targetDeployment] : [];
		appendDailyLog({
			requestId: state.requestId,
			services,
			datasources: ["elastic-iac"],
			summary: summaryParts.join(" "),
		});

		// SIO-943 / SIO-957: a fleet upgrade is a durable Profile fact so a later
		// session recalls "eu-cld fleet -> 9.4.2 (applied)" OR "us-cld fleet -> 9.4.2
		// (dispatched, pipeline #...)". Terminal (applied|failed) AND in-flight
		// (dispatched) all qualify: a long apply pipeline outlives the turn that
		// dispatched it, so without the dispatched fact a later session recalls
		// nothing about work the user kicked off. skipped|blocked are not recorded
		// (nothing happened). Agent-memory backend only: on the file backend durable
		// learnings stay PR-gated (key-decisions.md is untouched).
		const fleetResult = state.fleetUpgradeResult;
		const recordableStatus =
			fleetResult?.status === "applied" ||
			fleetResult?.status === "failed" ||
			fleetResult?.status === "partial" ||
			fleetResult?.status === "dispatched";
		if (isFleet && selectedBackend() === "agent-memory" && recordableStatus && fleetResult) {
			recordKeyDecision({
				requestId: state.requestId,
				decision: buildFleetFactDecision(state, fleetResult),
				rationale: buildFleetFactRationale(state, fleetResult),
				// SIO-959: structured labels for cross-session recovery (kind/deployment/pipeline_id).
				annotations: buildFleetFactAnnotations(state, fleetResult),
			});
			// SIO-958: make the durable-write decision visible (terminal vs in-flight).
			log.info(
				{ deployment: state.targetDeployment, status: fleetResult.status, pipelineId: fleetResult.pipelineId },
				"teardownIac: recorded durable fleet fact",
			);
		} else if (isFleet && selectedBackend() === "agent-memory") {
			// SIO-958: a fleet turn that did NOT record a durable fact -- say why, so the
			// recall gap is diagnosable from logs rather than silent.
			log.info(
				{ deployment: state.targetDeployment, status: fleetResult?.status ?? "none" },
				"teardownIac: skipped durable fleet fact (non-recordable status)",
			);
		}

		// SIO-965: a gitops config change that actually opened an MR is a durable Profile
		// fact too, annotated with the SAME keys as the knowledge-graph nodes (thread_id,
		// config_change_id, deployment, stack, mr_url, pipeline, outcome) so the two
		// systems join on shared values. Only when an MR exists (a rejected/blocked turn
		// changed nothing) and on the agent-memory backend (file-backend durable
		// learnings stay PR-gated, mirroring the fleet rule above).
		// SIO-992: ALSO record on a "pipeline-status" re-check (a "check my MR" turn). The proposal
		// turn writes pipeline_status="running"; a later re-check writes "success"/"failed", so the
		// two facts form a recallable progression (proposed -> running -> success) that
		// recallSessionProgress surfaces. dedupeHitsBy on pipeline_status collapses re-records of the
		// same status, so re-checking repeatedly does not multiply steps.
		const recordsIacChangeFact =
			!isFleet && (state.intent === "gitops" || state.intent === "pipeline-status") && state.mrUrl;
		if (recordsIacChangeFact && selectedBackend() === "agent-memory") {
			recordKeyDecision({
				requestId: state.requestId,
				decision: buildIacChangeDecision(state),
				rationale: buildIacChangeRationale(state),
				annotations: buildIacChangeAnnotations(state),
				// SIO-1005: give the PROPOSAL fact a TTL so it auto-expires once reconciliation has written
				// the durable terminal fact -- keeping the append-only store at ~one fact per settled MR.
				// undefined (durable) unless the reconciliation cron is enabled (see iacProposalFactTtlSeconds).
				ttlSeconds: iacProposalFactTtlSeconds(),
			});
			log.info(
				{ deployment: state.targetDeployment || state.iacRequest?.cluster, mrUrl: state.mrUrl, intent: state.intent },
				"teardownIac: recorded durable iac-change fact",
			);
		}
	} catch {
		// memory-writer already logs; never let a breadcrumb fail the turn.
	}

	// SIO-902: the synthetics flow renders its own summary (checked before "drift" since the
	// synthetics report lives on a different channel).
	if (state.intent === "synthetics-drift") {
		return { messages: [new AIMessage(formatSyntheticsSummary(state))] };
	}
	// SIO-913: the fleet-upgrade flow renders its own preview/apply summary.
	// SIO-926: a pipeline-status follow-up that re-polled a dispatched fleet apply (watchPipeline ->
	// checkFleetApplyStatus) also carries a fleetUpgradeResult -- render the fleet summary, not the
	// MR-pipeline lines below (a binary upgrade has no MR/approval).
	if (state.intent === "fleet-upgrade" || (state.intent === "pipeline-status" && state.fleetUpgradeResult)) {
		return { messages: [new AIMessage(formatFleetUpgradeSummary(state))] };
	}
	// SIO-882: the drift flow renders its own per-stack reconcile summary.
	if (state.intent === "drift") {
		return { messages: [new AIMessage(formatDriftSummary(state))] };
	}
	if (state.reviewDecision === "rejected") {
		return { messages: [new AIMessage("Plan rejected. No MR opened. Nothing was applied.")] };
	}
	const lines: string[] = [state.mrUrl ? `MR opened: ${state.mrUrl}` : "MR step complete."];
	// SIO-932: a multi-file ilm change names every file it touched so the user sees both edits in
	// one MR (the whole point of the batch). policyName is null on the multi path, so read proposedFiles.
	if (state.intent === "gitops" && (state.iacRequest?.ilmPolicies?.length ?? 0) >= 2) {
		lines.push(`This MR changes ${state.proposedFiles.length} files: ${state.proposedFiles.join(", ")}.`);
	}
	// SIO-899: when onboarding an untracked policy, name the created file + scope it (Step 2 is a runtime apply).
	if (state.policyCreated) {
		const created =
			(state.iacRequest?.ilmPolicies?.length ?? 0) >= 2
				? `${state.proposedFiles.length} ILM policy files`
				: `'${state.iacRequest?.policyName ?? "?"}'`;
		lines.push(
			`Created a new managed ILM policy ${created} (was untracked in IaC). Attaching it to existing indices is a runtime apply done in GitLab/Elasticsearch, not part of this MR.`,
		);
	}

	if (state.pipelineStatus && state.pipelineStatus !== "unknown") {
		const pid = state.pipelineId ? `#${state.pipelineId}` : "";
		// SIO-991: the MR pipeline only runs `terraform plan` -- "success" means the plan computed
		// cleanly and the change is STAGED on the MR, not applied. Qualify it so "success" doesn't
		// read as "the change is live"; non-success statuses render verbatim.
		// SIO-992: once the MR is MERGED the plan pipeline's "success" is stale (the apply runs on
		// main); say so on the line so it isn't mistaken for the apply succeeding.
		const label =
			state.pipelineStatus === "success"
				? state.mrState === "merged"
					? "plan succeeded (MR since MERGED — apply runs on main, not this pipeline)"
					: "plan succeeded (plan ready; nothing applied yet)"
				: state.pipelineStatus;
		lines.push(`Pipeline ${pid}: ${label}`);
	}
	// SIO-992: surface the MR lifecycle stage explicitly (open vs merged) when known, so the reader
	// sees where in proposed -> merged -> applied the change actually is.
	// SIO-993/SIO-995: when merged, add the REAL apply-JOB status (parent -> child -> apply:* job),
	// not the parent pipeline's transient status. Only a confirmed apply-job SUCCESS reads as LIVE.
	if (state.mrState === "merged") {
		lines.push("MR: MERGED (the terraform apply runs on main for the merge commit).");
		const pid = state.applyPipelineId ? `#${state.applyPipelineId}` : "";
		if (state.applyPipelineStatus === "success") {
			lines.push(`Apply: ${pid} SUCCEEDED on main — the change is LIVE.`);
		} else if (state.applyPipelineStatus === "failed" || state.applyPipelineStatus === "canceled") {
			lines.push(`Apply: ${pid} ${state.applyPipelineStatus.toUpperCase()} on main — the change is NOT live.`);
		} else if (state.applyPipelineStatus) {
			lines.push(`Apply: ${pid} ${state.applyPipelineStatus} on main — NOT live until it succeeds.`);
		} else {
			lines.push("Apply: not started yet on main (or unresolved) — re-check shortly. NOT live.");
		}
	} else if (state.mrState === "opened") {
		lines.push("MR: OPEN (not merged; merging it in GitLab triggers the apply).");
	} else if (state.mrState === "closed") {
		lines.push("MR: CLOSED without merging (nothing applied).");
	}
	if (state.planReport) {
		lines.push(`Plan: ${formatPlanSummary(state.planReport)}`);
		for (const r of state.planReport.resources.slice(0, 10)) {
			lines.push(`  ${r.actions.join("+")} ${r.address}`);
		}
		// SIO-1022 / SIO-1037: for a file DELETE (cluster-defaults override or ILM policy), state the
		// AGENTS.md s7 verdict from the plan counts -- both delete a for_each key, same plan semantics.
		if (state.iacRequest?.workflow === "cluster-default-delete" || state.iacRequest?.workflow === "ilm-delete") {
			const { create, update, delete: destroy } = state.planReport;
			lines.push(
				destroy === 0 && create === 0 && update === 0
					? "Verdict: NO-OP CLEANUP -- 0 destroy. The file never converged in state; safe to merge, no apply runs."
					: destroy > 0
						? `Verdict: DESTRUCTIVE -- ${destroy} resource(s) to destroy. Merging removes them live; needs data-owner sign-off, do NOT merge if unintended.`
						: "Verdict: unexpected plan for a file delete (no destroy but adds/changes). Review the plan before merging.",
			);
		}
	} else if (
		(state.iacRequest?.workflow === "cluster-default-delete" || state.iacRequest?.workflow === "ilm-delete") &&
		state.mrState !== "merged"
	) {
		// SIO-1022: a delete with no plan yet -> do NOT claim a verdict; tell the user to verify.
		lines.push(
			"Verdict: the CI plan has not reported yet -- verify it shows 0 destroy (no-op cleanup) before merging.",
		);
	} else if (isTerminalPipelineStatus(state.pipelineStatus)) {
		lines.push("Plan: not available from the pipeline report.");
		// SIO-878: when the pipeline failed, explain the likely cause.
		if (state.failureHint) lines.push(state.failureHint);
	} else if (state.pipelineStatus) {
		lines.push('Pipeline still running — ask "check my MR" to refresh the plan + approval.');
	}
	if (state.approvalState) {
		const by = state.approvalState.approvedBy?.length ? ` by ${state.approvalState.approvedBy.join(", ")}` : "";
		const req = state.approvalState.required != null ? ` (${state.approvalState.required} required)` : "";
		lines.push(`Approval: ${state.approvalState.approved ? `approved${by}` : "not approved"}${req}`);
	}
	// SIO-988: surface WHAT the change intended. Prefer in-turn context (a same-turn resume still
	// has planReview/iacRequest); fall back to durable memory by mr_url for a fresh cross-session
	// "check my MR" turn where that state is empty. Insert right under "MR opened:" so the user
	// reads the intent before the mechanics.
	const intentInTurn = state.planReview?.title || state.iacRequest?.workflow || "";
	const intent = intentInTurn || (await recallIacChangeIntent(state.mrUrl));
	if (intent) lines.splice(1, 0, `Change: ${intent}`);
	// SIO-992: on a "check my MR" re-poll, show where in the lifecycle we are by recalling THIS
	// session's own progression (proposed -> running -> success), not just the current status. Only
	// on pipeline-status turns (a fresh post-openMr gitops turn shows the live card and has no prior
	// history); only when there's an actual trail (>1 step), else the "Change:" line already covers it.
	if (state.intent === "pipeline-status" && state.mrUrl) {
		const steps = await recallSessionProgress(state.mrUrl);
		const trail = steps.map((s) => s.pipelineStatus ?? s.outcome ?? "proposed").join(" -> ");
		if (steps.length > 1) lines.push("", `Progress so far: proposed -> ${trail}`);
	}
	lines.push(iacClosingLine(state));
	return { messages: [new AIMessage(lines.join("\n"))] };
}

// ──────────────────────────────────────────────────────────────────────────────────────
// SIO-902: synthetics drift detection + operator-approved remote push.
// Straight-line sub-flow (no per-stack loop): detectSyntheticsDrift -> syntheticsPushGate
// -> pushSynthetics -> teardown. The synthetics-drift-report.json contract is whole-
// deployment with pre-aggregated totals + a bidirectional reconcile_plan; reconcile is a
// single CI push (re-assert source YAML), never a repo write or per-resource MR.
// ──────────────────────────────────────────────────────────────────────────────────────

// One drifted monitor from the report `drift[]`. Tolerant: drops entries with no monitor id or
// an unknown category; maps fields[] {field,source,live} when present (only on "changed").
function parseSyntheticsMonitor(entry: unknown): SyntheticsDriftMonitor | null {
	if (!entry || typeof entry !== "object") return null;
	const m = entry as {
		project?: unknown;
		monitor_id?: unknown;
		monitor_name?: unknown;
		category?: unknown;
		fields?: unknown;
	};
	const monitorId = typeof m.monitor_id === "string" ? m.monitor_id : "";
	if (!monitorId) return null;
	if (m.category !== "changed" && m.category !== "missing_in_kibana" && m.category !== "extra_in_kibana") return null;
	const fields = Array.isArray(m.fields)
		? m.fields
				.filter((f): f is { field: string; source?: unknown; live?: unknown } => {
					return Boolean(f) && typeof f === "object" && typeof (f as { field?: unknown }).field === "string";
				})
				.map((f) => ({ field: f.field, source: f.source, live: f.live }))
		: undefined;
	return {
		project: typeof m.project === "string" ? m.project : "",
		monitorId,
		monitorName: typeof m.monitor_name === "string" ? m.monitor_name : monitorId,
		category: m.category,
		...(fields && fields.length > 0 && { fields }),
	};
}

// reconcile_plan.{push_to_kibana,add_to_source}; tolerant of absence -> empty command/action +
// empty monitor lists.
function parseReconcilePlan(plan: unknown): SyntheticsDriftReport["reconcilePlan"] {
	const p = (plan && typeof plan === "object" ? plan : {}) as {
		push_to_kibana?: unknown;
		add_to_source?: unknown;
	};
	const monitorsOf = (v: unknown): Array<{ project: string; monitorId: string; monitorName: string }> => {
		const raw = v && typeof v === "object" ? (v as { monitors?: unknown }).monitors : undefined;
		if (!Array.isArray(raw)) return [];
		return raw
			.map((entry) => {
				if (!entry || typeof entry !== "object") return null;
				const m = entry as { project?: unknown; monitor_id?: unknown; monitor_name?: unknown };
				const monitorId = typeof m.monitor_id === "string" ? m.monitor_id : "";
				if (!monitorId) return null;
				return {
					project: typeof m.project === "string" ? m.project : "",
					monitorId,
					monitorName: typeof m.monitor_name === "string" ? m.monitor_name : monitorId,
				};
			})
			.filter((m): m is { project: string; monitorId: string; monitorName: string } => m !== null);
	};
	const strField = (v: unknown, key: string): string => {
		const s = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
		return typeof s === "string" ? s : "";
	};
	return {
		pushToKibana: { command: strField(p.push_to_kibana, "command"), monitors: monitorsOf(p.push_to_kibana) },
		addToSource: { action: strField(p.add_to_source, "action"), monitors: monitorsOf(p.add_to_source) },
	};
}

// Parse synthetics-drift-report.json. Mirrors parseDriftReport tolerance: slice from the first
// "{", JSON.parse, return null on empty/unparseable (caller sets planError -- never a false
// "in sync"). generatedAt is set by the caller. (Pure; unit-tested.)
export function parseSyntheticsDriftReport(reportJson: string): SyntheticsDriftReport | null {
	const jsonStart = reportJson.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const o = JSON.parse(reportJson.slice(jsonStart)) as Record<string, unknown>;
		const num = (v: unknown): number => (typeof v === "number" ? v : 0);
		const str = (v: unknown): string => (typeof v === "string" ? v : "");
		const t = (o.totals && typeof o.totals === "object" ? o.totals : {}) as Record<string, unknown>;
		const drift = Array.isArray(o.drift)
			? (o.drift as unknown[]).map(parseSyntheticsMonitor).filter((m): m is SyntheticsDriftMonitor => m !== null)
			: [];
		return {
			deployment: str(o.deployment),
			kibanaUrl: str(o.kibana_url),
			kibanaSpace: str(o.kibana_space),
			hasActionableDrift: o.has_actionable_drift === true,
			totals: {
				projectsChecked: num(t.projects_checked),
				monitorsInSource: num(t.monitors_in_source),
				monitorsInKibana: num(t.monitors_in_kibana),
				missingInKibana: num(t.missing_in_kibana),
				extraInKibana: num(t.extra_in_kibana),
				changed: num(t.changed),
			},
			drift,
			reconcilePlan: parseReconcilePlan(o.reconcile_plan),
			generatedAt: "",
		};
	} catch {
		return null;
	}
}

// The source-authoritative push set: changed + missing_in_kibana. NEVER extra_in_kibana --
// pushing it would delete live monitors. This invariant gates the push gate and the scope.
// (Pure; unit-tested.)
export function pushableMonitors(report: SyntheticsDriftReport): SyntheticsDriftMonitor[] {
	return report.drift.filter((m) => m.category === "changed" || m.category === "missing_in_kibana");
}

// The PROJECT to pass to the push trigger: the single shared project when EVERY pushable monitor
// belongs to one project, else undefined (fleet-wide). extra_in_kibana is excluded (it is never
// pushed, so it must not influence scope). (Pure; unit-tested.)
export function pushProjectScope(report: SyntheticsDriftReport): string | undefined {
	const projects = new Set(
		pushableMonitors(report)
			.map((m) => m.project)
			.filter(Boolean),
	);
	return projects.size === 1 ? [...projects][0] : undefined;
}

// Graph-edge predicate: is there pushable synthetics drift worth a push gate? True only when the
// report exists, was assessed (no planError), is actionable, and has >=1 pushable monitor. An
// extra_in_kibana-only report is actionable but NOT pushable -> false (surface-only). (Pure.)
export function hasPushableSyntheticsDrift(report: SyntheticsDriftReport | null): boolean {
	if (!report || report.planError || !report.hasActionableDrift) return false;
	return pushableMonitors(report).length > 0;
}

// Cap a field value for display (mirror formatLeafChange's value cap).
function fmtSynthVal(v: unknown): string {
	const s = typeof v === "string" ? v : JSON.stringify(v);
	return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

// Grounded, no-LLM explanation grouped by category. Used in the push-gate message and the
// summary. Notes the extra_in_kibana surface-only rule and the browser-monitor blind spot.
// (Pure; unit-tested.)
export function explainSyntheticsDrift(report: SyntheticsDriftReport): string {
	if (!report.hasActionableDrift) return "";
	const lines: string[] = [];
	const changed = report.drift.filter((m) => m.category === "changed");
	const missing = report.drift.filter((m) => m.category === "missing_in_kibana");
	const extra = report.drift.filter((m) => m.category === "extra_in_kibana");
	if (changed.length > 0) {
		lines.push(`Changed (${changed.length}) -- source differs from Kibana:`);
		for (const m of changed.slice(0, 8)) {
			const flds = (m.fields ?? [])
				.slice(0, 3)
				.map((f) => `${f.field}: ${fmtSynthVal(f.live)} -> ${fmtSynthVal(f.source)}`)
				.join(", ");
			lines.push(`  - ${m.project}/${m.monitorName}${flds ? ` (${flds})` : ""}`);
		}
		if (changed.length > 8) lines.push(`  ...and ${changed.length - 8} more`);
	}
	if (missing.length > 0) {
		lines.push(`Missing in Kibana (${missing.length}) -- in source, not live (push will create):`);
		for (const m of missing.slice(0, 8)) lines.push(`  - ${m.project}/${m.monitorName}`);
		if (missing.length > 8) lines.push(`  ...and ${missing.length - 8} more`);
	}
	if (extra.length > 0) {
		lines.push(
			`Extra in Kibana (${extra.length}) -- live, not in source. SURFACE-ONLY; the push never deletes these. ` +
				"Add them to source or remove them in Kibana manually:",
		);
		for (const m of extra.slice(0, 8)) lines.push(`  - ${m.project}/${m.monitorName}`);
		if (extra.length > 8) lines.push(`  ...and ${extra.length - 8} more`);
	}
	lines.push("Note: browser (journey) monitors are not covered by this check.");
	return lines.join("\n");
}

// A zeroed report carrying a planError (mirror StackDrift.planError): the drift-check was NOT
// assessed -- never a false "in sync".
function emptySyntheticsReport(deployment: string, reason: string): SyntheticsDriftReport {
	return {
		deployment,
		kibanaUrl: "",
		kibanaSpace: "",
		hasActionableDrift: false,
		totals: {
			projectsChecked: 0,
			monitorsInSource: 0,
			monitorsInKibana: 0,
			missingInKibana: 0,
			extraInKibana: 0,
			changed: 0,
		},
		drift: [],
		reconcilePlan: { pushToKibana: { command: "", monitors: [] }, addToSource: { action: "", monitors: [] } },
		generatedAt: new Date().toISOString(),
		planError: true,
		planErrorReason: reason,
	};
}

// Emit the enriched report once (forwarded by the SSE pump to the synthetics drift card).
async function emitSyntheticsReport(report: SyntheticsDriftReport): Promise<void> {
	await dispatchCustomEvent("synthetics_drift_report", {
		deployment: report.deployment,
		kibanaUrl: report.kibanaUrl,
		kibanaSpace: report.kibanaSpace,
		hasActionableDrift: report.hasActionableDrift,
		planError: report.planError ?? false,
		...(report.planErrorReason && { planErrorReason: report.planErrorReason }),
		totals: report.totals,
		drift: report.drift,
		reconcilePlan: report.reconcilePlan,
	});
}

// Detect synthetics drift for one deployment: resolve deployment (interrupt if needed), trigger
// the SYNTH_DRIFT_CHECK pipeline, poll, parse, emit the report. The explanation is folded in
// (the report is already grounded + category-grouped, so no separate explain node).
export async function detectSyntheticsDrift(state: IacStateType): Promise<Partial<IacStateType>> {
	let deployment = await resolveDriftDeployment(state);
	if (!deployment) {
		const answer = interrupt({
			type: "iac_clarify",
			question: "Which deployment's synthetics should I check for drift? (e.g. eu-b2b)",
			message: "Which deployment's synthetics should I check for drift? (e.g. eu-b2b)",
		}) as { answer?: string };
		deployment = (answer?.answer ?? "").trim();
	}
	if (!deployment) {
		return {
			messages: [
				new AIMessage('I need a deployment name to check synthetics drift. Try: "check synthetics drift for eu-b2b".'),
			],
		};
	}

	log.info({ deployment }, "iac synthetics drift: triggering synthetics drift-check");
	const trig = parseTriggerResult(await callTool("gitlab_trigger_synthetics_drift_check", { deployment }));
	if (trig.pipelineId === null) {
		const reason =
			trig.status === "locked"
				? "A synthetics pipeline is already running; re-check once it clears."
				: `Could not trigger the synthetics drift-check${trig.note ? `: ${trig.note}` : "."}`;
		log.warn(
			{ deployment, status: trig.status, note: trig.note },
			"iac synthetics drift: trigger did not start (planError)",
		);
		await dispatchCustomEvent("iac_pipeline_progress", {
			pipelineId: null,
			status: `synthetics: ${trig.status === "locked" ? "locked" : "trigger failed"}`,
		});
		const report = emptySyntheticsReport(deployment, reason);
		await emitSyntheticsReport(report);
		return { targetDeployment: deployment, syntheticsDriftReport: report };
	}

	log.info({ deployment, pipelineId: trig.pipelineId }, "iac synthetics drift: pipeline triggered; polling");
	const result = parseDriftCheckResult(
		await callTool("gitlab_get_synthetics_drift_result", { pipelineId: trig.pipelineId }),
	);
	if (result.status !== "success" || !result.report) {
		const reason =
			result.status === "failed" || result.status === "canceled"
				? `Synthetics drift-check pipeline ${result.status}. ${classifyPipelineFailure(result.failureLog, result.stateLocked)}`
				: result.status !== "success"
					? "Synthetics drift-check did not finish within the poll budget; use Re-check to retry."
					: "The synthetics drift-check produced no report.";
		log.warn(
			{ deployment, pipelineId: trig.pipelineId, status: result.status, hasReport: Boolean(result.report) },
			"iac synthetics drift: not authoritative (planError)",
		);
		await dispatchCustomEvent("iac_pipeline_progress", {
			pipelineId: trig.pipelineId,
			status: `synthetics: ${result.status !== "success" ? `check ${result.status}` : "no report"}`,
		});
		const report = emptySyntheticsReport(deployment, reason);
		await emitSyntheticsReport(report);
		return { targetDeployment: deployment, syntheticsDriftReport: report };
	}

	const parsed = parseSyntheticsDriftReport(result.report);
	if (parsed === null) {
		log.warn({ deployment, pipelineId: trig.pipelineId }, "iac synthetics drift: unreadable report (planError)");
		const report = emptySyntheticsReport(deployment, "The synthetics drift-check report could not be parsed.");
		await emitSyntheticsReport(report);
		return { targetDeployment: deployment, syntheticsDriftReport: report };
	}

	const report: SyntheticsDriftReport = { ...parsed, deployment, generatedAt: new Date().toISOString() };
	const driftedCount = report.totals.changed + report.totals.missingInKibana + report.totals.extraInKibana;
	log.info(
		{ deployment, pipelineId: trig.pipelineId, drifted: report.hasActionableDrift, totals: report.totals },
		"iac synthetics drift: assessed",
	);
	await dispatchCustomEvent("iac_pipeline_progress", {
		pipelineId: trig.pipelineId,
		status: `synthetics: ${report.hasActionableDrift ? `${driftedCount} drifted monitor(s)` : "in sync"}`,
	});
	await emitSyntheticsReport(report);
	return { targetDeployment: deployment, syntheticsDriftReport: report };
}

// The single operator approve/decline interrupt for the deployment (no per-stack loop). Only
// reached when hasPushableSyntheticsDrift is true (graph edge enforces). Surfaces the pushable
// set and the surface-only extras. Resume payload {approve: boolean}.
export function syntheticsPushGate(state: IacStateType): Partial<IacStateType> {
	const report = state.syntheticsDriftReport;
	if (!report) return { syntheticsPushApproved: false };
	const pushable = pushableMonitors(report);
	const scope = pushProjectScope(report);
	const extra = report.drift.filter((m) => m.category === "extra_in_kibana");
	const choice = interrupt({
		type: "synthetics_push_choice",
		deployment: report.deployment,
		kibanaSpace: report.kibanaSpace,
		pushableCount: pushable.length,
		extraCount: extra.length,
		projectScope: scope ?? null,
		command: report.reconcilePlan.pushToKibana.command,
		explanation: explainSyntheticsDrift(report),
		pushMonitors: pushable.slice(0, 50).map((m) => ({ project: m.project, monitorName: m.monitorName })),
		extraMonitors: extra.slice(0, 50).map((m) => ({ project: m.project, monitorName: m.monitorName })),
		message:
			`${report.deployment}: ${pushable.length} monitor(s) will be PUSHED to Kibana ` +
			`(${scope ? `project '${scope}'` : "fleet-wide"}). ` +
			`${extra.length ? `${extra.length} extra Kibana monitor(s) are surface-only and will NOT be deleted. ` : ""}` +
			"Approve the push, or decline. I never delete live monitors.",
	}) as { approve?: boolean };
	return { syntheticsPushApproved: choice?.approve === true };
}

// Emit the push outcome (forwarded by the SSE pump).
async function emitSyntheticsPushResult(r: SyntheticsPushResult): Promise<void> {
	await dispatchCustomEvent("synthetics_push_result", {
		status: r.status,
		pushedCount: r.pushedCount,
		...(r.project && { project: r.project }),
		...(r.pipelineId != null && { pipelineId: r.pipelineId }),
		...(r.pipelineStatus && { pipelineStatus: r.pipelineStatus }),
		...(r.note && { note: r.note }),
	});
}

// Trigger the operator-approved remote push (SYNTH_PUSH) and poll it to terminal. Honours project
// scoping (single project -> PROJECT; mixed -> fleet-wide). extra_in_kibana is never in scope.
export async function pushSynthetics(state: IacStateType): Promise<Partial<IacStateType>> {
	const report = state.syntheticsDriftReport;
	if (!report) return {};
	const pushable = pushableMonitors(report);
	const scope = pushProjectScope(report);

	log.info(
		{ deployment: report.deployment, project: scope, pushable: pushable.length },
		"iac synthetics push: triggering",
	);
	const trig = parseTriggerResult(
		await callTool("gitlab_trigger_synthetics_push", {
			deployment: report.deployment,
			...(scope && { project: scope }),
		}),
	);
	if (trig.pipelineId === null) {
		const note =
			trig.status === "locked"
				? "A synthetics pipeline is already running; re-try the push later."
				: `Could not trigger the push${trig.note ? `: ${trig.note}` : "."}`;
		log.warn({ deployment: report.deployment, status: trig.status, note: trig.note }, "iac synthetics push: blocked");
		const result: SyntheticsPushResult = {
			status: "blocked",
			...(scope && { project: scope }),
			pipelineId: null,
			pushedCount: pushable.length,
			note,
		};
		await emitSyntheticsPushResult(result);
		return { syntheticsPushResult: result };
	}

	log.info(
		{ deployment: report.deployment, pipelineId: trig.pipelineId },
		"iac synthetics push: pipeline triggered; polling",
	);
	const res = parseDriftCheckResult(
		await callTool("gitlab_get_synthetics_push_result", { pipelineId: trig.pipelineId }),
	);
	const result: SyntheticsPushResult =
		res.status === "success"
			? {
					status: "pushed",
					...(scope && { project: scope }),
					pipelineId: trig.pipelineId,
					pipelineStatus: res.status,
					pushedCount: pushable.length,
				}
			: {
					status: "failed",
					...(scope && { project: scope }),
					pipelineId: trig.pipelineId,
					pipelineStatus: res.status,
					pushedCount: pushable.length,
					note:
						res.status === "failed" || res.status === "canceled"
							? `Push pipeline ${res.status}. ${classifyPipelineFailure(res.failureLog, res.stateLocked)}`
							: "Push did not finish within the poll budget; re-check the pipeline in GitLab.",
				};
	log.info(
		{ deployment: report.deployment, pipelineId: trig.pipelineId, status: result.status },
		"iac synthetics push: result",
	);
	await emitSyntheticsPushResult(result);
	return { syntheticsPushResult: result };
}

// Final message for the synthetics flow. Branches: planError, clean (in sync), only-extra
// (nothing to push), pushed, declined, blocked/failed. (Pure; unit-tested.)
export function formatSyntheticsSummary(state: IacStateType): string {
	const report = state.syntheticsDriftReport;
	const dep = state.targetDeployment || "(unknown)";
	if (!report) return `Could not check synthetics drift for ${dep}.`;
	if (report.planError) {
		return `Synthetics drift-check for ${dep} could not be completed: ${report.planErrorReason ?? "unknown error"}`;
	}
	if (!report.hasActionableDrift) {
		return (
			`No synthetics drift for ${dep}: source and Kibana are in sync ` +
			`(${report.totals.monitorsInSource} monitor(s) checked across ${report.totals.projectsChecked} project(s)). ` +
			"Note: browser (journey) monitors are not covered by this check."
		);
	}
	const pushable = pushableMonitors(report);
	const explanation = explainSyntheticsDrift(report);
	const result = state.syntheticsPushResult;
	// Only extra_in_kibana -> the push gate was never reached.
	if (pushable.length === 0) {
		return (
			`${explanation}\n\n` +
			"Nothing to push (only extra-in-Kibana monitors, which are surface-only). " +
			"Add them to source or remove them in Kibana manually."
		);
	}
	if (!result || result.status === "skipped") {
		return `${explanation}\n\nPush declined. No monitors were pushed. ${pushable.length} drifted monitor(s) remain.`;
	}
	const scopeText = result.project ? `project '${result.project}'` : "fleet-wide";
	const extraReminder =
		report.totals.extraInKibana > 0
			? ` ${report.totals.extraInKibana} extra Kibana monitor(s) were left untouched (surface-only).`
			: "";
	if (result.status === "pushed") {
		const pid = result.pipelineId ? ` Pipeline #${result.pipelineId}: ${result.pipelineStatus ?? "success"}.` : "";
		return `Pushed ${result.pushedCount} monitor(s) to Kibana (${scopeText}).${pid}${extraReminder}`;
	}
	// blocked | failed
	return `Synthetics push ${result.status}: ${result.note ?? "see logs"}.${extraReminder}`;
}

// ============================================================================
// SIO-913: Fleet agent BINARY upgrade sub-flow (preview -> operator gate -> apply).
// Imperative POST /api/fleet/agents/bulk_upgrade, NOT Terraform. Mirrors the synthetics
// push sub-flow: a preview CI pipeline resolves the agent count + upgradeable crosstab,
// the operator approves, an apply CI pipeline issues the bulk_upgrade + verify sweep.
// Contract: fleet-upgrade-report/v1 (experiments/HANDOFF-2026-06-16-SIO-913-...md).
// ============================================================================

// Parse the fleet-upgrade-report.json artifact (snake_case -> camelCase). Tolerant: a
// malformed/empty body returns null (caller emits a planError stub). (Pure; unit-tested.)
export function parseFleetUpgradeReport(raw: string): FleetUpgradeReport | null {
	try {
		const o = JSON.parse(raw) as Record<string, unknown>;
		if (typeof o !== "object" || o === null) return null;
		const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		const str = (v: unknown): string => (typeof v === "string" ? v : "");
		const xt = (o.upgradeable_crosstab ?? {}) as Record<string, unknown>;
		const byReason = Array.isArray(xt.by_reason)
			? (xt.by_reason as Array<Record<string, unknown>>)
					.map((r) => ({ reason: str(r.reason), count: num(r.count) }))
					.filter((r) => r.reason)
			: [];
		// SIO-935: optional version partition. Absent in old v1 reports -> undefined (never a false
		// all-zero block, which would read as "everything already on target").
		const vc = o.version_crosstab;
		const versionCrosstab =
			vc && typeof vc === "object"
				? {
						alreadyOnTarget: num((vc as Record<string, unknown>).already_on_target),
						outdated: num((vc as Record<string, unknown>).outdated),
						versionUnknown: num((vc as Record<string, unknown>).version_unknown),
						upgradeableOutdated: num((vc as Record<string, unknown>).upgradeable_outdated),
					}
				: undefined;
		return {
			deployment: str(o.deployment),
			targetVersion: str(o.target_version),
			rolloutSeconds: num(o.rollout_seconds),
			selector: str(o.selector),
			resolvedCount: num(o.resolved_count),
			versionAvailable: o.version_available === true,
			maxAgents: num(o.max_agents),
			crosstab: {
				upgradeable: num(xt.upgradeable),
				notUpgradeable: num(xt.not_upgradeable),
				byReason,
			},
			...(versionCrosstab && { versionCrosstab }),
			generatedAt: str(o.generated_at),
		};
	} catch {
		return null;
	}
}

// Graph-edge predicate: is there an applicable Fleet upgrade worth the apply gate? True only
// when the preview was assessed (no planError), the target version is available, and >=1 agent
// is upgradeable. resolvedCount==0 or notUpgradeable-only -> false (nothing to apply). (Pure.)
export function hasApplicableFleetUpgrade(report: FleetUpgradeReport | null): boolean {
	if (!report || report.planError) return false;
	if (!report.versionAvailable) return false;
	return report.crosstab.upgradeable > 0;
}

// A zeroed preview report carrying a planError (mirror SyntheticsDriftReport.planError): the
// preview was NOT assessed -- never a false "0 agents".
function emptyFleetReport(deployment: string, version: string, reason: string): FleetUpgradeReport {
	return {
		deployment,
		targetVersion: version,
		rolloutSeconds: 0,
		selector: "",
		resolvedCount: 0,
		versionAvailable: false,
		maxAgents: 0,
		crosstab: { upgradeable: 0, notUpgradeable: 0, byReason: [] },
		generatedAt: new Date().toISOString(),
		planError: true,
		planErrorReason: reason,
	};
}

async function emitFleetReport(report: FleetUpgradeReport): Promise<void> {
	await dispatchCustomEvent("fleet_upgrade_preview_report", {
		deployment: report.deployment,
		targetVersion: report.targetVersion,
		resolvedCount: report.resolvedCount,
		versionAvailable: report.versionAvailable,
		rolloutSeconds: report.rolloutSeconds,
		crosstab: report.crosstab,
		...(report.versionCrosstab && { versionCrosstab: report.versionCrosstab }), // SIO-935
		planError: report.planError ?? false,
		...(report.planErrorReason && { planErrorReason: report.planErrorReason }),
	});
}

async function emitFleetResult(r: FleetUpgradeResult): Promise<void> {
	await dispatchCustomEvent("fleet_upgrade_apply_result", {
		status: r.status,
		...(r.actionId && { actionId: r.actionId }),
		...(r.pollStatus && { pollStatus: r.pollStatus }),
		...(r.acked != null && { acked: r.acked }),
		...(r.created != null && { created: r.created }),
		...(r.failedSilent != null && { failedSilent: r.failedSilent }),
		...(r.pipelineId != null && { pipelineId: r.pipelineId }),
		...(r.pipelineUrl && { pipelineUrl: r.pipelineUrl }),
		...(r.note && { note: r.note }),
	});
}

// Detect the Fleet upgrade scope for one deployment: resolve deployment + target version
// (interrupt if missing), trigger the FLEET_UPGRADE_PREVIEW pipeline, poll, parse, emit the
// preview report. Read-only -- no bulk_upgrade POST happens here.
// SIO-971: render recalled fleet-upgrade facts as a markdown bullet list for the gate card.
// "" for no hits (the UI block stays hidden). Local to the fleet path to avoid a circular
// import with graph-knowledge.ts (which already imports from this module); mirrors that file's
// renderLearnings shape but tags on version/outcome (fleet facts have no workflow key).
function renderFleetLearnings(hits: MemorySearchHit[]): string {
	if (hits.length === 0) return "";
	// SIO-973: a re-recorded terminal upgrade (same pipeline_id) returns as multiple hits; collapse
	// to one bullet per pipeline so the gate card doesn't show the same upgrade twice.
	return dedupeHitsBy(hits, (h) => h.annotations.pipeline_id)
		.map((h) => {
			const a = h.annotations;
			// SIO-1005: tag via lifecycleTag for wording consistency. Fleet facts carry no `lifecycle` and
			// their outcome is applied/partial/failed (never the misleading "completed"), so this is a
			// passthrough today; it keeps every recall renderer on one tag helper.
			const tags = [a.version, lifecycleTag(a), a.pipeline_id && `pipeline ${a.pipeline_id}`].filter(Boolean).join(" ");
			return tags ? `- ${h.text} [${tags}]` : `- ${h.text}`;
		})
		.join("\n");
}

// SIO-971: deployment-scoped recall of prior TERMINAL fleet upgrades for the gate card -- the
// fleet-path twin of memoryEnrichIac (SIO-970). Filters on the SAME keys the fleet write stamps
// (buildFleetFactAnnotations -> kind:"fleet-upgrade-terminal", deployment). Soft-fails to "" so a
// memory outage never blocks the preview. Distinct from recallInFlightFleetUpgrades, which reads
// the DISPATCHED (in-flight) facts to resume a running pipeline.
// SIO-971: exported for unit testing (the full detectFleetUpgrade needs gitlab preview mocks).
// SIO-998: `version` is retained in the signature (callers pass the target version) but no longer
// shapes the query -- this is a deterministic filter-only recall of ALL terminal fleet upgrades on the
// deployment (renderFleetLearnings wants the full history, not version-ranked hits).
export async function recallPriorFleetUpgrades(deployment: string, _version: string): Promise<string> {
	if (selectedBackend() !== "agent-memory" || !deployment) return "";
	try {
		// SIO-998: keyed by deployment + kind -> deterministic filter-only retrieval.
		const hits = await searchAgentMemory("elastic-iac", "", { deployment, kind: "fleet-upgrade-terminal" }, 8, {
			deterministic: true,
		});
		return renderFleetLearnings(hits);
	} catch (error) {
		log.warn(
			{ error: error instanceof Error ? error.message : String(error), deployment },
			"iac fleet upgrade: prior-upgrade recall failed; continuing without it",
		);
		return "";
	}
}

// SIO-1032: raw-text scoping parsers for the fleet-upgrade flow. The fleet-upgrade INTENT routes
// straight to detectFleetUpgrade and never runs parseIntent, so deployment/version (and now the host
// scope) are parsed from the message text here, deterministically -- same idiom as parseTargetVersion.

// A pasted Fleet KQL selector wins over a host list. Recognizes an explicit `SELECTOR=<kql>` /
// `selector: <kql>` / `kuery: <kql>` prefix, else a bare `local_metadata...:(...)` clause. Returns the
// trimmed query (quotes preserved) or undefined. Pure.
export function parseFleetRawSelector(text: string): string | undefined {
	const prefixed = text.match(/\b(?:selector|kuery|kql)\s*[:=]\s*(.+)$/im);
	if (prefixed?.[1]) {
		const q = prefixed[1]
			.trim()
			.replace(/^["'`]|["'`]$/g, "")
			.trim();
		if (/local_metadata|host\.hostname|agent\.id/i.test(q)) return q;
	}
	// A bare KQL clause the user pasted inline (up to the matching close paren).
	const bare = text.match(/local_metadata[^\n]*?:\s*\([^)]*\)/i);
	return bare ? bare[0].trim() : undefined;
}

// The user's "must resolve to exactly N agents" guard. Matches "resolve to (exactly) N", "exactly N
// agents", "must be N hosts/agents". Returns the integer or undefined. Pure.
export function parseExpectedAgentCount(text: string): number | undefined {
	const m =
		text.match(/\bresolve[sd]?\s+to\s+(?:exactly\s+|precisely\s+)?(\d+)\b/i) ||
		text.match(/\b(?:exactly|precisely)\s+(\d+)\s+(?:agent|host)s?\b/i) ||
		text.match(/\bmust\s+(?:be|resolve\s+to)\s+(\d+)\s+(?:agent|host)s?\b/i);
	if (!m?.[1]) return undefined;
	const n = Number.parseInt(m[1], 10);
	return Number.isFinite(n) ? n : undefined;
}

// A named host list the user scoped the upgrade to. Recognizes an explicit "(only/scope to/these)
// hosts/agents: h1, h2, ..." label, else a bare colon-introduced comma-run (the reported prompt form:
// "...to 9.4.2: eu1w2022amp40, hwv00061, ..."). The list is comma-separated; each element's LEADING
// token is the host, and collection STOPS at the first element whose leading token is not host-shaped
// (that is where the sentence resumes -- e.g. "...EU2DB01D. Scope the selector..."). A host token has
// >=2 chars, starts with a letter, is letters/digits/dot/underscore/hyphen, and is NOT a bare version.
// De-dupes case-insensitively (first-seen casing wins), preserves order. Pure.
export function parseFleetHostList(text: string): string[] {
	// The captured segment starts after a "hosts:/agents:" label or a bare colon and runs to the end of
	// the line (the list may wrap, but the reported form is single-line). Prefer the labelled form.
	const labelled = text.match(/\b(?:hosts?|agents?)\s*:\s*([^\n]+)/i);
	const colonRun = text.match(/:\s*([A-Za-z][\w.-]*\s*,\s*[^\n]+)/);
	const segment = (labelled?.[1] ?? colonRun?.[1] ?? "").trim();
	if (!segment) return [];
	const isVersion = (t: string) => /^\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?$/.test(t);
	const isHost = (t: string) => t.length >= 2 && /^[A-Za-z][\w.-]*$/.test(t) && !isVersion(t);
	const seen = new Set<string>();
	const hosts: string[] = [];
	for (const element of segment.split(",")) {
		// take the element's leading whitespace-delimited token, trimming trailing punctuation.
		const tok = (element.trim().split(/\s+/)[0] ?? "").replace(/[.,;:]+$/, "");
		// A non-host leading token means the comma-list ended and prose resumed -> stop.
		if (!isHost(tok)) break;
		const key = tok.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		hosts.push(tok);
	}
	return hosts;
}

// SIO-1032: build the Fleet KQL from a named host list, ANDed with upgradeable:true so a scoped
// upgrade never picks up a non-upgradeable (Wolfi/container) agent. Mirrors the repo
// `task fleet:bulk-upgrade-preview SELECTOR=...` form. Quotes each hostname; empty/whitespace-only
// entries are dropped, and an empty list yields undefined (unscoped -> all outdated agents). Pure.
export function buildFleetHostSelector(hostnames?: string[]): string | undefined {
	const hosts = (hostnames ?? []).map((h) => h.trim()).filter(Boolean);
	if (hosts.length === 0) return undefined;
	const clause = hosts.map((h) => `"${h}"`).join(" or ");
	return `local_metadata.elastic.agent.upgradeable:true and local_metadata.host.hostname:(${clause})`;
}

export async function detectFleetUpgrade(state: IacStateType): Promise<Partial<IacStateType>> {
	// SIO-923: prefer the deployment the planner already parsed (state.iacRequest.cluster) over
	// re-deriving it from the raw text. resolveDriftDeployment matches the WHOLE user message against
	// a live elastic_cloud_list_deployments call -- which spuriously clarifies a named deployment when
	// the message isn't an exact name and depends on a live MCP round-trip. This mirrors how `version`
	// already prefers state.iacRequest?.version. resolveDriftDeployment stays the fallback for the
	// drift/synthetics flows (and the fresh-turn case with no parsed cluster).
	let deployment = state.iacRequest?.cluster?.trim() || (await resolveDriftDeployment(state));
	if (!deployment) {
		const answer = interrupt({
			type: "iac_clarify",
			question: "Which deployment's Fleet agents should I upgrade? (e.g. eu-b2b)",
			message: "Which deployment's Fleet agents should I upgrade? (e.g. eu-b2b)",
		}) as { answer?: string };
		deployment = (answer?.answer ?? "").trim();
	}
	const version = parseTargetVersion(lastHumanText(state), state.iacRequest?.version);
	if (!deployment || !version) {
		return {
			messages: [
				new AIMessage(
					'I need a deployment and a target version to upgrade Fleet agents. Try: "upgrade Fleet agents on eu-b2b to 9.4.2".',
				),
			],
		};
	}

	// SIO-1032: scope the preview to the user's host set, parsed from the message text (fleet-upgrade
	// skips parseIntent, so we parse here like deployment/version). A raw KQL selector wins over a named
	// host list; state.iacRequest is a fallback for any future path that DOES run parseIntent. Absent
	// both -> undefined (CI resolves all outdated agents, the prior behavior).
	const fleetText = lastHumanText(state);
	const rawSelector = state.iacRequest?.fleetSelector?.trim() || parseFleetRawSelector(fleetText);
	const hostList =
		state.iacRequest?.selectedHostnames && state.iacRequest.selectedHostnames.length > 0
			? state.iacRequest.selectedHostnames
			: parseFleetHostList(fleetText);
	const requestedSelector = rawSelector || buildFleetHostSelector(hostList);
	const expectedAgentCount = state.iacRequest?.expectedAgentCount ?? parseExpectedAgentCount(fleetText);
	log.info(
		{ deployment, version, hasSelector: Boolean(requestedSelector), expectedAgentCount },
		"iac fleet upgrade: triggering preview",
	);
	const trig = parseTriggerResult(
		await callTool("gitlab_trigger_fleet_upgrade_preview", {
			deployment,
			version,
			...(requestedSelector && { selector: requestedSelector }),
		}),
	);
	if (trig.pipelineId === null) {
		const reason =
			trig.status === "locked"
				? "A fleet-upgrade pipeline is already running; re-check once it clears."
				: `Could not trigger the fleet-upgrade preview${trig.note ? `: ${trig.note}` : "."}`;
		log.warn({ deployment, status: trig.status, note: trig.note }, "iac fleet upgrade: preview trigger did not start");
		await dispatchCustomEvent("iac_pipeline_progress", {
			pipelineId: null,
			status: `fleet: ${trig.status === "locked" ? "locked" : "trigger failed"}`,
		});
		const report = emptyFleetReport(deployment, version, reason);
		await emitFleetReport(report);
		return { targetDeployment: deployment, fleetUpgradeReport: report };
	}

	log.info({ deployment, pipelineId: trig.pipelineId }, "iac fleet upgrade: preview triggered; polling");
	const result = parseDriftCheckResult(
		await callTool("gitlab_get_fleet_upgrade_preview_result", { pipelineId: trig.pipelineId }),
	);
	if (result.status !== "success" || !result.report) {
		const reason =
			result.status === "failed" || result.status === "canceled"
				? `Fleet-upgrade preview pipeline ${result.status}. ${classifyPipelineFailure(result.failureLog, result.stateLocked)}`
				: result.status !== "success"
					? "Fleet-upgrade preview did not finish within the poll budget; retry."
					: "The fleet-upgrade preview produced no report.";
		log.warn(
			{ deployment, pipelineId: trig.pipelineId, status: result.status, hasReport: Boolean(result.report) },
			"iac fleet upgrade: preview not authoritative (planError)",
		);
		const report = emptyFleetReport(deployment, version, reason);
		await emitFleetReport(report);
		return { targetDeployment: deployment, fleetUpgradeReport: report };
	}

	const parsed = parseFleetUpgradeReport(result.report);
	if (parsed === null) {
		log.warn({ deployment, pipelineId: trig.pipelineId }, "iac fleet upgrade: unreadable preview report (planError)");
		const report = emptyFleetReport(deployment, version, "The fleet-upgrade preview report could not be parsed.");
		await emitFleetReport(report);
		return { targetDeployment: deployment, fleetUpgradeReport: report };
	}

	// SIO-971: recall prior terminal fleet upgrades for this deployment (best-effort) and fold them
	// onto the report so the gate card surfaces "we've upgraded this deployment before".
	const priorUpgrades = await recallPriorFleetUpgrades(deployment, version);
	const report: FleetUpgradeReport = {
		...parsed,
		generatedAt: parsed.generatedAt || new Date().toISOString(),
		// SIO-1032: keep the agent-sent selector + expected-count guard on the report so the gate can
		// warn on a count mismatch and applyFleetUpgrade can resend the SAME selector (stay scoped).
		...(requestedSelector && { requestedSelector }),
		...(expectedAgentCount != null && { expectedAgentCount }),
		...(priorUpgrades && { priorUpgrades }),
	};
	log.info(
		{
			deployment,
			pipelineId: trig.pipelineId,
			resolved: report.resolvedCount,
			upgradeable: report.crosstab.upgradeable,
			versionAvailable: report.versionAvailable,
			hasPriorUpgrades: Boolean(priorUpgrades),
		},
		"iac fleet upgrade: preview assessed",
	);
	await dispatchCustomEvent("iac_pipeline_progress", {
		pipelineId: trig.pipelineId,
		status: `fleet: ${report.crosstab.upgradeable} upgradeable / ${report.resolvedCount} resolved`,
	});
	await emitFleetReport(report);
	return { targetDeployment: deployment, fleetUpgradeReport: report };
}

// The single operator approve/decline interrupt. Only reached when hasApplicableFleetUpgrade
// is true (graph edge enforces). Surfaces the resolved/upgradeable counts + the not-upgradeable
// (Wolfi/container) agents that will be SKIPPED. Resume payload {approve: boolean}.
// The fleet-upgrade gate card's headline count, scaled rollout window, and prose. Pure + unit-
// tested (the gate itself throws a GraphInterrupt that can't be introspected outside a graph run).
// willUpgrade = the upgradeable-AND-outdated set when the version partition (SIO-935) is present,
// else the raw upgradeable; rollout = SIO-936 dynamic window from that count.
export function buildFleetGateMessage(report: FleetUpgradeReport): {
	willUpgrade: number;
	rollout: number;
	message: string;
} {
	const { upgradeable, notUpgradeable } = report.crosstab;
	const vc = report.versionCrosstab;
	const willUpgrade = vc ? vc.upgradeableOutdated : upgradeable;
	const skipNote =
		notUpgradeable > 0
			? `${notUpgradeable} agent(s) are NOT Fleet-upgradeable (Wolfi/container; upgradeable:false) and will be SKIPPED -- bump their image tag upstream instead. `
			: "";
	const alreadyNote =
		vc && vc.alreadyOnTarget > 0 ? `${vc.alreadyOnTarget} are already on ${report.targetVersion} (no action). ` : "";
	// SIO-936: stagger window scales with the agents this flow actually moves (not the script's
	// fixed 3600s default), so the card no longer reads "4 agents over 3600s".
	const rollout = dynamicRolloutSeconds(willUpgrade);
	// SIO-1032: if the user stated an expected count ('must resolve to exactly N') and the selector
	// resolved to a different number, lead the card with a WARNING. The operator may still approve --
	// the apply stays scoped to the requested selector, so approving upgrades only the matched set.
	const countWarning =
		report.expectedAgentCount != null && report.expectedAgentCount !== report.resolvedCount
			? `WARNING: you asked for exactly ${report.expectedAgentCount} agent(s) but the selector resolved to ` +
				`${report.resolvedCount}. Review the host list before approving -- approving upgrades only the ` +
				`${willUpgrade} scoped, upgradeable agent(s) your selector matched. `
			: "";
	const message =
		countWarning +
		`${report.deployment}: ${willUpgrade} Fleet agent(s) will be upgraded to ${report.targetVersion} ` +
		`over ${rollout}s. ${alreadyNote}${skipNote}` +
		"This is an imperative bulk_upgrade (not Terraform). Approve to run it via CI, or decline.";
	return { willUpgrade, rollout, message };
}

export function fleetUpgradeGate(state: IacStateType): Partial<IacStateType> {
	const report = state.fleetUpgradeReport;
	if (!report) return { fleetUpgradeApproved: false };
	const { upgradeable, notUpgradeable } = report.crosstab;
	const vc = report.versionCrosstab;
	const { rollout, message } = buildFleetGateMessage(report);
	const choice = interrupt({
		type: "fleet_upgrade_choice",
		deployment: report.deployment,
		targetVersion: report.targetVersion,
		resolvedCount: report.resolvedCount,
		upgradeableCount: upgradeable,
		notUpgradeableCount: notUpgradeable,
		rolloutSeconds: rollout,
		byReason: report.crosstab.byReason,
		...(vc && { versionCrosstab: vc }), // SIO-935
		...(report.priorUpgrades && { priorUpgrades: report.priorUpgrades }), // SIO-971
		message,
	}) as { approve?: boolean };
	return { fleetUpgradeApproved: choice?.approve === true };
}

// Trigger the operator-approved apply (FLEET_UPGRADE_APPLY) with the SAME deployment/version
// that were previewed, poll to terminal, and parse the apply outcome (incl. the verify-sweep
// failed_silent ground truth). The apply job runs bulk_upgrade + the verify sweep in CI.
export async function applyFleetUpgrade(state: IacStateType): Promise<Partial<IacStateType>> {
	const report = state.fleetUpgradeReport;
	if (!report) return {};
	const { deployment, targetVersion } = report;
	// SIO-936: send the agent-count-scaled stagger window to the bulk_upgrade (the MCP tool forwards
	// it to ROLLOUT_SECONDS -> the script's rollout_duration_seconds). Same formula the gate showed.
	const willUpgrade = report.versionCrosstab?.upgradeableOutdated ?? report.crosstab.upgradeable;
	const rollout = dynamicRolloutSeconds(willUpgrade);

	// SIO-927: the apply CI script refuses when resolved_count exceeds its blast-radius cap (default
	// 500). The operator has already approved THIS report's resolved set at fleetUpgradeGate, so pass
	// resolvedCount as MAX_AGENTS -- approval == accepting the full blast radius. Preview stays uncapped
	// (we never send MAX_AGENTS on the preview trigger). Fleet's separate 10000 hard cap still applies.
	log.info(
		{ deployment, version: targetVersion, maxAgents: report.resolvedCount, rolloutSeconds: rollout },
		"iac fleet upgrade: triggering apply",
	);
	const trig = parseTriggerResult(
		await callTool("gitlab_trigger_fleet_upgrade_apply", {
			deployment,
			version: targetVersion,
			// SIO-1032: resend the SAME selector the preview used, so an operator who approves past a
			// count-mismatch warning still upgrades ONLY the scoped set -- never a silent fleet-wide apply.
			...(report.requestedSelector && { selector: report.requestedSelector }),
			maxAgents: report.resolvedCount,
			rolloutSeconds: rollout,
		}),
	);
	if (trig.pipelineId === null) {
		const note =
			trig.status === "locked"
				? "A fleet-upgrade pipeline is already running; re-try the apply later."
				: `Could not trigger the apply${trig.note ? `: ${trig.note}` : "."}`;
		log.warn({ deployment, status: trig.status, note: trig.note }, "iac fleet upgrade: apply blocked");
		const result: FleetUpgradeResult = { status: "blocked", pipelineId: null, note };
		await emitFleetResult(result);
		return { fleetUpgradeResult: result };
	}

	log.info({ deployment, pipelineId: trig.pipelineId }, "iac fleet upgrade: apply triggered; polling");

	// SIO-926: tell the user up front that the upgrade started and how long it is expected to take
	// (from the rollout window), so the expectation is set before we ever return a `dispatched`
	// outcome -- a long rollout is normal, not a hang.
	await dispatchCustomEvent("iac_pipeline_progress", {
		pipelineId: trig.pipelineId,
		status:
			`fleet apply: started -- ${willUpgrade} agent(s) -> ${targetVersion}, ` +
			`expected ${formatRolloutDuration(rollout)}`,
	});

	// SIO-924: stream live apply progress like watchPipeline, so the user can TRACK the imperative
	// bulk_upgrade instead of staring at a frozen card for ~2 min. Surface the pipeline id + a
	// clickable GitLab link up front, then emit iac_pipeline_progress on each status transition.
	// gitlab_get_fleet_upgrade_apply_result blocks server-side until terminal, so the ticker comes
	// from polling gitlab_get_pipeline (single-shot status read) BEFORE we fetch the artifact.
	let pipelineUrl = "";
	{
		const first = parseSinglePipeline(await callTool("gitlab_get_pipeline", { pipelineId: trig.pipelineId }));
		pipelineUrl = first?.webUrl ?? "";
		let lastStatus = first?.status ?? "running";
		await dispatchCustomEvent("iac_pipeline_progress", {
			pipelineId: trig.pipelineId,
			status: `fleet apply: ${lastStatus}`,
			...(pipelineUrl && { url: pipelineUrl }),
		});
		const budgetMs = Number(process.env.IAC_PIPELINE_POLL_BUDGET_MS ?? "90000");
		const intervalMs = Number(process.env.IAC_PIPELINE_POLL_INTERVAL_MS ?? "10000");
		const deadline = Date.now() + budgetMs;
		while (!isTerminalPipelineStatus(lastStatus) && Date.now() < deadline) {
			if (Date.now() + intervalMs >= deadline) break;
			await new Promise((r) => setTimeout(r, intervalMs));
			const cur = parseSinglePipeline(await callTool("gitlab_get_pipeline", { pipelineId: trig.pipelineId }));
			if (cur && cur.status !== lastStatus) {
				lastStatus = cur.status;
				if (!pipelineUrl && cur.webUrl) pipelineUrl = cur.webUrl;
				log.info({ deployment, pipelineId: trig.pipelineId, status: lastStatus }, "iac fleet apply: pipeline status");
				await dispatchCustomEvent("iac_pipeline_progress", {
					pipelineId: trig.pipelineId,
					status: `fleet apply: ${lastStatus}`,
					...(pipelineUrl && { url: pipelineUrl }),
				});
			}
		}
	}

	const res = parseDriftCheckResult(
		await callTool("gitlab_get_fleet_upgrade_apply_result", { pipelineId: trig.pipelineId }),
	);
	const outcome = res.report ? parseFleetApplyOutcome(res.report) : null;
	// Fields common to every outcome (pipeline identity + the verify-sweep counts if the report
	// was fetched). SIO-926: three outcomes, not two -- success => applied; a real failed/canceled
	// pipeline => failed; anything else (running/non-terminal at the status window) => dispatched
	// (started, still in flight), NOT failed.
	const common = {
		pipelineId: trig.pipelineId,
		pipelineStatus: res.status,
		...(pipelineUrl && { pipelineUrl }),
		...(outcome && {
			actionId: outcome.actionId,
			pollStatus: outcome.pollStatus,
			acked: outcome.acked,
			created: outcome.created,
			failedSilent: outcome.failedSilent,
			// SIO-961: carry the full breakdown so the summary + durable fact are honest.
			succeeded: outcome.succeeded,
			failed: outcome.failed,
			rolledBack: outcome.rolledBack,
			unsettled: outcome.unsettled,
			failedAgents: outcome.failedAgents,
		}),
	};
	let result: FleetUpgradeResult;
	if (res.status === "success" || res.status === "failed" || res.status === "canceled") {
		// SIO-961/SIO-975: terminal CI status. classifyFleetApplyResult is the single source of
		// truth (shared with the SIO-926 follow-up re-poll): a failed/canceled job that actioned
		// agents (created>0) with agent-side failures is PARTIAL, not failed; a true infra failure
		// names the report's error_reason or the state-lock/generic classifier.
		const classified = classifyFleetApplyResult(res.status, outcome, res.failureLog, res.stateLocked);
		result = { status: classified.status, ...common, ...(classified.note && { note: classified.note }) };
	} else {
		// Running past the status window: the bulk_upgrade is in flight (a long rollout we chose not
		// to block on). Report it as dispatched with the expected duration + the pipeline to track.
		// SIO-1023: use the agent-count-scaled rollout we actually sent to CI (same as the up-front
		// "expected ~N min" step), not the preview artifact's fixed report.rolloutSeconds.
		const eta = rollout > 0 ? ` Expected ${formatRolloutDuration(rollout)}.` : "";
		result = {
			status: "dispatched",
			...common,
			note: `Upgrade started and running (status ${res.status || "running"}).${eta} Not finished within the status window; ask me to check on it or watch the pipeline.`,
		};
	}
	// SIO-958: name the poll outcome so a reader never mistakes "still running at the
	// status window" (dispatched -> in flight, healthy) for a pipeline failure. The
	// raw pipelineStatus alone (e.g. "error"/"running" from an unparseable in-flight
	// artifact) was misread as a failed deployment; pollOutcome disambiguates.
	const pollOutcome =
		result.status === "applied"
			? "terminal_success"
			: result.status === "failed"
				? "pipeline_failed"
				: "running_at_budget"; // dispatched: started + still in flight, NOT a failure
	log.info(
		{
			deployment,
			pipelineId: trig.pipelineId,
			status: result.status,
			pipelineStatus: res.status,
			pollOutcome,
			failedSilent: result.failedSilent,
		},
		"iac fleet upgrade: apply result",
	);
	await emitFleetResult(result);
	// SIO-926: persist the apply pipeline id so a follow-up "how's the upgrade going?" re-polls it.
	// Only meaningful while still in flight (dispatched); a terminal apply needs no re-check.
	return {
		fleetUpgradeResult: result,
		...(result.status === "dispatched" && { fleetApplyPipelineId: trig.pipelineId }),
	};
}

// SIO-936: Fleet's rollout_duration_seconds staggers agent restarts to avoid a thundering herd.
// Scale it with the number of agents this flow actually moves: ~30s/agent, clamped to Fleet's
// 600s API minimum (the script rejects anything lower) and a 3600s ceiling. A fixed 3600s for a
// handful of agents reads as a fake hour-long op; too small a window for a large fleet risks a
// mass simultaneous restart -- the clamp gives both ends a sane value. (Pure; unit-tested.)
export function dynamicRolloutSeconds(agentCount: number): number {
	const PER_AGENT = 30;
	const FLOOR = 600;
	const CEIL = 3600;
	if (!Number.isFinite(agentCount) || agentCount <= 0) return FLOOR;
	return Math.min(CEIL, Math.max(FLOOR, Math.round(agentCount * PER_AGENT)));
}

// SIO-926: turn a rollout window (seconds) into a human "expected duration" phrase, used both up
// front at apply time and in the dispatched summary so the user knows how long the bulk_upgrade
// takes. <2h renders in minutes (the common case: a 3600s rollout reads "~60 min"); >=2h in hours.
// Degrades to "a short while" on a missing/zero/negative window so the copy never prints NaN.
export function formatRolloutDuration(rolloutSeconds: number): string {
	if (!Number.isFinite(rolloutSeconds) || rolloutSeconds <= 0) return "a short while";
	const minutes = Math.round(rolloutSeconds / 60);
	if (rolloutSeconds < 7200) return `~${minutes} min`;
	const hours = Math.round((rolloutSeconds / 3600) * 10) / 10;
	return `~${hours} h`;
}

// Final message for the fleet-upgrade flow. Branches: planError, version-unavailable, nothing
// upgradeable, declined, applied (leads with the failed_silent ground truth), dispatched
// (started, still running -- SIO-926), blocked/failed. (Pure; unit-tested.)
export function formatFleetUpgradeSummary(state: IacStateType): string {
	const report = state.fleetUpgradeReport;
	const dep = state.targetDeployment || "(unknown)";
	if (!report) return `Could not assess a Fleet upgrade for ${dep}.`;
	if (report.planError) {
		return `Fleet-upgrade preview for ${dep} could not be completed: ${report.planErrorReason ?? "unknown error"}`;
	}
	const skipNote =
		report.crosstab.notUpgradeable > 0
			? ` ${report.crosstab.notUpgradeable} non-upgradeable agent(s) (Wolfi/container) were left for an upstream image-tag bump.`
			: "";
	// SIO-935: when the version partition is present, state plainly how many were already on the
	// target (bulk_upgrade no-ops them) so the "will upgrade" count is unambiguous. Empty pre-CI.
	const vc = report.versionCrosstab;
	const alreadyNote =
		vc && vc.alreadyOnTarget > 0
			? ` ${vc.alreadyOnTarget} were already on ${report.targetVersion} (no action needed).`
			: "";
	if (!report.versionAvailable) {
		return (
			`Target version ${report.targetVersion} is not in ${dep}'s available_versions list; ` +
			"refusing to upgrade. Confirm the target is a valid forward step."
		);
	}
	if (report.crosstab.upgradeable === 0) {
		return `No Fleet agents on ${dep} are upgradeable to ${report.targetVersion} (resolved ${report.resolvedCount}).${alreadyNote}${skipNote}`;
	}
	const result = state.fleetUpgradeResult;
	if (!result || result.status === "skipped") {
		return (
			`Fleet upgrade declined. No agents were upgraded. ${report.crosstab.upgradeable} agent(s) on ${dep} ` +
			`remain eligible for ${report.targetVersion}.${alreadyNote}${skipNote}`
		);
	}
	if (result.status === "applied") {
		const pid = result.pipelineId
			? result.pipelineUrl
				? ` Apply pipeline [#${result.pipelineId}](${result.pipelineUrl}).`
				: ` Apply pipeline #${result.pipelineId}.`
			: "";
		const silent =
			result.failedSilent && result.failedSilent > 0
				? ` WARNING: ${result.failedSilent} agent(s) reached UPG_FAILED (verify sweep -- Fleet action_status undercounts these). Investigate before declaring success.`
				: " Verify sweep clean (0 UPG_FAILED).";
		const counts = result.created != null ? ` ${result.acked ?? 0}/${result.created} acked.` : "";
		return `Fleet upgrade to ${report.targetVersion} on ${dep} applied (poll ${result.pollStatus ?? "?"}).${counts}${silent}${pid}${alreadyNote}${skipNote}`;
	}
	// SIO-926: dispatched -- the apply STARTED and is still running past the status window. This is
	// not a failure; report it as in-progress, name the expected duration, keep the pipeline link,
	// and offer the follow-up check (a later "how's the upgrade going?" re-polls this pipeline).
	if (result.status === "dispatched") {
		const dPid = result.pipelineId
			? result.pipelineUrl
				? ` Pipeline [#${result.pipelineId}](${result.pipelineUrl}) is running.`
				: ` Pipeline #${result.pipelineId} is running.`
			: "";
		// SIO-1023: derive the ETA from the SAME agent-count-scaled formula applyFleetUpgrade sent to
		// CI (and showed in the "expected ~N min" pipeline-log step), not the preview artifact's
		// report.rolloutSeconds (a fixed ~3600s -> a stale "~60 min" that always overstated the rollout).
		const willUpgrade = report.versionCrosstab?.upgradeableOutdated ?? report.crosstab.upgradeable;
		const effectiveRollout = dynamicRolloutSeconds(willUpgrade);
		return (
			`Fleet upgrade started for ${dep} -- ${willUpgrade} agent(s) upgrading to ` +
			`${report.targetVersion} over ${formatRolloutDuration(effectiveRollout)}.${dPid}${skipNote} ` +
			"I won't block on the full rollout; ask me to check on it or watch the pipeline."
		);
	}
	const bfPid = result.pipelineId
		? result.pipelineUrl
			? ` Apply pipeline [#${result.pipelineId}](${result.pipelineUrl}).`
			: ` Apply pipeline #${result.pipelineId}.`
		: "";
	// SIO-961: a partial apply -- the rollout ran, most agents are pending-offline, a few had
	// agent-side failures. Lead with the in-flight reality (note already does), NOT a red "failed".
	if (result.status === "partial") {
		return `Fleet upgrade to ${report.targetVersion} on ${dep} -- ${result.note ?? "partial outcome; see logs"}${bfPid}${skipNote}`;
	}
	// blocked | failed
	return `Fleet upgrade ${result.status}: ${result.note ?? "see logs"}.${bfPid}${skipNote}`;
}
