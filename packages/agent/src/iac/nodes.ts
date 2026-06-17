// agent/src/iac/nodes.ts

import { createHash } from "node:crypto";
import { buildSystemPrompt } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import { AIMessage, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { createLlm, createLlmWithTools } from "../llm.ts";
import { getConnectedServers, getToolsForDataSource } from "../mcp-bridge.ts";
import { getAgentByName } from "../prompt-context.ts";
import { evaluateGuards } from "./guards.ts";
import type {
	DriftReport,
	FleetUpgradeReport,
	FleetUpgradeResult,
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

const log = getLogger("agent:iac");
const AGENT = "elastic-iac";
const IAC_SERVER = "elastic-iac-mcp";

function lastHumanText(state: IacStateType): string {
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const m = state.messages[i];
		if (m?.getType() === "human") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
	}
	return "";
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

// The planner commonly emits explicit `null` for absent optional fields; z.optional()
// rejects null and would silently fail the whole parse (-> the clarify fallback), so
// every optional field is .nullish() and nulls are normalized to undefined below.
const IntentSchema = z.object({
	workflow: z
		.enum([
			"tier-resize",
			"ilm-rollout",
			"version-upgrade",
			"fleet-integration",
			"slo-edit",
			"alerting-edit",
			"dataview-edit",
			"cluster-default-edit",
			"space-edit",
			"security-edit",
			"topology-edit",
			"dashboard-edit",
			"other",
		])
		.default("other"),
	cluster: z.string().nullish(),
	tier: z.string().nullish(),
	resource: z.string().nullish(),
	newSizeGb: z.number().nullish(),
	newMaxGb: z.number().nullish(),
	policyName: z.string().nullish(),
	sourcePolicy: z.string().nullish(),
	phasesPatch: z.record(z.string(), z.unknown()).nullish(),
	version: z.string().nullish(),
	integration: z.string().nullish(),
	integrationVersion: z.string().nullish(),
	force: z.boolean().nullish(),
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
	sizeComponent: z.enum(["integrations_server", "kibana"]).nullish(),
	componentSize: z.string().nullish(),
	componentZoneCount: z.number().nullish(),
	dashboardSpace: z.string().nullish(),
	dashboardName: z.string().nullish(),
	dashboardNdjson: z.string().nullish(),
	dashboardAction: z.enum(["add", "replace", "delete"]).nullish(),
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
				return {
					workflow: p.workflow,
					isProd: p.isProd,
					cluster: nn(p.cluster),
					tier: nn(p.tier),
					resource: nn(p.resource),
					newSizeGb: nn(p.newSizeGb),
					newMaxGb: nn(p.newMaxGb),
					policyName: nn(p.policyName),
					sourcePolicy: nn(p.sourcePolicy),
					phasesPatch: nn(p.phasesPatch),
					version: nn(p.version),
					integration: nn(p.integration),
					integrationVersion: nn(p.integrationVersion),
					force: nn(p.force),
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
					templateName: nn(p.templateName),
					totalShardsPerNode: nn(p.totalShardsPerNode),
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
					sizeComponent: nn(p.sizeComponent),
					componentSize: nn(p.componentSize),
					componentZoneCount: nn(p.componentZoneCount),
					dashboardSpace: nn(p.dashboardSpace),
					dashboardName: nn(p.dashboardName),
					dashboardNdjson: nn(p.dashboardNdjson),
					dashboardAction: nn(p.dashboardAction),
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
		'- **ILM lifecycle changes** -- e.g. "set eu-b2b 30-day retention to 60 days"\n' +
		'- **Fleet integration version pins** -- e.g. "bump the aws integration on eu-b2b to 6.15.0"\n' +
		'- **SLO target/window edits** -- e.g. "set the ds-authentication SLO target to 99.5% on eu-b2b"\n' +
		'- **Alert rule edits** -- e.g. "raise the MarTech cart-failed alert threshold to 5 on eu-b2b"\n' +
		'- **Data view edits** -- e.g. "add a service runtime field to the logs data view on eu-b2b"\n' +
		'- **Cluster-defaults edits** -- e.g. "set total_shards_per_node to 3 on the logs@custom template on eu-b2b"\n' +
		'- **Space edits** -- e.g. "change the developer-experience space description on eu-b2b"\n' +
		'- **Security role privilege grants** -- e.g. "grant the developer role read on logs-* on eu-b2b" (HIGH risk; additive only)\n' +
		'- **Deployment topology** -- autoscale, a tier zone_count/autoscale, SSO user_settings_yaml, or integrations_server/kibana sizing; e.g. "turn on autoscaling for eu-onboarding", "set the hot tier zone_count to 3 on eu-b2b" (HIGH risk; single shared state, long apply; SSO edits can lock out login)\n' +
		'- **Dashboards** -- add or replace a whole Kibana dashboard NDJSON in a space; e.g. "add this dashboard to the developer-experience space on eu-b2b" (paste the Kibana export) (MEDIUM risk; whole-file only, no panel edits)\n\n' +
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
	const res = await llm.invoke([new SystemMessage(sys), new HumanMessage(query)]);
	// SIO-930: gate converse on a real follow-up turn (the LLM can mis-emit it on a first message).
	const intent = coerceConverseIntent(intentFromText(String(res.content)), state.isFollowUp);
	// SIO-877: pipeline-status resolves even without a thread-local mrIid -- watchPipeline
	// falls back to the latest open agent MR (so "check my MR" survives a page reload).
	log.info({ intent, query, hasMr: state.mrIid !== null }, "classified IaC intent");
	return { intent };
}

// Verify the unified IaC server is connected before any user-facing action (hooks/bootstrap.md).
export function bootstrapIac(_state: IacStateType): Partial<IacStateType> {
	const connected = getConnectedServers().includes(IAC_SERVER);
	if (!connected) {
		log.warn({ server: IAC_SERVER }, "elastic-iac server not connected");
		return {
			connected: false,
			messages: [
				new AIMessage(
					"The Elastic IaC server is not connected. Start mcp-server-elastic-iac (:9086) and set ELASTIC_IAC_MCP_URL, then retry.",
				),
			],
		};
	}
	return { connected: true };
}

// Translate the plain-English request into a structured IacRequest. Asks one direct
// clarifying question via interrupt when the cluster/change is ambiguous.
export async function parseIntent(state: IacStateType): Promise<Partial<IacStateType>> {
	const query = lastHumanText(state);
	const llm = createLlm("iacPlanner", AGENT);
	const sys = buildSystemPrompt(getAgentByName(AGENT));
	const instruction =
		"Extract the requested Elastic Cloud IaC change as a single strict JSON object with keys: " +
		"workflow ('tier-resize'|'ilm-rollout'|'version-upgrade'|'fleet-integration'|'slo-edit'|'alerting-edit'|" +
		"'dataview-edit'|'cluster-default-edit'|'space-edit'|'security-edit'|'topology-edit'|'dashboard-edit'|'other'), " +
		"cluster, tier, " +
		"resource, newSizeGb, " +
		"newMaxGb, policyName, phasesPatch, version, integration, integrationVersion, force, sloName, sloTarget, sloWindow, " +
		"sloTags, ruleName, alertThreshold, alertWindowSize, alertWindowUnit, alertEnabled, alertInterval, dataviewName, " +
		"runtimeFieldName, runtimeFieldType, runtimeFieldScript, dataviewTitle, dataviewDisplayName, templateName, " +
		"totalShardsPerNode, spaceName, spaceDisplayName, spaceDescription, spaceColor, roleName, grantCluster, " +
		"grantIndexNames, grantIndexPrivileges, grantKibanaApplication, grantKibanaPrivileges, autoscaleEnabled, " +
		"topologyTier, tierZoneCount, tierAutoscale, userSettingsTarget, userSettingsYaml, sizeComponent, componentSize, " +
		"componentZoneCount, dashboardSpace, dashboardName, dashboardNdjson, dashboardAction, reason, isProd (true only if " +
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
		"For a Fleet INTEGRATION PACKAGE version pin ('bump the aws integration on eu-b2b to 6.15.0', 'pin kafka to " +
		"1.28.0 on eu-cld', 'update the system integration package to 2.18.0') -- note this is the integration PACKAGE " +
		"version, NOT a Fleet AGENT binary upgrade and NOT a cluster version -- set workflow to 'fleet-integration', cluster " +
		"to the named deployment, integration to the integration alias key VERBATIM (e.g. 'aws', 'kafka', 'system', 'apm', " +
		"'elastic-defend'), integrationVersion to the explicit target package version string, and force to true ONLY if the " +
		"user explicitly asks to force/reinstall it. " +
		"For an SLO change ('set the DS API Health SLO target to 99.5% on eu-b2b', 'change the eu-b2b ds-authentication SLO " +
		"window to 60 days') -- editing an EXISTING SLO's target/time-window/tags, NOT creating one -- set workflow to " +
		"'slo-edit', cluster to the named deployment, sloName to the SLO file basename VERBATIM (e.g. 'ds-authentication', " +
		"'cci-sftpgo'; the part before .json), sloTarget to the numeric target the user gave (a percent like 99.5 or a " +
		"fraction like 0.995 -- pass it as the user said it), sloWindow to a duration string ('60d', '90d') ONLY if they " +
		"change the window, and sloTags to the full new tag array ONLY if they change tags. Set at least one of sloTarget/" +
		"sloWindow/sloTags. " +
		"For an ALERT RULE change ('raise the MarTech Add-To-Wallet threshold to 5 on eu-b2b', 'disable the cart-failed " +
		"alert on eu-b2b', 'change the X rule window to 10 minutes') -- editing an EXISTING rule's threshold/window/enabled/" +
		"interval, NOT creating one -- set workflow to 'alerting-edit', cluster to the named deployment, ruleName to the " +
		"rule file basename VERBATIM (it is '<space>__<rule-name>', e.g. 'default__martech_add_to_wallet_transactions_" +
		"failed_status_prd'; if the user gives only a friendly name, construct the basename with the space prefix, " +
		"defaulting the space to 'default' when unstated), and the field(s) to change: alertThreshold (number), " +
		"alertWindowSize (number) + alertWindowUnit ('m'|'h'|'s'|'d'), alertEnabled (false to disable / silence the rule, " +
		"true to enable), alertInterval (a check-interval string like '5m'). Set at least one of those alert* fields. " +
		"For a DATA VIEW change ('add a service runtime field to the logs data view on eu-b2b', 'rename the logs data " +
		"view title to logs-*') -- editing an EXISTING data view, NOT creating one -- set workflow to 'dataview-edit', " +
		"cluster to the named deployment, dataviewName to the data-view file basename VERBATIM (e.g. 'logs', 'metrics'; the " +
		"part before .json). To add/replace a runtime field set runtimeFieldName, runtimeFieldType (default 'keyword'), and " +
		"runtimeFieldScript (the painless source, ONLY when the user gives a script). To change the index pattern set " +
		"dataviewTitle; to change the display name set dataviewDisplayName. Set at least one of those. " +
		"For a CLUSTER-DEFAULTS index-template change ('set total_shards_per_node to 3 on the logs@custom template on " +
		"eu-b2b') -- editing an EXISTING template, NOT creating one -- set workflow to 'cluster-default-edit', cluster to " +
		"the named deployment, templateName to the template file basename VERBATIM (e.g. 'logs', 'metrics', " +
		"'metrics-system.cpu'; the part before .json, NOT the '@custom' suffix), and totalShardsPerNode to the positive " +
		"integer the user gave. " +
		"For a SPACE change ('rename the developer-experience space description on eu-b2b', 'change the apps space color') " +
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
		"topology-edit ALSO covers two more surfaces of the same _deployments JSON: (a) the SSO/OIDC login config -- if the " +
		"user gives a new user_settings_yaml block (SAML/OIDC realm or Kibana auth providers), set userSettingsTarget " +
		"('elasticsearch_config' for the ES SAML realm, 'kibana' for the Kibana auth providers) and userSettingsYaml to the " +
		"raw YAML string verbatim; and (b) component sizing -- to resize the integrations_server or kibana node, set " +
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
		"Set clarification (a single direct question) ONLY when a required field is genuinely missing -- e.g. no " +
		"cluster named, an upgrade with no concrete target version ('upgrade to latest'), or a resize with no tier or " +
		"no size/max. Do NOT ask for information the user already provided. Respond with ONLY the JSON object.";

	const res = await llm.invoke([new SystemMessage(`${sys}\n\n${instruction}`), new HumanMessage(query)]);
	let request = parseIntentJson(String(res.content));

	if (request.clarification) {
		const answer = interrupt({
			type: "iac_clarify",
			question: request.clarification,
			message: request.clarification,
		}) as { answer?: string };
		const reply = answer?.answer ?? "";
		const res2 = await llm.invoke([
			new SystemMessage(`${sys}\n\n${instruction}`),
			new HumanMessage(query),
			new AIMessage(request.clarification),
			new HumanMessage(reply),
		]);
		request = { ...parseIntentJson(String(res2.content)), clarification: undefined };
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

function infoTools(): StructuredToolInterface[] {
	const allowed = new Set<string>(INFO_TOOL_NAMES);
	return getToolsForDataSource(AGENT).filter((t) => allowed.has(t.name));
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
	const toolNames = new Set(tools.map((t) => t.name));
	const convo: BaseMessage[] = [new SystemMessage(sys), new HumanMessage(query)];

	const MAX_STEPS = 5;
	for (let step = 0; step < MAX_STEPS; step++) {
		const ai = (await llm.invoke(convo)) as AIMessage;
		convo.push(ai);
		const calls = ai.tool_calls ?? [];
		if (calls.length === 0) return { messages: [new AIMessage(String(ai.content))] };
		for (const call of calls) {
			const result = toolNames.has(call.name)
				? await callTool(call.name, (call.args ?? {}) as Record<string, unknown>)
				: `[${call.name} is not an allowed read tool]`;
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
	const toolNames = new Set(tools.map((t) => t.name));
	const convo: BaseMessage[] = [new SystemMessage(sys), ...state.messages];

	const MAX_STEPS = 5;
	for (let step = 0; step < MAX_STEPS; step++) {
		const ai = (await llm.invoke(convo)) as AIMessage;
		convo.push(ai);
		const calls = ai.tool_calls ?? [];
		if (calls.length === 0) return { messages: [new AIMessage(String(ai.content))] };
		for (const call of calls) {
			const result = toolNames.has(call.name)
				? await callTool(call.name, (call.args ?? {}) as Record<string, unknown>)
				: `[${call.name} is not an allowed read tool]`;
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
				? req.policyName
				: req.workflow === "fleet-integration"
					? req.integration
					: req.workflow === "slo-edit"
						? req.sloName
						: req.workflow === "alerting-edit"
							? req.ruleName
							: req.workflow === "dataview-edit"
								? req.dataviewName
								: req.workflow === "cluster-default-edit"
									? req.templateName
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

// SIO-873: the agent owns the per-deployment JSON path -- it knows the cluster and
// passes the resolved filePath to the MCP gitlab_* tools, which only own the repo
// target (base URL + project). Literal "${cluster}" placeholder. The agent edits
// JSON config only; it never runs terraform or git.
// Read lazily via process.env (works under both Bun and the web app's Vite SSR
// runtime, where a top-level `Bun.env` reference throws "Bun is not defined").
function deploymentJsonTemplate(): string {
	return process.env.ELASTIC_IAC_DEPLOYMENT_JSON_TEMPLATE ?? "environments/_deployments/${cluster}.json";
}

// SIO-880: agent-side path template for ILM lifecycle-policy JSON. ${cluster}/${policy}
// are literal placeholders. Lazy process.env read (no module-scope Bun.env; the web app
// runs Vite SSR where a top-level Bun.env reference throws "Bun is not defined").
function ilmPolicyTemplate(): string {
	return process.env.ELASTIC_IAC_ILM_POLICY_TEMPLATE ?? "environments/${cluster}/lifecycle-policies/${policy}.json";
}

// SIO-914: agent-side path for the per-deployment fleet-integrations aggregate JSON.
// ${cluster} is the literal placeholder. One aggregate file keyed by integration alias.
function fleetIntegrationsTemplate(): string {
	return (
		process.env.ELASTIC_IAC_FLEET_INTEGRATIONS_TEMPLATE ??
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
	return process.env.ELASTIC_IAC_DATAVIEW_TEMPLATE ?? "environments/${cluster}/dataviews/${dataview}.json";
}

// SIO-917: agent-side path for a per-deployment cluster-defaults index-template JSON.
// ${cluster}/${template} are literal placeholders. One file per template under
// environments/<cluster>/cluster-defaults/.
function clusterDefaultTemplate(): string {
	return (
		process.env.ELASTIC_IAC_CLUSTER_DEFAULT_TEMPLATE ?? "environments/${cluster}/cluster-defaults/${template}.json"
	);
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

// SIO-918: agent-side path for a per-deployment per-space JSON. ${cluster}/${space} are literal
// placeholders. One file per space under environments/<cluster>/spaces/.
function spaceTemplate(): string {
	return process.env.ELASTIC_IAC_SPACE_TEMPLATE ?? "environments/${cluster}/spaces/${space}.json";
}

// SIO-918: agent-side path for a per-deployment security aggregate JSON. ${cluster} is the
// literal placeholder. ONE aggregate file (roles + role_mappings + api_keys) per deployment.
function securityTemplate(): string {
	return process.env.ELASTIC_IAC_SECURITY_TEMPLATE ?? "environments/${cluster}/security/security.json";
}

// SIO-920: agent-side path for a Kibana dashboard NDJSON export. ${cluster}/${space}/${name} are
// literal placeholders. One NDJSON file per dashboard; the filename is <space>__<name>.ndjson.
// Lazy process.env read (no module-scope Bun.env; the web app runs Vite SSR where a top-level
// Bun.env reference throws "Bun is not defined").
function dashboardNdjsonTemplate(): string {
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

	if (grant.index && grant.index.privileges.length > 0) {
		const indices = Array.isArray(r.indices) ? (r.indices as Array<Record<string, unknown>>) : [];
		// Find an index entry with the same `names` set; else append a new one.
		const sameNames = (a: unknown): boolean =>
			Array.isArray(a) && a.length === grant.index!.names.length && grant.index!.names.every((n) => a.includes(n));
		let entry = indices.find((e) => sameNames(e.names));
		if (!entry) {
			entry = { names: [...grant.index.names], privileges: [] };
			indices.push(entry);
		}
		const cur = Array.isArray(entry.privileges)
			? (entry.privileges as unknown[]).filter((x): x is string => typeof x === "string")
			: [];
		for (const p of grant.index.privileges) if (!cur.includes(p)) addedIndex.push(p);
		entry.privileges = [...cur, ...addedIndex];
		r.indices = indices;
	}

	if (grant.kibana && grant.kibana.privileges.length > 0) {
		const apps = Array.isArray(r.applications) ? (r.applications as Array<Record<string, unknown>>) : [];
		let entry = apps.find((e) => e.application === grant.kibana!.application);
		if (!entry) {
			entry = { application: grant.kibana.application, privileges: [], resources: grant.kibana.resources ?? ["*"] };
			apps.push(entry);
		}
		const cur = Array.isArray(entry.privileges)
			? (entry.privileges as unknown[]).filter((x): x is string => typeof x === "string")
			: [];
		for (const p of grant.kibana.privileges) if (!cur.includes(p)) addedKibana.push(p);
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

// version-upgrade: propose the change as a GitLab config edit + branch + commit via
// the API (no clone, no terraform, no local git). CI computes the plan on the MR.
async function proposeVersionUpgrade(state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
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
			blockedReason: `${cluster} is already on ${version}; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: ${cluster} is already on Elasticsearch ${version}. I did not open a merge request.`,
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
		previousVersion: updated.previous ?? "",
		proposedDiff: diff,
		precheckPassed: committed,
	};
}

// SIO-879: tier-resize via the GitOps proposer -- edit elasticsearch.<tier>.size/max_size
// in the deployment JSON and open an MR via the API. Mirrors proposeVersionUpgrade.
async function proposeTierResize(state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
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
			blockedReason: `${tier} tier already has the requested sizing; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: the ${tier} tier already has the requested sizing. I did not open a merge request.`,
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
		proposedDiff: diffLines.join("\n"),
		precheckPassed: committed,
	};
}

// SIO-880: ilm-rollout via the GitOps proposer -- deep-merge a phase patch into the
// cluster's lifecycle-policy JSON and open an MR via the API. Mirrors proposeTierResize.
export async function proposeIlmChange(state: IacStateType, req: IacRequest): Promise<Partial<IacStateType>> {
	const cluster = req.cluster ?? "";
	const policy = req.policyName ?? "";
	const patch = req.phasesPatch;

	if (!policy) {
		return {
			blockedReason: "ILM change needs a policy name.",
			messages: [new AIMessage("Cannot propose the change: name the policy to change or create.")],
		};
	}
	if (!req.sourcePolicy && (!patch || Object.keys(patch).length === 0)) {
		return {
			blockedReason: "ILM change needs at least one phase field to change (or a sourcePolicy to copy).",
			messages: [new AIMessage("Cannot propose the change: name a phase field to change, or a policy to copy from.")],
		};
	}

	const filePath = deploymentJsonPath(ilmPolicyTemplate(), cluster, policy);
	const branch = branchName(req);

	const raw = await callTool("gitlab_get_file_content", { filePath });
	if (raw.startsWith("[gitlab token not configured")) {
		return {
			blockedReason: "ELASTIC_IAC_GITLAB_TOKEN not configured; cannot read the GitOps repo.",
			messages: [new AIMessage("Cannot propose the change: set ELASTIC_IAC_GITLAB_TOKEN for the GitOps repo.")],
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
			blockedReason: `Could not read the GitOps repo via the GitLab API: ${raw.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: I could not read the target file from the GitOps repo.")],
		};
	}
	const patchObj = (patch ?? {}) as Record<string, unknown>;

	// SIO-931 copy-from-reference: the base is the source policy (already correctly shaped). The
	// source must be readable -- a copy of a policy we can't read is never silently downgraded.
	if (req.sourcePolicy) {
		const srcPath = deploymentJsonPath(ilmPolicyTemplate(), cluster, req.sourcePolicy);
		const srcRaw = await callTool("gitlab_get_file_content", { filePath: srcPath });
		if (!isGitlabSuccess(srcRaw)) {
			return {
				blockedReason: `Could not read reference policy '${req.sourcePolicy}' on '${cluster}': ${srcRaw.slice(0, 80)}.`,
				messages: [
					new AIMessage(
						`I couldn't read reference policy '${req.sourcePolicy}' on '${cluster}' (${srcRaw.slice(0, 40)}). Name an existing policy to copy, or specify the phases directly.`,
					),
				],
			};
		}
		let srcObj: Record<string, unknown>;
		try {
			srcObj = JSON.parse(extractFileContent(srcRaw)) as Record<string, unknown>;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				blockedReason: `Reference policy '${req.sourcePolicy}' on '${cluster}' is not valid JSON: ${reason}.`,
				messages: [
					new AIMessage(
						`Cannot propose the change: reference policy '${req.sourcePolicy}' on '${cluster}' did not parse as JSON.`,
					),
				],
			};
		}
		srcObj.name = policy;
		policyCreated = !isGitlabSuccess(raw); // target is new if it 404s
		updated = mergeIlmPhases(JSON.stringify(srcObj), patchObj);
	} else if (raw.startsWith("[404")) {
		// SIO-931 from-scratch: learn the shape from a sibling policy in this cluster's dir; fall
		// back to the canonical skeleton when the cluster has no lifecycle-policies/ files yet.
		policyCreated = true;
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
	} else {
		try {
			updated = mergeIlmPhases(extractFileContent(raw), patchObj);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			return {
				blockedReason: `Could not edit ${filePath}: ${reason}.`,
				messages: [new AIMessage(`Cannot propose the change: ${reason}.`)],
			};
		}

		// No-op guard: the phase patch matches the current policy (empty diff). Only a
		// modify can be a no-op; a freshly created file is always a change.
		if (isUnchangedConfig(updated.content, extractFileContent(raw))) {
			return {
				blockedReason: `Policy '${policy}' on '${cluster}' already has the requested phase values; no change needed.`,
				messages: [
					new AIMessage(
						`No change needed: policy '${policy}' on '${cluster}' already has the requested phase values. I did not open a merge request.`,
					),
				],
			};
		}
	}

	// SIO-931: structural gate -- never commit a policy CI's terraform plan would reject.
	const valid = validateIlmPolicy(JSON.parse(updated.content));
	if (!valid.ok) {
		return {
			blockedReason: `Proposed ILM policy '${policy}' is structurally invalid: ${valid.reason}`,
			messages: [
				new AIMessage(
					`I won't open an MR: the proposed '${policy}' policy doesn't match the repo schema. ${valid.reason}`,
				),
			],
		};
	}

	const retentionChange = detectRetentionReduction(updated.previous, patchObj);

	await callTool("gitlab_create_branch", { branch, ref: "main" });
	const fields = Object.keys(patchObj).join(", ") || (req.sourcePolicy ? `copy of ${req.sourcePolicy}` : "copy");
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
			blockedReason: `Could not commit the change via the GitLab API: ${commit.slice(0, 120)}.`,
			messages: [new AIMessage("Cannot propose the change: the GitLab commit failed.")],
		};
	}
	const committed = true;

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
	walk(updated.previous, patchObj, "");

	return {
		branch,
		proposedFilePath: filePath,
		proposedDiff: diffLines.join("\n"),
		precheckPassed: committed,
		retentionChange,
		policyCreated,
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
			blockedReason: `Integration '${alias}' on '${cluster}' is already at ${version}; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: integration '${alias}' on '${cluster}' is already pinned to ${version}. I did not open a merge request.`,
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
			blockedReason: `SLO '${slo}' on '${cluster}' already has the requested values; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: SLO '${slo}' on '${cluster}' already has the requested values. I did not open a merge request.`,
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
			blockedReason: `Alert rule '${rule}' on '${cluster}' already has the requested values; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: alert rule '${rule}' on '${cluster}' already has the requested values. I did not open a merge request.`,
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
			blockedReason: `Data view '${dataview}' on '${cluster}' already has the requested values; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: data view '${dataview}' on '${cluster}' already has the requested values. I did not open a merge request.`,
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

	return { branch, proposedFilePath: filePath, proposedDiff: diffLines.join("\n"), precheckPassed: committed };
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
			blockedReason: `Template '${template}' on '${cluster}' already has total_shards_per_node=${req.totalShardsPerNode}; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: template '${template}' on '${cluster}' already has total_shards_per_node=${req.totalShardsPerNode}. I did not open a merge request.`,
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
		proposedDiff,
		precheckPassed: committed,
		shardsLowered,
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
			blockedReason: `Space '${space}' on '${cluster}' already has the requested values; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: space '${space}' on '${cluster}' already has the requested values. I did not open a merge request.`,
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

	return { branch, proposedFilePath: filePath, proposedDiff: diffLines.join("\n"), precheckPassed: committed };
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
			blockedReason: `Role '${roleName}' on '${cluster}' already has the requested privileges; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: role '${roleName}' on '${cluster}' already has the requested privileges. I did not open a merge request.`,
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
		(req.sizeComponent !== undefined && (req.componentSize !== undefined || req.componentZoneCount !== undefined));
	if (!cluster || !hasChange) {
		return {
			blockedReason:
				"Topology change needs a cluster and at least one of autoscale / tier zone_count / tier autoscale / user_settings_yaml / component size.",
			messages: [
				new AIMessage(
					"Cannot propose the change: name the deployment and what to change (autoscale, a tier's zone_count/autoscale, an SSO user_settings_yaml block, or integrations_server/kibana sizing).",
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
		return {
			blockedReason: `Deployment '${cluster}' already has the requested topology values; no change needed.`,
			messages: [
				new AIMessage(
					`No change needed: deployment '${cluster}' already has the requested topology values. I did not open a merge request.`,
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

	return { branch, proposedFilePath: filePath, proposedDiff: diffLines.join("\n"), precheckPassed: committed };
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
	return { branch, proposedFilePath: filePath, proposedDiff, precheckPassed: true };
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
	if (req.workflow === "cluster-default-edit") return proposeClusterDefaultChange(state, req);
	if (req.workflow === "space-edit") return proposeSpaceChange(state, req);
	if (req.workflow === "security-edit") return proposeSecurityRoleChange(state, req);
	if (req.workflow === "topology-edit") return proposeTopologyChange(state, req);
	if (req.workflow === "dashboard-edit") return proposeDashboardChange(state, req);

	// Defensive: a workflow value with no proposer must stop before the review gate rather
	// than open an empty MR. parseIntent should already have blocked "other" upstream.
	return {
		blockedReason: `No proposer for workflow '${req.workflow}'.`,
		messages: [new AIMessage(capabilityMessage())],
	};
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
		// SIO-880: a retention REDUCTION is irreversible data loss -- surface as HIGH (first).
		if (state.retentionChange) {
			risks.unshift(
				`Retention REDUCED ${state.retentionChange.from}->${state.retentionChange.to}; data deleted at apply is irrecoverable -- confirm the IR/issue reference before merge.`,
			);
		}
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
				? `${req?.policyName ?? "?"}: ${state.policyCreated ? "create " : ""}${Object.keys(req?.phasesPatch ?? {}).join(", ") || "change"}`
				: req?.workflow === "fleet-integration"
					? `${req?.integration ?? "?"} -> ${req?.integrationVersion ?? "?"}`
					: req?.workflow === "slo-edit"
						? `${req?.sloName ?? "?"}: ${[req?.sloTarget != null ? `target ${req.sloTarget}` : "", req?.sloWindow ? `window ${req.sloWindow}` : "", req?.sloTags ? "tags" : ""].filter(Boolean).join(", ") || "change"}`
						: req?.workflow === "alerting-edit"
							? `${req?.ruleName ?? "?"}: ${[req?.alertThreshold != null ? `threshold ${req.alertThreshold}` : "", req?.alertEnabled === false ? "disable" : req?.alertEnabled === true ? "enable" : "", req?.alertWindowSize != null ? `window ${req.alertWindowSize}${req?.alertWindowUnit ?? ""}` : "", req?.alertInterval ? `interval ${req.alertInterval}` : ""].filter(Boolean).join(", ") || "change"}`
							: req?.workflow === "dataview-edit"
								? `${req?.dataviewName ?? "?"}: ${[req?.runtimeFieldName ? `runtime ${req.runtimeFieldName}` : "", req?.dataviewTitle ? "title" : "", req?.dataviewDisplayName ? "name" : ""].filter(Boolean).join(", ") || "change"}`
								: req?.workflow === "cluster-default-edit"
									? `${req?.templateName ?? "?"}: total_shards_per_node ${req?.totalShardsPerNode ?? "?"}`
									: req?.workflow === "space-edit"
										? `${req?.spaceName ?? "?"}: ${[req?.spaceDisplayName ? "name" : "", req?.spaceDescription ? "description" : "", req?.spaceColor ? "color" : ""].filter(Boolean).join(", ") || "change"}`
										: req?.workflow === "security-edit"
											? `${req?.roleName ?? "?"}: grant ${[req?.grantCluster?.length ? "cluster" : "", req?.grantIndexNames?.length ? "index" : "", req?.grantKibanaApplication ? "kibana" : ""].filter(Boolean).join(", ") || "privileges"}`
											: req?.workflow === "topology-edit"
												? `${req?.cluster ?? "?"}: ${[req?.autoscaleEnabled !== undefined ? `autoscale ${req.autoscaleEnabled}` : "", req?.topologyTier ? `${req.topologyTier} ${[req?.tierZoneCount != null ? `zones ${req.tierZoneCount}` : "", req?.tierAutoscale !== undefined ? `autoscale ${req.tierAutoscale}` : ""].filter(Boolean).join(" ")}` : "", req?.userSettingsYaml !== undefined ? `${req.userSettingsTarget ?? ""} SSO` : "", req?.sizeComponent ? `${req.sizeComponent} ${[req?.componentSize ? req.componentSize : "", req?.componentZoneCount != null ? `zones ${req.componentZoneCount}` : ""].filter(Boolean).join(" ")}` : ""].filter(Boolean).join(", ") || "topology"}`
												: req?.workflow === "dashboard-edit"
													? `${req?.dashboardSpace ?? "?"}__${req?.dashboardName ?? "?"}: ${req?.dashboardAction ?? "change"}`
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
	};
	return { terraformPlan: plan, precheckPassed, risks, planReview: review };
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
export function extractMrUrl(toolResult: string): string {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart >= 0) {
		try {
			const parsed: unknown = JSON.parse(toolResult.slice(jsonStart));
			if (typeof parsed === "object" && parsed !== null) {
				const url = (parsed as { web_url?: unknown }).web_url;
				if (typeof url === "string" && url.length > 0) return url;
			}
		} catch {
			// fall through to the raw result
		}
	}
	return toolResult;
}

// Minimal deterministic MR body, used as the fallback when the LLM step fails so the
// MR never blocks. Real bodies follow knowledge/mr-template.md (filled by the LLM).
function fallbackMrDescription(review: IacPlanReview | null): string {
	return `${review?.diff ?? ""}\n\n## Plan\n\n${review?.plan ?? ""}\n\n## Risks\n\n${(review?.risks ?? []).map((r) => `- ${r}`).join("\n")}`;
}

// Build the MR description by having the LLM fill the agent's own mr-template.md
// (already in the system prompt) per the open-mr skill, from the gathered context.
// Falls back to the deterministic stub on any error.
export async function buildMrDescription(state: IacStateType): Promise<string> {
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
				? `ILM policy '${req?.policyName}' ${req?.sourcePolicy ? `EXACT COPY of '${req.sourcePolicy}'` : state.policyCreated ? "CREATE (new lifecycle-policy file for an untracked/unmanaged policy, onboarding it into IaC)" : "phase change"}${Object.keys(req?.phasesPatch ?? {}).length > 0 ? ` with overrides: ${JSON.stringify(req?.phasesPatch ?? {})}` : ""}.${state.retentionChange ? ` Retention REDUCED ${state.retentionChange.from} -> ${state.retentionChange.to} (irreversible).` : ""}`
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
				? `Cluster-defaults template '${req?.templateName}': settings.index.routing.allocation.total_shards_per_node -> ${req?.totalShardsPerNode}.${state.shardsLowered ? " LOWERED (can unbalance allocation)." : ""}`
				: "",
			req?.workflow === "space-edit"
				? `Space '${req?.spaceName}' edit:${req?.spaceDisplayName ? ` name -> ${req.spaceDisplayName}` : ""}${req?.spaceDescription ? " description (changed)" : ""}${req?.spaceColor ? ` color -> ${req.spaceColor}` : ""}.`
				: "",
			req?.workflow === "security-edit"
				? `Security role '${req?.roleName}' ADDITIVE privilege grant${state.privilegeEscalation ? " (PRIVILEGE ESCALATION -- recommend human security review)" : ""}. role_mappings + api_keys untouched.`
				: "",
			req?.workflow === "topology-edit"
				? `Deployment topology '${req?.cluster}' (SHARED deployments state):${req?.autoscaleEnabled !== undefined ? ` elasticsearch.autoscale -> ${req.autoscaleEnabled}` : ""}${req?.topologyTier ? ` ${req.topologyTier}${req?.tierZoneCount != null ? ` zone_count -> ${req.tierZoneCount}` : ""}${req?.tierAutoscale !== undefined ? ` autoscale -> ${req.tierAutoscale}` : ""}` : ""}${req?.userSettingsYaml !== undefined ? ` ${req?.userSettingsTarget ?? ""}.user_settings_yaml updated (SSO/login; value withheld)` : ""}${req?.sizeComponent ? ` ${req.sizeComponent}${req?.componentSize ? ` size -> ${req.componentSize}` : ""}${req?.componentZoneCount != null ? ` zone_count -> ${req.componentZoneCount}` : ""}` : ""}.`
				: "",
			req?.workflow === "dashboard-edit"
				? `Dashboard ${req?.dashboardAction ?? "?"} '${req?.dashboardSpace ?? "?"}__${req?.dashboardName ?? "?"}.ndjson' (whole-file Kibana NDJSON export; committed verbatim, no panel edits). ${review?.diff ?? ""}`
				: "",
			req?.reason ? `Reason given: ${req.reason}.` : "",
			`Branch: ${state.branch}. Target: main.`,
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
														: "Category version-bump, Risk LOW";
		const instruction =
			"Write the GitLab merge request description using knowledge/mr-template.md's SECTION HEADINGS, but as an " +
			"agent-authored MR: state the single RESOLVED value per section -- do NOT reproduce the human checkbox " +
			"menus. Category, Cluster(s) affected, and Risk are one resolved line each (e.g. 'Category: tier-resize', " +
			"'Cluster(s) affected: eu-b2b', 'Risk: MEDIUM') -- never list the unselected options or empty `- [ ]` boxes. " +
			`This is a config edit committed via the GitLab API (no local terraform): use ${categoryRisk}, and mark the ` +
			"gl-testing / Plan output sections 'n/a -- config edit; CI computes the plan on the MR'. Fill Summary, " +
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
	});
	return { mrUrl: extractMrUrl(mr), mrIid: extractMrIid(mr) };
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

// A pipeline status is terminal when CI has stopped running.
export function isTerminalPipelineStatus(status: string): boolean {
	return ["success", "failed", "canceled", "skipped"].includes(status);
}

// SIO-930: the user-facing outcome of one IaC turn, derived from terminal state, so the UI chip
// reflects what actually happened instead of an unconditional "Completed". Precedence: explicit human
// decisions (reject/decline) > a request we have no proposer for (unsupported) > a mechanical guard
// block > a failed CI pipeline > completed. (Pure; unit-tested.)
export type IacTurnOutcome = "completed" | "rejected" | "declined" | "blocked" | "unsupported" | "pipeline-failed";

export function iacTurnOutcome(state: IacStateType): IacTurnOutcome {
	if (state.reviewDecision === "rejected") return "rejected";
	if (state.syntheticsPushApproved === false && state.syntheticsDriftReport) return "declined";
	if (state.fleetUpgradeApproved === false && state.fleetUpgradeReport) return "declined";
	if (state.blockedReason) {
		return state.iacRequest?.workflow === "other" ? "unsupported" : "blocked";
	}
	if (isTerminalPipelineStatus(state.pipelineStatus) && state.pipelineStatus === "failed") return "pipeline-failed";
	return "completed";
}

// SIO-924: parse a single pipeline's {status, web_url} from gitlab_get_pipeline's
// "[status] {...}" body (GET /projects/:id/pipelines/:id). Used to stream live apply
// progress + surface a clickable pipeline link. (Pure; unit-tested.)
export function parseSinglePipeline(toolResult: string): { status: string; webUrl: string } | null {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return null;
	try {
		const p = JSON.parse(toolResult.slice(jsonStart)) as { status?: unknown; web_url?: unknown };
		if (typeof p !== "object" || p === null) return null;
		return {
			status: typeof p.status === "string" ? p.status : "unknown",
			webUrl: typeof p.web_url === "string" ? p.web_url : "",
		};
	} catch {
		return null;
	}
}

// One-line plan summary: "0 create / 1 update / 0 destroy".
export function formatPlanSummary(report: IacPlanReport | null): string {
	if (!report) return "plan not available";
	return `${report.create} create / ${report.update} update / ${report.delete} destroy`;
}

// SIO-878: classify a failed plan job's log into a human-readable cause hint. The
// deployments stack shares one Terraform state across all 10 clusters, so concurrent
// MRs contend on a single state lock -- the most common, recoverable failure. (Pure.)
//
// SIO-904: the MCP now greps the FULL trace and returns a `stateLocked` verdict; prefer it when
// present, since the signature can sit beyond the returned tail. When the flag is absent (e.g. the
// gitlab_get_pipeline_plan_log caller), fall back to substring-matching the supplied log.
export function classifyPipelineFailure(planLog: string, stateLocked?: boolean): string {
	const lower = planLog.toLowerCase();
	if (stateLocked === true || lower.includes("error acquiring the state lock") || lower.includes("already locked")) {
		return (
			"Likely cause: a Terraform state-lock on the shared deployments stack (all 10 clusters share one " +
			"state, so concurrent MRs contend on a single lock). An operator can force-unlock in GitLab or wait " +
			"for the holding pipeline to finish, then re-run the plan."
		);
	}
	if (!planLog || planLog.startsWith("[")) return "The plan job log was not available to diagnose the failure.";
	return "The plan job failed for another reason -- review the job log.";
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
	const result: FleetUpgradeResult =
		res.status === "success" || status === "success"
			? { status: "applied", ...common }
			: {
					status: "failed",
					...common,
					note: `Apply pipeline ${res.status || status}. ${classifyPipelineFailure(res.failureLog, res.stateLocked)}`,
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

	// SIO-877: when the thread no longer holds the MR (e.g. a follow-up after a page
	// reload), fall back to the latest OPEN agent MR so "check my MR" still works.
	let iid = state.mrIid;
	let recoveredUrl = "";
	if (iid === null) {
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

	const budgetMs = Number(process.env.IAC_PIPELINE_POLL_BUDGET_MS ?? "90000");
	const intervalMs = Number(process.env.IAC_PIPELINE_POLL_INTERVAL_MS ?? "10000");
	const deadline = Date.now() + budgetMs;

	let pipelineId: number | null = null;
	let status = "unknown";
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
				await dispatchCustomEvent("iac_pipeline_progress", { pipelineId, status });
			}
			if (isTerminalPipelineStatus(status)) break;
		}
		if (Date.now() + intervalMs >= deadline) break;
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	// Persist the (possibly recovered) MR so subsequent turns reuse it; set the link
	// when we recovered it (don't clobber an existing mrUrl from this thread's openMr).
	const recovered: Partial<IacStateType> = { mrIid: iid, ...(recoveredUrl && { mrUrl: recoveredUrl }) };

	// Still running at budget: surface the partial result; a follow-up re-checks.
	if (!isTerminalPipelineStatus(status)) {
		return { ...recovered, pipelineId, pipelineStatus: status || "running" };
	}

	// Terminal: fetch the real plan + approval state.
	const planReport = pipelineId
		? parsePlanReport(await callTool("gitlab_get_pipeline_terraform_report", { pipelineId }))
		: null;
	const approvalState = parseApprovalState(await callTool("gitlab_get_merge_request_approvals", { iid }));

	// SIO-878: on failure, read the plan job log and classify the cause (e.g. state-lock).
	let failureHint = "";
	if (status === "failed" && pipelineId) {
		failureHint = classifyPipelineFailure(await callTool("gitlab_get_pipeline_plan_log", { pipelineId }));
	}
	return { ...recovered, pipelineId, pipelineStatus: status, planReport, approvalState, failureHint };
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

// gitlab_get_drift_check_result's outer JSON: {status,report?,failureLog?,stateLocked?,note?}.
// `report` is the raw drift-report.json text (parsed by parseDriftReport); `failureLog` is the
// job trace tail on a failed run (SIO-887, classified into a human reason); `stateLocked` is the
// MCP's full-trace state-lock verdict (SIO-904), preferred over the tail when present. (Pure; unit-tested.)
export function parseDriftCheckResult(toolResult: string): {
	status: string;
	report: string;
	failureLog: string;
	stateLocked: boolean;
	note: string;
} {
	const jsonStart = toolResult.indexOf("{");
	if (jsonStart < 0) return { status: "error", report: "", failureLog: "", stateLocked: false, note: "unparseable" };
	try {
		const o = JSON.parse(toolResult.slice(jsonStart)) as {
			status?: unknown;
			report?: unknown;
			failureLog?: unknown;
			stateLocked?: unknown;
			note?: unknown;
		};
		return {
			status: typeof o.status === "string" ? o.status : "unknown",
			report: typeof o.report === "string" ? o.report : "",
			failureLog: typeof o.failureLog === "string" ? o.failureLog : "",
			stateLocked: o.stateLocked === true,
			note: typeof o.note === "string" ? o.note : "",
		};
	} catch {
		return { status: "error", report: "", failureLog: "", stateLocked: false, note: "unparseable" };
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
export function teardownIac(state: IacStateType): Partial<IacStateType> {
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
	// SIO-899: when onboarding an untracked policy, name the created file + scope it (Step 2 is a runtime apply).
	if (state.policyCreated) {
		lines.push(
			`Created a new managed ILM policy '${state.iacRequest?.policyName ?? "?"}' (was untracked in IaC). Attaching it to existing indices is a runtime apply done in GitLab/Elasticsearch, not part of this MR.`,
		);
	}

	if (state.pipelineStatus && state.pipelineStatus !== "unknown") {
		const pid = state.pipelineId ? `#${state.pipelineId}` : "";
		lines.push(`Pipeline ${pid}: ${state.pipelineStatus}`);
	}
	if (state.planReport) {
		lines.push(`Plan: ${formatPlanSummary(state.planReport)}`);
		for (const r of state.planReport.resources.slice(0, 10)) {
			lines.push(`  ${r.actions.join("+")} ${r.address}`);
		}
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
	lines.push("Review and apply manually in GitLab. I never merge or apply.");
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
			generatedAt: str(o.generated_at),
		};
	} catch {
		return null;
	}
}

// Parse the apply-mode report's `apply` + `action_id` block for the result summary. Returns
// the fields needed for FleetUpgradeResult; absent/preview reports yield zeros. (Pure.)
export function parseFleetApplyOutcome(raw: string): {
	actionId: string;
	pollStatus: string;
	acked: number;
	created: number;
	failedSilent: number;
} {
	const empty = { actionId: "", pollStatus: "", acked: 0, created: 0, failedSilent: 0 };
	try {
		const o = JSON.parse(raw) as Record<string, unknown>;
		const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		const a = (o.apply ?? {}) as Record<string, unknown>;
		return {
			actionId: typeof o.action_id === "string" ? o.action_id : "",
			pollStatus: typeof a.poll_status === "string" ? a.poll_status : "",
			acked: num(a.acked),
			created: num(a.created),
			failedSilent: num(a.failed_silent),
		};
	} catch {
		return empty;
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

	log.info({ deployment, version }, "iac fleet upgrade: triggering preview");
	const trig = parseTriggerResult(await callTool("gitlab_trigger_fleet_upgrade_preview", { deployment, version }));
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

	const report: FleetUpgradeReport = { ...parsed, generatedAt: parsed.generatedAt || new Date().toISOString() };
	log.info(
		{
			deployment,
			pipelineId: trig.pipelineId,
			resolved: report.resolvedCount,
			upgradeable: report.crosstab.upgradeable,
			versionAvailable: report.versionAvailable,
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
export function fleetUpgradeGate(state: IacStateType): Partial<IacStateType> {
	const report = state.fleetUpgradeReport;
	if (!report) return { fleetUpgradeApproved: false };
	const { upgradeable, notUpgradeable } = report.crosstab;
	const skipNote =
		notUpgradeable > 0
			? `${notUpgradeable} agent(s) are NOT Fleet-upgradeable (Wolfi/container; upgradeable:false) and will be SKIPPED -- bump their image tag upstream instead. `
			: "";
	const choice = interrupt({
		type: "fleet_upgrade_choice",
		deployment: report.deployment,
		targetVersion: report.targetVersion,
		resolvedCount: report.resolvedCount,
		upgradeableCount: upgradeable,
		notUpgradeableCount: notUpgradeable,
		rolloutSeconds: report.rolloutSeconds,
		byReason: report.crosstab.byReason,
		message:
			`${report.deployment}: ${upgradeable} Fleet agent(s) will be upgraded to ${report.targetVersion} ` +
			`over ${report.rolloutSeconds}s. ${skipNote}` +
			"This is an imperative bulk_upgrade (not Terraform). Approve to run it via CI, or decline.",
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

	// SIO-927: the apply CI script refuses when resolved_count exceeds its blast-radius cap (default
	// 500). The operator has already approved THIS report's resolved set at fleetUpgradeGate, so pass
	// resolvedCount as MAX_AGENTS -- approval == accepting the full blast radius. Preview stays uncapped
	// (we never send MAX_AGENTS on the preview trigger). Fleet's separate 10000 hard cap still applies.
	log.info(
		{ deployment, version: targetVersion, maxAgents: report.resolvedCount },
		"iac fleet upgrade: triggering apply",
	);
	const trig = parseTriggerResult(
		await callTool("gitlab_trigger_fleet_upgrade_apply", {
			deployment,
			version: targetVersion,
			maxAgents: report.resolvedCount,
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
			`fleet apply: started -- ${report.crosstab.upgradeable} agent(s) -> ${targetVersion}, ` +
			`expected ${formatRolloutDuration(report.rolloutSeconds)}`,
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
		}),
	};
	let result: FleetUpgradeResult;
	if (res.status === "success") {
		result = { status: "applied", ...common };
	} else if (res.status === "failed" || res.status === "canceled") {
		result = {
			status: "failed",
			...common,
			note: `Apply pipeline ${res.status}. ${classifyPipelineFailure(res.failureLog, res.stateLocked)}`,
		};
	} else {
		// Running past the status window: the bulk_upgrade is in flight (a long rollout we chose not
		// to block on). Report it as dispatched with the expected duration + the pipeline to track.
		const eta = report.rolloutSeconds ? ` Expected ${formatRolloutDuration(report.rolloutSeconds)}.` : "";
		result = {
			status: "dispatched",
			...common,
			note: `Upgrade started and running (status ${res.status || "running"}).${eta} Not finished within the status window; ask me to check on it or watch the pipeline.`,
		};
	}
	log.info(
		{
			deployment,
			pipelineId: trig.pipelineId,
			status: result.status,
			pipelineStatus: res.status,
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
	if (!report.versionAvailable) {
		return (
			`Target version ${report.targetVersion} is not in ${dep}'s available_versions list; ` +
			"refusing to upgrade. Confirm the target is a valid forward step."
		);
	}
	if (report.crosstab.upgradeable === 0) {
		return `No Fleet agents on ${dep} are upgradeable to ${report.targetVersion} (resolved ${report.resolvedCount}).${skipNote}`;
	}
	const result = state.fleetUpgradeResult;
	if (!result || result.status === "skipped") {
		return (
			`Fleet upgrade declined. No agents were upgraded. ${report.crosstab.upgradeable} agent(s) on ${dep} ` +
			`remain eligible for ${report.targetVersion}.${skipNote}`
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
		return `Fleet upgrade to ${report.targetVersion} on ${dep} applied (poll ${result.pollStatus ?? "?"}).${counts}${silent}${pid}${skipNote}`;
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
		return (
			`Fleet upgrade started for ${dep} -- ${report.crosstab.upgradeable} agent(s) upgrading to ` +
			`${report.targetVersion} over ${formatRolloutDuration(report.rolloutSeconds)}.${dPid}${skipNote} ` +
			"I won't block on the full rollout; ask me to check on it or watch the pipeline."
		);
	}
	// blocked | failed
	const bfPid = result.pipelineId
		? result.pipelineUrl
			? ` Apply pipeline [#${result.pipelineId}](${result.pipelineUrl}).`
			: ` Apply pipeline #${result.pipelineId}.`
		: "";
	return `Fleet upgrade ${result.status}: ${result.note ?? "see logs"}.${bfPid}${skipNote}`;
}
