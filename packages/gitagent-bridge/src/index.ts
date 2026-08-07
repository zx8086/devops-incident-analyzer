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
// SIO-1223: the single source of truth for every model this repo may invoke, and its
// probe-backed capability record. See docs/development/model-upgrade-checklist.md.
export {
	type ContentShape,
	getModelCapabilities,
	isKnownModel,
	MODEL_REGISTRY,
	type ModelCapabilities,
	type ModelName,
} from "./model-registry.ts";
export {
	type FrontmatterDegradation,
	findFrontmatterDegradations,
	findMissingDeclaredSubAgents,
	findOrphanedKnowledgeFiles,
	findSkillDeclarationDrift,
	type OrphanedKnowledgeFile,
	type SkillDeclarationDrift,
	type SubAgentDeclarationGap,
} from "./okf-spec-audit.ts";
export { getRelatedTools, withRelatedTools } from "./related-tools.ts";
// SIO-1398: the two runbook tool-citation readers, exported so eval coverage targets derive
// from the SAME parse runbook-validator enforces (frontmatter `tools:` first, tail CSV as the
// documented SIO-1288 fallback) instead of a second hand-rolled parser that could drift.
export { extractFrontmatterTools, extractTailSection } from "./runbook-validator.ts";
export { loadSchedules, type ScheduleDef, ScheduleDefSchema } from "./schedule.ts";
export { mergeShared, type SharedMergeResult } from "./shared-merge.ts";
export {
	buildSubAgentSystemPrompt,
	buildSystemPrompt,
	buildSystemPromptParts,
	SUB_AGENT_NON_INTERACTIVE_PREAMBLE,
	type SystemPromptParts,
} from "./skill-loader.ts";
export {
	SKILL_EXTENSION_FIELDS,
	SKILL_SPEC_FIELDS,
	type SkillSpecViolation,
	validateSkillFile,
} from "./skill-spec-validator.ts";
export { extractPromptToolNames, extractSkillToolNames, type SkillSource } from "./skill-tools.ts";
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
	isRunbookCategory,
	KnowledgeCategorySchema,
	type KnowledgeIndex,
	KnowledgeIndexSchema,
	type KnowledgeSelectionConfig,
	KnowledgeSelectionConfigSchema,
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
