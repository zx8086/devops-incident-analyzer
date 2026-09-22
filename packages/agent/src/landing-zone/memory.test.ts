import { describe, expect, test } from "bun:test";
import type { AnnotationMap } from "@devops-agent/shared";
import type { MemorySearchHit } from "../memory-backend.ts";
import {
	buildLandingZoneMemoryAnnotations,
	memoryEnrichLandingZone,
	recordLandingZoneDecision,
	recordLandingZoneOutcome,
} from "./memory.ts";
import type { LandingZoneStateType } from "./state.ts";

function state(overrides: Partial<LandingZoneStateType> = {}): LandingZoneStateType {
	return {
		messages: [{ content: "What happened during MarTech account vending?" }],
		requestId: "change-123",
		intent: "understand",
		repositoryScope: ["aws-lz-account-creator"],
		accountScope: ["martech-dev"],
		selectedKnowledge: [],
		gitlabEvidence: null,
		okfEvidence: null,
		terraformDocsEvidence: null,
		awsDocsEvidence: null,
		awsApiEvidence: null,
		memoryEvidence: null,
		knowledgeGraphEvidence: null,
		evidenceResults: [],
		priorMemory: [],
		reconciliation: null,
		risk: null,
		response: null,
		responseCitations: [],
		topologyStates: [],
		blockedReason: null,
		outcome: "pending",
		proposedChangeReview: null,
		...overrides,
	} as LandingZoneStateType;
}

describe("memoryEnrichLandingZone", () => {
	test("searches only the independent Landing Zone identity with scoped filters", async () => {
		const calls: Array<{ agent: string; query: string; filter?: AnnotationMap }> = [];
		const result = await memoryEnrichLandingZone(state(), {
			search: async (agent, query, filter) => {
				calls.push({ agent, query, filter });
				return [
					{
						text: "The reviewed account request used the account YAML authoring surface.",
						annotations: {
							kind: "account-vending",
							repository: "aws-lz-account-creator",
							account: "martech-dev",
						},
						blockId: "memory-1",
					},
				] satisfies MemorySearchHit[];
			},
		});

		expect(calls).toEqual([
			{
				agent: "landing-zone-terraform",
				query: "What happened during MarTech account vending?",
				filter: {
					repository: "aws-lz-account-creator",
					account: "martech-dev",
					kind: "account-vending",
				},
			},
		]);
		expect(result.priorMemory).toEqual([
			{
				text: "The reviewed account request used the account YAML authoring surface.",
				annotations: {
					kind: "account-vending",
					repository: "aws-lz-account-creator",
					account: "martech-dev",
				},
				blockId: "memory-1",
				advisory: true,
				requiresLiveRevalidation: true,
			},
		]);
	});

	test("does not claim that an empty search proves an event never happened", async () => {
		const result = await memoryEnrichLandingZone(state(), { search: async () => [] });

		expect(result.priorMemory).toEqual([]);
	});

	test("drops recalled Terraform state values and redacts recalled credentials", async () => {
		const result = await memoryEnrichLandingZone(state(), {
			search: async (): Promise<MemorySearchHit[]> => [
				{ text: "Terraform state value: password=do-not-store", annotations: {} },
				{
					text: "Use the reviewed exception; token=do-not-repeat",
					annotations: { kind: "platform-exception" },
				},
			],
		});

		expect(result.priorMemory).toHaveLength(1);
		expect(result.priorMemory?.[0]?.text).toBe("Use the reviewed exception; token=[REDACTED]");
	});
});

describe("Landing Zone memory writes", () => {
	test("stores the complete repository, account, workflow, MR and change identity annotations", () => {
		expect(
			buildLandingZoneMemoryAnnotations({
				kind: "account-vending",
				repository: "aws-lz-account-creator",
				account: "martech-dev",
				workflow: "account-vending",
				mrUrl: "https://gitlab.com/pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator/-/merge_requests/42",
				configChangeId: "change-123",
			}),
		).toEqual({
			kind: "account-vending",
			repository: "aws-lz-account-creator",
			account: "martech-dev",
			workflow: "account-vending",
			mr_url: "https://gitlab.com/pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator/-/merge_requests/42",
			config_change_id: "change-123",
		});
	});

	test("records reviewed decisions durably without a TTL and redacts credentials", () => {
		const writes: unknown[] = [];
		const recorded = recordLandingZoneDecision(
			{
				requestId: "decision-1",
				decision: "Use the account YAML; token=super-secret-token",
				rationale: "Approved by the platform owner",
				reviewed: true,
				kind: "key-decision",
				repository: "aws-lz-account-creator",
			},
			{ recordDecision: (write) => writes.push(write) },
		);

		expect(recorded).toBeTrue();
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			requestId: "decision-1",
			decision: "Use the account YAML; token=[REDACTED]",
			annotations: { kind: "key-decision", repository: "aws-lz-account-creator" },
		});
		expect(writes[0]).not.toHaveProperty("ttlSeconds");
	});

	test("rejects unreviewed decisions and Terraform state or sensitive plan values", () => {
		const writes: unknown[] = [];
		const deps = { recordDecision: (write: unknown) => writes.push(write) };

		expect(
			recordLandingZoneDecision(
				{ requestId: "decision-2", decision: "Tentative", reviewed: false, kind: "key-decision" },
				deps,
			),
		).toBeFalse();
		expect(
			recordLandingZoneDecision(
				{
					requestId: "decision-3",
					decision: "Terraform state value: db_password=secret",
					reviewed: true,
					kind: "key-decision",
				},
				deps,
			),
		).toBeFalse();
		expect(
			recordLandingZoneDecision(
				{
					requestId: "decision-4",
					decision: "Plan-sensitive value: known after apply",
					reviewed: true,
					kind: "key-decision",
				},
				deps,
			),
		).toBeFalse();
		expect(writes).toEqual([]);
	});

	test("keeps confirmed final outcomes durable and gives in-flight changes an explicit TTL", () => {
		const writes: unknown[] = [];
		const deps = { recordDecision: (write: unknown) => writes.push(write) };

		expect(
			recordLandingZoneOutcome(
				{
					requestId: "outcome-1",
					summary: "MR 42 was reviewed and the deployment pipeline succeeded.",
					confirmed: true,
					kind: "plan-outcome",
					mrUrl: "https://gitlab.com/example/-/merge_requests/42",
				},
				deps,
			),
		).toBeTrue();
		expect(
			recordLandingZoneOutcome(
				{
					requestId: "outcome-2",
					summary: "MR 43 is awaiting review.",
					confirmed: true,
					kind: "in-flight-change",
					mrUrl: "https://gitlab.com/example/-/merge_requests/43",
					ttlSeconds: 3600,
				},
				deps,
			),
		).toBeTrue();
		expect(writes[0]).not.toHaveProperty("ttlSeconds");
		expect(writes[1]).toMatchObject({ ttlSeconds: 3600 });
	});

	test("rejects unconfirmed outcomes and in-flight records without an expiry", () => {
		const writes: unknown[] = [];
		const deps = { recordDecision: (write: unknown) => writes.push(write) };

		expect(
			recordLandingZoneOutcome(
				{ requestId: "outcome-3", summary: "Tentative result", confirmed: false, kind: "plan-outcome" },
				deps,
			),
		).toBeFalse();
		expect(
			recordLandingZoneOutcome(
				{ requestId: "outcome-4", summary: "MR is open", confirmed: true, kind: "in-flight-change" },
				deps,
			),
		).toBeFalse();
		expect(writes).toEqual([]);
	});
});
