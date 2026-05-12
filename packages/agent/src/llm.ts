// agent/src/llm.ts

import {
	type BedrockModelConfig,
	loadAgent,
	resolveBedrockConfig,
	resolveFallbackConfig,
} from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { ChatBedrockConverse } from "@langchain/aws";
import { getAgentsDir } from "./paths.ts";

const logger = getLogger("agent:llm");

let cachedRootAgent: ReturnType<typeof loadAgent> | null = null;

function getRootAgent() {
	if (!cachedRootAgent) {
		cachedRootAgent = loadAgent(getAgentsDir());
	}
	return cachedRootAgent;
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
	| "actionProposal"
	| "runbookSelector";

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
	actionProposal: { temperature: 0, maxTokens: 512 },
	runbookSelector: { temperature: 0, maxTokens: 512 },
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
	actionProposal: 60_000,
	runbookSelector: 0,
};

export function getRoleDeadlineMs(role: LlmRole): number {
	const envKey = `AGENT_LLM_TIMEOUT_${role.toUpperCase()}_MS`;
	const raw = process.env[envKey];
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
const TOOL_BINDING_ROLES: ReadonlySet<LlmRole> = new Set(["subAgent"]);

export function createLlm(role: LlmRole): ChatBedrockConverse {
	const agent = getRootAgent();
	const isLightweight = role === "classifier";

	const modelConfig = isLightweight ? agent.subAgents.get("elastic-agent")?.manifest.model : agent.manifest.model;

	const bedrockConfig = resolveBedrockConfig(modelConfig);
	const overrides = ROLE_OVERRIDES[role];
	const primary = buildChatModel(bedrockConfig, overrides);

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
