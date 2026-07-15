// packages/agent/src/aggregator-grounding-integration.test.ts
// SIO-1013: integration test for aggregate()-level ungrounded-blocker cap.
// Mirrors the mock seam from aggregator.test.ts. The describe block is gated
// on hasRunbooks because aggregate() calls buildOrchestratorPrompt(), which
// calls loadAgent() — requires the real agents/incident-analyzer directory.
import { describe, expect, mock, test } from "bun:test";

// SIO-1120: the mock LLM emits BOTH failure shapes at once:
//   1. logs:DescribeLogGroups "not permitted" -- no auth error will be observed for it (fabricated).
//   2. ec2:DescribeRouteTables "not permitted" -- a GRANTED action; the run WILL carry a real,
//      unrelated auth error (logs:StartQuery). Under the old all-or-nothing guard, that unrelated
//      auth error suppressed the WHOLE report and this fabricated EC2 bullet sailed through. The
//      per-action guard must still flag + rewrite it.
const mockLlmContent =
	"## Gaps\n\n- ECS collector logs are inaccessible: `logs:DescribeLogGroups` is not permitted for `DevOpsAgentReadOnly`.\n- Route table configuration could not be confirmed: `ec2:DescribeRouteTables` is not permitted for `DevOpsAgentReadOnly`.\n- A second real gap here.\n\nConfidence: 0.62";

mock.module("@langchain/aws", () => ({
	ChatBedrockConverse: class {
		withFallbacks() {
			return this;
		}
		bindTools() {
			return this;
		}
		async invoke() {
			return { content: mockLlmContent };
		}
	},
}));

mock.module("@devops-agent/shared", () => ({
	redactPiiContent: (s: string) => s,
	DEFAULT_TOOL_RESULT_CAP_BYTES: 131_072,
}));

import { aggregate } from "./aggregator.ts";
import { getRunbookFilenames } from "./prompt-context.ts";
import type { AgentStateType } from "./state.ts";

const availableRunbooks = (() => {
	try {
		return getRunbookFilenames();
	} catch {
		return [];
	}
})();
const hasRunbooks = availableRunbooks.length > 0;

describe.skipIf(!hasRunbooks)("aggregate SIO-1013 ungrounded-IAM-blocker cap", () => {
	test("aggregate caps confidence and rewrites text on an ungrounded IAM gap", async () => {
		const state = {
			messages: [],
			queryComplexity: "complex",
			targetDataSources: ["aws"],
			targetDeployments: [],
			retryDeployments: [],
			dataSourceResults: [
				{
					dataSourceId: "aws",
					data: {},
					status: "success",
					toolErrors: [],
					messageCount: 5,
				},
			],
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
			requestId: "test-grounding",
			attachmentMeta: [],
			suggestions: [],
			normalizedIncident: { affectedServices: [] },
			mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
			confidenceScore: 0,
			lowConfidence: false,
			pendingActions: [],
			actionResults: [],
			selectedRunbooks: null,
			skillsApplied: null,
			investigationFocus: undefined,
			resolvedIdentifiers: undefined,
			pendingTopicShiftPrompt: undefined,
		} as unknown as AgentStateType;

		const out = await aggregate(state);
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.confidenceCap).toBe(0.59);
		expect(out.finalAnswer).not.toContain("not permitted for");
		expect(out.finalAnswer).toContain("were not retrieved");
	});

	// SIO-1120: the localcore regression, end-to-end. A REAL unrelated auth error
	// (logs:StartQuery) must NOT ground the fabricated ec2:DescribeRouteTables /
	// logs:DescribeLogGroups "not permitted" bullets. Before the per-action fix, the single
	// unrelated auth error suppressed the whole guard and both fabricated bullets shipped.
	test("caps + rewrites fabricated granted-action bullets even when an unrelated auth error exists", async () => {
		const state = {
			messages: [],
			queryComplexity: "complex",
			targetDataSources: ["aws"],
			targetDeployments: [],
			retryDeployments: [],
			dataSourceResults: [
				{
					dataSourceId: "aws",
					data: {},
					status: "success",
					// A real denial for logs:StartQuery -- an action NEITHER fabricated bullet names.
					toolErrors: [
						{
							toolName: "aws_logs_start_query",
							category: "auth",
							message: 'Update DevOpsAgentReadOnlyPolicy to include "logs:StartQuery".',
							retryable: false,
						},
					],
					messageCount: 5,
				},
			],
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
			requestId: "test-grounding-cross-action",
			attachmentMeta: [],
			suggestions: [],
			normalizedIncident: { affectedServices: [] },
			mitigationSteps: { investigate: [], monitor: [], escalate: [], relatedRunbooks: [] },
			confidenceScore: 0,
			lowConfidence: false,
			pendingActions: [],
			actionResults: [],
			selectedRunbooks: null,
			skillsApplied: null,
			investigationFocus: undefined,
			resolvedIdentifiers: undefined,
			pendingTopicShiftPrompt: undefined,
		} as unknown as AgentStateType;

		const out = await aggregate(state);
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.confidenceCap).toBe(0.59);
		// Both fabricated "not permitted" bullets must be rewritten away.
		expect(out.finalAnswer).not.toContain("ec2:DescribeRouteTables` is not permitted");
		expect(out.finalAnswer).not.toContain("logs:DescribeLogGroups` is not permitted");
		expect(out.finalAnswer).toContain("were not retrieved");
	});
});
