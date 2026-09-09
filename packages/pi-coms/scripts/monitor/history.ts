// scripts/monitor/history.ts
import { type Family, FamilySchema, FindingSchema, type Severity, SeveritySchema } from "./report.ts";

// `history [count] [info|warn|critical] [family]`: the digest names at most
// ten findings and points at "the journal" for the rest; this is the read
// path for the rest (SIO-1676). Window stays seven days.

export const HISTORY_DEFAULT = 20;
export const HISTORY_MAX = 200;
export const HISTORY_USAGE = `usage: history [count<=${HISTORY_MAX}] [info|warn|critical] [${FamilySchema.options.join("|")}]`;

export type HistoryQuery = { count: number; minSeverity: Severity | null; family: Family | null };

const SEV_RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

export function parseHistoryArgs(rest: string): HistoryQuery | { error: string } {
	const q: HistoryQuery = { count: HISTORY_DEFAULT, minSeverity: null, family: null };
	for (const tok of rest.trim().split(/\s+/).filter(Boolean)) {
		const lower = tok.toLowerCase();
		if (/^\d+$/.test(lower)) {
			const n = Number(lower);
			if (n < 1 || n > HISTORY_MAX) return { error: HISTORY_USAGE };
			q.count = n;
		} else if (SeveritySchema.safeParse(lower).success) {
			q.minSeverity = lower as Severity;
		} else if (FamilySchema.safeParse(lower).success) {
			q.family = lower as Family;
		} else {
			return { error: HISTORY_USAGE };
		}
	}
	return q;
}

// Rows are oldest-first from the journal; the reply keeps that order but
// takes the newest `count` matches, and says how many it left out.
export function formatHistory(rows: { ts: string; payload: string }[], q: HistoryQuery): string {
	const matching: { ts: string; payload: string }[] = [];
	for (const r of rows) {
		if (q.minSeverity === null && q.family === null) {
			matching.push(r);
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(r.payload);
		} catch {
			continue;
		}
		const f = FindingSchema.safeParse(parsed);
		if (!f.success) continue;
		if (q.minSeverity !== null && SEV_RANK[f.data.severity] < SEV_RANK[q.minSeverity]) continue;
		if (q.family !== null && f.data.family !== q.family) continue;
		matching.push(r);
	}
	const filter = [q.minSeverity ? `${q.minSeverity}+` : "", q.family ?? ""].filter(Boolean).join(" ");
	if (matching.length === 0) return `no ${filter ? `${filter} ` : ""}findings in the last 7 days`;
	const shown = matching.slice(-q.count);
	const lines = shown.map((r) => `${r.ts} ${r.payload}`);
	if (matching.length > shown.length) {
		lines.push(
			`(showing the newest ${shown.length} of ${matching.length} matching finding(s); history <count> up to ${HISTORY_MAX})`,
		);
	}
	return lines.join("\n");
}
