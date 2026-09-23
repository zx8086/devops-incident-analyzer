import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";
import LandingZonePlanReviewCard from "./LandingZonePlanReviewCard.svelte";

const prompt = {
	threadId: "thread-lz",
	message: "Review the evidence-backed proposal.",
	review: {
		repository: "aws-lz-account-creator",
		projectId: 42,
		baseBranch: "main",
		baseSha: "a".repeat(40),
		targetBranch: "agent/add-martech",
		changeSummary: "Add MarTech account request",
		title: "Add MarTech account request",
		files: [{ path: "accounts/martech.yml", contentSha256: "b".repeat(64), expectedFileSha: null }],
		diffSummary: "Create accounts/martech.yml",
		standardsComparison: [],
		validations: [{ command: "account schema", status: "passed" as const, required: true, summary: "Passed." }],
		expectedPlan: "One account addition; no deletion.",
		stopConditions: [],
		destructiveFlags: [],
		unresolvedEvidence: [],
		riskLevel: "high" as const,
	},
};

describe("LandingZonePlanReviewCard", () => {
	test("renders evidence, validation, plan, and the non-apply approval boundary", () => {
		const { body } = render(LandingZonePlanReviewCard, {
			props: { prompt, onApprove: () => undefined, onReject: () => undefined, onAmend: () => undefined },
		});
		expect(body).toContain("Review Landing Zone proposal");
		expect(body).toContain("aws-lz-account-creator");
		expect(body).toContain("Create accounts/martech.yml");
		expect(body).toContain("account schema");
		expect(body).toContain("One account addition; no deletion.");
		expect(body).toContain("Approve and open MR");
		expect(body).toContain("never merges or applies Terraform");
	});
});
