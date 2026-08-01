// gitagent-bridge/src/schedule.ts
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// SIO-1358: top-level schedules/*.yaml, one file per cron-driven job -- the
// GitAgent-styled schedule layer (verified live against gitagent.sh/docs/schedules:
// id/prompt/cron/mode/enabled). Our repo is multi-agent (no bare "the agent" to run
// a prompt against) and needs deterministic (non-LLM) sweeps alongside future
// prompt-on-a-timer schedules, so `workflow` is a second target kind: it names a
// workflows/*.yaml run via runWorkflow(), while `prompt` (+ `agent`) is reserved for
// a future LLM-invocation schedule. Exactly one of workflow/prompt is expected by
// convention; the scheduler (packages/skillflow/src/scheduler.ts) enforces that at
// registration time rather than here, so an unset combination fails loudly there
// with the file path, not silently here.
//
// Cadence AND enablement live ONLY in this file -- no env-var override for either.
// `enabled: false` is the one on/off control a human edits; a schedule's backend
// dependency (e.g. is the knowledge graph configured at all) is a separate runtime
// precondition the scheduler checks, not a second flag in this schema.
export const ScheduleDefSchema = z
	.object({
		id: z.string(),
		mode: z.enum(["repeat", "once"]).default("repeat"),
		cron: z.string().optional(),
		runAt: z.string().optional(),
		enabled: z.boolean().default(true),
		workflow: z.string().optional(),
		prompt: z.string().optional(),
		agent: z.string().optional(),
	})
	.strict()
	.superRefine((def, ctx) => {
		if (def.mode === "repeat" && !def.cron) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: `schedule "${def.id}" has mode "repeat" but no cron` });
		}
		if (def.mode === "once" && !def.runAt) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: `schedule "${def.id}" has mode "once" but no runAt` });
		}
		if (def.workflow && def.prompt) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `schedule "${def.id}" sets both workflow and prompt; exactly one target is allowed`,
			});
		}
		if (!def.workflow && !def.prompt) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `schedule "${def.id}" sets neither workflow nor prompt; one target is required`,
			});
		}
	});
export type ScheduleDef = z.infer<typeof ScheduleDefSchema>;

// Parses every schedules/*.yaml under rootDir into an id-keyed map. Returns an
// empty map when schedules/ is absent. A malformed file logs a warning and is
// skipped (unlike loadWorkflows, which throws) -- a typo in one schedule must
// never take down every other schedule at boot.
export function loadSchedules(
	rootDir: string,
	onError?: (path: string, error: unknown) => void,
): Map<string, ScheduleDef> {
	const schedules = new Map<string, ScheduleDef>();
	const schedulesDir = join(rootDir, "schedules");
	if (!existsSync(schedulesDir) || !statSync(schedulesDir).isDirectory()) {
		return schedules;
	}

	const files = readdirSync(schedulesDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
	for (const file of files) {
		const path = join(schedulesDir, file);
		try {
			const raw = parse(readFileSync(path, "utf-8"));
			const result = ScheduleDefSchema.safeParse(raw);
			if (!result.success) {
				onError?.(path, result.error);
				continue;
			}
			schedules.set(result.data.id, result.data);
		} catch (error) {
			onError?.(path, error);
		}
	}
	return schedules;
}
