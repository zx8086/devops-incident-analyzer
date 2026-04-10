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
	aggregator: { temperature: 0.1 },
	responder: { temperature: 0.3 },
	entityExtractor: { temperature: 0 },
	followUp: { temperature: 0.5, maxTokens: 256 },
	normalizer: { temperature: 0 },
	mitigation: { temperature: 0.2 },
	actionProposal: { temperature: 0, maxTokens: 512 },
	runbookSelector: { temperature: 0, maxTokens: 512 },
};

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
	const isLightweight = role === "classifier" || role === "entityExtractor";

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
