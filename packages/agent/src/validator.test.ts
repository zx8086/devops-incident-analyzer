// agent/src/validator.test.ts
import { describe, expect, test } from "bun:test";
import type { DataSourceResult } from "@devops-agent/shared";
import type { AgentStateType } from "./state.ts";
import { validate } from "./validator.ts";

function makeState(overrides: Partial<AgentStateType> = {}): AgentStateType {
	return {
		messages: [],
		queryComplexity: "complex",
		targetDataSources: ["elastic"],
		targetDeployments: [],
		retryDeployments: [],
		dataSourceResults: [
			{ dataSourceId: "elastic", status: "success", data: "result", duration: 100, toolErrors: [] },
		] as DataSourceResult[],
		currentDataSource: "",
		extractedEntities: { dataSources: [] },
		previousEntities: { dataSources: [] },
		toolPlanMode: "autonomous",
		toolPlan: [],
		validationResult: "pass",
		retryCount: 0,
		alignmentRetries: 0,
		alignmentHints: [],
		skippedDataSources: [],
		isFollowUp: false,
		finalAnswer: "",
		graphContext: "",
		graphBlastRadius: [],
		dataSourceContext: undefined,
		requestId: "test",
		attachmentMeta: [],
		suggestions: [],
		normalizedIncident: {},
		mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
		confidenceScore: 0,
		confidencePreCap: undefined,
		capReasons: [] as string[],
		confirmedDegradingGapBullets: [] as string[],
		reportCaveats: [],
		correlationFetchDirective: undefined,
		lowConfidence: false,
		pendingActions: [],
		actionResults: [],
		selectedRunbooks: null,
		skillsApplied: null,
		investigationFocus: undefined,
		resolvedIdentifiers: undefined,
		pendingTopicShiftPrompt: undefined,
		...overrides,
	} as AgentStateType;
}

// SIO-1140's ensureVerbatimDdl backstop appends a "## Server-computed index DDL (verbatim)"
// section to whatever answer the aggregator produced, so a real DDL recommendation is never
// silently dropped -- even when the aggregator's own synthesis is EMPTY (the 2026-08-04
// incident-replay eval regression: Sonnet 5's reasoning block consumed the entire maxTokens
// budget, leaving zero prose). That backstop section alone is long enough to clear
// validator.ts's `answer.length < 50` short-answer gate, so a report that is ACTUALLY just a
// raw DDL dump with no investigation content at all currently passes validation and never
// retries -- the exact failure this test pins.
const DDL_ONLY_ANSWER = [
	"## Server-computed index DDL (verbatim)",
	"",
	"The Index Advisor returned the following statements; reproduced exactly as computed (recommendation only -- never execute without review):",
	"",
	"```sql",
	"CREATE INDEX adv_styleSeasonCode_divisionCode ON `default`:`default`.`media_assets`.`images`(`styleSeasonCode`,`divisionCode`)",
	"```",
].join("\n");

describe("validate() catches a DDL-backstop-only answer (SIO-1273 follow-up, 2026-08-04)", () => {
	test("an answer that is ONLY the verbatim-DDL backstop section fails validation and retries", () => {
		const result = validate(makeState({ finalAnswer: DDL_ONLY_ANSWER, retryCount: 0 }));
		expect(result.validationResult).toBe("fail");
		expect(result.retryCount).toBe(1);
	});

	test("a genuinely short answer (unrelated to DDL) still fails validation, unaffected by the new check", () => {
		const result = validate(makeState({ finalAnswer: "Investigation inconclusive.", retryCount: 0 }));
		expect(result.validationResult).toBe("fail");
	});

	test("a real investigation report that also happens to carry an appended DDL section still passes", () => {
		const realReport = [
			"## Executive Summary",
			"",
			"The styles-v3-service experienced a Couchbase connectivity failure at 14:32 UTC, traced to a security-group misconfiguration on the ECS task role.",
			"",
			"## Findings",
			"",
			"- elastic: 47 error-level log entries matching the connection-refused signature",
			"- couchbase: cluster healthy, 12/12 nodes reporting, no fatal query errors",
			"",
			DDL_ONLY_ANSWER,
			"",
			"Confidence: 0.72",
		].join("\n");
		const result = validate(makeState({ finalAnswer: realReport, retryCount: 0 }));
		expect(result.validationResult).not.toBe("fail");
	});
});

// SIO-1857: the timestamp check normalized by STRIPPING a "+02:00" suffix textually, so
// 2026-09-19T22:10:46+02:00 and 2026-09-19T20:10:46Z -- the same instant, and exactly how
// Kibana's CET display relates to the UTC log line behind it -- produced different keys.
// A correctly converted timestamp was then reported as fabricated. Observed on a live run
// (2026-09-20) in a repo whose incidents are routinely anchored from a CET console.
//
// The warning is logged, not returned in state, so these assert the OBSERVABLE outcome:
// a clean answer passes, an unsourced timestamp downgrades to pass_with_warnings.
describe("SIO-1857 an offset timestamp is converted, not stripped", () => {
	const sourceWithUtcLog = (ts: string): DataSourceResult[] =>
		[
			{
				dataSourceId: "elastic",
				status: "success",
				data: `ERROR at ${ts} in localcore-service`,
				duration: 100,
				toolErrors: [],
			},
		] as DataSourceResult[];

	function resultFor(answer: string, sourceTs: string) {
		return validate(makeState({ finalAnswer: answer, retryCount: 0, dataSourceResults: sourceWithUtcLog(sourceTs) }));
	}

	test("the same instant in CET and UTC passes clean", () => {
		// The answer quotes the operator-facing CET form; the log carries UTC.
		const result = resultFor(
			"The elastic log shows the error at 2026-09-19T22:10:46+02:00 for localcore-service.",
			"2026-09-19T20:10:46Z",
		);
		expect(result.validationResult).toBe("pass");
	});

	test("a genuinely unsourced timestamp still downgrades the result", () => {
		const result = resultFor(
			"The elastic log shows a second failure at 2026-09-19T23:59:00Z for localcore-service.",
			"2026-09-19T20:10:46Z",
		);
		expect(result.validationResult).toBe("pass_with_warnings");
	});

	// Greptile (PR #866): `new Date` ROLLS OVER an impossible calendar date rather than
	// rejecting it, so 2026-02-30 became 2026-03-02 and would match a real March 2 in the
	// source -- masking the very fabrication this check exists to catch. A regression the
	// epoch-based normalizer introduced; the old textual key had kept them apart.
	test("an impossible calendar date does not collide with the day it rolls over to", () => {
		const result = resultFor(
			"The elastic log shows the error at 2026-02-30T10:00:00Z for localcore-service.",
			"2026-03-02T10:00:00Z",
		);
		expect(result.validationResult).toBe("pass_with_warnings");
	});

	test("a real leap day still matches its source", () => {
		const result = resultFor(
			"The elastic log shows the error at 2024-02-29T10:00:00Z for localcore-service.",
			"2024-02-29T10:00:00Z",
		);
		expect(result.validationResult).toBe("pass");
	});

	test("the AWS space form and a negative offset both match their UTC source", () => {
		expect(
			resultFor("The elastic log shows it at 2026-09-19 20:10:46 for localcore-service.", "2026-09-19T20:10:46Z")
				.validationResult,
		).toBe("pass");
		expect(
			resultFor("The elastic log shows it at 2026-09-19T15:10:46-05:00 for localcore-service.", "2026-09-19T20:10:46Z")
				.validationResult,
		).toBe("pass");
	});
});

// SIO-1859: the AWS sub-agent writes its own timeline as a markdown table with the date in
// the COLUMN HEADER and a bare `17:35:00` in each row, so no row carries a date for the
// timestamp pattern to match. The aggregator qualifies the row into the report as
// 2026-09-19T17:35:00Z, which then finds no counterpart in the source and is reported as
// fabricated -- although the time is genuinely in the evidence. Observed on a live run.
describe("SIO-1859 a bare time in a dated source grounds a qualified answer", () => {
	// The shape the sub-agent actually emits: date in the header, bare times in the rows.
	// The prose line carries one FULLY DATED timestamp, as a real sub-agent report does. That
	// is load-bearing for the test, not decoration: the fabrication check is skipped outright
	// when a source yields no timestamps at all, so a table-only fixture would make these
	// tests pass on that guard whether or not bare-time harvesting works.
	const timelineTable = [
		"Fee calculation timeline for 2026-09-19 (all times UTC)",
		"Window opened at 2026-09-19T17:00:00Z.",
		"| Time (UTC) | Event |",
		"|---|---|",
		"| `17:35:00` | Fee calculation started |",
		"| `17:41:12` | Fee calculation completed |",
	].join("\n");

	function resultFor(answer: string, data: string) {
		return validate(
			makeState({
				finalAnswer: answer,
				retryCount: 0,
				dataSourceResults: [
					{ dataSourceId: "aws", status: "success", data, duration: 100, toolErrors: [] },
				] as DataSourceResult[],
			}),
		);
	}

	test("a row time qualified onto the header's date is not called fabricated", () => {
		const result = resultFor("The aws timeline shows fee calculation started at 2026-09-19T17:35:00Z.", timelineTable);
		expect(result.validationResult).toBe("pass");
	});

	test("a time absent from the table still downgrades the result", () => {
		const result = resultFor("The aws timeline shows fee calculation started at 2026-09-19T03:02:01Z.", timelineTable);
		expect(result.validationResult).toBe("pass_with_warnings");
	});

	// The lookbehind must reject a time that already carries a date, or a real 09:00 on one
	// day would ground a hallucinated 09:00 on every other day the source mentions --
	// inverting the check. Both days appear here; only the dated pairing is real.
	test("a dated time is not re-harvested as bare onto another day the source names", () => {
		const twoDays = "Error at 2026-09-18T09:00:00Z. A separate incident is tracked for 2026-09-19.";
		expect(
			resultFor("The aws evidence shows the failure occurred at 2026-09-18T09:00:00Z.", twoDays).validationResult,
		).toBe("pass");
		expect(
			resultFor("The aws evidence shows the failure occurred at 2026-09-19T09:00:00Z.", twoDays).validationResult,
		).toBe("pass_with_warnings");
	});

	// Greptile (PR #867): sourceData flattens every datasource narrative into one string, so
	// pairing across it let a date mentioned by ONE datasource qualify a bare time stated by
	// ANOTHER. Here 17:35:00 belongs to an aws timeline dated the 18th, and the 19th appears
	// only in an unrelated elastic line -- so a fabricated 2026-09-19T17:35:00Z was accepted
	// with no warning. Pairing is now scoped to the narrative that states both.
	test("a date from one datasource does not qualify a bare time from another", () => {
		const twoSources = [
			{
				dataSourceId: "aws",
				status: "success",
				data: "Timeline for 2026-09-18 (UTC). Window opened at 2026-09-18T16:00:00Z. | `17:35:00` | Feed run starts |",
				duration: 100,
				toolErrors: [],
			},
			{
				dataSourceId: "elastic",
				status: "success",
				data: "Unrelated index rollover scheduled for 2026-09-19.",
				duration: 100,
				toolErrors: [],
			},
		] as DataSourceResult[];
		const resultFromBoth = (answer: string) =>
			validate(makeState({ finalAnswer: answer, retryCount: 0, dataSourceResults: twoSources })).validationResult;

		// The real pairing, within the aws narrative, still grounds.
		expect(resultFromBoth("The aws and elastic evidence show the feed run at 2026-09-18T17:35:00Z.")).toBe("pass");
		// The cross-narrative pairing must NOT ground: the 19th is elastic's, 17:35:00 is aws's.
		expect(resultFromBoth("The aws and elastic evidence show the feed run at 2026-09-19T17:35:00Z.")).toBe(
			"pass_with_warnings",
		);
	});

	// Guards the cap: a source ranging over many days must not let one bare time ground a
	// timestamp on any of them. Four days is over MAX_SOURCE_DAYS_FOR_BARE_TIMES.
	// The source carries one real timestamp so the fabrication check is LIVE -- it is skipped
	// entirely when a source has no timestamps at all, and without this the test would pass on
	// that pre-existing guard instead of on the cap.
	test("a source spanning many days does not ground bare times at all", () => {
		const manyDays = [
			"Deploys on 2026-09-16, 2026-09-17, 2026-09-18 and 2026-09-19.",
			"Pipeline started at 2026-09-16T08:00:00Z. Rollback at 17:35:00.",
		].join(" ");
		expect(
			resultFor("The aws evidence shows the rollback ran at 2026-09-19T17:35:00Z.", manyDays).validationResult,
		).toBe("pass_with_warnings");
	});
});
