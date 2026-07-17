// packages/agent/src/kg-retention.ts
//
// SIO-1135: retention sweep for uncurated incidents. Only human-curated investigations
// are durable memory (SIO-1134); uncurated Incident rows accumulate and, because
// enrichment now filters them out, they are dead weight. This sweep physically removes
// uncurated incidents older than a retention window. DB-only (no MCP I/O), unlike the
// topology sweep -- so it gets its own cron flag and can run on a cheaper cadence.

import { getGraphStore, isKnowledgeGraphEnabled, purgeUncuratedIncidents } from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";

const logger = getLogger("agent:kg-retention");

const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 86_400_000;

// Retention window in days. Default 30 (feature ON -- the user rule: features default
// ON). A value <= 0 disables the purge (returns 0 so the sweep no-ops). Call-time read
// with an injectable env (no module-scope env reads in packages/agent).
export function uncuratedRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.KG_UNCURATED_RETENTION_DAYS;
	if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
	return parsed;
}

// Default OFF, like the topology cron: a scheduled sweep that mutates the store should be
// opt-in per environment. Requires the knowledge graph itself to be enabled.
export function purgeCronEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env.KG_PURGE_CRON_ENABLED;
	return (v === "true" || v === "1") && isKnowledgeGraphEnabled(env);
}

export interface PurgeSweepSummary {
	skipped?: string;
	incidents?: number;
	edges?: number;
	retentionDays?: number;
}

// Compute the cutoff and purge. Callable from the cron OR ad hoc. Self-skips when the
// graph is disabled or the retention window is non-positive (disabled). Never throws:
// the caller (cron) still wraps it, but returning a summary keeps failures observable.
export async function runUncuratedPurgeSweep(
	opts: { source?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<PurgeSweepSummary> {
	const env = opts.env ?? process.env;
	if (!isKnowledgeGraphEnabled(env)) return { skipped: "kg-disabled" };
	const days = uncuratedRetentionDays(env);
	if (!(days > 0)) return { skipped: "retention-disabled", retentionDays: days };

	const cutoffIso = new Date(Date.now() - days * MS_PER_DAY).toISOString();
	const store = await getGraphStore();
	const result = await purgeUncuratedIncidents(store, cutoffIso);
	logger.info(
		{ source: opts.source ?? "manual", retentionDays: days, cutoff: cutoffIso, ...result },
		"uncurated incident purge complete",
	);
	return { incidents: result.incidents, edges: result.edges, retentionDays: days };
}
