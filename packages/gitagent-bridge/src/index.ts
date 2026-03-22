// gitagent-bridge/src/index.ts
export { loadAgent, type LoadedAgent } from "./manifest-loader.ts";
export { resolveBedrockConfig, getRecursionLimit, type BedrockModelConfig } from "./model-factory.ts";
export { buildSystemPrompt } from "./skill-loader.ts";
export { buildToolPrompt, buildAllToolPrompts, buildContextFromAgent, type ToolPromptContext } from "./tool-prompt.ts";
export { getRelatedTools, buildRelatedToolsMap, withRelatedTools } from "./related-tools.ts";
export { complianceToMetadata, requiresApproval } from "./compliance.ts";
export { validateToolSchemas } from "./tool-schema.ts";
export {
  AgentManifestSchema,
  ToolDefinitionSchema,
  type AgentManifest,
  type ToolDefinition,
  type ComplianceConfig,
  type ModelConfig,
} from "./types.ts";
