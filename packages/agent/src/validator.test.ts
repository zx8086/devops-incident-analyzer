// packages/agent/src/validator.test.ts
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
