// packages/shared/src/landing-zone-types.test.ts

import { describe, expect, test } from "bun:test";
import {
	AlignmentSchema,
	EvidenceItemSchema,
	EvidenceSourceSchema,
	EvidenceStatusSchema,
	LandingZoneRiskAssessmentSchema,
	ReconciliationStatusSchema,
	ResponseCitationSchema,
	TopologyStateSchema,
} from "./landing-zone-types.ts";

const baseEvidence = {
	id: "gitlab:aws-lz-account-creator:abc123:accounts/example.yml",
	claimKey: "account-authoring-surface",
	source: "gitlab",
	retrievedAt: "2026-09-22T10:30:00.000Z",
	status: "observed",
	summary: "Account requests are authored under accounts/*.yml.",
	freshness: { status: "current" },
} as const;

describe("Landing Zone evidence vocabulary", () => {
	test("pins source, claim, alignment, reconciliation, and topology states", () => {
		expect(EvidenceSourceSchema.options).toEqual([
			"pvh-okf",
			"gitlab",
			"terraform-docs",
			"aws-docs",
			"aws-api",
			"memory",
			"knowledge-graph",
		]);
		expect(EvidenceStatusSchema.options).toEqual(["observed", "inferred", "proposed", "unverified"]);
		expect(AlignmentSchema.options).toEqual(["aligned", "divergent", "exception", "unresolved", "unverified"]);
		expect(ReconciliationStatusSchema.options).toEqual([
			"aligned",
			"drifted",
			"pending",
			"unknown",
			"conflicting-evidence",
		]);
		expect(TopologyStateSchema.options).toEqual(["desired", "observed", "proposed", "unverified"]);
	});
});

describe("EvidenceItemSchema", () => {
	test.each([
		["URL", { url: "https://gitlab.com/pvhcorp/example/-/blob/abc123/main.tf" }],
		["repository", { repository: "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator" }],
		["commit", { commitSha: "0123456789abcdef0123456789abcdef01234567" }],
		["path", { path: "accounts/example.yml" }],
		["AWS resource", { awsResourceId: "vpc-0123456789abcdef0" }],
		["memory block", { memoryBlockId: "memory-block-123" }],
		["graph entity", { graphEntityId: "Repository:aws-lz-account-creator" }],
	] as const)("accepts %s provenance", (_name, provenance) => {
		const result = EvidenceItemSchema.safeParse({ ...baseEvidence, provenance });
		expect(result.success).toBeTrue();
	});

	test("rejects evidence without a provenance locator", () => {
		const result = EvidenceItemSchema.safeParse({ ...baseEvidence, provenance: {} });
		expect(result.success).toBeFalse();
	});

	test("rejects unknown status strings", () => {
		const result = EvidenceItemSchema.safeParse({
			...baseEvidence,
			status: "verified",
			provenance: { path: "accounts/example.yml" },
		});
		expect(result.success).toBeFalse();
	});

	test.each(["secretValue", "stateValue", "plaintextCredential"] as const)("rejects unsafe field %s", (field) => {
		const result = EvidenceItemSchema.safeParse({
			...baseEvidence,
			provenance: { path: "accounts/example.yml" },
			[field]: "must-not-cross-the-boundary",
		});
		expect(result.success).toBeFalse();
	});

	test("rejects unbounded raw payloads", () => {
		const result = EvidenceItemSchema.safeParse({
			...baseEvidence,
			provenance: { path: "accounts/example.yml" },
			rawPayload: "x".repeat(100_000),
		});
		expect(result.success).toBeFalse();
	});

	test("bounds summaries retained by the agent", () => {
		const result = EvidenceItemSchema.safeParse({
			...baseEvidence,
			summary: "x".repeat(8_193),
			provenance: { path: "accounts/example.yml" },
		});
		expect(result.success).toBeFalse();
	});

	test("rejects unsafe fields nested inside provenance", () => {
		const result = EvidenceItemSchema.safeParse({
			...baseEvidence,
			provenance: { path: "accounts/example.yml", stateValue: "sensitive-state" },
		});
		expect(result.success).toBeFalse();
	});
});

describe("ResponseCitationSchema", () => {
	test("requires at least one evidence reference", () => {
		expect(
			ResponseCitationSchema.safeParse({
				id: "citation-1",
				claim: "Accounts are defined in YAML.",
				evidenceIds: [],
			}).success,
		).toBeFalse();
	});
});

describe("LandingZoneRiskAssessmentSchema", () => {
	test("requires a blocked level and flag to agree", () => {
		const result = LandingZoneRiskAssessmentSchema.safeParse({
			level: "blocked",
			reasons: ["Required repository evidence is unavailable."],
			requiresHumanDecision: true,
			blocked: false,
			stopConditions: ["Stop before proposing a change."],
			requiredEvidenceSources: ["gitlab"],
		});
		expect(result.success).toBeFalse();
	});
});
