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
	// Module load can run more than once under HMR; register once per module instance.
	// SIO-1468: cross-graph protection (a dev-server restart that closes the Vite module
	// runner WITHOUT hot.dispose leaves this flag reset in the fresh graph while the old
	// graph's timers survive) lives in the scheduler itself -- registerSchedules keys its
	// timers on globalThis slots and repoints dispatch at the latest registration, so a
	// re-register from a fresh graph takes over the surviving timers instead of stacking.
	if (started) return;
	started = true;

	// loadWorkflows() THROWS on a schema-invalid workflows/*.yaml (any workflow
	// under either agent dir, not just the 3 scheduled ones) -- this runs at
	// module load from agent.ts, so an uncaught throw here would crash the whole
	// web app's boot rather than just skip schedules. Every other failure path
	// in this function logs and continues; this one must too. Reset `started`
	// on failure so a fixed workflow file can be picked up on the next boot
	// (e.g. Vite HMR reload) rather than staying permanently un-registered.
	try {
		const root = getWorkspaceRoot();
		const schedules = loadSchedules(root, (path, error) => {
			log.warn(
				{ path, error: error instanceof Error ? error.message : String(error) },
				"malformed schedule file; skipping",
			);
		});
		if (schedules.size === 0) {
			// SIO-1468: still run the registration pass -- its absent-id reaper stops
			// any slots a previous module graph armed for schedules that no longer exist.
			registerSchedules(schedules, new Map(), { nodes: {} });
			log.info("no schedule definitions found under schedules/*.yaml; nothing to register");
			return;
		}

		const workflows = new Map([
			...loadWorkflows(join(root, "agents", "elastic-iac")),
			...loadWorkflows(join(root, "agents", "incident-analyzer")),
		]);

		// Backend-availability preconditions -- same checks the old cron files made
		// before registering their Bun.cron/setInterval timer. `enabled: false` in a
		// schedule's YAML is the human on/off switch; these are a second, orthogonal
		// gate (does the dependency this sweep needs even exist in this deployment).
		// SIO-1468: gate by DISABLING the entry, not deleting it -- a deleted id never
		// reaches the scheduler's disabled path, so a slot armed by a previous module
		// graph (before the backend went away) would keep sweeping in a dead graph.
		const filtered = new Map(schedules);
		const gate = (id: string, reason: string) => {
			const def = filtered.get(id);
			if (def) filtered.set(id, { ...def, enabled: false });
			log.info(reason);
		};
		if (!reconcileEnabled()) {
			gate(
				"iac-reconcile-sweep",
				"iac-reconcile-sweep: neither agent-memory backend nor knowledge graph enabled; not registering",
			);
		}
		if (!topologyBackendAvailable()) {
			gate("kg-topology-sweep", "kg-topology-sweep: knowledge graph not enabled; not registering");
		}
		if (!purgeBackendAvailable()) {
			gate("kg-purge-sweep", "kg-purge-sweep: knowledge graph not enabled; not registering");
		}

		registerSchedules(filtered, workflows, {
			nodes: {
				"iac-reconcile-sweep": () => reconcileAll({ source: "cron" }),
				"kg-topology-sweep": () => runTopologySweep({ source: "cron" }),
				"kg-purge-sweep": () => runUncuratedPurgeSweep({ source: "cron" }),
			},
		});
	} catch (error) {
		started = false;
		// SIO-1468: no registration pass ran to take ownership of surviving slots, so
		// stop them all (empty-set reap) rather than leave a previous module graph's
		// timers dispatching dead closures. The next successful boot re-arms them.
		registerSchedules(new Map(), new Map(), { nodes: {} });
		log.error(
			{ error: error instanceof Error ? error.message : String(error) },
			"startSchedules failed; no schedules registered this boot",
		);
	}
}
