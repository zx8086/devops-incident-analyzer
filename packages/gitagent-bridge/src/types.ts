// gitagent-bridge/src/types.ts
import { z } from "zod";

export const ModelConfigSchema = z.object({
	preferred: z.string(),
	fallback: z.array(z.string()).optional(),
	constraints: z
		.object({
			temperature: z.number().min(0).max(2).optional(),
			max_tokens: z.number().positive().optional(),
		})
		.optional(),
});

export const ComplianceSchema = z.object({
	risk_tier: z.enum(["low", "standard", "medium", "high", "critical"]),
	supervision: z
		.object({
			human_in_the_loop: z.enum(["always", "conditional", "advisory", "none"]).optional(),
			escalation_triggers: z.array(z.record(z.string(), z.unknown())).optional(),
			kill_switch: z.boolean().optional(),
		})
		.optional(),
	recordkeeping: z
		.object({
			audit_logging: z.boolean().optional(),
			log_format: z.string().optional(),
			retention_period: z.string().optional(),
			log_contents: z.array(z.string()).optional(),
			immutable: z.boolean().optional(),
		})
		.optional(),
	data_governance: z
		.object({
			pii_handling: z.enum(["redact", "encrypt", "prohibit", "allow"]).optional(),
			data_classification: z.string().optional(),
		})
		.optional(),
});

export const RuntimeConfigSchema = z.object({
	max_turns: z.number().positive().optional(),
	timeout: z.number().positive().optional(),
});

export const SubAgentRefSchema = z.object({
	delegation: z.enum(["auto", "explicit", "router"]).optional(),
});

export const AgentManifestSchema = z.object({
	spec_version: z.string().optional(),
	name: z.string().regex(/^[a-z][a-z0-9-]*$/),
	version: z.string(),
	description: z.string(),
	model: ModelConfigSchema.optional(),
	runtime: RuntimeConfigSchema.optional(),
	skills: z.array(z.string()).optional(),
	tools: z.array(z.string()).optional(),
	agents: z.record(z.string(), SubAgentRefSchema).optional(),
	delegation: z
		.object({
			mode: z.enum(["auto", "explicit", "router"]),
			router: z.string().optional(),
		})
		.optional(),
	compliance: ComplianceSchema.optional(),
	tags: z.array(z.string()).optional(),
});

export const ToolDefinitionSchema = z.object({
	name: z.string(),
	description: z.string(),
	version: z.string().optional(),
	input_schema: z.record(z.string(), z.unknown()),
	output_schema: z.record(z.string(), z.unknown()).optional(),
	annotations: z
		.object({
			requires_confirmation: z.boolean().optional(),
			read_only: z.boolean().optional(),
			cost: z.enum(["low", "medium", "high"]).optional(),
		})
		.optional(),
	prompt_template: z.string().optional(),
	related_tools: z.array(z.string()).optional(),
	tool_mapping: z
		.object({
			mcp_server: z.string().describe("MCP server this facade maps to"),
			mcp_patterns: z.array(z.string()).describe("MCP tool name patterns: exact names or glob with * suffix"),
			action_tool_map: z
				.record(z.string(), z.array(z.string()))
				.optional()
				.describe("Maps action categories to specific MCP tool names"),
			// SIO-680/682: Optional one-line LLM-facing hint per action key.
			// Each value is a single sentence completing "pick this action when ...".
			// Consumed by entity-extractor.buildActionCatalog() to steer action selection.
			// Keys, when present, must be a subset of action_tool_map keys; enforced via superRefine below.
			// (For another superRefine cross-field example, see packages/mcp-server-kafka/src/config/schemas.ts.)
			action_descriptions: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					'Optional one-line LLM-facing hint per action key. Each value is a single sentence completing "pick this action when ...". Consumed by entity-extractor.buildActionCatalog() to steer action selection. Keys, when present, must be a subset of action_tool_map keys.',
				),
			action_keywords: z
				.record(z.string(), z.array(z.string()))
				.optional()
				.describe(
					"Optional case-insensitive keyword catalog per action key. When the user's query contains any keyword (word-boundary match), the corresponding action is force-included in the sub-agent's tool filter. Augments LLM-driven action selection with deterministic fallback. Keys, when present, must be a subset of action_tool_map keys.",
				),
		})
		.superRefine((tm, ctx) => {
			if (!tm.action_tool_map) return;
			const validKeys = new Set(Object.keys(tm.action_tool_map));
			if (tm.action_descriptions) {
				for (const key of Object.keys(tm.action_descriptions)) {
					if (!validKeys.has(key)) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: `action_descriptions key "${key}" is not in action_tool_map`,
							path: ["action_descriptions", key],
						});
					}
				}
			}
			if (tm.action_keywords) {
				for (const key of Object.keys(tm.action_keywords)) {
					if (!validKeys.has(key)) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: `action_keywords key "${key}" is not in action_tool_map`,
							path: ["action_keywords", key],
						});
					}
				}
			}
		})
		.optional(),
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ComplianceConfig = z.infer<typeof ComplianceSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ToolMapping = NonNullable<ToolDefinition["tool_mapping"]>;

export const KnowledgeCategorySchema = z.object({
	path: z.string(),
	description: z.string(),
});

// SIO-640: Lazy runbook selection fallback config. When present, selectRunbooks
// is wired into the graph; when absent, the feature is disabled entirely.
export const RunbookSelectionConfigSchema = z.object({
	fallback_by_severity: z.object({
		critical: z.array(z.string()),
		high: z.array(z.string()),
		medium: z.array(z.string()),
		low: z.array(z.string()),
	}),
});
export type RunbookSelectionConfig = z.infer<typeof RunbookSelectionConfigSchema>;

export const KnowledgeIndexSchema = z.object({
	name: z.string(),
	description: z.string(),
	version: z.string(),
	categories: z.record(z.string(), KnowledgeCategorySchema),
	runbook_selection: RunbookSelectionConfigSchema.optional(),
});
export type KnowledgeIndex = z.infer<typeof KnowledgeIndexSchema>;

export const RunbookTriggersSchema = z
	.object({
		severity: z.array(z.enum(["critical", "high", "medium", "low"])).optional(),
		services: z.array(z.string()).optional(),
		metrics: z.array(z.string()).optional(),
		match: z.enum(["any", "all"]).optional(),
	})
	.strict();

export type RunbookTriggers = z.infer<typeof RunbookTriggersSchema>;

export const RunbookFrontmatterSchema = z
	.object({
		triggers: RunbookTriggersSchema,
	})
	.strict();

export type RunbookFrontmatter = z.infer<typeof RunbookFrontmatterSchema>;
