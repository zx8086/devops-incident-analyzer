// packages/agent/src/landing-zone/telemetry.test.ts

import { describe, expect, test } from "bun:test";
import type { LandingZoneStateType } from "./state.ts";
import { projectLandingZoneTurnTelemetry } from "./telemetry.ts";

function state(overrides: Partial<LandingZoneStateType> = {}): LandingZoneStateType {
	return {
		messages: [{ content: "Create account 111122223333 with arn:aws:iam::111122223333:role/SecretRole" }],
		requestId: "secret-request-id",
		intent: "review",
		repositoryScope: ["aws-lz-network-workloads", "aws-lz-account-creator", "aws-lz-account-creator"],
		accountScope: ["111122223333"],
		authorizedAccountScope: ["111122223333"],
		selectedKnowledge: ["private/context/path.md"],
		gitlabEvidence: { source: "gitlab", status: "collected", evidence: [] },
		okfEvidence: { source: "pvh-okf", status: "collected", evidence: [] },
		terraformDocsEvidence: { source: "terraform-docs", status: "unavailable", evidence: [], reason: "token-secret" },
		awsDocsEvidence: { source: "aws-docs", status: "skipped", evidence: [], reason: "private reason" },
		awsApiEvidence: null,
		memoryEvidence: { source: "memory", status: "collected", evidence: [] },
		knowledgeGraphEvidence: { source: "knowledge-graph", status: "unavailable", evidence: [] },
		evidenceResults: [],
		priorMemory: [],
		reconciliation: null,
		risk: {
			level: "high",
			reasons: ["Sensitive reason for account 111122223333"],
			requiresHumanDecision: true,
			blocked: false,
			stopConditions: [],
			requiredEvidenceSources: ["gitlab"],
		},
		response: "Sensitive generated response",
		responseCitations: [],
		topologyStates: [],
		landingZoneTopology: null,
		blockedReason: null,
		outcome: "answered",
		changeCandidate: null,
		candidateValidations: [],
		candidateValidationPassed: false,
		proposedChangeReview: null,
		reviewDecision: null,
		amendmentInstructions: null,
		proposalIteration: 0,
		mergeRequest: null,
		pipelineObservation: null,
		answerResult: null,
		answerValidation: null,
		answerRetryCount: 0,
		...overrides,
	} as LandingZoneStateType;
}

describe("projectLandingZoneTurnTelemetry", () => {
	test("projects stable categorical metadata for a completed turn", () => {
		expect(projectLandingZoneTurnTelemetry(state())).toEqual({
			agent: "landing-zone-terraform",
			intent: "review",
			repositories: ["aws-lz-account-creator", "aws-lz-network-workloads"],
			evidenceAvailability: {
				gitlab: "collected",
				okf: "collected",
				terraformDocs: "unavailable",
				awsDocs: "skipped",
				awsApi: "not-attempted",
				memory: "collected",
				knowledgeGraph: "unavailable",
			},
			riskTier: "high",
			outcome: "answered",
			graphUsed: true,
			memoryUsed: true,
			knowledgeGraphUsed: false,
		});
	});

	test("does not include prompts, account scope, evidence content, reasons, or identifiers", () => {
		const serialized = JSON.stringify(projectLandingZoneTurnTelemetry(state()));
		for (const secret of [
			"111122223333",
			"SecretRole",
			"secret-request-id",
			"private/context/path.md",
			"token-secret",
			"Sensitive reason",
			"Sensitive generated response",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	test("reports an unassessed turn and no optional evidence usage", () => {
		const telemetry = projectLandingZoneTurnTelemetry(
			state({
				risk: null,
				memoryEvidence: null,
				knowledgeGraphEvidence: { source: "knowledge-graph", status: "skipped", evidence: [] },
				outcome: "pending",
			}),
		);

		expect(telemetry.riskTier).toBe("unassessed");
		expect(telemetry.memoryUsed).toBeFalse();
		expect(telemetry.knowledgeGraphUsed).toBeFalse();
	});
});
