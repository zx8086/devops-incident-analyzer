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

export type CapClass = "integrity" | "coverage";

export const CAP_REASON_CLASS: Record<string, CapClass> = {
	"degraded-subagents": "coverage",
	gaps: "coverage",
	"correlation-degraded": "coverage",
	"ungrounded-blocker": "integrity",
	"ungrounded-expiry": "integrity",
	"premature-absence": "integrity",
	"ungrounded-root-cause": "integrity",
	"no-index-misread": "integrity",
	"ungrounded-metrics": "integrity",
};

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
	rootCauseDataSources: string[] | null;
	threshold: number;
}): CapDecision {
	const integrity = input.capReasons.filter((r) => CAP_REASON_CLASS[r] !== "coverage");
	const coverage = input.capReasons.filter((r) => CAP_REASON_CLASS[r] === "coverage");
	const degradedDataSources = [...new Set(input.coverageSignals.flatMap((s) => s.dataSources ?? []))];

	if (input.capReasons.length === 0) {
		return { mode: "none", hardReasons: [], scopedReasons: [], degradedDataSources };
	}
	if (integrity.length > 0) {
		return {
			mode: "hard",
			cap: hardCapFor(input.threshold),
			hardReasons: input.capReasons,
			scopedReasons: [],
			degradedDataSources,
		};
	}

	const rc = input.rootCauseDataSources;
	// Soft requires: an identified root-cause evidence set, every coverage reason
	// backed by at least one signal, and every signal attributable to datasources
	// none of which supplied the root-cause evidence.
	const everyReasonSignalled = coverage.every((r) => input.coverageSignals.some((s) => s.reason === r));
	const disjoint =
		rc !== null &&
		rc.length > 0 &&
		everyReasonSignalled &&
		input.coverageSignals.length > 0 &&
		input.coverageSignals.every(
			(s) => s.dataSources !== null && s.dataSources.length > 0 && s.dataSources.every((ds) => !rc.includes(ds)),
		);

	return disjoint
		? {
				mode: "soft",
				cap: softCapFor(input.threshold),
				hardReasons: [],
				scopedReasons: coverage,
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

// --- Coverage note --------------------------------------------------------------

// The note carries NO numbers so a later hard re-cap (enforce-node) can remove it
// without ever having printed a contradictory value.
export const COVERAGE_NOTE_PREFIX = "_Coverage note:_";

const CONFIDENCE_LINE_ONLY_RE = /^\s*[*_>\-\s]*\**\s*confidence(?:\s+score)?\s*:?\**\s*[0-1](?:\.\d+)?[^\r\n]*$/i;

export function upsertCoverageNote(answer: string, note: string | null): string {
	// Remove any existing note first (idempotent upsert / removal).
	const lines = answer.split("\n").filter((line) => !line.startsWith(COVERAGE_NOTE_PREFIX));
	if (note === null) return lines.join("\n");
	const noteLine = `${COVERAGE_NOTE_PREFIX} ${note}`;
	const idx = lines.findIndex((line) => CONFIDENCE_LINE_ONLY_RE.test(line));
	if (idx === -1) {
		return `${lines.join("\n").replace(/\s+$/, "")}\n\n${noteLine}`;
	}
	return [...lines.slice(0, idx + 1), noteLine, ...lines.slice(idx + 1)].join("\n");
}

// --- Kill switch ------------------------------------------------------------------

// COVERAGE_CAP_SCOPING_ENABLED defaults ON; read at call time (gaps-judge idiom) so
// flipping the env var takes effect without a code change. OFF = the pre-SIO-1195
// behavior: any cap reason yields the hard cap.
export function isCoverageScopingEnabled(env: Record<string, string | undefined>): boolean {
	const raw = env.COVERAGE_CAP_SCOPING_ENABLED?.trim().toLowerCase();
	return !(raw === "false" || raw === "0");
}
