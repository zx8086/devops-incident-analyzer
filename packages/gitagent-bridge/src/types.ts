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
			escalation_triggers: z.array(z.record(z.unknown())).optional(),
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
	agents: z.record(SubAgentRefSchema).optional(),
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
	input_schema: z.record(z.unknown()),
	output_schema: z.record(z.unknown()).optional(),
	annotations: z
		.object({
			requires_confirmation: z.boolean().optional(),
			read_only: z.boolean().optional(),
			cost: z.enum(["low", "medium", "high"]).optional(),
		})
		.optional(),
	prompt_template: z.string().optional(),
	related_tools: z.array(z.string()).optional(),
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ComplianceConfig = z.infer<typeof ComplianceSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
