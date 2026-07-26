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
	| "absenceJudge";

// SIO-1224: exported so the model-conformance probe and the long-form truncation test read
// this exact table rather than duplicating the numbers -- a duplicate would drift silently,
// which is the failure mode this whole hardening series exists to remove.
export const ROLE_OVERRIDES: Record<LlmRole, Partial<BedrockModelConfig>> = {
	orchestrator: {},
	classifier: { temperature: 0 },
	// SIO-1225: was {} -- inheriting the orchestrator manifest's max_tokens: 4096. SIO-1224's
	// probe measured Sonnet 5 (which is what this role resolves to) needing ~4,300-4,700 output
	// tokens for a full report and TRUNCATING at 4096, where Haiku 4.5 finished in 3,874 and
	// Opus 4.8 in 2,964. A truncated sub-agent report is the SIO-649 failure one layer down: the
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
};

// SIO-1224: roles whose output is prose or a complete JSON document that must not be cut off
// mid-generation. Their effective maxTokens has to clear the active model's measured
// long-form floor, or the answer truncates -- the exact SIO-649 failure (a report cut before
// its mandatory trailing Confidence line, leaving the HITL gate a 0 score), which a more
// verbose model reproduces at a budget that used to be ample.
//
// Membership is narrow ON PURPOSE. SIO-1224's probe measured Sonnet 5 needing ~4,300-4,700
// output tokens for a full six-section incident report, making 8192 the smallest CONFIGURED
// budget that clears it. Applying that floor to a role that emits a compact JSON envelope
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

export function createLlm(role: LlmRole, agentName = "incident-analyzer"): ChatBedrockConverse {
	const agent = getAgentForLlm(agentName);
	const isLightweight = isLightweightRole(role);

	// KNOWN FRAGILITY: the light tier borrows the elastic-agent sub-agent manifest's
	// model (haiku). There is no dedicated light-model config; if the elastic-agent
	// manifest changes model, every light-tier role follows it.
	const modelConfig = isLightweight ? agent.subAgents.get("elastic-agent")?.manifest.model : agent.manifest.model;

	const bedrockConfig = resolveBedrockConfig(modelConfig);
	const overrides = ROLE_OVERRIDES[role];
	const primary = buildChatModel(role, bedrockConfig, overrides);

	// SIO-621: Wrap with fallback model from gitagent manifest if available.
	// Skip for tool-binding roles (subAgent) because createReactAgent requires
	// bindTools() which RunnableWithFallbacks does not implement.
	if (TOOL_BINDING_ROLES.has(role)) {
		logger.info({ role, tier: isLightweight ? "light" : "standard", model: bedrockConfig.model }, "LLM model selected");
		return primary;
	}

	const fallbackConfig = resolveFallbackConfig(modelConfig);
	if (!fallbackConfig) {
		logger.info({ role, tier: isLightweight ? "light" : "standard", model: bedrockConfig.model }, "LLM model selected");
		return primary;
	}

	const fallback = buildChatModel(role, fallbackConfig, overrides);
	logger.info(
		{ role, tier: isLightweight ? "light" : "standard", model: bedrockConfig.model, fallback: fallbackConfig.model },
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
