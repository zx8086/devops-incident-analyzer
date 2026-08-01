// skillflow/src/scheduler.ts
//
// SIO-1358: registers real timers for schedules/*.yaml entries -- the ONE
// generalized version of the Bun/Node runtime split, re-entrancy guard, and
// cron->interval translation that used to be tripled across
// apps/web/src/lib/server/{iac-reconcile,kg-topology,kg-purge}-cron.ts.
//
// A `workflow`-targeted schedule resolves to a single `node:` step and runs
// through the real runWorkflow() executor (tracing span, consistent result
// shape) rather than calling the sweep function bare -- same pattern already
// proven by packages/agent/src/resolve-identifiers-workflow-handlers.ts
// (SIO-1353/1354). Multi-step scheduled workflows are out of scope: a
// scheduled workflow that isn't exactly one node-kind step is skipped with a
// warning, never partially run.

import type { ScheduleDef, WorkflowDef } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";
import { runWorkflow } from "./executor.ts";
import { stepKind } from "./resolvers.ts";

const log = getLogger("skillflow:scheduler");

export interface ScheduleHandlers {
	// Keyed by the workflow's `node:` step target. Each function IS the sweep
	// (reconcileAll, runTopologySweep, runUncuratedPurgeSweep, ...). Bound once
	// at registration; the scheduler never re-resolves it per fire.
	nodes: Record<string, () => Promise<unknown>>;
	// Reserved for future `prompt`-mode schedules: invokes the named agent's
	// supervisor with the schedule's prompt. Unimplemented target kind is
	// skipped with a warning until this is wired.
	prompt?: (agent: string, prompt: string) => Promise<unknown>;
}

export interface RegisteredSchedule {
	id: string;
	stop: () => void;
}

const DEFAULT_INTERVAL_MS = 60 * 60_000; // 1h; used only when a repeat schedule's cron is unparseable under Node

// Translates a 5-field cron minute/hour shape to a setInterval cadence for the
// Node fallback (no `Bun` global). Supports: every-minute ("* ..."), a minute
// step that divides 60 ("*/N ..."), and a fixed minute with a wildcard hour
// ("M * ..." -- hourly). A constrained hour ("0 9 * * MON-FRI" = daily) must
// NOT silently ride the fast path off its minute field alone. Anything else
// falls back to DEFAULT_INTERVAL_MS with a warn via onUnsupported.
export function scheduleToIntervalMs(cron: string, onUnsupported?: (cron: string) => void): number {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) {
		onUnsupported?.(cron);
		return DEFAULT_INTERVAL_MS;
	}
	const [minuteField, hourField] = fields;
	if (minuteField === "*") return 60_000;
	const step = /^\*\/(\d+)$/.exec(minuteField ?? "");
	if (step) {
		const n = Number(step[1]);
		if (Number.isInteger(n) && n > 0) return n * 60_000;
	}
	if (/^\d+$/.test(minuteField ?? "") && hourField === "*") return 60 * 60_000;
	onUnsupported?.(cron);
	return DEFAULT_INTERVAL_MS;
}

// One schedule's single node-step target, resolved from its declared workflow.
// Returns undefined (with a warning already logged) when the workflow is
// missing, has no matching node step, or isn't shaped as a single node step --
// scheduled workflows are deliberately restricted to that shape for now.
function resolveNodeTarget(scheduleId: string, def: WorkflowDef): string | undefined {
	if (def.steps.length !== 1) {
		log.warn(
			{ scheduleId, workflow: def.name, steps: def.steps.length },
			"scheduled workflow must have exactly one step",
		);
		return undefined;
	}
	const [step] = def.steps;
	if (!step || stepKind(step) !== "node") {
		log.warn({ scheduleId, workflow: def.name }, "scheduled workflow's single step must be a node step");
		return undefined;
	}
	return step.node;
}

function runScheduledWorkflow(def: WorkflowDef, nodeFn: () => Promise<unknown>): Promise<void> {
	return runWorkflow(def, {
		trigger: { source: "schedule" },
		handlers: {
			node: async () => {
				await nodeFn();
				return {};
			},
		},
	}).then((result) => {
		if (!result.ok) {
			const failed = result.steps.find((s) => s.status === "failed");
			log.warn({ workflow: def.name, error: failed?.error }, "scheduled workflow run failed");
		}
	});
}

function registerRepeat(id: string, cron: string, run: () => Promise<void>): (() => void) | undefined {
	let sweeping = false;
	const guarded = async (): Promise<void> => {
		if (sweeping) return;
		sweeping = true;
		try {
			await run();
		} catch (error) {
			log.warn({ id, error: error instanceof Error ? error.message : String(error) }, "schedule run threw");
		} finally {
			sweeping = false;
		}
	};

	try {
		if (typeof Bun !== "undefined") {
			const job = Bun.cron(cron, guarded);
			job.unref();
			log.info({ id, cron, runtime: "bun" }, "schedule registered");
			return () => job.stop();
		}
		const intervalMs = scheduleToIntervalMs(cron, (c) =>
			log.warn({ id, cron: c }, "schedule: cron expression unsupported under Node; defaulting to hourly"),
		);
		const timer = setInterval(() => void guarded(), intervalMs);
		timer.unref();
		log.info({ id, cron, intervalMs, runtime: "node" }, "schedule registered");
		return () => clearInterval(timer);
	} catch (error) {
		log.warn(
			{ id, cron, error: error instanceof Error ? error.message : String(error) },
			"schedule failed to register",
		);
		return undefined;
	}
}

function registerOnce(id: string, runAt: string, run: () => Promise<void>): (() => void) | undefined {
	const target = new Date(runAt).getTime();
	if (Number.isNaN(target)) {
		log.warn({ id, runAt }, "schedule has invalid runAt; skipping");
		return undefined;
	}
	const delayMs = target - Date.now();
	if (delayMs <= 0) {
		log.warn({ id, runAt }, "schedule's runAt is in the past; skipping");
		return undefined;
	}
	const timer = setTimeout(() => {
		void run().catch((error) => {
			log.warn({ id, error: error instanceof Error ? error.message : String(error) }, "schedule run threw");
		});
	}, delayMs);
	timer.unref();
	log.info({ id, runAt, delayMs }, "one-time schedule registered");
	return () => clearTimeout(timer);
}

// Registers a real timer for every enabled schedule. Never throws: a bad cron
// expression, an unresolvable workflow target, or an unimplemented `prompt`
// target logs a warning and skips just that one schedule.
export function registerSchedules(
	schedules: Map<string, ScheduleDef>,
	workflows: Map<string, WorkflowDef>,
	handlers: ScheduleHandlers,
): RegisteredSchedule[] {
	const registered: RegisteredSchedule[] = [];

	for (const [id, scheduleDef] of schedules) {
		if (!scheduleDef.enabled) {
			log.info({ id }, "schedule disabled; skipping");
			continue;
		}

		let run: (() => Promise<void>) | undefined;
		if (scheduleDef.workflow) {
			const def = workflows.get(scheduleDef.workflow);
			if (!def) {
				log.warn({ id, workflow: scheduleDef.workflow }, "schedule's workflow not found; skipping");
				continue;
			}
			const nodeTarget = resolveNodeTarget(id, def);
			if (!nodeTarget) continue;
			const nodeFn = handlers.nodes[nodeTarget];
			if (!nodeFn) {
				log.warn({ id, node: nodeTarget }, "no handler bound for schedule's node target; skipping");
				continue;
			}
			run = () => runScheduledWorkflow(def, nodeFn);
		} else if (scheduleDef.prompt) {
			if (!handlers.prompt) {
				log.warn({ id }, "schedule targets a prompt but no prompt handler is wired; skipping");
				continue;
			}
			const { prompt, agent } = scheduleDef;
			run = () => handlers.prompt?.(agent ?? "", prompt).then(() => undefined) ?? Promise.resolve();
		} else {
			// ScheduleDefSchema's superRefine guarantees exactly one target for a
			// schema-validated schedule; unreachable in practice.
			log.warn({ id }, "schedule has no workflow or prompt target; skipping");
			continue;
		}

		const stop =
			scheduleDef.mode === "once"
				? registerOnce(id, scheduleDef.runAt as string, run)
				: registerRepeat(id, scheduleDef.cron as string, run);
		if (stop) registered.push({ id, stop });
	}

	return registered;
}
