// agent/src/llm.ts
import { ChatBedrockConverse } from "@langchain/aws";
import { resolveBedrockConfig, loadAgent, type BedrockModelConfig } from "@devops-agent/gitagent-bridge";
import { join } from "node:path";

const AGENTS_DIR = join(import.meta.dir, "../../../agents/incident-analyzer");

let cachedRootAgent: ReturnType<typeof loadAgent> | null = null;

function getRootAgent() {
  if (!cachedRootAgent) {
    cachedRootAgent = loadAgent(AGENTS_DIR);
  }
  return cachedRootAgent;
}

export type LlmRole = "orchestrator" | "classifier" | "subAgent" | "aggregator" | "responder" | "entityExtractor";

const ROLE_OVERRIDES: Record<LlmRole, Partial<BedrockModelConfig>> = {
  orchestrator: {},
  classifier: { temperature: 0 },
  subAgent: {},
  aggregator: { temperature: 0.1 },
  responder: { temperature: 0.3 },
  entityExtractor: { temperature: 0 },
};

export function createLlm(role: LlmRole): ChatBedrockConverse {
  const agent = getRootAgent();
  const isLightweight = role === "classifier" || role === "entityExtractor";

  const modelConfig = isLightweight
    ? agent.subAgents.get("elastic-agent")?.manifest.model
    : agent.manifest.model;

  const bedrockConfig = resolveBedrockConfig(modelConfig);
  const overrides = ROLE_OVERRIDES[role];

  return new ChatBedrockConverse({
    model: bedrockConfig.model,
    region: bedrockConfig.region,
    temperature: overrides.temperature ?? bedrockConfig.temperature,
    maxTokens: overrides.maxTokens ?? bedrockConfig.maxTokens,
  });
}
