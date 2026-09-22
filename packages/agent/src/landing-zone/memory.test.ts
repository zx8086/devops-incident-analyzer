import { describe, expect, test } from "bun:test";
import type { AnnotationMap } from "@devops-agent/shared";
import type { MemorySearchHit } from "../memory-backend.ts";
import {
	buildLandingZoneMemoryAnnotations,
	memoryEnrichLandingZone,
	recordLandingZoneDecision,
	recordLandingZoneOutcome,
	recordLandingZoneTurn,
	renderLandingZonePriorMemory,
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

	test("renders recalled experience as advisory content requiring live revalidation", () => {
		expect(
			renderLandingZonePriorMemory([
				{
					text: "A previous account review used the YAML authoring surface.",
					annotations: { kind: "account-vending" },
					advisory: true,
					requiresLiveRevalidation: true,
				},
			]),
		).toContain("Prior experience (advisory; revalidate against current live evidence)");
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

	test("redacts prefixed credential keys and credential-bearing connection URLs", () => {
		const writes: KeyDecisionFixture[] = [];
		const recorded = recordLandingZoneDecision(
			{
				requestId: "decision-secret-forms",
				decision: "db_password=hunter2 api_token=token-value DATABASE_URL=postgres://app:password@db.internal/app",
				reviewed: true,
				kind: "key-decision",
			},
			{ recordDecision: (write) => writes.push(write) },
		);

		expect(recorded).toBeTrue();
		expect(writes[0]?.decision).toBe("db_password=[REDACTED] api_token=[REDACTED] DATABASE_URL=[REDACTED]");
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

type KeyDecisionFixture = Parameters<NonNullable<Parameters<typeof recordLandingZoneDecision>[1]>["recordDecision"]>[0];

describe("recordLandingZoneTurn", () => {
	test("writes a breadcrumb and persists an evidence-confirmed review outcome", () => {
		const breadcrumbs: unknown[] = [];
		const outcomes: unknown[] = [];
		const recorded = recordLandingZoneTurn(
			state({
				intent: "review",
				outcome: "answered",
				evidenceResults: [
					{
						id: "gitlab:account",
						claimKey: "account-authoring-surface",
						source: "gitlab",
						retrievedAt: "2026-09-22T10:30:00.000Z",
						status: "observed",
						summary: "Account requests use YAML.",
						provenance: { repository: "aws-lz-account-creator", path: "accounts/example.yml" },
						freshness: { status: "current" },
					},
				],
				reconciliation: {
					status: "aligned",
					conclusion: "The live authoring surface matches the PVH contract.",
					comparisons: [],
					conflicts: [],
					unavailableSources: [],
				},
			}),
			{
				appendBreadcrumb: (entry) => breadcrumbs.push(entry),
				recordOutcome: (input) => {
					outcomes.push(input);
					return true;
				},
			},
		);

		expect(recorded).toBeTrue();
		expect(breadcrumbs).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			confirmed: true,
			kind: "plan-outcome",
			repository: "aws-lz-account-creator",
			account: "martech-dev",
			workflow: "review",
			configChangeId: "change-123",
		});
	});

	test("keeps non-review turns as expiring breadcrumbs without durable outcomes", () => {
		const breadcrumbs: unknown[] = [];
		const outcomes: unknown[] = [];
		const recorded = recordLandingZoneTurn(state({ intent: "learn", outcome: "answered" }), {
			appendBreadcrumb: (entry) => breadcrumbs.push(entry),
			recordOutcome: (input) => {
				outcomes.push(input);
				return true;
			},
		});

		expect(recorded).toBeFalse();
		expect(breadcrumbs).toHaveLength(1);
		expect(outcomes).toEqual([]);
	});

	test("does not persist blocked or non-aligned reviews as confirmed outcomes", () => {
		const breadcrumbs: unknown[] = [];
		const outcomes: unknown[] = [];
		const recorded = recordLandingZoneTurn(
			state({
				intent: "review",
				outcome: "blocked",
				evidenceResults: [
					{
						id: "gitlab:conflict",
						claimKey: "backend-locking",
						source: "gitlab",
						retrievedAt: "2026-09-22T10:30:00.000Z",
						status: "observed",
						summary: "The live backend differs from the documented target.",
						provenance: { repository: "aws-lz-network-core", path: "_backend.tf" },
						freshness: { status: "current" },
					},
				],
				reconciliation: {
					status: "conflicting-evidence",
					conclusion: "The sources conflict.",
					comparisons: [],
					conflicts: ["Backend locking differs."],
					unavailableSources: [],
				},
			}),
			{
				appendBreadcrumb: (entry) => breadcrumbs.push(entry),
				recordOutcome: (input) => {
					outcomes.push(input);
					return true;
				},
			},
		);

		expect(recorded).toBeFalse();
		expect(breadcrumbs).toHaveLength(1);
		expect(outcomes).toEqual([]);
	});
});
