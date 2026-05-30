// gitagent-bridge/src/workflow.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// SkillsFlow (EPIC 4): deterministic multi-step workflows chaining skill/agent/
// tool/node/graph steps. The schema lives here (the lower-level package) so the
// bridge owns one parse path; the skillflow executor imports WorkflowSchema.
//
// A step performs exactly one kind of work, selected by which of
// skill/agent/tool/node/graph is set. The superRefine below enforces that.
export const WorkflowStepSchema = z
	.object({
		name: z.string(),
		description: z.string().optional(),
		skill: z.string().optional(),
		agent: z.string().optional(),
		tool: z.string().optional(),
		node: z.string().optional(),
		graph: z.literal(true).optional(),
		depends_on: z.array(z.string()).optional(),
		// Per-step prompt overlay (does not change the underlying skill body).
		prompt: z.string().optional(),
		// Inputs, may contain ${{ steps.X.outputs.Y }} templates.
		with: z.record(z.string(), z.string()).optional(),
		// Names this step exposes to downstream steps.
		outputs: z.array(z.string()).optional(),
		error_handling: z.enum(["fail", "continue", "retry"]).optional(),
		retry: z
			.object({
				attempts: z.number().int().positive(),
				backoff_ms: z.number().int().positive(),
			})
			.optional(),
	})
	.strict()
	.superRefine((step, ctx) => {
		const kinds = ["skill", "agent", "tool", "node", "graph"] as const;
		const present = kinds.filter((k) => step[k] !== undefined);
		if (present.length !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					present.length === 0
						? `workflow step "${step.name}" must set exactly one of skill/agent/tool/node/graph`
						: `workflow step "${step.name}" sets multiple step kinds (${present.join(", ")}); exactly one is allowed`,
				path: ["name"],
			});
		}
	});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowTriggerSchema = z
	.object({
		type: z.enum(["manual", "event", "schedule"]),
		event: z.string().optional(),
		cron: z.string().optional(),
	})
	.strict();
export type WorkflowTrigger = z.infer<typeof WorkflowTriggerSchema>;

export const WorkflowSchema = z
	.object({
		name: z.string(),
		version: z.string(),
		description: z.string(),
		triggers: z.array(WorkflowTriggerSchema).optional(),
		steps: z.array(WorkflowStepSchema).min(1),
		error_handling: z.enum(["fail_fast", "best_effort"]).optional(),
	})
	.strict();
export type WorkflowDef = z.infer<typeof WorkflowSchema>;

// Parses every workflows/*.yaml into a name-keyed map. Returns an empty map
// when workflows/ is absent. Throws (with the offending file path) on a
// malformed or schema-invalid workflow so CI fails loudly.
export function loadWorkflows(agentDir: string): Map<string, WorkflowDef> {
	const workflows = new Map<string, WorkflowDef>();
	const workflowsDir = join(agentDir, "workflows");
	if (!existsSync(workflowsDir) || !statSync(workflowsDir).isDirectory()) {
		return workflows;
	}

	const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
	for (const file of files) {
		const path = join(workflowsDir, file);
		const raw = parse(readFileSync(path, "utf-8"));
		const result = WorkflowSchema.safeParse(raw);
		if (!result.success) {
			throw new Error(`Failed to parse workflow ${path}: ${result.error.message}`);
		}
		workflows.set(result.data.name, result.data);
	}
	return workflows;
}
