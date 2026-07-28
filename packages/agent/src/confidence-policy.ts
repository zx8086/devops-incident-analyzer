// agent/src/confidence-policy.ts
// SIO-1195: two-class confidence cap policy. INTEGRITY reasons (fabrication-class
// guards) always hard-cap strictly below the HITL gate. COVERAGE reasons (tool
// degradation / gaps / correlation shortfalls) soft-cap ABOVE the gate -- but only
// when every coverage signal is deterministically attributable to datasources that
// are provably disjoint from the root-cause evidence. Every uncertain case (missing
// Root Cause section, unattributable bullet, unknown reason code, overlap) fails
// closed to the hard cap, so this module can only ever make behavior less punitive
// than the SIO-709 single clamp, never more permissive on integrity failures.
// Pure: no LLM, no state import, no aggregator import (aggregator imports this).

import type { ReportCaveat } from "@devops-agent/shared";

export type CapClass = "integrity" | "coverage";

export const CAP_REASON_CLASS: Record<string, CapClass> = {
	"degraded-subagents": "coverage",
	gaps: "coverage",
	"correlation-degraded": "coverage",
	"ungrounded-blocker": "integrity",
	"ungrounded-expiry": "integrity",
	"premature-absence": "integrity",
	// SIO-1266: sibling of "premature-absence" for a claim whose OWN tool call failed this turn.
	// INTEGRITY, not coverage: the report asserts a MEASURED negative that was never measured -- a
	// fabricated finding, not a hole the report is honest about. Classifying it "coverage" would
	// route it through the disjointness test below and let a report that published "0 hits, the
	// error is not happening now" off a failed query soft-cap to 0.75, ABOVE the 0.6 HITL gate, in
	// the dangerous direction.
	"premature-absence-unverifiable": "integrity",
	"ungrounded-root-cause": "integrity",
	"no-index-misread": "integrity",
	"ungrounded-metrics": "integrity",
};

// SIO-1266: integrity reasons that are NEVER soft-eligible, whatever their per-claim signals say.
//
// The SIO-1198 soft path exists for a claim the guard DISCHARGED. A contradicted-absence caveat
// discharges it by restoring the reader to a TRUE belief ("there IS data; here it is"), so a
// corrected, non-load-bearing claim need not gate the report. An unverifiable-absence caveat cannot
// do that. The best it can say is "nobody knows whether this is still happening" -- it restores the
// reader to IGNORANCE, which is precisely the state a human reviewer exists to resolve.
// `reconciled` and `loadBearing` are both blind to this distinction (one is a discharge test, the
// other a location test), so it is stated here explicitly rather than smuggled in by mislabelling
// a signal.
//
// This also makes SIO-1266 a pure reason-correctness change: run 2445908e stays hard-capped at 0.59
// and still gates HITL. Only the stated reason and the caveat text change.
const ALWAYS_HARD_INTEGRITY_REASONS: ReadonlySet<string> = new Set(["premature-absence-unverifiable"]);

// Same derivation as deriveConfidenceCap (confidence-gate.ts) -- duplicated here to
// keep this module import-free; the parity is pinned by tests on both sides,
// including the 0-clamp for pathological sub-margin thresholds (CodeRabbit PR #455).
export function hardCapFor(threshold: number): number {
	return Math.max(0, Math.min(0.59, threshold - 0.01));
}

// Soft cap: partial coverage forbids near-certainty (ceiling 0.95) but must pass
// the gate with margin (floor threshold+0.1, never below 0.75). A multiplicative
// penalty was rejected: 0.9 * 0.65 = 0.585 would land BELOW the default gate on
// the soft path, recreating the exact confusion this policy removes.
export function softCapFor(threshold: number): number {
	return Math.min(0.95, Math.max(threshold + 0.1, 0.75));
}

// One signal per coverage trigger. dataSources === null => unattributable.
export interface CoverageSignal {
	reason: string;
	dataSources: string[] | null;
}

// SIO-1198 Part B: one signal per flagged CLAIM behind an integrity reason.
// reconciled = the guard DISCHARGED the claim -- either it mutated the claim line in place
// (the suffix-append guards) or, since SIO-1242, it recorded a structured caveat naming the
// claim verbatim. Both make the report internally honest; only an UNDISCHARGED claim keeps
// the SIO-1195 hard cap. Renamed from `rewritten`, which described the mechanism rather than
// the property the tiering actually depends on -- and which would have silently forced every
// integrity reason to hard-cap once the absence guard stopped mutating text.
// loadBearing = the claim sits in, or is attributed by, the Root Cause section
// (location-based -- see isClaimLoadBearing). An integrity reason is soft-eligible
// only when every one of its signals is reconciled and not load-bearing.
export interface IntegritySignal {
	reason: string;
	reconciled: boolean;
	loadBearing: boolean;
}

export interface CapDecision {
	mode: "none" | "hard" | "soft";
	cap?: number;
	hardReasons: string[];
	scopedReasons: string[];
	degradedDataSources: string[];
}

export function decideConfidenceCap(input: {
	capReasons: string[];
	coverageSignals: CoverageSignal[];
	// SIO-1198: per-claim signals for integrity reasons; an integrity reason with no
	// signal (or tiering disabled) is ineligible for softening -- fail-closed hard.
	integritySignals?: IntegritySignal[];
	integrityTieringEnabled?: boolean;
	rootCauseDataSources: string[] | null;
	threshold: number;
}): CapDecision {
	const integrity = input.capReasons.filter((r) => CAP_REASON_CLASS[r] !== "coverage");
	const coverage = input.capReasons.filter((r) => CAP_REASON_CLASS[r] === "coverage");
	const degradedDataSources = [...new Set(input.coverageSignals.flatMap((s) => s.dataSources ?? []))];

	if (input.capReasons.length === 0) {
		return { mode: "none", hardReasons: [], scopedReasons: [], degradedDataSources };
	}

	// SIO-1198 Part B: integrity reasons are soft-eligible only when tiering is on and
	// EVERY reason has at least one signal with every signal reconciled and
	// not load-bearing for the Root Cause. Anything else (unsignalled reason, failed
	// rewrite, load-bearing claim, tiering off) keeps the SIO-1195 hard cap.
	const tiering = input.integrityTieringEnabled ?? true;
	const integritySignals = input.integritySignals ?? [];
	const integrityEligible =
		integrity.length === 0 ||
		(tiering &&
			// SIO-1266: one always-hard reason poisons the whole soft path, exactly as one
			// unsignalled or load-bearing reason does in the every() below.
			!integrity.some((r) => ALWAYS_HARD_INTEGRITY_REASONS.has(r)) &&
			integrity.every((r) => {
				const signals = integritySignals.filter((s) => s.reason === r);
				return signals.length > 0 && signals.every((s) => s.reconciled && !s.loadBearing);
			}));
	if (!integrityEligible) {
		return {
			mode: "hard",
			cap: hardCapFor(input.threshold),
			hardReasons: input.capReasons,
			scopedReasons: [],
			degradedDataSources,
		};
	}

	const rc = input.rootCauseDataSources;
	// Coverage soft requires: an identified root-cause evidence set, every coverage
	// reason backed by at least one signal, and every signal attributable to
	// datasources none of which supplied the root-cause evidence. No coverage
	// reasons at all passes trivially (integrity-only soft path).
	const everyReasonSignalled = coverage.every((r) => input.coverageSignals.some((s) => s.reason === r));
	const disjoint =
		rc !== null &&
		rc.length > 0 &&
		everyReasonSignalled &&
		input.coverageSignals.length > 0 &&
		input.coverageSignals.every(
			(s) => s.dataSources !== null && s.dataSources.length > 0 && s.dataSources.every((ds) => !rc.includes(ds)),
		);
	const coverageOk = coverage.length === 0 || disjoint;

	return coverageOk
		? {
				mode: "soft",
				cap: softCapFor(input.threshold),
				hardReasons: [],
				scopedReasons: input.capReasons,
				degradedDataSources,
			}
		: {
				mode: "hard",
				cap: hardCapFor(input.threshold),
				hardReasons: coverage,
				scopedReasons: [],
				degradedDataSources,
			};
}

// --- Deterministic datasource attribution -------------------------------------

// Case-sensitive snake_case tool prefixes (same rationale as GAP_TOOL_NAME_RE in
// aggregator.ts: SCREAMING_SNAKE identifiers are data, not tool names).
const TOOL_PREFIX_TO_DATASOURCE: Array<[RegExp, string]> = [
	[/\b(?:kafka|ksql|sr|schema_registry)_[a-z0-9_]+/, "kafka"],
	[/\belasticsearch_[a-z0-9_]+/, "elastic"],
	[/\b(?:capella|couchbase)_[a-z0-9_]+/, "couchbase"],
	[/\bkonnect_[a-z0-9_]+/, "konnect"],
	[/\bgitlab_[a-z0-9_]+/, "gitlab"],
	[/\batlassian_[a-z0-9_]+/, "atlassian"],
	[/\baws_[a-z0-9_]+/, "aws"],
];

// Keyword fallback. A SUPERSET of aggregator.ts's DATASOURCE_KEYWORDS (which covers
// only elastic/couchbase/kafka and is tuned for detectPrematureAbsence -- do NOT
// fold these together). False positives here only WIDEN the degraded set, which
// biases toward overlap and therefore toward the hard cap: errors are safe.
export const ATTRIBUTION_KEYWORDS: Record<string, RegExp> = {
	elastic: /\b(elastic|elasticsearch|kibana|logs-apm|apm)\b/i,
	couchbase: /\b(couchbase|capella|n1ql|sql\+\+)\b/i,
	kafka: /\b(kafka|ksqldb?|schema registry|consumer group|dlq)\b/i,
	konnect: /\b(konnect|kong)\b/i,
	gitlab: /\b(gitlab|orbit|merge request|pipeline)\b/i,
	atlassian: /\b(atlassian|jira|confluence)\b/i,
	aws: /\b(aws|cloudwatch|ecs|lambda|log group)\b/i,
};

export function attributeLineDataSources(line: string): string[] {
	const out = new Set<string>();
	for (const [re, ds] of TOOL_PREFIX_TO_DATASOURCE) {
		if (re.test(line)) out.add(ds);
	}
	for (const [ds, re] of Object.entries(ATTRIBUTION_KEYWORDS)) {
		if (re.test(line)) out.add(ds);
	}
	return [...out];
}

export function attributeGapBullets(bullets: string[]): { dataSources: string[]; allAttributed: boolean } {
	const union = new Set<string>();
	let allAttributed = true;
	for (const bullet of bullets) {
		const attributed = attributeLineDataSources(bullet);
		if (attributed.length === 0) {
			allAttributed = false;
			continue;
		}
		for (const ds of attributed) union.add(ds);
	}
	return { dataSources: [...union], allAttributed };
}

// --- Root-cause evidence set ---------------------------------------------------

const ROOT_CAUSE_SECTION_HEADING_RE = /^(#{1,6})\s+root cause/i;
const ANY_HEADING_LINE_RE = /^(#{1,6})\s+\S/;

// Walks the "## Root Cause" section, attributes its lines, then INTERSECTS with the
// datasources that actually returned data this turn (blocks hallucinated grounding:
// a Root Cause naming a datasource whose sub-agent returned nothing cannot claim it
// as evidence). Missing section / zero attributions / empty intersection => null.
export function extractRootCauseDataSources(answer: string, dataSourcesWithReturnedData: string[]): string[] | null {
	const lines = answer.split("\n");
	let sectionLevel: number | null = null;
	const attributed = new Set<string>();
	for (const line of lines) {
		if (sectionLevel === null) {
			const m = line.match(ROOT_CAUSE_SECTION_HEADING_RE);
			if (m?.[1]) sectionLevel = m[1].length;
			continue;
		}
		const heading = line.match(ANY_HEADING_LINE_RE);
		if (heading?.[1] && heading[1].length <= sectionLevel) break;
		for (const ds of attributeLineDataSources(line)) attributed.add(ds);
	}
	if (sectionLevel === null || attributed.size === 0) return null;
	const returned = new Set(dataSourcesWithReturnedData);
	const grounded = [...attributed].filter((ds) => returned.has(ds));
	return grounded.length > 0 ? grounded : null;
}

// --- Root-cause load-bearing test (SIO-1198) -------------------------------------

// Location-based, deliberately NOT the coverage disjointness test: a datasource can
// be absent from rootCauseDataSources precisely BECAUSE it returned nothing while the
// Root Cause prose still cites it -- returned-data intersection would soften exactly
// that case. A flagged claim is load-bearing when its line lies inside the Root Cause
// section, or the section's raw prose attribution includes the claim's datasource.
// Missing section or unattributable claim => load-bearing (fail-closed hard).
export function isClaimLoadBearing(answer: string, claimLine: string): boolean {
	const lines = answer.split("\n");
	let sectionLevel: number | null = null;
	const sectionLines: string[] = [];
	for (const line of lines) {
		if (sectionLevel === null) {
			const m = line.match(ROOT_CAUSE_SECTION_HEADING_RE);
			if (m?.[1]) sectionLevel = m[1].length;
			continue;
		}
		const heading = line.match(ANY_HEADING_LINE_RE);
		if (heading?.[1] && heading[1].length <= sectionLevel) break;
		sectionLines.push(line);
	}
	if (sectionLevel === null) return true;
	const needle = claimLine.trim();
	if (sectionLines.some((l) => l.trim() === needle)) return true;
	const claimDataSources = attributeLineDataSources(claimLine);
	if (claimDataSources.length === 0) return true;
	const rootCauseAttribution = new Set(sectionLines.flatMap((l) => attributeLineDataSources(l)));
	return claimDataSources.some((ds) => rootCauseAttribution.has(ds));
}

// --- Coverage / integrity notes ----------------------------------------------------

// Notes carry NO numbers so a later hard re-cap (enforce-node) can remove them
// without ever having printed a contradictory value.
export const COVERAGE_NOTE_PREFIX = "_Coverage note:_";
export const INTEGRITY_NOTE_PREFIX = "_Integrity note:_";

const CONFIDENCE_LINE_ONLY_RE = /^\s*[*_>\-\s]*\**\s*confidence(?:\s+score)?\s*:?\**\s*[0-1](?:\.\d+)?[^\r\n]*$/i;

function upsertPrefixedNote(answer: string, prefix: string, note: string | null): string {
	// Remove any existing note first (idempotent upsert / removal).
	const lines = answer.split("\n").filter((line) => !line.startsWith(prefix));
	if (note === null) return lines.join("\n");
	const noteLine = `${prefix} ${note}`;
	const idx = lines.findIndex((line) => CONFIDENCE_LINE_ONLY_RE.test(line));
	if (idx === -1) {
		return `${lines.join("\n").replace(/\s+$/, "")}\n\n${noteLine}`;
	}
	return [...lines.slice(0, idx + 1), noteLine, ...lines.slice(idx + 1)].join("\n");
}

export function upsertCoverageNote(answer: string, note: string | null): string {
	return upsertPrefixedNote(answer, COVERAGE_NOTE_PREFIX, note);
}

// SIO-1242: the caveat SECTION, sibling to the single-line notes above. Same anchor (immediately
// around the confidence line), same idempotent-upsert contract.
//
// Deliberately NOT "## Gaps": GAPS_HEADING_RE feeds the SIO-709 degrading-gap parser and its own
// GAPS_BULLET_THRESHOLD cap, so routing integrity caveats there would make the absence guard
// manufacture gaps-cap pressure against itself -- a self-amplifying loop.
export const CAVEATS_HEADING = "## Report caveats";

export function upsertCaveatsSection(answer: string, caveats: ReportCaveat[]): string {
	// Strip any existing block first (idempotent: the enforce-node re-cap path can call twice).
	const lines = answer.split("\n");
	const start = lines.findIndex((l) => l.trim() === CAVEATS_HEADING);
	let stripped = lines;
	if (start !== -1) {
		// Stop at the next heading OR the confidence line: the section is inserted directly above
		// the confidence line (SIO-632 keeps it last), so a heading-only bound would swallow it.
		let end = start + 1;
		while (end < lines.length) {
			const l = lines[end] ?? "";
			if (/^#{1,6}\s/.test(l) || CONFIDENCE_LINE_ONLY_RE.test(l)) break;
			end++;
		}
		stripped = [...lines.slice(0, start), ...lines.slice(end)];
	}
	if (caveats.length === 0) return stripped.join("\n").replace(/\n{3,}$/, "\n");

	const body = caveats
		.map((c) => {
			const where = c.section ? ` in "${c.section}"` : "";
			const times = c.occurrences > 1 ? ` (appears ${c.occurrences}x)` : "";
			return `- **Flagged${where}${times}:** ${c.claim.trim()}\n  - ${c.note}`;
		})
		.join("\n");
	const section = `${CAVEATS_HEADING}\n\nAn automated grounding check flagged the following claims. The report text above is UNCHANGED; each claim is reproduced here with its correction.\n\n${body}\n`;

	// SIO-632 contract: the dedicated Confidence line stays last -- insert above it.
	const idx = stripped.findIndex((l) => CONFIDENCE_LINE_ONLY_RE.test(l));
	if (idx === -1) return `${stripped.join("\n").replace(/\s+$/, "")}\n\n${section}`;
	return [...stripped.slice(0, idx), section, ...stripped.slice(idx)].join("\n");
}

export function upsertIntegrityNote(answer: string, note: string | null): string {
	return upsertPrefixedNote(answer, INTEGRITY_NOTE_PREFIX, note);
}

// --- Kill switch ------------------------------------------------------------------

// COVERAGE_CAP_SCOPING_ENABLED defaults ON; read at call time (gaps-judge idiom) so
// flipping the env var takes effect without a code change. OFF = the pre-SIO-1195
// behavior: any cap reason yields the hard cap.
export function isCoverageScopingEnabled(env: Record<string, string | undefined>): boolean {
	const raw = env.COVERAGE_CAP_SCOPING_ENABLED?.trim().toLowerCase();
	return !(raw === "false" || raw === "0");
}

// SIO-1198: INTEGRITY_CAP_TIERING_ENABLED defaults ON. OFF = the pre-SIO-1198
// behavior: every integrity reason hard-caps regardless of signals.
export function isIntegrityCapTieringEnabled(env: Record<string, string | undefined>): boolean {
	const raw = env.INTEGRITY_CAP_TIERING_ENABLED?.trim().toLowerCase();
	return !(raw === "false" || raw === "0");
}
