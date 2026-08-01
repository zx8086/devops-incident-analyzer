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
// No `.default()` here (CLAUDE.md: no .default() in config schemas) -- `mode`/
// `enabled` are optional in the SCHEMA (a schedule file may omit them), but
// loadSchedules() below materializes the actual defaults after a successful
// parse, once, rather than having the schema silently rewrite what a file did
// or didn't say.
export const ScheduleDefSchema = z
	.object({
		id: z.string(),
		mode: z.enum(["repeat", "once"]).optional(),
		cron: z.string().optional(),
		runAt: z.string().optional(),
		enabled: z.boolean().optional(),
		workflow: z.string().optional(),
		prompt: z.string().optional(),
		agent: z.string().optional(),
	})
	.strict()
	.superRefine((def, ctx) => {
		const mode = def.mode ?? "repeat";
		if (mode === "repeat") {
			if (!def.cron) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: `schedule "${def.id}" has mode "repeat" but no cron` });
			}
			if (def.runAt) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `schedule "${def.id}" has mode "repeat" but sets runAt (repeat schedules use cron, not runAt)`,
				});
			}
		}
		if (mode === "once") {
			if (!def.runAt) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: `schedule "${def.id}" has mode "once" but no runAt` });
			}
			if (def.cron) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `schedule "${def.id}" has mode "once" but sets cron (once schedules use runAt, not cron)`,
				});
			}
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
export type ScheduleDefInput = z.infer<typeof ScheduleDefSchema>;
// The materialized shape loadSchedules() returns: mode/enabled always present
// (defaults applied post-parse, not by the schema).
export type ScheduleDef = ScheduleDefInput & { mode: "repeat" | "once"; enabled: boolean };

// Parses every schedules/*.yaml under rootDir into an id-keyed map. Returns an
// empty map when schedules/ is absent. A malformed file logs a warning and is
// skipped (unlike loadWorkflows, which throws) -- a typo in one schedule must
// never take down every other schedule at boot. A duplicate `id` across two
// files is also reported via onError and the later file is skipped (not
// silently overwritten) -- which file "wins" would otherwise depend on
// directory enumeration order, and a duplicate id can unintentionally disable
// or redirect a production sweep.
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
			if (schedules.has(result.data.id)) {
				onError?.(path, new Error(`duplicate schedule id "${result.data.id}"; skipping`));
				continue;
			}
			schedules.set(result.data.id, {
				...result.data,
				mode: result.data.mode ?? "repeat",
				enabled: result.data.enabled ?? true,
			});
		} catch (error) {
			onError?.(path, error);
		}
	}
	return schedules;
}
