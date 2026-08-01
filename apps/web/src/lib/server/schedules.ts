// apps/web/src/lib/server/schedules.ts
// SIO-1358: replaces the 3 hand-wired Bun.cron files (iac-reconcile-cron.ts,
// kg-topology-cron.ts, purge-cron.ts) with the declarative schedules/*.yaml
// layer. Loads schedules/*.yaml + the matching workflows/*.yaml, binds each
// workflow's `node:` target to the sweep function it already calls, and hands
// off to the generic packages/skillflow scheduler. Cadence and enablement both
// live in the YAML now -- no env-var overrides. Backend availability
// (topologyCronEnabled/purgeCronEnabled/reconcileEnabled) is still checked
// before registering, same as before, so an unconfigured deployment never
// registers a sweep it can't run.
import { join } from "node:path";
import {
	getWorkspaceRoot,
	purgeCronEnabled as purgeBackendAvailable,
	reconcileAll,
	reconcileEnabled,
	registerSchedules,
	runTopologySweep,
	runUncuratedPurgeSweep,
	topologyCronEnabled as topologyBackendAvailable,
} from "@devops-agent/agent";
import { loadSchedules, loadWorkflows } from "@devops-agent/gitagent-bridge";
import { getLogger } from "@devops-agent/observability";

const log = getLogger("agent:schedules");

let started = false;

export function startSchedules(): void {
	if (started) return; // module load can run more than once under HMR; register once
	started = true;

	const root = getWorkspaceRoot();
	const schedules = loadSchedules(root, (path, error) => {
		log.warn(
			{ path, error: error instanceof Error ? error.message : String(error) },
			"malformed schedule file; skipping",
		);
	});
	if (schedules.size === 0) return;

	const workflows = new Map([
		...loadWorkflows(join(root, "agents", "elastic-iac")),
		...loadWorkflows(join(root, "agents", "incident-analyzer")),
	]);

	// Backend-availability preconditions -- same checks the old cron files made
	// before registering their Bun.cron/setInterval timer. `enabled: false` in a
	// schedule's YAML is the human on/off switch; these are a second, orthogonal
	// gate (does the dependency this sweep needs even exist in this deployment).
	const filtered = new Map(schedules);
	if (!reconcileEnabled()) {
		filtered.delete("iac-reconcile-sweep");
		log.info("iac-reconcile-sweep: neither agent-memory backend nor knowledge graph enabled; not registering");
	}
	if (!topologyBackendAvailable()) {
		filtered.delete("kg-topology-sweep");
		log.info("kg-topology-sweep: knowledge graph not enabled; not registering");
	}
	if (!purgeBackendAvailable()) {
		filtered.delete("kg-purge-sweep");
		log.info("kg-purge-sweep: knowledge graph not enabled; not registering");
	}

	registerSchedules(filtered, workflows, {
		nodes: {
			"iac-reconcile-sweep": () => reconcileAll({ source: "cron" }),
			"kg-topology-sweep": () => runTopologySweep({ source: "cron" }),
			"kg-purge-sweep": () => runUncuratedPurgeSweep({ source: "cron" }),
		},
	});
}
