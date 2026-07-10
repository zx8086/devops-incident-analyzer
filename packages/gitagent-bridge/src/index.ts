// gitagent-bridge/src/index.ts

export { complianceToMetadata, requiresApproval } from "./compliance.ts";
export {
	type BootstrapStep,
	BootstrapStepSchema,
	type HooksConfig,
	HooksConfigSchema,
	loadHooks,
	type TeardownStep,
	TeardownStepSchema,
} from "./hooks.ts";
export { type KnowledgeEntry, type LoadedAgent, loadAgent } from "./manifest-loader.ts";
export { type LoadedMemory, loadMemoryLayout } from "./memory.ts";
export {
	type BedrockModelConfig,
	getRecursionLimit,
	resolveBedrockConfig,
	resolveFallbackConfig,
} from "./model-factory.ts";
export { getRelatedTools, withRelatedTools } from "./related-tools.ts";
export { mergeShared, type SharedMergeResult } from "./shared-merge.ts";
export { buildSystemPrompt, buildSystemPromptParts, type SystemPromptParts } from "./skill-loader.ts";
export {
	buildFacadeMap,
	type FacadeMap,
	getActionKeywords,
	getAllActionToolNames,
	getAvailableActions,
	getUncoveredTools,
	matchActionsByKeywords,
	type ResolvedMapping,
	resolveActionTools,
	resolveMapping,
} from "./tool-mapping.ts";
export { buildContextFromAgent, buildToolPrompt, type ToolPromptContext } from "./tool-prompt.ts";
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
	type SkillFrontmatter,
	SkillFrontmatterSchema,
	type ToolDefinition,
	ToolDefinitionSchema,
	type ToolMapping,
} from "./types.ts";
export {
	loadWorkflows,
	type SkillFlowDef,
	SkillFlowSchema,
	skillFlowToWorkflowDef,
	type WorkflowDef,
	WorkflowSchema,
	type WorkflowStep,
	WorkflowStepSchema,
	type WorkflowTrigger,
	WorkflowTriggerSchema,
} from "./workflow.ts";
