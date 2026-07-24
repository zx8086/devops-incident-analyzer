// agent/src/confidence-policy.test.ts
// SIO-1195: the two-class cap policy. Integrity violations always hard-cap below
// the HITL gate; coverage degradation provably disjoint from the root-cause
// evidence soft-caps above it. Every uncertain case fails closed to hard.
import { describe, expect, test } from "bun:test";
import {
	attributeGapBullets,
	attributeLineDataSources,
	CAP_REASON_CLASS,
	decideConfidenceCap,
	extractRootCauseDataSources,
	hardCapFor,
	isClaimLoadBearing,
	isCoverageScopingEnabled,
	isIntegrityCapTieringEnabled,
	softCapFor,
	upsertCoverageNote,
} from "./confidence-policy.ts";

describe("CAP_REASON_CLASS", () => {
	test("classifies the three coverage reasons", () => {
		expect(CAP_REASON_CLASS["degraded-subagents"]).toBe("coverage");
		expect(CAP_REASON_CLASS.gaps).toBe("coverage");
		expect(CAP_REASON_CLASS["correlation-degraded"]).toBe("coverage");
	});

	test("classifies the six integrity reasons", () => {
		for (const r of [
			"ungrounded-blocker",
			"ungrounded-expiry",
			"premature-absence",
			"ungrounded-root-cause",
			"no-index-misread",
			"ungrounded-metrics",
		]) {
			expect(CAP_REASON_CLASS[r]).toBe("integrity");
		}
	});
});

describe("cap math", () => {
	test("hardCapFor stays strictly below the threshold, ceiling 0.59", () => {
		expect(hardCapFor(0.6)).toBe(0.59);
		expect(hardCapFor(0.5)).toBeCloseTo(0.49, 10);
		expect(hardCapFor(0.9)).toBe(0.59);
	});

	test("softCapFor stays above the gate with a floor of 0.75 and ceiling 0.95", () => {
		expect(softCapFor(0.6)).toBe(0.75);
		expect(softCapFor(0.5)).toBe(0.75);
		expect(softCapFor(0.75)).toBeCloseTo(0.85, 10);
		expect(softCapFor(0.9)).toBe(0.95);
	});
});

describe("decideConfidenceCap", () => {
	const rc = ["kafka", "elastic"];

	test("no reasons -> mode none", () => {
		const d = decideConfidenceCap({ capReasons: [], coverageSignals: [], rootCauseDataSources: rc, threshold: 0.6 });
		expect(d.mode).toBe("none");
		expect(d.cap).toBeUndefined();
	});

	test("integrity-only -> hard", () => {
		const d = decideConfidenceCap({
			capReasons: ["premature-absence"],
			coverageSignals: [],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
		expect(d.cap).toBe(0.59);
		expect(d.hardReasons).toEqual(["premature-absence"]);
	});

	test("coverage disjoint from root cause -> soft 0.75", () => {
		const d = decideConfidenceCap({
			capReasons: ["degraded-subagents"],
			coverageSignals: [{ reason: "degraded-subagents", dataSources: ["konnect", "atlassian"] }],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("soft");
		expect(d.cap).toBe(0.75);
		expect(d.scopedReasons).toEqual(["degraded-subagents"]);
		expect(d.degradedDataSources.sort()).toEqual(["atlassian", "konnect"]);
	});

	test("coverage overlapping the root cause -> hard (the intended 'touches the evidence' case)", () => {
		const d = decideConfidenceCap({
			capReasons: ["degraded-subagents"],
			coverageSignals: [{ reason: "degraded-subagents", dataSources: ["kafka"] }],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
		expect(d.cap).toBe(0.59);
	});

	test("mixed integrity + coverage -> hard even when coverage is disjoint", () => {
		const d = decideConfidenceCap({
			capReasons: ["gaps", "ungrounded-root-cause"],
			coverageSignals: [{ reason: "gaps", dataSources: ["gitlab"] }],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});

	test("unidentifiable root cause (null) -> hard", () => {
		const d = decideConfidenceCap({
			capReasons: ["gaps"],
			coverageSignals: [{ reason: "gaps", dataSources: ["gitlab"] }],
			rootCauseDataSources: null,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});

	test("empty root-cause set -> hard", () => {
		const d = decideConfidenceCap({
			capReasons: ["gaps"],
			coverageSignals: [{ reason: "gaps", dataSources: ["gitlab"] }],
			rootCauseDataSources: [],
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});

	test("unattributable coverage signal (null dataSources) -> hard", () => {
		const d = decideConfidenceCap({
			capReasons: ["gaps"],
			coverageSignals: [{ reason: "gaps", dataSources: null }],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});

	test("coverage reason with NO matching signal -> hard", () => {
		const d = decideConfidenceCap({
			capReasons: ["gaps", "degraded-subagents"],
			coverageSignals: [{ reason: "gaps", dataSources: ["gitlab"] }],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});

	test("one disjoint + one overlapping signal -> hard", () => {
		const d = decideConfidenceCap({
			capReasons: ["degraded-subagents", "gaps"],
			coverageSignals: [
				{ reason: "degraded-subagents", dataSources: ["konnect"] },
				{ reason: "gaps", dataSources: ["elastic"] },
			],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});

	test("unknown future reason -> integrity -> hard (fail-closed forward compat)", () => {
		const d = decideConfidenceCap({
			capReasons: ["future-new-cap"],
			coverageSignals: [],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});

	test("threshold plumbs through both cap values", () => {
		const hard = decideConfidenceCap({
			capReasons: ["premature-absence"],
			coverageSignals: [],
			rootCauseDataSources: rc,
			threshold: 0.5,
		});
		expect(hard.cap).toBeCloseTo(0.49, 10);
		const soft = decideConfidenceCap({
			capReasons: ["gaps"],
			coverageSignals: [{ reason: "gaps", dataSources: ["gitlab"] }],
			rootCauseDataSources: rc,
			threshold: 0.75,
		});
		expect(soft.cap).toBeCloseTo(0.85, 10);
	});
});

describe("attributeLineDataSources", () => {
	test("snake_case tool prefixes map to datasources", () => {
		expect(attributeLineDataSources("three `gitlab_blast_radius` calls failed")).toEqual(["gitlab"]);
		expect(attributeLineDataSources("ksql_run_query timed out after 8s")).toEqual(["kafka"]);
		expect(attributeLineDataSources("capella_get_buckets returned an error")).toEqual(["couchbase"]);
		expect(attributeLineDataSources("elasticsearch_search was unreachable")).toEqual(["elastic"]);
	});

	test("SCREAMING_SNAKE identifiers are data, not tool names", () => {
		expect(attributeLineDataSources("the DLQ_T_ORDERS backlog was not drained")).toEqual([]);
	});

	test("keyword fallback attributes prose lines", () => {
		expect(attributeLineDataSources("Schema Registry health probe was unavailable")).toEqual(["kafka"]);
		expect(attributeLineDataSources("Orbit knowledge graph was unavailable")).toEqual(["gitlab"]);
		expect(attributeLineDataSources("CloudWatch log group query returned nothing")).toEqual(["aws"]);
	});

	test("multiple datasources union", () => {
		expect(attributeLineDataSources("kafka consumer lag correlates with elasticsearch error spikes").sort()).toEqual([
			"elastic",
			"kafka",
		]);
	});
});

describe("attributeGapBullets", () => {
	test("all attributed -> union + allAttributed true", () => {
		const r = attributeGapBullets([
			"- gitlab_blast_radius was unavailable for all three calls",
			"- konnect control plane listing timed out",
		]);
		expect(r.allAttributed).toBe(true);
		expect(r.dataSources.sort()).toEqual(["gitlab", "konnect"]);
	});

	test("one unattributable bullet -> allAttributed false", () => {
		const r = attributeGapBullets([
			"- gitlab_blast_radius was unavailable",
			"- the follow-up verification query could not be re-run",
		]);
		expect(r.allAttributed).toBe(false);
	});
});

describe("extractRootCauseDataSources", () => {
	const answer = `# Report

## Root Cause

The kafka consumer group order-sink stalled on partition 3; elasticsearch APM traces
confirm the timeout cascade began at 03:11Z.

## Recommendations

- Check gitlab pipeline #42.

Confidence: 0.84`;

	test("attributes the section and intersects with returned data", () => {
		expect(extractRootCauseDataSources(answer, ["kafka", "elastic", "gitlab"])?.sort()).toEqual(["elastic", "kafka"]);
	});

	test("drops datasources that returned no data (hallucinated grounding)", () => {
		expect(extractRootCauseDataSources(answer, ["gitlab"])).toBeNull();
	});

	test("section boundaries: the Recommendations mention of gitlab does not leak in", () => {
		const rc = extractRootCauseDataSources(answer, ["kafka", "elastic", "gitlab"]);
		expect(rc).not.toContain("gitlab");
	});

	test("missing Root Cause section -> null", () => {
		expect(extractRootCauseDataSources("# Report\n\nConfidence: 0.9", ["kafka"])).toBeNull();
	});

	test("section with no datasource mention -> null", () => {
		const a = "## Root Cause\n\nA timeout cascade in the order pipeline.\n\nConfidence: 0.8";
		expect(extractRootCauseDataSources(a, ["kafka"])).toBeNull();
	});
});

describe("upsertCoverageNote", () => {
	const base = "# Report\n\nFindings here.\n\nConfidence: 0.75";
	const note = "tool degradation affected konnect, which did not supply the root-cause evidence (kafka).";

	test("inserts the note directly under the confidence line", () => {
		const out = upsertCoverageNote(base, note);
		expect(out).toContain("Confidence: 0.75\n_Coverage note:_ tool degradation affected konnect");
	});

	test("idempotent upsert replaces an existing note", () => {
		const once = upsertCoverageNote(base, note);
		const twice = upsertCoverageNote(once, "different text entirely.");
		expect(twice.match(/_Coverage note:_/g)?.length).toBe(1);
		expect(twice).toContain("different text entirely.");
		expect(twice).not.toContain("affected konnect");
	});

	test("null removes the note", () => {
		const once = upsertCoverageNote(base, note);
		expect(upsertCoverageNote(once, null)).toBe(base);
	});

	test("no confidence line -> note appended at the end", () => {
		const out = upsertCoverageNote("# Report\n\nBody.", note);
		expect(out.trimEnd().endsWith(`_Coverage note:_ ${note}`)).toBe(true);
	});
});

describe("isCoverageScopingEnabled", () => {
	test("defaults ON; only explicit false/0 disable", () => {
		expect(isCoverageScopingEnabled({})).toBe(true);
		expect(isCoverageScopingEnabled({ COVERAGE_CAP_SCOPING_ENABLED: "true" })).toBe(true);
		expect(isCoverageScopingEnabled({ COVERAGE_CAP_SCOPING_ENABLED: "false" })).toBe(false);
		expect(isCoverageScopingEnabled({ COVERAGE_CAP_SCOPING_ENABLED: "0" })).toBe(false);
	});
});

describe("hardCapFor parity with deriveConfidenceCap (CodeRabbit PR #455 clamp)", () => {
	test("never goes negative for a pathological sub-0.01 threshold", () => {
		expect(hardCapFor(0.005)).toBe(0);
		expect(hardCapFor(0)).toBe(0);
	});
});

// CodeRabbit PR #456: several degraded correlation rules produce several signals
// sharing one reason -- .every fail-closes when ANY of them overlaps.
describe("decideConfidenceCap same-reason multi-signal (CodeRabbit PR #456)", () => {
	test("two signals sharing the same reason, one disjoint one overlapping -> hard", () => {
		const d = decideConfidenceCap({
			capReasons: ["correlation-degraded"],
			coverageSignals: [
				{ reason: "correlation-degraded", dataSources: ["konnect"] },
				{ reason: "correlation-degraded", dataSources: ["kafka"] },
			],
			rootCauseDataSources: ["kafka", "elastic"],
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
		expect(d.cap).toBe(0.59);
	});
});

// SIO-1198 Part B: severity tiers within the integrity class. An integrity reason is
// soft-eligible only when EVERY flagged claim behind it was rewritten in place AND is
// not load-bearing for the Root Cause; all uncertainty resolves to hard.
describe("decideConfidenceCap integrity tiers (SIO-1198)", () => {
	const rc = ["kafka", "elastic"];

	test("integrity reason with all-rewritten, non-load-bearing signals -> soft 0.75", () => {
		const d = decideConfidenceCap({
			capReasons: ["no-index-misread"],
			coverageSignals: [],
			integritySignals: [{ reason: "no-index-misread", rewritten: true, loadBearing: false }],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("soft");
		expect(d.cap).toBe(0.75);
		expect(d.scopedReasons).toEqual(["no-index-misread"]);
	});

	test("load-bearing integrity signal -> hard", () => {
		const d = decideConfidenceCap({
			capReasons: ["no-index-misread"],
			coverageSignals: [],
			integritySignals: [{ reason: "no-index-misread", rewritten: true, loadBearing: true }],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
		expect(d.cap).toBe(0.59);
	});

	test("unrewritten integrity signal -> hard", () => {
		const d = decideConfidenceCap({
			capReasons: ["premature-absence"],
			coverageSignals: [],
			integritySignals: [{ reason: "premature-absence", rewritten: false, loadBearing: false }],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});

	test("integrity reason with NO signal stays hard (unsignalled = fail-closed)", () => {
		const d = decideConfidenceCap({
			capReasons: ["ungrounded-metrics"],
			coverageSignals: [],
			integritySignals: [],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});

	test("one eligible + one ineligible integrity reason -> hard", () => {
		const d = decideConfidenceCap({
			capReasons: ["no-index-misread", "premature-absence"],
			coverageSignals: [],
			integritySignals: [
				{ reason: "no-index-misread", rewritten: true, loadBearing: false },
				{ reason: "premature-absence", rewritten: true, loadBearing: true },
			],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});

	test("multiple signals for one reason: every one must be eligible", () => {
		const d = decideConfidenceCap({
			capReasons: ["premature-absence"],
			coverageSignals: [],
			integritySignals: [
				{ reason: "premature-absence", rewritten: true, loadBearing: false },
				{ reason: "premature-absence", rewritten: true, loadBearing: true },
			],
			rootCauseDataSources: rc,
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});

	test("eligible integrity + disjoint coverage -> soft; overlapping coverage -> hard", () => {
		const base = {
			capReasons: ["no-index-misread", "degraded-subagents"],
			integritySignals: [{ reason: "no-index-misread", rewritten: true, loadBearing: false }],
			rootCauseDataSources: rc,
			threshold: 0.6,
		};
		const soft = decideConfidenceCap({
			...base,
			coverageSignals: [{ reason: "degraded-subagents", dataSources: ["konnect"] }],
		});
		expect(soft.mode).toBe("soft");
		const hard = decideConfidenceCap({
			...base,
			coverageSignals: [{ reason: "degraded-subagents", dataSources: ["kafka"] }],
		});
		expect(hard.mode).toBe("hard");
	});

	test("threshold plumbs through the integrity-soft cap", () => {
		const d = decideConfidenceCap({
			capReasons: ["ungrounded-expiry"],
			coverageSignals: [],
			integritySignals: [{ reason: "ungrounded-expiry", rewritten: true, loadBearing: false }],
			rootCauseDataSources: rc,
			threshold: 0.75,
		});
		expect(d.cap).toBeCloseTo(0.85, 10);
	});
});

describe("isClaimLoadBearing (SIO-1198)", () => {
	const answer = `# Report

## Findings

### Couchbase
- Style TH1037 zero rows in styles.variant (SELECT * failed, no index)

## Root Cause

The kafka consumer group stalled; couchbase season mapping absence contributed.

## Recommendations

- fix things

Confidence: 0.8`;

	test("flagged line inside the Root Cause section -> load-bearing", () => {
		expect(
			isClaimLoadBearing(answer, "The kafka consumer group stalled; couchbase season mapping absence contributed."),
		).toBe(true);
	});

	test("flagged line outside Root Cause whose datasource the Root Cause prose attributes -> load-bearing", () => {
		expect(isClaimLoadBearing(answer, "- Style TH1037 zero rows in styles.variant (SELECT * failed, no index)")).toBe(
			true,
		);
	});

	test("flagged line outside Root Cause with a datasource the Root Cause never mentions -> not load-bearing", () => {
		const a = `# Report

### Couchbase
- Style TH1037 zero rows in styles.variant (couchbase SELECT * failed)

## Root Cause

The kafka consumer group order-sink stalled on partition 3; elasticsearch traces confirm it.

Confidence: 0.8`;
		expect(isClaimLoadBearing(a, "- Style TH1037 zero rows in styles.variant (couchbase SELECT * failed)")).toBe(false);
	});

	test("no Root Cause section -> load-bearing (fail-closed)", () => {
		expect(isClaimLoadBearing("# Report\n\n- couchbase claim here\n\nConfidence: 0.8", "- couchbase claim here")).toBe(
			true,
		);
	});

	test("unattributable flagged line -> load-bearing (fail-closed)", () => {
		expect(isClaimLoadBearing(answer, "- the follow-up verification could not be re-run")).toBe(true);
	});
});

describe("isIntegrityCapTieringEnabled", () => {
	test("defaults ON; only explicit false/0 disable", () => {
		expect(isIntegrityCapTieringEnabled({})).toBe(true);
		expect(isIntegrityCapTieringEnabled({ INTEGRITY_CAP_TIERING_ENABLED: "false" })).toBe(false);
		expect(isIntegrityCapTieringEnabled({ INTEGRITY_CAP_TIERING_ENABLED: "0" })).toBe(false);
	});

	test("kill switch off -> integrity signals ignored, hard cap", () => {
		const d = decideConfidenceCap({
			capReasons: ["no-index-misread"],
			coverageSignals: [],
			integritySignals: [{ reason: "no-index-misread", rewritten: true, loadBearing: false }],
			integrityTieringEnabled: false,
			rootCauseDataSources: ["kafka"],
			threshold: 0.6,
		});
		expect(d.mode).toBe("hard");
	});
});
