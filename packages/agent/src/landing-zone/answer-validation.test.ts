// packages/agent/src/landing-zone/answer-validation.test.ts

import { describe, expect, test } from "bun:test";
import type { EvidenceItem } from "@devops-agent/shared";
import { validateLandingZoneAnswer } from "./answer-validation.ts";
import type { LandingZoneAnswer, LandingZoneRequestResolution } from "./types.ts";

const resolution: LandingZoneRequestResolution = {
	intent: "learn",
	subject: "account-vending",
	repositories: ["aws-lz-account-creator"],
	accountIds: [],
	application: null,
	environment: null,
	topologyView: null,
	clarification: null,
	repositoryResolution: "deterministic",
	accountResolution: "unresolved",
};

const evidence: EvidenceItem = {
	id: "gitlab:account",
	claimKey: "account-surface",
	claimValue: "accounts/*.yml",
	source: "gitlab",
	retrievedAt: "2026-09-24T08:00:00.000Z",
	status: "observed",
	summary: "Current account authoring evidence.",
	provenance: { repository: "aws-lz-account-creator", path: "accounts/example.yml" },
	freshness: { status: "current" },
};

function answer(overrides: Partial<LandingZoneAnswer> = {}): LandingZoneAnswer {
	return {
		answerMarkdown:
			"Use `accounts/<application>.yml` in `aws-lz-account-creator`. The repository generator validates that YAML and produces the reviewed Terraform configuration. [citation-account]",
		citations: [{ id: "citation-account", claim: "Current account workflow", evidenceIds: ["gitlab:account"] }],
		limitations: ["AWS documentation was unavailable."],
		...overrides,
	};
}

describe("validateLandingZoneAnswer", () => {
	test("accepts a substantive YAML-first account answer with known current evidence", () => {
		expect(
			validateLandingZoneAnswer({
				answer: answer(),
				resolution,
				evidence: [evidence],
				unavailableSources: ["aws-docs"],
				requestText: "Show me the PVH account process",
			}).valid,
		).toBeTrue();
	});

	test("rejects the old status-only answer", () => {
		const result = validateLandingZoneAnswer({
			answer: answer({
				answerMarkdown: "Current PVH, repository, Terraform, and AWS evidence is aligned for the evaluated claims.",
				citations: [],
			}),
			resolution,
			evidence: [evidence],
			unavailableSources: ["terraform-docs", "aws-docs"],
			requestText: "Show me the PVH account process",
		});

		expect(result.valid).toBeFalse();
		expect(result.issues).toContain("Answer is reconciliation boilerplate rather than a substantive response.");
		expect(result.issues).toContain("An unavailable source is described as aligned or consulted.");
	});

	test("rejects unknown citations and invented account identifiers", () => {
		const result = validateLandingZoneAnswer({
			answer: answer({
				answerMarkdown:
					"Use `accounts/<application>.yml` for account 999900001111. The generator produces Terraform from that reviewed YAML.",
				citations: [{ id: "citation-account", claim: "Unknown", evidenceIds: ["missing"] }],
			}),
			resolution,
			evidence: [evidence],
			unavailableSources: [],
			requestText: "Show me the PVH account process",
		});

		expect(result.valid).toBeFalse();
		expect(result.issues).toContain("Citation citation-account references unknown evidence missing.");
		expect(result.issues).toContain("Answer contains an account ID that was not present in the request or evidence.");
	});
});
