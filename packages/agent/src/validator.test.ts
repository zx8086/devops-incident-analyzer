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
