// apps/web/src/lib/server/kg-topology-cron.ts
// SIO-1104 (5a): in-process scheduled topology sweep -- collects live runtime topology
// (elastic APM service_destination, Konnect routes, Kafka consumer groups, AWS ECS)
// into the knowledge graph with tValid/tInvalid freshness + K-miss invalidation.
// In-process (not OS-level) is deliberate, same as iac-reconcile-cron: it reuses THIS
// web process's already-connected MCP bridge and the single getGraphStore() lbug
// handle (embedded lbug takes an exclusive file lock -- a second process would be
// locked out). Default OFF (KG_TOPOLOGY_CRON_ENABLED) -- it does live MCP I/O on a
// schedule, unlike the other KG flags.
//
// SIO-1021 runtime split as in iac-reconcile-cron.ts: Bun.cron under Bun; a portable
// setInterval fallback under Node (Vite dev server / Node adapter), with a `sweeping`
// re-entrancy flag emulating Bun.cron's no-overlap.
import { runTopologySweep, topologyCronEnabled } from "@devops-agent/agent";
import { getLogger } from "@devops-agent/observability";

const log = getLogger("agent:kg-topology-cron");

const DEFAULT_SCHEDULE = "0 * * * *"; // hourly, on the hour (UTC under Bun.cron)
const DEFAULT_INTERVAL_MS = 60 * 60_000; // matches DEFAULT_SCHEDULE; Node fallback default

let started = false;
let sweeping = false; // setInterval has no no-overlap guarantee; emulate Bun.cron's

// Translate the cron schedule to a setInterval cadence for the Node fallback. On top
// of the iac-reconcile forms ("*/N * * * *" step, "* * * * *" every-minute) this ALSO
// accepts a fixed minute-of-hour ("0 * * * *", the default) as an hourly cadence --
// without it the default schedule would warn-and-fall-back on every Node boot.
// Anything else falls back to hourly with a warn.
export function scheduleToIntervalMs(schedule: string, onUnsupported?: (schedule: string) => void): number {
	const fields = schedule.trim().split(/\s+/);
	const minuteField = fields[0];
	const hourField = fields[1];
	if (minuteField === "*") return 60_000;
	const step = /^\*\/(\d+)$/.exec(minuteField ?? "");
	if (step) {
		const n = Number(step[1]);
		if (Number.isInteger(n) && n > 0) return n * 60_000;
	}
	// Fixed minute-of-hour is hourly ONLY with a wildcard hour ("0 * * * *"); a
	// constrained hour ("0 9 * * MON-FRI" = daily) must not silently run hourly.
	if (/^\d+$/.test(minuteField ?? "") && hourField === "*") return 60 * 60_000;
	onUnsupported?.(schedule);
	return DEFAULT_INTERVAL_MS;
}

export function startKgTopologyCron(): void {
	if (started) return; // module load can run more than once under HMR; register the job once
	if (!topologyCronEnabled()) {
		log.info("kg-topology cron not started: KG_TOPOLOGY_CRON_ENABLED (and KNOWLEDGE_GRAPH_ENABLED) required");
		return;
	}
	const schedule = process.env.KG_TOPOLOGY_CRON_SCHEDULE || DEFAULT_SCHEDULE;

	// A thrown sweep must not crash the web process. Both Bun.cron and setInterval error
	// semantics match setTimeout, so a rejected handler emits unhandledRejection --
	// register a listener so the job keeps running.
	process.on("unhandledRejection", (err) => {
		log.error({ error: err instanceof Error ? err.message : String(err) }, "kg-topology cron handler rejected");
	});

	// Shared by both timer paths; the `sweeping` re-entrancy guard gives the Node
	// setInterval path the same no-overlap behaviour Bun.cron provides natively.
	const runSweep = async (): Promise<void> => {
		if (sweeping) return;
		sweeping = true;
		try {
			// runTopologySweep logs its own "topology sweep complete" summary and skips
			// itself until the MCP bridge is connected (lazy on the first user turn).
			await runTopologySweep({ source: "cron" });
		} catch (error) {
			log.warn({ error: error instanceof Error ? error.message : String(error) }, "kg-topology cron sweep failed");
		} finally {
			sweeping = false;
		}
	};

	try {
		if (typeof Bun !== "undefined") {
			const job = Bun.cron(schedule, runSweep);
			job.unref(); // never keep the process alive solely for the sweep
			started = true;
			log.info({ schedule, runtime: "bun" }, "kg-topology cron registered");
		} else {
			// Node runtime (Vite dev server / Node adapter) has no `Bun` global -> setInterval.
			const intervalMs = scheduleToIntervalMs(schedule, (s) =>
				log.warn({ schedule: s }, "kg-topology: cron expression unsupported under Node; defaulting to hourly"),
			);
			const timer = setInterval(() => {
				void runSweep();
			}, intervalMs);
			timer.unref(); // never keep the process alive solely for the sweep
			started = true;
			log.info({ schedule, intervalMs, runtime: "node" }, "kg-topology cron registered");
		}
	} catch (error) {
		// An invalid schedule expression throws synchronously -- log and continue (never block boot).
		log.warn(
			{ schedule, error: error instanceof Error ? error.message : String(error) },
			"kg-topology cron failed to register",
		);
	}
}
