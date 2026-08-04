// agent/src/llm.ts

import {
	type BedrockModelConfig,
	loadAgent,
	resolveBedrockConfig,
	resolveFallbackConfig,
} from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { ChatBedrockConverse } from "@langchain/aws";
import type { BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { getAgentsDir } from "./paths.ts";

const logger = getLogger("agent:llm");

// Per-agent manifest cache so the elastic-iac graph resolves its own model config
// without disturbing the incident-analyzer default.
const agentCache = new Map<string, ReturnType<typeof loadAgent>>();

function getAgentForLlm(agentName: string) {
	let agent = agentCache.get(agentName);
	if (!agent) {
		agent = loadAgent(getAgentsDir(agentName));
		agentCache.set(agentName, agent);
	}
	return agent;
}

export type LlmRole =
	| "orchestrator"
	| "classifier"
	| "subAgent"
	| "aggregator"
	| "responder"
	| "entityExtractor"
	| "followUp"
	| "normalizer"
	| "mitigation"
	| "mitigateInvestigate"
	| "mitigateMonitor"
	| "mitigateEscalate"
	| "actionProposal"
	| "runbookSelector"
	| "awsEstateRouter"
	// elastic-iac graph roles
	| "iacPlanner"
	| "iacDrafter"
	| "iacReviewer"
	// SIO-870: read-vs-write classification + read-only info answering for elastic-iac
	| "iacClassifier"
	| "iacReader"
	// SIO-1015: post-turn worthiness judge for the skill-learning subsystem.
	| "skillLearner"
	// SIO-1126: HIL learning distiller (diff agent diagnosis vs human resolution).
	| "hilDistiller"
	// SIO-1149: degrading-gaps veto judge -- confirms regex-flagged Gaps bullets
	// before the confidence cap applies. Only runs on would-cap paths.
	| "gapsJudge"
	// SIO-1158: contradicted-absence veto judge -- confirms regex-flagged absence
	// claims against the flagging datasource's returned data before the cap applies.
	| "absenceJudge"
	// SIO-1357: composes a SkillsFlow `skill:` step's SKILL.md body with the
	// closing turn's context into one LLM call (the incident-close workflow's
	// postmortem/wiki-ingest steps).
	| "closureSkillStep";

// SIO-1224: exported so the model-conformance probe and the long-form truncation test read
// this exact table rather than duplicating the numbers -- a duplicate would drift silently,
// which is the failure mode this whole hardening series exists to remove.
export const ROLE_OVERRIDES: Record<LlmRole, Partial<BedrockModelConfig>> = {
	orchestrator: {},
	classifier: { temperature: 0 },
	// SIO-1225: was {} -- inheriting the orchestrator manifest's max_tokens: 4096. SIO-1224's
	// probe measured Sonnet 5 (which is what this role resolves to) emitting ~3,900-4,300 output
	// tokens for a full report and TRUNCATING at 4096, where Haiku 4.5 finished the same report in
	// 3,289 and Opus 4.8 in 3,094. A truncated sub-agent report is the SIO-649 failure one layer down: the
	// findings block is cut off and the aggregator silently correlates less than was found.
	subAgent: { maxTokens: 8192 },
	// SIO-649: Multi-deployment elastic fan-out produces reports with a per-deployment
	// findings block (10 deployments = 10 tables) plus a mandatory trailing Confidence line.
	// Default maxTokens was truncating the end of the report before the confidence line,
	// leaving the HITL gate with a 0 score. 16384 matches responder for consistency.
	aggregator: { temperature: 0.1, maxTokens: 16384 },
	responder: { temperature: 0.3, maxTokens: 16384 },
	entityExtractor: { temperature: 0 },
	followUp: { temperature: 0.5, maxTokens: 256 },
	normalizer: { temperature: 0 },
	mitigation: { temperature: 0.2 },
	mitigateInvestigate: { temperature: 0.2 },
	mitigateMonitor: { temperature: 0.2 },
	mitigateEscalate: { temperature: 0.2 },
	actionProposal: { temperature: 0, maxTokens: 512 },
	runbookSelector: { temperature: 0, maxTokens: 512 },
	awsEstateRouter: { temperature: 0, maxTokens: 256 },
	// elastic-iac: deterministic intent/guard parsing; the drafter writes Terraform diffs.
	// SIO-1225: iacPlanner raised 2048 -> 8192. Its intent JSON embeds VERBATIM user-pasted
	// documents (ilmFullPolicy, phasesPatch, userSettingsYaml, ingest-pipeline bodies), so its
	// output scales with whatever the operator pasted -- the least bounded output in the repo,
	// and it had the smallest budget. Truncation here does not error: parseIntentJson falls
	// through to "Which cluster and what change should I make?", silently turning a valid
	// gitops request into a re-ask.
	iacPlanner: { temperature: 0, maxTokens: 8192 },
	iacDrafter: { temperature: 0.1, maxTokens: 8192 },
	iacReviewer: { temperature: 0, maxTokens: 4096 },
	iacClassifier: { temperature: 0, maxTokens: 16 },
	// SIO-1225: 4096 -> 8192. Primary is Opus 4.8 (measured floor 4096) but the manifest
	// FALLBACK is Sonnet 5 (floor 8192), so the old budget truncated a long info answer
	// whenever the chain failed over -- the failure mode a fallback is supposed to prevent.
	iacReader: { temperature: 0, maxTokens: 8192 },
	// SIO-1015: deterministic worthiness judgment + a compact skill proposal as JSON.
	skillLearner: { temperature: 0, maxTokens: 1024 },
	// SIO-1126: deterministic distillation of a resolved ticket into a structured
	// LearningProposal (root cause + facts as JSON).
	// SIO-1225: 4096 -> 8192. The proposal carries a root cause, up to 10 bindings, 3 heuristics
	// and 6 memory facts, each with 1-3 VERBATIM evidence quotes from the ticket, and it runs on
	// Sonnet 5 (measured floor 8192). A truncated proposal fails the JSON parse and the user is
	// told the ticket "could not be distilled".
	hilDistiller: { temperature: 0, maxTokens: 8192 },
	// SIO-1149: deterministic per-bullet verdicts as compact JSON.
	gapsJudge: { temperature: 0, maxTokens: 1024 },
	// SIO-1158: deterministic per-claim verdicts as compact JSON.
	absenceJudge: { temperature: 0, maxTokens: 1024 },
	// SIO-1357: a skill step's output is a full document (postmortem markdown,
	// wiki page body) -- matches responder/aggregator's long-form budget rather
	// than a compact-JSON role's.
	closureSkillStep: { temperature: 0.2, maxTokens: 16384 },
};

// SIO-1224: roles whose output is prose or a complete JSON document that must not be cut off
// mid-generation. Their effective maxTokens has to clear the active model's measured
// long-form floor, or the answer truncates -- the exact SIO-649 failure (a report cut before
// its mandatory trailing Confidence line, leaving the HITL gate a 0 score), which a more
// verbose model reproduces at a budget that used to be ample.
//
// Membership is narrow ON PURPOSE. SIO-1224's probe measured Sonnet 5 emitting ~3,900-4,300
// output tokens for a full six-section incident report and truncating at a 4096 cap, making 8192
// the smallest CONFIGURED budget that clears it. Applying that floor to a role that emits a compact JSON envelope
// would inflate its budget for nothing, so only roles whose output is genuinely a long
// document belong here.
//
// Excluded as compact-output, with their effective budgets: normalizer (4096 manifest),
// entityExtractor (4096), mitigation + mitigate* (4096, bullet lists), skillLearner (1024,
// a fixed five-field proposal capped at "1-4 sentences"), classifier, iacClassifier (16),
// awsEstateRouter (256), followUp (256), actionProposal (512), runbookSelector (512),
// gapsJudge (1024), absenceJudge (1024). `orchestrator` and `iacReviewer` are excluded because
// they are declared but never constructed -- verified: no createLlm("orchestrator") or
// createLlm("iacReviewer") call site exists outside tests, so budgeting them proves nothing.
export const LONG_FORM_ROLES: ReadonlySet<LlmRole> = new Set<LlmRole>([
	"aggregator",
	"responder",
	"subAgent",
	"iacDrafter",
	"iacReader",
	"hilDistiller",
	// The sharpest case: iacPlanner's intent JSON embeds VERBATIM user-pasted documents
	// (ilmFullPolicy, phasesPatch, userSettingsYaml), so its output scales with the paste. It
	// held the lowest budget of any role in this set (2048) until SIO-1225 raised it to 8192.
	"iacPlanner",
	// SIO-1357: postmortem/wiki-page prose, structurally the same shape as responder's report.
	"closureSkillStep",
]);

// SIO-739: Per-role wall-clock deadline for non-streaming llm.invoke calls. A
// value of 0 disables the per-call timer for that role (the graph-level signal
// is still in force). Defaults cover the post-validate non-streaming hang
// surface; other roles opt in when they need it.
export const ROLE_DEADLINES_MS: Record<LlmRole, number> = {
	orchestrator: 0,
	classifier: 0,
	subAgent: 0,
	aggregator: 0,
	responder: 0,
	entityExtractor: 0,
	followUp: 60_000,
	normalizer: 0,
	mitigation: 120_000,
	// SIO-741: each branch does ~1/3 the work of the old monolithic mitigation call.
	mitigateInvestigate: 60_000,
	mitigateMonitor: 60_000,
	mitigateEscalate: 60_000,
	actionProposal: 60_000,
	runbookSelector: 0,
	awsEstateRouter: 30_000,
	iacPlanner: 60_000,
	iacDrafter: 120_000,
	iacReviewer: 60_000,
	iacClassifier: 30_000,
	iacReader: 120_000,
	// SIO-1015: post-turn, off the critical path; bound it so a slow judge never lingers.
	skillLearner: 60_000,
	// SIO-1126: user-facing but interactive (the review gate follows); bound it.
	hilDistiller: 120_000,
	// SIO-1149: on the aggregate critical path (would-cap runs only); a slow judge
	// must never stall the report -- fail-closed to the regex verdict instead.
	gapsJudge: 8_000,
	// SIO-1158: same profile as gapsJudge -- would-cap runs only, fail-closed.
	absenceJudge: 8_000,
	// SIO-1357: post-turn background workflow, off the critical path entirely --
	// bound it generously (long-form prose) so a hung call is never silently
	// unbounded, but never so tight that a real postmortem call gets cut short.
	closureSkillStep: 120_000,
};

// SIO-739: Convert camelCase LlmRole to SCREAMING_SNAKE for env-var keys.
// followUp -> FOLLOW_UP; actionProposal -> ACTION_PROPOSAL; runbookSelector -> RUNBOOK_SELECTOR.
function roleToEnvSegment(role: LlmRole): string {
	return role.replace(/([A-Z])/g, "_$1").toUpperCase();
}

export function getRoleDeadlineMs(role: LlmRole, env: NodeJS.ProcessEnv = process.env): number {
	const envKey = `AGENT_LLM_TIMEOUT_${roleToEnvSegment(role)}_MS`;
	const raw = env[envKey];
	if (raw != null && raw !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
	}
	return ROLE_DEADLINES_MS[role];
}

export class DeadlineExceededError extends Error {
	constructor(
		public readonly role: LlmRole,
		public readonly deadlineMs: number,
	) {
		super(`LLM call for role '${role}' exceeded deadline of ${deadlineMs}ms`);
		this.name = "DeadlineExceededError";
	}
}

// SIO-1214: Claude's 4.7+/5 generation rejects `temperature` outright -- "`temperature` is
// deprecated for this model" -- rather than accepting and ignoring it like prior generations,
// so sending it hard-fails every call for that role.
//
// SIO-1223: this used to be a local NO_TEMPERATURE_MODEL_MARKERS substring list, a SECOND model
// registry living in a different package from MODEL_MAP with nothing keeping the two in step --
// SIO-1213 added to one, production broke, and SIO-1214 retrofitted the other. The capability is
// now declared once, per model, in MODEL_REGISTRY and carried on the resolved config.
// SIO-1226: token accounting. Before this, nothing in the repo could see LLM token use or
// cost: buildChatModel passed no callbacks and packages/observability has no usage surface, so
// the only "budget" was graph-budget.ts's wall clock. A per-token price change or a verbosity
// regression -- exactly what SIO-1213 introduced -- was therefore unobservable and ungated; we
// could infer the model change was expensive but never measure it.
//
// Attached here rather than in invokeWithDeadline because only 8 call sites use that helper;
// the highest-token roles (aggregator and responder at 16384, and subAgent across up to 40
// ReAct iterations) call invoke directly or run inside createReactAgent. A callback on the
// model instance covers every path, streaming included.
//
// Reads usage from the two places LangChain has put it, and stays silent rather than throwing
// if a future version moves it again -- telemetry must never break an answer.
function logTokenUsage(role: LlmRole, model: string, output: unknown): void {
	const result = output as {
		llmOutput?: { usage?: Record<string, unknown> };
		generations?: Array<Array<{ message?: { usage_metadata?: Record<string, unknown> } }>>;
	};
	const usage = result.generations?.[0]?.[0]?.message?.usage_metadata ?? result.llmOutput?.usage;
	if (!usage) return;
	const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
	logger.info(
		{
			role,
			model,
			inputTokens: num(usage.input_tokens) ?? num(usage.inputTokens),
			outputTokens: num(usage.output_tokens) ?? num(usage.outputTokens),
			totalTokens: num(usage.total_tokens) ?? num(usage.totalTokens),
		},
		"LLM token usage",
	);
}

function buildChatModel(
	role: LlmRole,
	bedrockConfig: BedrockModelConfig,
	overrides: Partial<BedrockModelConfig>,
): ChatBedrockConverse {
	const temperature = overrides.temperature ?? bedrockConfig.temperature;
	return new ChatBedrockConverse({
		model: bedrockConfig.model,
		region: bedrockConfig.region,
		maxTokens: overrides.maxTokens ?? bedrockConfig.maxTokens,
		...(bedrockConfig.capabilities.acceptsTemperature ? { temperature } : {}),
		// SIO-1271: stamp the ROLE on the model instance so a consumer of the LangGraph event
		// stream can tell the answer-producing call from the utility calls that share its node.
		// FOUR LLM calls run under langgraph_node "aggregate" -- the aggregator itself plus
		// gapsJudge and both absenceJudge arms -- so the SSE pump's node-scoped filter forwarded
		// all four to the browser, appending raw judge JSON after the report body.
		//
		// Attached here rather than in invokeWithDeadline for the same reason as the callbacks
		// above: the model instance covers every path (streaming and createReactAgent included),
		// whereas that helper covers only 8 call sites and the aggregator does not use it.
		// LangChain carries these as NON-inheritable locals, so `role` never leaks onto child
		// runs: base.cjs sets this.tags/this.metadata, chat_models.cjs passes them to
		// CallbackManager.configure, and event_stream.cjs surfaces them on on_chat_model_stream.
		tags: [`role:${role}`],
		metadata: { role },
		callbacks: [
			{
				handleLLMEnd: (output: unknown) => {
					try {
						logTokenUsage(role, bedrockConfig.model, output);
					} catch {
						// never let telemetry break a turn
					}
				},
			},
		],
	});
}

// SIO-621: Roles that are passed to createReactAgent need bindTools(), which
// RunnableWithFallbacks does not implement. Only wrap invoke-only roles with fallbacks.
// (iacReader binds tools via createLlmWithTools, which handles the fallback itself.)
const TOOL_BINDING_ROLES: ReadonlySet<LlmRole> = new Set(["subAgent"]);

// SIO-1040: model tiering. A role in DEFAULT_LIGHTWEIGHT_ROLES runs on the light
// model (the borrowed elastic-agent manifest -> haiku) unless an env override says
// otherwise. Rollout shipped classifier-only; gapsJudge (SIO-1149) is light by design
// (a per-bullet boolean verdict needs no frontier model). The others are eligible to
// be flipped to light per-role via AGENT_LLM_TIER_<ROLE>=light after a LangSmith
// replay eval, without a code change.
//
// SIO-1225 CORRECTION: this comment previously claimed "a light-model failure falls UP to the
// standard manifest model". It does not. The light tier resolves its config from the borrowed
// elastic-agent sub-agent manifest, and resolveFallbackConfig reads the fallback list from that
// SAME config -- the sub-agent manifests declare no `fallback:` key, so it returns null and
// light-tier roles have NO fallback at all. Flipping a role to light therefore trades a
// Sonnet-5-with-Haiku-fallback for a bare Haiku.
const DEFAULT_LIGHTWEIGHT_ROLES: ReadonlySet<LlmRole> = new Set(["classifier", "gapsJudge", "absenceJudge"]);
const TIERABLE_ROLES: ReadonlySet<LlmRole> = new Set([
	"classifier",
	"entityExtractor",
	"normalizer",
	"awsEstateRouter",
	"runbookSelector",
	"followUp",
	"actionProposal",
	"gapsJudge",
	"absenceJudge",
]);

export function isLightweightRole(role: LlmRole, env: NodeJS.ProcessEnv = process.env): boolean {
	if (!TIERABLE_ROLES.has(role)) return false;
	const raw = env[`AGENT_LLM_TIER_${roleToEnvSegment(role)}`]?.toLowerCase();
	if (raw === "light") return true;
	if (raw === "standard") return false;
	return DEFAULT_LIGHTWEIGHT_ROLES.has(role);
}

type LoadedAgentForLlm = ReturnType<typeof getAgentForLlm>;
type ManifestModelConfig = LoadedAgentForLlm["manifest"]["model"];

// Which manifest the model came from. Emitted on every "LLM model selected" line so an
// operator can tell a specialist running its own model from one silently inheriting root's.
export type ModelConfigSource = "light-tier" | "sub-agent-manifest" | "root-manifest";

// SIO-1235: default ON (the RESOLVE_IDENTIFIERS_ENABLED idiom), read at CALL time so flipping
// it needs only a container restart, not a redeploy. Set to false (or 0) to put all 7
// specialists back on the root manifest's model in one move.
export function isSubAgentManifestModelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.SUB_AGENT_MANIFEST_MODEL_ENABLED;
	return v !== "false" && v !== "0";
}

// SIO-1262/SIO-1372: default light-tier model, used only when the root manifest's
// `lightTierModel:` key is absent (a manifest predating SIO-1372, or a test fixture). Haiku 4.5
// is probed, accepts temperature, and is what the tier was resolving to before this became
// manifest-configurable. The normal, supported way to change the light tier's model is editing
// `lightTierModel:` in agent.yaml, not this constant.
const LIGHT_TIER_MODEL = { preferred: "claude-haiku-4-5" } as const;

// SIO-1371: eval-only model-swap A/B override, read at CALL time (same idiom as
// SUB_AGENT_MANIFEST_MODEL_ENABLED above) so it never needs a redeploy and can never leak into
// a normal run by accident -- both env vars are unset in every environment except a deliberate
// eval invocation. Substitutes the resolved `preferred` (and drops any manifest `fallback`, since
// the override is meant to isolate ONE model's behavior, not its production fallback chain) AFTER
// resolveRoleModelConfig has already picked light-tier / sub-agent-manifest / root-manifest, so
// the override composes with the real precedence rule instead of replacing it -- an eval run using
// this still exercises the same source-selection logic production does.
//
// Deliberately narrow: this exists to let run-incident-replay-eval.ts A/B sub-agent model swaps
// (e.g. the SIO-1367 claude-haiku-4-5 move against its claude-sonnet-4-6 predecessor) without ever
// touching a committed agent.yaml, not as a general-purpose config mechanism. Do not read these
// vars anywhere outside the eval harness.
const warnedEvalOverrides = new Set<string>();

function applyEvalModelOverride(
	role: LlmRole,
	modelConfig: ManifestModelConfig,
	env: NodeJS.ProcessEnv,
): ManifestModelConfig {
	const override = role === "subAgent" ? env.EVAL_SUB_AGENT_MODEL_OVERRIDE : env.EVAL_ROOT_MODEL_OVERRIDE;
	if (!override) return modelConfig;
	// CodeRabbit PR #590: an override silently rerouting model resolution would be invisible in
	// a misconfigured production environment. Warn once per role+model so ANY activation is
	// loud in the logs -- in a deliberate eval run this is expected noise; anywhere else it is
	// the signal that an EVAL_* var leaked into an environment it must never be set in.
	const warnKey = `${role}:${override}`;
	if (!warnedEvalOverrides.has(warnKey)) {
		warnedEvalOverrides.add(warnKey);
		logger.warn({ role, override }, "EVAL model override ACTIVE -- eval-only seam, never set in production");
	}
	// CodeRabbit (PR #589): a bare { preferred: override } dropped the resolved manifest's
	// `constraints` too -- for lightTierModel that silently turned temperature: 0 into the
	// provider default under an eval override, changing generation behavior, not just the model.
	return { ...modelConfig, preferred: override, fallback: undefined };
}

// SIO-1235: the whole precedence rule in one readable, unit-testable place.
//
// The defect this replaces: every non-lightweight role -- INCLUDING subAgent -- resolved from
// the ROOT manifest, so all 7 sub-agent manifests' `model.preferred: claude-haiku-4-5` had never
// taken effect since the original scaffold (125b3f9e). That is why SIO-1213 flipping one line in
// the root agent.yaml silently moved all seven specialists onto Sonnet 5.
//
// Precedence: light tier > sub-agent manifest > root manifest. Only the `subAgent` role consults
// subAgentName, so the ~25 other call sites keep their exact previous behaviour.
function resolveRoleModelConfigBySource(
	role: LlmRole,
	agent: LoadedAgentForLlm,
	subAgentName: string | undefined,
): { modelConfig: ManifestModelConfig; source: ModelConfigSource } {
	// SIO-1262: the light tier used to BORROW the elastic-agent sub-agent manifest's model. The
	// comment here flagged that as a known fragility with decoupling left as a follow-up; this
	// ticket forced the follow-up. Moving the seven specialists onto Sonnet 4.6 would otherwise
	// have dragged every light-tier role -- classifier, followUp, runbookSelector, awsEstateRouter
	// and the rest, all high-frequency and deliberately cheap -- onto a ~3x costlier model as a
	// pure side effect. Nothing in the change would have said so; the SIO-1214 temperature test is
	// what caught it.
	//
	// The light tier now NAMES its own model rather than inheriting one, so a specialist bump can
	// never reprice it again. Haiku 4.5 is what it was effectively resolving to before this change,
	// is probed, and accepts temperature.
	//
	// SIO-1372: this model now lives in the root manifest's `lightTierModel:` key, not a hardcoded
	// constant -- the isolation SIO-1262 wanted comes from it being an independent YAML field (it
	// inherits from nothing), not from living in code. LIGHT_TIER_MODEL is kept only as the
	// fallback for a manifest that predates this field, so an unedited agent.yaml keeps behaving
	// exactly as before.
	if (isLightweightRole(role)) {
		return { modelConfig: agent.manifest.lightTierModel ?? LIGHT_TIER_MODEL, source: "light-tier" };
	}

	if (role === "subAgent" && subAgentName && isSubAgentManifestModelEnabled()) {
		const sub = agent.subAgents.get(subAgentName);
		if (!sub) {
			// Degrade loudly: a sub-agent absent from the orchestrator's `agents:` map is the
			// SIO-1229 class of bug, and silently using root's model is how it stayed invisible.
			logger.warn({ role, subAgentName }, "Sub-agent not found in manifest; falling back to root model");
		} else if (!sub.manifest.model?.preferred) {
			logger.warn({ role, subAgentName }, "Sub-agent manifest declares no model.preferred; falling back to root");
		} else {
			return { modelConfig: sub.manifest.model, source: "sub-agent-manifest" };
		}
	}

	return { modelConfig: agent.manifest.model, source: "root-manifest" };
}

export function resolveRoleModelConfig(
	role: LlmRole,
	agent: LoadedAgentForLlm,
	subAgentName?: string,
	env: NodeJS.ProcessEnv = process.env,
): { modelConfig: ManifestModelConfig; source: ModelConfigSource } {
	const resolved = resolveRoleModelConfigBySource(role, agent, subAgentName);
	// SIO-1371: applied AFTER the real precedence rule picks a source, so an eval override
	// composes with light-tier/sub-agent-manifest/root-manifest instead of bypassing it. The
	// `source` field is left untouched -- an override changes WHICH model a role gets, not
	// which manifest it would have come from, so provenance logging stays honest.
	return { modelConfig: applyEvalModelOverride(role, resolved.modelConfig, env), source: resolved.source };
}

export function createLlm(role: LlmRole, agentName = "incident-analyzer", subAgentName?: string): ChatBedrockConverse {
	const agent = getAgentForLlm(agentName);
	const isLightweight = isLightweightRole(role);

	const resolved = resolveRoleModelConfig(role, agent, subAgentName);
	let { modelConfig, source } = resolved;

	// SIO-1235: resolveBedrockConfig THROWS on a model name absent from MODEL_REGISTRY. Fail-loud
	// is right for the root manifest -- a bad root model should stop the process, not run on a
	// guess. But a typo in ONE specialist's yaml must not take that datasource offline for the
	// whole run, so the throw is caught on the new sub-agent path ONLY. Every pre-existing path
	// keeps its throw untouched.
	let bedrockConfig: BedrockModelConfig;
	if (source === "sub-agent-manifest") {
		try {
			bedrockConfig = resolveBedrockConfig(modelConfig);
		} catch (error) {
			logger.error(
				{ role, subAgentName, error: error instanceof Error ? error.message : String(error) },
				"Sub-agent manifest model is not in MODEL_REGISTRY; falling back to root model",
			);
			modelConfig = agent.manifest.model;
			source = "root-manifest";
			bedrockConfig = resolveBedrockConfig(modelConfig);
		}
	} else {
		bedrockConfig = resolveBedrockConfig(modelConfig);
	}

	// `tier` is kept VERBATIM on all three log lines below -- operator log filters depend on it.
	// `source`/`subAgentName` are additive.
	const provenance = { source, ...(source === "sub-agent-manifest" ? { subAgentName } : {}) };
	const overrides = ROLE_OVERRIDES[role];
	const primary = buildChatModel(role, bedrockConfig, overrides);

	// SIO-621: Wrap with fallback model from gitagent manifest if available.
	// Skip for tool-binding roles (subAgent) because createReactAgent requires
	// bindTools() which RunnableWithFallbacks does not implement.
	if (TOOL_BINDING_ROLES.has(role)) {
		logger.info(
			{ role, tier: isLightweight ? "light" : "standard", model: bedrockConfig.model, ...provenance },
			"LLM model selected",
		);
		return primary;
	}

	const fallbackConfig = resolveFallbackConfig(modelConfig);
	if (!fallbackConfig) {
		logger.info(
			{ role, tier: isLightweight ? "light" : "standard", model: bedrockConfig.model, ...provenance },
			"LLM model selected",
		);
		return primary;
	}

	const fallback = buildChatModel(role, fallbackConfig, overrides);
	logger.info(
		{
			role,
			tier: isLightweight ? "light" : "standard",
			model: bedrockConfig.model,
			fallback: fallbackConfig.model,
			...provenance,
		},
		"LLM model selected",
	);
	return primary.withFallbacks({ fallbacks: [fallback] }) as unknown as ChatBedrockConverse;
}

// SIO-870: createLlm cannot return a tool-bound model with a fallback because
// RunnableWithFallbacks has no bindTools. This binds the tools to BOTH the primary
// and the manifest fallback first, then wraps -- so a tool-calling node (answerInfo)
// keeps fallback resilience even if the manifest's preferred model is ever unusable
// (see SIO-872: bare, non-suffixed model ids can be invalid Bedrock inference-profile ids).
export function createLlmWithTools(
	role: LlmRole,
	tools: StructuredToolInterface[],
	agentName = "incident-analyzer",
): Runnable<BaseMessage[], BaseMessage> {
	const agent = getAgentForLlm(agentName);
	const modelConfig = agent.manifest.model;
	const overrides = ROLE_OVERRIDES[role];

	const bedrockConfig = resolveBedrockConfig(modelConfig);
	const primary = buildChatModel(role, bedrockConfig, overrides).bindTools(tools);
	const fallbackConfig = resolveFallbackConfig(modelConfig);
	if (!fallbackConfig) {
		logger.info({ role, model: bedrockConfig.model }, "LLM model selected");
		return primary as unknown as Runnable<BaseMessage[], BaseMessage>;
	}

	const fallback = buildChatModel(role, fallbackConfig, overrides).bindTools(tools);
	logger.info({ role, model: bedrockConfig.model, fallback: fallbackConfig.model }, "LLM model selected");
	return primary.withFallbacks({ fallbacks: [fallback] }) as unknown as Runnable<BaseMessage[], BaseMessage>;
}

// SIO-739: Wrap llm.invoke with a per-role wall-clock deadline merged into
// the LangGraph RunnableConfig signal. The local AbortController is private,
// so we can distinguish a local-deadline trip from an external graph abort
// and only convert the former into DeadlineExceededError.
export type InvokableLlm = {
	invoke: (
		messages: unknown,
		config?: { signal?: AbortSignal; [key: string]: unknown },
	) => Promise<{ content: unknown }>;
};

export async function invokeWithDeadline<TLlm extends InvokableLlm>(
	llm: TLlm,
	role: LlmRole,
	messages: Parameters<TLlm["invoke"]>[0],
	config?: { signal?: AbortSignal; [key: string]: unknown },
): Promise<Awaited<ReturnType<TLlm["invoke"]>>> {
	const deadlineMs = getRoleDeadlineMs(role);

	// deadline === 0 → no per-call timer; just pass through.
	if (deadlineMs === 0) {
		return (await llm.invoke(messages, config)) as Awaited<ReturnType<TLlm["invoke"]>>;
	}

	const localController = new AbortController();
	const timer = setTimeout(() => localController.abort(), deadlineMs);
	const externalSignal = config?.signal;
	const merged = externalSignal ? AbortSignal.any([externalSignal, localController.signal]) : localController.signal;

	try {
		const response = await llm.invoke(messages, { ...config, signal: merged });
		return response as Awaited<ReturnType<TLlm["invoke"]>>;
	} catch (err) {
		if (localController.signal.aborted && err instanceof Error && err.name === "AbortError") {
			throw new DeadlineExceededError(role, deadlineMs);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
