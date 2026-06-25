// gitagent-bridge/src/types.ts
import { z } from "zod";

// GAP dialect support: agent.yaml may list skills/tools as `[{ id: "x" }]`
// (GitAgent Protocol layout) instead of `["x"]`. Normalize either form to a
// plain string[] at parse time so every downstream consumer keeps seeing string[].
const toIdList = (v: unknown): unknown => {
	if (!Array.isArray(v)) return v;
	return v.map((e) => {
		if (e && typeof e === "object" && "id" in e) {
			return (e as { id: unknown }).id;
		}
		return e;
	});
};

export const ModelConfigSchema = z.object({
	preferred: z.string(),
	// GAP dialect allows a single fallback string; normalize to string[].
	fallback: z.preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.string())).optional(),
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
	// GAP dialect: maker/checker separation-of-duties policy. The agent is
	// assigned a subset of roles; conflicting role pairs (e.g. maker/checker)
	// must never be held by the same actor.
	segregation_of_duties: z
		.object({
			roles: z
				.array(
					z.object({
						id: z.string(),
						description: z.string().optional(),
						permissions: z.array(z.string()).optional(),
					}),
				)
				.optional(),
			conflicts: z.array(z.array(z.string())).optional(),
			assignments: z.record(z.string(), z.array(z.string())).optional(),
			enforcement: z.enum(["strict", "advisory"]).optional(),
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
	// GAP dialect: skills/tools may be `["x"]` or `[{ id: "x" }]`; both normalize to string[].
	skills: z.preprocess(toIdList, z.array(z.string())).optional(),
	tools: z.preprocess(toIdList, z.array(z.string())).optional(),
	agents: z.record(z.string(), SubAgentRefSchema).optional(),
	delegation: z
		.object({
			mode: z.enum(["auto", "explicit", "router"]),
			router: z.string().optional(),
		})
		.optional(),
	compliance: ComplianceSchema.optional(),
	tags: z.array(z.string()).optional(),
	// GAP dialect: where the IaC truth lives + which knowledge/workflow files to load.
	// repository.project_id may be numeric in the YAML.
	repository: z
		.object({
			url: z.string(),
			project_id: z.union([z.string(), z.number()]).optional(),
			default_branch: z.string().optional(),
		})
		.optional(),
	knowledge: z.array(z.string()).optional(),
	workflows: z.array(z.string()).optional(),
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

// SIO-1014: typed view of a SKILL.md frontmatter block. `name`/`description` are
// the gitagent.sh authoring fields surfaced in the prompt's Skills catalog;
// `inputs`/`outputs` are opaque contracts (narrowed at use sites). The learning
// fields are optional so a SIO-1015 promoted/crystallized skill validates against
// the same schema. `.passthrough()` (not `.strict()`) tolerates unknown keys —
// many skills are markdown-only with no frontmatter at all.
export const SkillFrontmatterSchema = z
	.object({
		name: z.string().optional(),
		description: z.string().optional(),
		inputs: z.record(z.string(), z.unknown()).optional(),
		outputs: z.record(z.string(), z.unknown()).optional(),
		// SIO-1015 skill-learning fields (absent on hand-authored skills). Constrained
		// so invalid metadata (confidence out of [0,1], negative/fractional counts,
		// non-ISO timestamps) is rejected at parse time rather than propagating.
		confidence: z.number().min(0).max(1).optional(),
		learned_from: z.string().optional(),
		learned_at: z
			.string()
			.regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}/)
			.optional(),
		usage_count: z.number().int().nonnegative().optional(),
		success_count: z.number().int().nonnegative().optional(),
		failure_count: z.number().int().nonnegative().optional(),
		negative_examples: z.array(z.string()).optional(),
	})
	.passthrough();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
