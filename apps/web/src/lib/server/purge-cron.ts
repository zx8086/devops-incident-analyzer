// apps/web/src/lib/server/purge-cron.ts
// SIO-1135: in-process scheduled sweep that physically removes uncurated Incident rows
// older than KG_UNCURATED_RETENTION_DAYS. DB-only (no MCP I/O), unlike the topology
// sweep -- but in-process for the same reason: embedded lbug takes an exclusive file
// lock, so it must reuse THIS web process's getGraphStore() handle. Default OFF
// (KG_PURGE_CRON_ENABLED); the retention WINDOW still defaults ON (30d), this flag only
// controls the automatic sweep.
//
// Runtime split mirrors kg-topology-cron.ts: Bun.cron under Bun; a portable setInterval
// fallback under Node (Vite dev server / Node adapter), with a `sweeping` re-entrancy
// flag emulating Bun.cron's no-overlap. Reuses scheduleToIntervalMs from that file.
import { purgeCronEnabled, runUncuratedPurgeSweep } from "@devops-agent/agent";
import { getLogger } from "@devops-agent/observability";
import { scheduleToIntervalMs } from "./kg-topology-cron";

const log = getLogger("agent:kg-purge-cron");

const DEFAULT_SCHEDULE = "0 3 * * *"; // daily at 03:00 (UTC under Bun.cron)
const DEFAULT_INTERVAL_MS = 24 * 60 * 60_000; // matches DEFAULT_SCHEDULE; Node fallback default

let started = false;
let sweeping = false;

export function startPurgeCron(): void {
	if (started) return; // module load can run more than once under HMR; register the job once
	if (!purgeCronEnabled()) {
		log.info("kg-purge cron not started: KG_PURGE_CRON_ENABLED (and KNOWLEDGE_GRAPH_ENABLED) required");
		return;
	}
	const schedule = process.env.KG_PURGE_CRON_SCHEDULE || DEFAULT_SCHEDULE;

	const runSweep = async (): Promise<void> => {
		if (sweeping) return;
		sweeping = true;
		try {
			await runUncuratedPurgeSweep({ source: "cron" });
		} catch (error) {
			log.warn({ error: error instanceof Error ? error.message : String(error) }, "kg-purge cron sweep failed");
		} finally {
			sweeping = false;
		}
	};

	try {
		if (typeof Bun !== "undefined") {
			const job = Bun.cron(schedule, runSweep);
			job.unref(); // never keep the process alive solely for the sweep
			started = true;
			log.info({ schedule, runtime: "bun" }, "kg-purge cron registered");
		} else {
			// Node runtime (Vite dev server / Node adapter) has no `Bun` global -> setInterval.
			// scheduleToIntervalMs supports minute-step / every-minute / fixed-minute-of-hour,
			// but NOT the daily "0 3 * * *" default -- it reports that via the callback, in which
			// case we use our own DAILY fallback (not the topology cron's hourly default).
			let unsupported = false;
			const parsedMs = scheduleToIntervalMs(schedule, () => {
				unsupported = true;
			});
			const intervalMs = unsupported ? DEFAULT_INTERVAL_MS : parsedMs;
			if (unsupported) {
				log.info({ schedule, intervalMs }, "kg-purge: cron expression unsupported under Node; defaulting to daily");
			}
			const timer = setInterval(() => {
				void runSweep();
			}, intervalMs);
			timer.unref(); // never keep the process alive solely for the sweep
			started = true;
			log.info({ schedule, intervalMs, runtime: "node" }, "kg-purge cron registered");
		}
	} catch (error) {
		// An invalid schedule expression throws synchronously -- log and continue (never block boot).
		log.warn(
			{ schedule, error: error instanceof Error ? error.message : String(error) },
			"kg-purge cron failed to register",
		);
	}
}
