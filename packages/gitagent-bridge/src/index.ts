// gitagent-bridge/src/index.ts

export { complianceToMetadata, requiresApproval } from "./compliance.ts";
export { type KnowledgeEntry, type LoadedAgent, loadAgent } from "./manifest-loader.ts";
export {
	type BedrockModelConfig,
	getRecursionLimit,
	resolveBedrockConfig,
	resolveFallbackConfig,
} from "./model-factory.ts";
export { buildRelatedToolsMap, getRelatedTools, withRelatedTools } from "./related-tools.ts";
export { buildSystemPrompt } from "./skill-loader.ts";
export {
	buildFacadeMap,
	type FacadeMap,
	getActionKeywords,
	getAllActionToolNames,
	getAvailableActions,
	getUncoveredTools,
	matchActionsByKeywords,
	matchesPattern,
	type ResolvedMapping,
	resolveActionTools,
	resolveMapping,
} from "./tool-mapping.ts";
export { buildAllToolPrompts, buildContextFromAgent, buildToolPrompt, type ToolPromptContext } from "./tool-prompt.ts";
export { type ToolValidationResult, validateToolSchemas } from "./tool-schema.ts";
export {
	type AgentManifest,
	AgentManifestSchema,
	type ComplianceConfig,
	KnowledgeCategorySchema,
	type KnowledgeIndex,
	KnowledgeIndexSchema,
	type ModelConfig,
	type RunbookFrontmatter,
	RunbookFrontmatterSchema,
	type RunbookSelectionConfig,
	RunbookSelectionConfigSchema,
	type RunbookTriggers,
	RunbookTriggersSchema,
	type ToolDefinition,
	ToolDefinitionSchema,
	type ToolMapping,
} from "./types.ts";
