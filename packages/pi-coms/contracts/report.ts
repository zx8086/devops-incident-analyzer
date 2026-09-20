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

// SIO-1832: the header may carry the friendly account name after the id --
// `[info] aws-123456789012 (eu-oit-prd) daily digest (since <ts>)` -- because an
// inbox list of eight numeric accounts is unreadable.
//
// OPTIONAL on purpose, and it must stay that way. The fleet rolls out host by
// host, so during a rollout both shapes sit in the mailbox at once; a REQUIRED
// group would drop every report from a spoke still on the old bundle, which is
// the SIO-1825 failure again. The name also stays AFTER the id so the id keeps
// capture group 2 and no caller's indexing moves.
//
// The charset is deliberately tight (lowercase, digits, hyphen -- the shape of a
// fleet.yaml spoke key): a looser group could swallow the rest of the header and
// make `daily digest` match inside a name.
const ACCOUNT_NAME_RE = String.raw`(?: \(([a-z0-9-]+)\))?`;

const INCIDENT_HEADER_RE = new RegExp(
	String.raw`^\[(info|warn|critical)\] aws-(\d+)${ACCOUNT_NAME_RE}: (\d+) finding\(s\)`,
);
const DIGEST_HEADER_RE = new RegExp(String.raw`^\[(info|warn|critical)\] aws-(\d+)${ACCOUNT_NAME_RE} daily digest\b`);
const SUPPRESSION_HEADER_RE = new RegExp(
	String.raw`^\[(info|warn|critical)\] aws-(\d+)${ACCOUNT_NAME_RE} suppression review\b`,
);

export type MonitorHeader = {
	kind: MonitorMessageKind;
	severity: string;
	accountId: string;
	// The friendly account name when the writing monitor knew one (SIO-1832).
	// undefined for an older monitor, so a reader must fall back to accountId
	// rather than treating its absence as a parse failure.
	accountName: string | undefined;
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
			accountName: incident[3],
			// The name is group 3 now, so the count moved to 4.
			findingCount: Number(incident[4]),
		};
	}
	const digest = DIGEST_HEADER_RE.exec(line);
	if (digest) {
		return {
			kind: "daily-digest",
			severity: digest[1] ?? "",
			accountId: digest[2] ?? "",
			accountName: digest[3],
			findingCount: null,
		};
	}
	const suppression = SUPPRESSION_HEADER_RE.exec(line);
	if (suppression) {
		return {
			kind: "suppression-review",
			severity: suppression[1] ?? "",
			accountId: suppression[2] ?? "",
			accountName: suppression[3],
			findingCount: null,
		};
	}
	return undefined;
}
