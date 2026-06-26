// packages/agent/src/aggregator-grounding-integration.test.ts
// SIO-1013: integration test for aggregate()-level ungrounded-blocker cap.
// Mirrors the mock seam from aggregator.test.ts. The describe block is gated
// on hasRunbooks because aggregate() calls buildOrchestratorPrompt(), which
// calls loadAgent() — requires the real agents/incident-analyzer directory.
import { describe, expect, mock, test } from "bun:test";

const mockLlmContent =
	"## Gaps\n\n- ECS collector logs are inaccessible: `logs:DescribeLogGroups` is not permitted for `DevOpsAgentReadOnly`.\n- A second real gap here.\n\nConfidence: 0.62";

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
			pendingTopicShiftPrompt: undefined,
		} as unknown as AgentStateType;

		const out = await aggregate(state);
		expect(out.confidenceScore).toBeLessThanOrEqual(0.59);
		expect(out.confidenceCap).toBe(0.59);
		expect(out.finalAnswer).not.toContain("not permitted for");
		expect(out.finalAnswer).toContain("were not retrieved");
	});
});
