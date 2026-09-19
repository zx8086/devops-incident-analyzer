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

// SIO-1825: the monitor writes FOUR header shapes, not one. The analyzer matched
// only the incident report's and silently dropped the rest: a daily digest and a
// suppression review parsed as `undefined`, fell through to the conversation
// branch, and were discarded by the monitor-report filter. So the fleet inbox
// read "0 monitor report(s)" on accounts whose mailbox held a digest every day.
// All four live here for the same reason FINDING_LINE_RE does: the monitor that
// writes them and the analyzer that reads them share one definition.
//
//   [warn] aws-123456789012: 2 finding(s)                      incident report
//   [info] aws-123456789012 daily digest (since <ts>)          daily digest
//   [warn] aws-123456789012 daily digest DEGRADED: ...         daily digest
//   [info] aws-123456789012 suppression review (last 7d)       suppression review
//
// `finding(s)` is the ONLY shape carrying a finding count; a digest's counts are a
// 24 h rollup of its own and a suppression review has none. Callers must therefore
// treat `findingCount` as present only on an incident report (see MonitorMessageKind).
export type MonitorMessageKind = "incident-report" | "daily-digest" | "suppression-review";

const INCIDENT_HEADER_RE = /^\[(info|warn|critical)\] aws-(\d+): (\d+) finding\(s\)/;
const DIGEST_HEADER_RE = /^\[(info|warn|critical)\] aws-(\d+) daily digest\b/;
const SUPPRESSION_HEADER_RE = /^\[(info|warn|critical)\] aws-(\d+) suppression review\b/;

export type MonitorHeader = {
	kind: MonitorMessageKind;
	severity: string;
	accountId: string;
	// Incident reports only: the count the header states. null on the other two,
	// so a digest can never be read as "N fresh findings".
	findingCount: number | null;
};

// Parses the first line of a monitor message. Returns undefined for anything that
// is not one of the monitor's own headers (a spoke conversation, an operator note).
export function parseMonitorHeader(line: string): MonitorHeader | undefined {
	const incident = INCIDENT_HEADER_RE.exec(line);
	if (incident) {
		return {
			kind: "incident-report",
			severity: incident[1] ?? "",
			accountId: incident[2] ?? "",
			findingCount: Number(incident[3]),
		};
	}
	const digest = DIGEST_HEADER_RE.exec(line);
	if (digest) {
		return { kind: "daily-digest", severity: digest[1] ?? "", accountId: digest[2] ?? "", findingCount: null };
	}
	const suppression = SUPPRESSION_HEADER_RE.exec(line);
	if (suppression) {
		return {
			kind: "suppression-review",
			severity: suppression[1] ?? "",
			accountId: suppression[2] ?? "",
			findingCount: null,
		};
	}
	return undefined;
}
