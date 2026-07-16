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
	| "hilDistiller";

const ROLE_OVERRIDES: Record<LlmRole, Partial<BedrockModelConfig>> = {
	orchestrator: {},
	classifier: { temperature: 0 },
	subAgent: {},
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
	iacPlanner: { temperature: 0, maxTokens: 2048 },
	iacDrafter: { temperature: 0.1, maxTokens: 8192 },
	iacReviewer: { temperature: 0, maxTokens: 4096 },
	iacClassifier: { temperature: 0, maxTokens: 16 },
	iacReader: { temperature: 0, maxTokens: 4096 },
	// SIO-1015: deterministic worthiness judgment + a compact skill proposal as JSON.
	skillLearner: { temperature: 0, maxTokens: 1024 },
	// SIO-1126: deterministic distillation of a resolved ticket into a structured
	// LearningProposal (root cause + facts as JSON).
	hilDistiller: { temperature: 0, maxTokens: 4096 },
};

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

function buildChatModel(
	bedrockConfig: BedrockModelConfig,
	overrides: Partial<BedrockModelConfig>,
): ChatBedrockConverse {
	return new ChatBedrockConverse({
		model: bedrockConfig.model,
		region: bedrockConfig.region,
		temperature: overrides.temperature ?? bedrockConfig.temperature,
		maxTokens: overrides.maxTokens ?? bedrockConfig.maxTokens,
	});
}

// SIO-621: Roles that are passed to createReactAgent need bindTools(), which
// RunnableWithFallbacks does not implement. Only wrap invoke-only roles with fallbacks.
// (iacReader binds tools via createLlmWithTools, which handles the fallback itself.)
const TOOL_BINDING_ROLES: ReadonlySet<LlmRole> = new Set(["subAgent"]);

// SIO-1040: model tiering. A role in DEFAULT_LIGHTWEIGHT_ROLES runs on the light
// model (the borrowed elastic-agent manifest -> haiku) unless an env override says
// otherwise. Rollout ships classifier-only (status quo); the others are eligible to
// be flipped to light per-role via AGENT_LLM_TIER_<ROLE>=light after a LangSmith
// replay eval, without a code change. Every tierable role is invoke-only (not in
// TOOL_BINDING_ROLES), so withFallbacks is unchanged and a light-model failure falls
// UP to the standard manifest model.
const DEFAULT_LIGHTWEIGHT_ROLES: ReadonlySet<LlmRole> = new Set(["classifier"]);
const TIERABLE_ROLES: ReadonlySet<LlmRole> = new Set([
	"classifier",
	"entityExtractor",
	"normalizer",
	"awsEstateRouter",
	"runbookSelector",
	"followUp",
	"actionProposal",
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
	const primary = buildChatModel(bedrockConfig, overrides);
	logger.debug({ role, tier: isLightweight ? "light" : "standard", model: bedrockConfig.model }, "LLM tier resolved");

	// SIO-621: Wrap with fallback model from gitagent manifest if available.
	// Skip for tool-binding roles (subAgent) because createReactAgent requires
	// bindTools() which RunnableWithFallbacks does not implement.
	if (TOOL_BINDING_ROLES.has(role)) return primary;

	const fallbackConfig = resolveFallbackConfig(modelConfig);
	if (!fallbackConfig) return primary;

	const fallback = buildChatModel(fallbackConfig, overrides);
	logger.debug({ role, primary: bedrockConfig.model, fallback: fallbackConfig.model }, "LLM created with fallback");
	return primary.withFallbacks({ fallbacks: [fallback] }) as unknown as ChatBedrockConverse;
}

// SIO-870: createLlm cannot return a tool-bound model with a fallback because
// RunnableWithFallbacks has no bindTools. This binds the tools to BOTH the primary
// and the manifest fallback first, then wraps -- so a tool-calling node (answerInfo)
// keeps fallback resilience even when the manifest's preferred model is unusable
// (elastic-iac prefers claude-opus-4-6, which is not a valid Bedrock id here).
export function createLlmWithTools(
	role: LlmRole,
	tools: StructuredToolInterface[],
	agentName = "incident-analyzer",
): Runnable<BaseMessage[], BaseMessage> {
	const agent = getAgentForLlm(agentName);
	const modelConfig = agent.manifest.model;
	const overrides = ROLE_OVERRIDES[role];

	const primary = buildChatModel(resolveBedrockConfig(modelConfig), overrides).bindTools(tools);
	const fallbackConfig = resolveFallbackConfig(modelConfig);
	if (!fallbackConfig) return primary as unknown as Runnable<BaseMessage[], BaseMessage>;

	const fallback = buildChatModel(fallbackConfig, overrides).bindTools(tools);
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
