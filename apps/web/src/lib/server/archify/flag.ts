// apps/web/src/lib/server/archify/flag.ts

// SIO-1877: on by default, like every capability flag (kill-switch semantics, matching
// HIL_LEARNING_ENABLED / RESOLVE_IDENTIFIERS_ENABLED). Only an explicit "false" or "0" turns the
// Diagram tab and /api/diagram off. The one read point; the route and the tab probe both ask here.
export function isArchifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.ARCHIFY_DIAGRAMS_ENABLED?.toLowerCase();
	return v !== "false" && v !== "0";
}
