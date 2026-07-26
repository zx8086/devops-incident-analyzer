// gitagent-bridge/src/model-factory.ts
import { getModelCapabilities, isKnownModel, type ModelCapabilities } from "./model-registry.ts";
import type { ModelConfig } from "./types.ts";

// SIO-1223: MODEL_MAP is gone. The name -> Bedrock-id mapping AND every capability flag now
// come from MODEL_REGISTRY, so there is no second list left to drift out of sync with it.

export interface BedrockModelConfig {
	model: string;
	region: string;
	temperature: number;
	maxTokens: number;
	/**
	 * SIO-1223: declared, probe-backed capabilities for `model`. Consumers must read this rather
	 * than re-derive anything from the id string -- substring-matching the id is exactly what
	 * NO_TEMPERATURE_MODEL_MARKERS did, and it only existed because production had already broken.
	 */
	capabilities: ModelCapabilities;
}

export function resolveBedrockConfig(
	modelConfig: ModelConfig | undefined,
	defaults: { temperature?: number; maxTokens?: number } = {},
): BedrockModelConfig {
	const preferred = modelConfig?.preferred ?? "claude-sonnet-4-6";
	// Throws with the same message as before on an unmapped name -- fail loud at resolve time.
	const capabilities = getModelCapabilities(preferred);

	return {
		model: capabilities.bedrockId,
		region: process.env.AWS_REGION ?? "eu-central-1",
		temperature: modelConfig?.constraints?.temperature ?? defaults.temperature ?? 0,
		maxTokens: modelConfig?.constraints?.max_tokens ?? defaults.maxTokens ?? 4096,
		capabilities,
	};
}

// SIO-621: Resolve fallback model from gitagent manifest fallback array.
// Returns the first valid fallback model config, or null if none are available.
export function resolveFallbackConfig(
	modelConfig: ModelConfig | undefined,
	defaults: { temperature?: number; maxTokens?: number } = {},
): BedrockModelConfig | null {
	const fallbacks = modelConfig?.fallback;
	if (!fallbacks || fallbacks.length === 0) return null;

	for (const fallback of fallbacks) {
		// Unlike the primary this does NOT throw on an unknown name: a typo'd fallback degrades
		// to "no fallback" rather than taking down the agent. Pre-existing behaviour, preserved.
		if (!isKnownModel(fallback)) continue;
		const capabilities = getModelCapabilities(fallback);
		return {
			model: capabilities.bedrockId,
			region: process.env.AWS_REGION ?? "eu-central-1",
			// Constraints come from the SAME top-level block as the primary -- there is no
			// per-model constraint, so a Haiku fallback inherits Sonnet 5's maxTokens.
			temperature: modelConfig?.constraints?.temperature ?? defaults.temperature ?? 0,
			maxTokens: modelConfig?.constraints?.max_tokens ?? defaults.maxTokens ?? 4096,
			capabilities,
		};
	}
	return null;
}

export function getRecursionLimit(maxTurns?: number): number {
	return (maxTurns ?? 25) * 2;
}
