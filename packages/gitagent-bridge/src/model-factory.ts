// gitagent-bridge/src/model-factory.ts
import type { ModelConfig } from "./types.ts";

const MODEL_MAP: Record<string, string> = {
  "claude-sonnet-4-6": "eu.anthropic.claude-sonnet-4-6",
  "claude-haiku-4-5": "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  "claude-opus-4-6": "eu.anthropic.claude-opus-4-6",
};

export interface BedrockModelConfig {
  model: string;
  region: string;
  temperature: number;
  maxTokens: number;
}

export function resolveBedrockConfig(
  modelConfig: ModelConfig | undefined,
  defaults: { temperature?: number; maxTokens?: number } = {},
): BedrockModelConfig {
  const preferred = modelConfig?.preferred ?? "claude-sonnet-4-6";
  const bedrockId = MODEL_MAP[preferred];
  if (!bedrockId) {
    throw new Error(`Unknown model "${preferred}". Available: ${Object.keys(MODEL_MAP).join(", ")}`);
  }

  return {
    model: bedrockId,
    region: Bun.env.AWS_REGION ?? "eu-west-1",
    temperature: modelConfig?.constraints?.temperature ?? defaults.temperature ?? 0,
    maxTokens: modelConfig?.constraints?.max_tokens ?? defaults.maxTokens ?? 4096,
  };
}

export function getRecursionLimit(maxTurns?: number): number {
  return (maxTurns ?? 25) * 2;
}
