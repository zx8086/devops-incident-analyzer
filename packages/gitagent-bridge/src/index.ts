// gitagent-bridge/src/index.ts

export { complianceToMetadata, requiresApproval } from "./compliance.ts";
export { type LoadedAgent, loadAgent } from "./manifest-loader.ts";
export { type BedrockModelConfig, getRecursionLimit, resolveBedrockConfig } from "./model-factory.ts";
export { buildRelatedToolsMap, getRelatedTools, withRelatedTools } from "./related-tools.ts";
export { buildSystemPrompt } from "./skill-loader.ts";
export { buildAllToolPrompts, buildContextFromAgent, buildToolPrompt, type ToolPromptContext } from "./tool-prompt.ts";
export { validateToolSchemas } from "./tool-schema.ts";
export {
	type AgentManifest,
	AgentManifestSchema,
	type ComplianceConfig,
	type ModelConfig,
	type ToolDefinition,
	ToolDefinitionSchema,
} from "./types.ts";
