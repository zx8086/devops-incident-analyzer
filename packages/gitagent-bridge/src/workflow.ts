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

// GAP (GitAgent Protocol) SkillsFlow dialect. The portable GAP layout authors
// workflows with map-form steps (`validate:`/`draft:` keys) carrying `inputs:`
// and `conditions:`, string triggers, and an object `error_handling` -- a
// different surface from the array-form WorkflowSchema above. We parse it
// faithfully here and convert into the canonical WorkflowDef so the existing
// executor/triggers run it unchanged. (Honouring conditions + declared inputs in
// the executor is future work; the IaC graph enforces guards directly for now.)
const SkillFlowTriggerSchema = z.union([z.string(), z.object({ type: z.string() }).passthrough()]);

const SkillFlowStepSchema = z
	.object({
		skill: z.string().optional(),
		agent: z.string().optional(),
		tool: z.string().optional(),
		node: z.string().optional(),
		depends_on: z.array(z.string()).optional(),
		conditions: z.array(z.string()).optional(),
		inputs: z.record(z.string(), z.unknown()).optional(),
		outputs: z.array(z.string()).optional(),
	})
	.strict()
	.superRefine((step, ctx) => {
		const kinds = ["skill", "agent", "tool", "node"] as const;
		const present = kinds.filter((k) => step[k] !== undefined);
		if (present.length !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message:
					present.length === 0
						? "SkillsFlow step must set exactly one of skill/agent/tool/node"
						: `SkillsFlow step sets multiple kinds (${present.join(", ")}); exactly one is allowed`,
			});
		}
	});

export const SkillFlowSchema = z
	.object({
		name: z.string(),
		version: z.string().optional(),
		description: z.string().optional(),
		triggers: z.array(SkillFlowTriggerSchema).optional(),
		inputs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
		steps: z.record(z.string(), SkillFlowStepSchema),
		error_handling: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();
export type SkillFlowDef = z.infer<typeof SkillFlowSchema>;

function normalizeSkillFlowTrigger(t: z.infer<typeof SkillFlowTriggerSchema>): WorkflowTrigger {
	const type = typeof t === "string" ? t : t.type;
	return type === "event" || type === "schedule" ? { type } : { type: "manual" };
}

function stringifySkillFlowInput(v: unknown): string {
	return typeof v === "string" ? v : JSON.stringify(v);
}

// Convert a GAP map-form SkillsFlow into the canonical array-form WorkflowDef.
// Lossy by design: `conditions` are folded into the step prompt as a note and
// non-string `inputs` are JSON-stringified into `with`; the IaC graph owns the
// authoritative guard logic.
export function skillFlowToWorkflowDef(flow: SkillFlowDef): WorkflowDef {
	const steps: WorkflowStep[] = Object.entries(flow.steps).map(([name, s]) => {
		const withInputs: Record<string, string> = {};
		for (const [k, val] of Object.entries(s.inputs ?? {})) withInputs[k] = stringifySkillFlowInput(val);
		const conditionNote = s.conditions?.length ? `Conditions: ${s.conditions.join(" && ")}` : undefined;
		return {
			name,
			...(s.skill && { skill: s.skill }),
			...(s.agent && { agent: s.agent }),
			...(s.tool && { tool: s.tool }),
			...(s.node && { node: s.node }),
			...(s.depends_on && { depends_on: s.depends_on }),
			...(Object.keys(withInputs).length > 0 && { with: withInputs }),
			...(s.outputs && { outputs: s.outputs }),
			...(conditionNote && { prompt: conditionNote }),
		};
	});

	const converted: WorkflowDef = {
		name: flow.name,
		version: flow.version ?? "0.0.0",
		description: flow.description ?? flow.name,
		...(flow.triggers && { triggers: flow.triggers.map(normalizeSkillFlowTrigger) }),
		steps,
		...(flow.error_handling && { error_handling: "best_effort" as const }),
	};

	// Re-validate through the canonical schema so a bad conversion fails loudly.
	return WorkflowSchema.parse(converted);
}

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
		workflows.set(...parseWorkflowFile(raw, path));
	}
	return workflows;
}

// Dialect detection: array-form `steps` is the canonical WorkflowSchema; map-form
// `steps` (`{ stepName: {...} }`) is the GAP SkillsFlow dialect, converted to the
// canonical shape. Either way a malformed file throws with its path so CI fails loudly.
function parseWorkflowFile(raw: unknown, path: string): [string, WorkflowDef] {
	const steps = (raw as { steps?: unknown } | null)?.steps;
	if (steps !== null && typeof steps === "object" && !Array.isArray(steps)) {
		const flow = SkillFlowSchema.safeParse(raw);
		if (!flow.success) {
			throw new Error(`Failed to parse SkillsFlow workflow ${path}: ${flow.error.message}`);
		}
		const def = skillFlowToWorkflowDef(flow.data);
		return [def.name, def];
	}
	const result = WorkflowSchema.safeParse(raw);
	if (!result.success) {
		throw new Error(`Failed to parse workflow ${path}: ${result.error.message}`);
	}
	return [result.data.name, result.data];
}
