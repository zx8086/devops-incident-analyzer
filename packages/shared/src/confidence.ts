// packages/shared/src/confidence.ts
// SIO-1194: single source of truth for confidence cap-reason codes and their
// human-readable explanations. The agent's printed confidence-line annotation and
// the web ConfidenceBadge both read this map so prose and UI never disagree.
// Labels must never start with a digit and the annotation prefix keeps any digit
// beyond LOOSE_CONFIDENCE_RE's 20-char window (see aggregator.ts extraction regexes).

export interface CapReasonInfo {
	label: string;
	detail: string;
}

export const CAP_REASON_INFO: Record<string, CapReasonInfo> = {
	"degraded-subagents": {
		label: "datasource tool errors",
		detail: "One or more datasource agents had a high tool-failure rate, so their findings may be incomplete.",
	},
	gaps: {
		label: "unresolved data gaps",
		detail: "The report lists two or more gaps caused by failed or unrecovered tools or queries.",
	},
	"ungrounded-blocker": {
		label: "unverified permission claim",
		detail: "A permission or IAM blocker was claimed with no observed authorization error; the claim was rewritten.",
	},
	"ungrounded-expiry": {
		label: "unverified log-expiry claim",
		detail: "A log retention or expiry claim had no observed evidence of absence.",
	},
	"premature-absence": {
		label: "unverified absence claim",
		detail: "An absence claim was contradicted by returned data or over-generalized from a partial query.",
	},
	"ungrounded-root-cause": {
		label: "unverified root-cause mechanism",
		detail: "The stated root-cause mechanism is not supported by any returned data; it was softened.",
	},
	"no-index-misread": {
		label: "misread no-index result",
		detail: "A no-data or schema claim was grounded only in a query that failed for lack of an index.",
	},
	"correlation-degraded": {
		label: "unresolved cross-source correlation",
		detail: "A correlation rule fired but the follow-up fetch did not cover the triggered entities.",
	},
	"ungrounded-metrics": {
		label: "unverified metric values",
		detail: "Several metric values in the answer were not found in the source data.",
	},
};

export function capReasonLabel(code: string): string {
	return CAP_REASON_INFO[code]?.label ?? code;
}

export function capReasonDetail(code: string): string {
	return CAP_REASON_INFO[code]?.detail ?? code;
}
