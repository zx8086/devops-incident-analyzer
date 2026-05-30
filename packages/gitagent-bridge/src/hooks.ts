// gitagent-bridge/src/hooks.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// Agent-session lifecycle hook steps. Closed enums on purpose: hooks stay
// declarative and safe (no arbitrary shell). Each name maps to a typed runtime
// behavior dispatched by the agent's lifecycle runner (EPIC 7).
export const BootstrapStepSchema = z.enum([
	"load_live_memory",
	"load_wiki_index",
	"warm_knowledge_graph",
	"emit_session_start",
]);
export type BootstrapStep = z.infer<typeof BootstrapStepSchema>;

export const TeardownStepSchema = z.enum([
	"flush_daily_log",
	"checkpoint_key_decisions",
	"open_memory_pr",
	"close_knowledge_graph",
]);
export type TeardownStep = z.infer<typeof TeardownStepSchema>;

const HookPhaseSchema = z
	.object({
		// Narrative markdown (bootstrap.md / teardown.md) loaded by the lifecycle
		// runner; the config only references it by filename.
		instructions_file: z.string().optional(),
		steps: z.array(BootstrapStepSchema).optional(),
	})
	.strict();

const TeardownPhaseSchema = z
	.object({
		instructions_file: z.string().optional(),
		steps: z.array(TeardownStepSchema).optional(),
	})
	.strict();

export const HooksConfigSchema = z
	.object({
		bootstrap: HookPhaseSchema.optional(),
		teardown: TeardownPhaseSchema.optional(),
	})
	.strict();
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

// Returns undefined when hooks/hooks.yaml is absent (lifecycle disabled).
export function loadHooks(agentDir: string): HooksConfig | undefined {
	const hooksPath = join(agentDir, "hooks", "hooks.yaml");
	if (!existsSync(hooksPath)) return undefined;
	const raw = parse(readFileSync(hooksPath, "utf-8"));
	return HooksConfigSchema.parse(raw);
}
