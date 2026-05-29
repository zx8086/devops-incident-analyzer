// src/tools/transform/summary.ts
// SIO-831: Shared summary projection for transform config + stats.
// Used by list_transforms, get_transform, and get_transform_stats so the
// "headline view" payload stays compact and consistent across tools.

import type { estypes } from "@elastic/elasticsearch";

export interface TransformSummary {
	id: string;
	mode: "pivot" | "latest";
	source_index: string;
	dest_index: string;
	dest_pipeline?: string;
	sync_field?: string;
	retention_max_age?: string;
	// ES `Duration` is string | number depending on how the transform was created.
	frequency?: string | number;
	description?: string;
}

export function summarizeTransform(t: estypes.TransformGetTransformTransformSummary): TransformSummary {
	const sourceIdx = Array.isArray(t.source.index) ? t.source.index.join(",") : t.source.index;
	const mode = "pivot" in t && t.pivot ? "pivot" : "latest";
	const dest = t.dest as { index: string; pipeline?: string };
	const sync = (t as { sync?: { time?: { field?: string } } }).sync;
	const retention = (t as { retention_policy?: { time?: { max_age?: string } } }).retention_policy;
	return {
		id: t.id,
		mode,
		source_index: sourceIdx,
		dest_index: dest.index,
		dest_pipeline: dest.pipeline,
		sync_field: sync?.time?.field,
		retention_max_age: retention?.time?.max_age,
		frequency: t.frequency,
		description: t.description,
	};
}

export function renderSummaryLine(s: TransformSummary): string {
	const parts = [`\`${s.id}\` (${s.mode})`, `src=${s.source_index}`, `dest=${s.dest_index}`];
	if (s.dest_pipeline) parts.push(`pipeline=${s.dest_pipeline}`);
	if (s.sync_field) parts.push(`sync.field=${s.sync_field}`);
	if (s.retention_max_age) parts.push(`retention=${s.retention_max_age}`);
	if (s.frequency) parts.push(`freq=${s.frequency}`);
	return `- ${parts.join(" ")}`;
}

// Parse an ES-style relative duration like `24h`, `30m`, `7d`, `90s`, `100ms`.
// Returns milliseconds. Returns null when the input is not parseable.
const DURATION_UNITS_MS: Record<string, number> = {
	ms: 1,
	s: 1000,
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
};

export function parseEsDuration(value: string): number | null {
	const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
	if (!match?.[1] || !match[2]) return null;
	const unit = DURATION_UNITS_MS[match[2]];
	if (unit === undefined) return null;
	return Number.parseInt(match[1], 10) * unit;
}

export interface TransformStatsSummary {
	id: string;
	state: string;
	health: string;
	node: string;
	last_checkpoint: number | null;
	last_checkpoint_age_seconds: number | null;
	has_next_checkpoint: boolean;
	trigger_count: number;
	failure_rate: number;
	is_stalled: boolean;
}

// SIO-831: Derive the operator-visible fields from the raw stats entry.
// `nowMs` is injectable so tests can pin time.
// `stalledAfterMs` configures the is_stalled threshold (default 24h).
export function summarizeTransformStats(
	t: estypes.TransformGetTransformStatsTransformStats,
	options: { nowMs?: number; stalledAfterMs?: number } = {},
): TransformStatsSummary {
	const now = options.nowMs ?? Date.now();
	const stalledAfter = options.stalledAfterMs ?? 24 * 60 * 60 * 1000;

	const checkpointing = t.checkpointing as
		| { last?: { checkpoint?: number; timestamp_millis?: number }; next?: unknown }
		| undefined;
	const health = (t as { health?: { status?: string } }).health;
	const node = (t as { node?: { id?: string; name?: string } }).node;

	const lastCheckpointTsMs = checkpointing?.last?.timestamp_millis;
	const lastCheckpointAgeSeconds =
		typeof lastCheckpointTsMs === "number" ? Math.max(0, Math.floor((now - lastCheckpointTsMs) / 1000)) : null;

	const stats = (t as { stats?: { trigger_count?: number; index_failures?: number; search_failures?: number } }).stats;
	const triggerCount = stats?.trigger_count ?? 0;
	const indexFailures = stats?.index_failures ?? 0;
	const searchFailures = stats?.search_failures ?? 0;
	// Guard against divide-by-zero for fresh transforms.
	const failureRate = triggerCount === 0 ? 0 : (indexFailures + searchFailures) / triggerCount;
	const isStalled = typeof lastCheckpointTsMs === "number" ? now - lastCheckpointTsMs > stalledAfter : false;

	return {
		id: t.id,
		state: String(t.state),
		health: health?.status ?? "unknown",
		node: node?.name ?? node?.id ?? "n/a",
		last_checkpoint: checkpointing?.last?.checkpoint ?? null,
		last_checkpoint_age_seconds: lastCheckpointAgeSeconds,
		has_next_checkpoint: checkpointing?.next !== undefined,
		trigger_count: triggerCount,
		failure_rate: failureRate,
		is_stalled: isStalled,
	};
}

export function renderStatsSummaryLine(s: TransformStatsSummary): string {
	const ageStr = s.last_checkpoint_age_seconds === null ? "n/a" : `${s.last_checkpoint_age_seconds}s`;
	const failurePct = (s.failure_rate * 100).toFixed(2);
	const stalled = s.is_stalled ? " STALLED" : "";
	return (
		[
			`- \`${s.id}\``,
			`state=${s.state}`,
			`health=${s.health}`,
			`node=${s.node}`,
			`last_ckpt=${s.last_checkpoint ?? "n/a"}`,
			`age=${ageStr}`,
			`next?=${s.has_next_checkpoint}`,
			`failures=${failurePct}%`,
		].join(" ") + stalled
	);
}
