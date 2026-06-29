// apps/web/src/lib/server/iac-reconcile-cron.ts
// SIO-1005: in-process sweep that reconciles proposed elastic-iac memory facts to their
// real terminal state (applied / apply-failed / closed). In-process (not OS-level) is deliberate:
// it shares the already-connected MCP bridge and the bound agent-memory client in THIS web process,
// so reconcileAll's gitlab_* tool calls and durable-memory writes just work -- no separate daemon,
// no re-connecting tools. unref() so it never blocks shutdown.
//
// SIO-1021: apps/web runs under Vite's Node dev server / a Node production adapter, where the `Bun`
// global is undefined and `Bun.cron` throws "Bun is not defined". So we register Bun.cron only under
// the Bun runtime and fall back to a portable setInterval under Node -- the sweep (reconcileAll) has
// no Bun dependency. Bun.cron guarantees no-overlap; setInterval does not, so the Node path emulates
// it with a `sweeping` re-entrancy flag.
//
// Enabled implicitly by the agent-memory backend: reconcile has nothing to read or write on any
// other backend (reconcileAll early-returns), so the cron is driven purely by
// LIVE_MEMORY_BACKEND=agent-memory -- no separate on/off flag. Only the cadence is tunable
// (IAC_RECONCILE_CRON_SCHEDULE).
import { reconcileAll, selectedBackend } from "@devops-agent/agent";
import { getLogger } from "@devops-agent/observability";

const log = getLogger("agent:iac:reconcile-cron");

// Divides 60 -> portable to OS-level cron too; interpreted in UTC by Bun.cron.
const DEFAULT_SCHEDULE = "*/30 * * * *";
const DEFAULT_INTERVAL_MS = 30 * 60_000; // matches DEFAULT_SCHEDULE; used as the Node fallback default

let started = false;
let sweeping = false; // setInterval has no no-overlap guarantee; emulate Bun.cron's

// SIO-1021: translate the cron schedule to a setInterval millisecond cadence for the Node fallback.
// Only the simple "*/N * * * *" minute-step form (the default + the documented "use a step that
// divides 60" guidance) and "* * * * *" are supported -- no cron-parser dependency. Anything else
// falls back to the 30-minute default with a warn.
export function scheduleToIntervalMs(schedule: string, onUnsupported?: (schedule: string) => void): number {
	const minuteField = schedule.trim().split(/\s+/)[0];
	if (minuteField === "*") return 60_000;
	const step = /^\*\/(\d+)$/.exec(minuteField ?? "");
	if (step) {
		const n = Number(step[1]);
		if (Number.isInteger(n) && n > 0) return n * 60_000;
	}
	onUnsupported?.(schedule);
	return DEFAULT_INTERVAL_MS;
}

export function startIacReconcileCron(): void {
	if (started) return; // module load can run more than once under HMR; register the job once
	// Driven by the agent-memory backend: on any other backend reconcile is a no-op, so don't even
	// register the timer. Set LIVE_MEMORY_BACKEND=agent-memory to enable.
	if (selectedBackend() !== "agent-memory") {
		log.info({ backend: selectedBackend() }, "iac-reconcile cron not started: agent-memory backend not selected");
		return;
	}
	const schedule = process.env.IAC_RECONCILE_CRON_SCHEDULE || DEFAULT_SCHEDULE;

	// A thrown sweep must not crash the web process. Both Bun.cron and setInterval error semantics
	// match setTimeout, so a rejected handler emits unhandledRejection -- register a listener so the
	// job keeps running.
	process.on("unhandledRejection", (err) => {
		log.error({ error: err instanceof Error ? err.message : String(err) }, "iac-reconcile cron handler rejected");
	});

	// Shared by both timer paths; the `sweeping` re-entrancy guard gives the Node setInterval path the
	// same no-overlap behaviour Bun.cron provides natively.
	const runSweep = async (): Promise<void> => {
		if (sweeping) return;
		sweeping = true;
		try {
			// reconcileAll logs its own "reconcile sweep complete" summary (tagged source:"cron").
			await reconcileAll({ source: "cron" });
		} catch (error) {
			log.warn({ error: error instanceof Error ? error.message : String(error) }, "iac-reconcile cron sweep failed");
		} finally {
			sweeping = false;
		}
	};

	try {
		if (typeof Bun !== "undefined") {
			const job = Bun.cron(schedule, runSweep);
			job.unref(); // never keep the process alive solely for the sweep
			started = true;
			log.info({ schedule, runtime: "bun" }, "iac-reconcile cron registered");
		} else {
			// SIO-1021: Node runtime (Vite dev server / Node adapter) has no `Bun` global -> setInterval.
			const intervalMs = scheduleToIntervalMs(schedule, (s) =>
				log.warn({ schedule: s }, "iac-reconcile: cron expression unsupported under Node; defaulting to 30m"),
			);
			const timer = setInterval(() => {
				void runSweep();
			}, intervalMs);
			timer.unref(); // never keep the process alive solely for the sweep
			started = true;
			log.info({ schedule, intervalMs, runtime: "node" }, "iac-reconcile cron registered");
		}
	} catch (error) {
		// An invalid schedule expression throws synchronously -- log and continue (never block boot).
		log.warn(
			{ schedule, error: error instanceof Error ? error.message : String(error) },
			"iac-reconcile cron failed to register",
		);
	}
}
