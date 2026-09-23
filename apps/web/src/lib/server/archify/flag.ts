// apps/web/src/lib/server/archify/flag.ts

// SIO-1876: opt-in (not the usual kill-switch form) because the diagrams are not yet verified live.
// The one read point; the route and /api/agents both ask here.
export function isArchifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.ARCHIFY_DIAGRAMS_ENABLED === "true";
}
