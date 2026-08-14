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

// SIO-1468: schedule timers are PROCESS-wide slots keyed on globalThis, same idiom as
// the mcp-bridge health poll (HEALTH_POLL_TICK_KEY). Under Vite, a dev-server restart
// can close and recreate the SSR module runner WITHOUT running hot.dispose: the old
// module graph's timers survive AND the fresh graph registers a second set, so the
// sweeps run stacked and the old set executes inside a dead module graph. Each slot
// holds the one live timer per schedule id plus a `run` closure that every
// re-registration repoints at the CALLING module instance -- the surviving timer then
// always dispatches into the live graph, and no second timer is ever armed for the
// same cadence. The re-entrancy guard lives on the slot so it survives repointing.
const SCHEDULE_SLOTS_KEY = Symbol.for("devops-agent.skillflow.scheduleSlots");
interface ScheduleSlot {
	run: () => Promise<void>;
	sweeping: boolean;
	// `repeat:<cron>` or `once:<runAt>`; a cadence change re-arms instead of repointing.
	cadence: string;
	stopTimer: () => void;
}
function getScheduleSlots(): Map<string, ScheduleSlot> {
	const g = globalThis as Record<symbol, unknown>;
	let slots = g[SCHEDULE_SLOTS_KEY] as Map<string, ScheduleSlot> | undefined;
	if (!slots) {
		slots = new Map();
		g[SCHEDULE_SLOTS_KEY] = slots;
	}
	return slots;
}
function stopSlot(id: string): void {
	const slots = getScheduleSlots();
	const slot = slots.get(id);
	if (slot) {
		slot.stopTimer();
		slots.delete(id);
	}
}

// Test escape hatches. Underscore prefix marks these as internal -- do not import from production code.
export function _getScheduleSlotForTest(id: string): { run: () => Promise<void> } | undefined {
	return getScheduleSlots().get(id);
}
export function _resetScheduleSlotsForTest(): void {
	for (const id of [...getScheduleSlots().keys()]) stopSlot(id);
}

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
	const slots = getScheduleSlots();
	// SIO-1468: the re-entrancy flag lives on the SLOT, not this closure, so an
	// in-flight sweep from a previous module graph still blocks the repointed one.
	const guarded = async (): Promise<void> => {
		const slot = slots.get(id);
		if (!slot) return;
		if (slot.sweeping) {
			// The flag lives on the process-wide slot, so a sweep that never settles
			// would silence the schedule permanently -- make every skip visible.
			log.warn({ id }, "previous sweep still in flight; skipping this tick");
			return;
		}
		slot.sweeping = true;
		try {
			await run();
		} catch (error) {
			log.warn({ id, error: error instanceof Error ? error.message : String(error) }, "schedule run threw");
		} finally {
			slot.sweeping = false;
		}
	};

	const cadence = `repeat:${cron}`;
	const existing = slots.get(id);
	if (existing && existing.cadence === cadence) {
		// Same schedule, same cadence: the timer survives; only dispatch moves to the
		// latest (live) module graph. Never arm a second timer.
		existing.run = guarded;
		log.info({ id, cron }, "schedule already armed; dispatch repointed at latest registration");
		return () => stopSlot(id);
	}

	try {
		let stopTimer: () => void;
		// The timer dispatches through the slot so a later registration can take over.
		const tick = () => void slots.get(id)?.run();
		if (typeof Bun !== "undefined") {
			const job = Bun.cron(cron, tick);
			job.unref();
			log.info({ id, cron, runtime: "bun" }, "schedule registered");
			stopTimer = () => job.stop();
		} else {
			const intervalMs = scheduleToIntervalMs(cron, (c) =>
				log.warn({ id, cron: c }, "schedule: cron expression unsupported under Node; defaulting to hourly"),
			);
			const timer = setInterval(tick, intervalMs);
			timer.unref();
			log.info({ id, cron, intervalMs, runtime: "node" }, "schedule registered");
			stopTimer = () => clearInterval(timer);
		}
		// Cadence changed: stop the old timer only AFTER the new one armed, so a
		// registration that throws above leaves the previous schedule running.
		if (existing) {
			existing.stopTimer();
			log.info({ id, cron, previous: existing.cadence }, "schedule cadence changed; re-armed");
		}
		// Fresh sweeping flag: an in-flight sweep from the replaced slot clears the OLD
		// slot object it captured, so inheriting its true value would wedge this slot.
		slots.set(id, { run: guarded, sweeping: false, cadence, stopTimer });
		return () => stopSlot(id);
	} catch (error) {
		log.warn(
			{ id, cron, error: error instanceof Error ? error.message : String(error) },
			"schedule failed to register",
		);
		return undefined;
	}
}

function registerOnce(id: string, runAt: string, run: () => Promise<void>): (() => void) | undefined {
	// Validate BEFORE touching the slot: an invalid or past runAt must not tear down
	// a previously armed slot (the surviving timer stays the source of truth).
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

	const slots = getScheduleSlots();
	const guarded = async (): Promise<void> => {
		try {
			await run();
		} catch (error) {
			log.warn({ id, error: error instanceof Error ? error.message : String(error) }, "schedule run threw");
		}
	};

	const cadence = `once:${runAt}`;
	const existing = slots.get(id);
	if (existing && existing.cadence === cadence) {
		existing.run = guarded; // SIO-1468: pending timeout survives; dispatch moves to the live graph
		log.info({ id, runAt }, "one-time schedule already armed; dispatch repointed at latest registration");
		return () => stopSlot(id);
	}

	const timer = setTimeout(() => {
		const slot = slots.get(id);
		slots.delete(id); // fired: a later registration may arm a fresh one-time slot
		void slot?.run();
	}, delayMs);
	timer.unref();
	if (existing) {
		existing.stopTimer();
		log.info({ id, runAt, previous: existing.cadence }, "one-time schedule runAt changed; re-armed");
	}
	slots.set(id, { run: guarded, sweeping: false, cadence, stopTimer: () => clearTimeout(timer) });
	log.info({ id, runAt, delayMs }, "one-time schedule registered");
	return () => stopSlot(id);
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

	// SIO-1468: this function owns every id in the global slot map. The caller
	// passes the FULL current schedule set, so an armed slot whose id is absent
	// from it (schedule deleted, renamed, or its YAML skipped as malformed)
	// belongs to a previous registration and must stop -- otherwise the surviving
	// timer keeps dispatching a dead module graph's closure forever.
	for (const id of [...getScheduleSlots().keys()]) {
		if (!schedules.has(id)) {
			stopSlot(id);
			log.info({ id }, "schedule no longer defined; stopped surviving slot");
		}
	}

	for (const [id, scheduleDef] of schedules) {
		if (!scheduleDef.enabled) {
			// SIO-1468: disabling in YAML is the explicit off switch -- also stop a slot
			// a previous module graph armed, or it would keep sweeping forever.
			stopSlot(id);
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
