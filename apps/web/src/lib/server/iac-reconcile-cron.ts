// apps/web/src/lib/server/iac-reconcile-cron.ts
// SIO-1005: in-process Bun.cron sweep that reconciles proposed elastic-iac memory facts to their
// real terminal state (applied / apply-failed / closed). In-process (not OS-level) is deliberate:
// it shares the already-connected MCP bridge and the bound agent-memory client in THIS web process,
// so reconcileAll's gitlab_* tool calls and durable-memory writes just work -- no separate daemon,
// no re-connecting tools. Bun.cron's no-overlap guarantee means a slow sweep never stacks; unref()
// so it never blocks shutdown.
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

let started = false;

export function startIacReconcileCron(): void {
	if (started) return; // module load can run more than once under HMR; register the job once
	// Driven by the agent-memory backend: on any other backend reconcile is a no-op, so don't even
	// register the timer. Set LIVE_MEMORY_BACKEND=agent-memory to enable.
	if (selectedBackend() !== "agent-memory") {
		log.info({ backend: selectedBackend() }, "iac-reconcile cron not started: agent-memory backend not selected");
		return;
	}
	const schedule = process.env.IAC_RECONCILE_CRON_SCHEDULE || DEFAULT_SCHEDULE;

	// A thrown sweep must not crash the web process. Bun.cron error semantics match setTimeout, so a
	// rejected handler emits unhandledRejection -- register a listener so the job keeps running.
	process.on("unhandledRejection", (err) => {
		log.error({ error: err instanceof Error ? err.message : String(err) }, "iac-reconcile cron handler rejected");
	});

	try {
		const job = Bun.cron(schedule, async () => {
			try {
				// reconcileAll logs its own "reconcile sweep complete" summary (tagged source:"cron").
				await reconcileAll({ source: "cron" });
			} catch (error) {
				log.warn({ error: error instanceof Error ? error.message : String(error) }, "iac-reconcile cron sweep failed");
			}
		});
		job.unref(); // never keep the process alive solely for the sweep
		started = true;
		log.info({ schedule }, "iac-reconcile cron registered");
	} catch (error) {
		// An invalid schedule expression throws synchronously -- log and continue (never block boot).
		log.warn(
			{ schedule, error: error instanceof Error ? error.message : String(error) },
			"iac-reconcile cron failed to register",
		);
	}
}
