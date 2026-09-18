// packages/pi-coms/contracts/report.ts
// SIO-1814: the one definition of an incident report's finding line, shared by
// the monitor that writes it (scripts/monitor/report.ts) and the analyzer that
// reads it (packages/agent/src/fleet-inbox.ts). They used to hold a template and
// a regex apart, and the regex silently stopped matching when hyphenated
// families (db-events, spoke-health) arrived. Dependency-free like reply.ts: the
// analyzer cannot resolve the monitor's nested zod install.

export type FindingLine = { severity: string; family: string; resource: string; summary: string };

export function formatFindingLine(f: FindingLine): string {
	return `- (${f.severity}/${f.family}) ${f.resource}: ${f.summary}`;
}

// The family capture is a shape, not the enum: the monitor ships in the fleet
// bundle on its own cadence, so a reader pinned to today's families would drop
// every finding of a family a newer monitor adds. Anchored at column 0 on
// purpose: the digest's notable lines share the "(sev/family)" shape behind a
// two-space indent and are a 24 h rollup, not findings to count again.
export const FINDING_LINE_RE = /^- \((info|warn|critical)\/([a-z-]+)\) (.+?): (.+)$/;
