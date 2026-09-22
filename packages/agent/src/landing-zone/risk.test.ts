// packages/agent/src/landing-zone/risk.test.ts

import { describe, expect, test } from "bun:test";
import type { EvidenceItem, EvidenceReconciliation, EvidenceSource } from "@devops-agent/shared";
import { assessRisk } from "./risk.ts";

function reconciliation(overrides: Partial<EvidenceReconciliation> = {}): EvidenceReconciliation {
	return {
		status: "aligned",
		conclusion: "Current repository evidence supports the explanation.",
		comparisons: [],
		conflicts: [],
		unavailableSources: [],
		...overrides,
	};
}

describe("assessRisk", () => {
	test("allows general learning during a GitLab outage but marks the answer constrained", () => {
		const result = assessRisk(reconciliation({ status: "unknown", unavailableSources: ["gitlab"] }), {
			intent: "learn",
		});

		expect(result.blocked).toBeFalse();
		expect(result.level).toBe("medium");
		expect(result.reasons.join(" ")).toContain("general guidance only");
	});

	test("blocks a repository change when current GitLab evidence is unavailable", () => {
		const result = assessRisk(reconciliation({ status: "unknown", unavailableSources: ["gitlab"] }), {
			intent: "propose-change",
		});

		expect(result.blocked).toBeTrue();
		expect(result.requiredEvidenceSources).toContain("gitlab" satisfies EvidenceSource);
		expect(result.stopConditions.join(" ")).toContain("repository evidence");
	});

	test("blocks a multi-repository change when one scoped repository lacks current evidence", () => {
		const accountEvidence: EvidenceItem = {
			id: "gitlab:account",
			claimKey: "account-contract",
			source: "gitlab",
			retrievedAt: "2026-09-22T12:00:00.000Z",
			status: "observed",
			summary: "Account repository contract read.",
			provenance: { repository: "aws-lz-account-creator", path: "." },
			freshness: { status: "current" },
		};
		const result = assessRisk(reconciliation(), {
			intent: "propose-change",
			currentEvidenceSources: ["gitlab"],
			repositories: ["aws-lz-account-creator", "aws-lz-network-workloads"],
			evidence: [accountEvidence],
		});

		expect(result.blocked).toBeTrue();
		expect(result.stopConditions.join(" ")).toContain("aws-lz-network-workloads");
	});

	test("marks requested topology unverified without AWS live evidence", () => {
		const result = assessRisk(reconciliation({ unavailableSources: ["aws-api"] }), {
			intent: "review",
			requestText: "Compare the live VPC and subnet topology for drift",
		});

		expect(result.blocked).toBeFalse();
		expect(result.level).toBe("medium");
		expect(result.reasons.join(" ")).toContain("topology remains unverified");
	});

	test.each([
		["backend contract", "Change the production backend locking contract"],
		["shared-module version", "Update the shared module ref without a verified released version"],
		["destructive plan", "Apply a plan that destroys the KMS key"],
		["state operation", "Run terraform state rm on the production address"],
		["public access", "Allow public access from 0.0.0.0/0"],
		["broad IAM expansion", "Grant IAM Action * and Resource *"],
		["secrets", "Commit a plaintext secret in tfvars"],
	] as const)("blocks the %s stop condition", (_name, requestText) => {
		const result = assessRisk(reconciliation(), { intent: "propose-change", requestText });

		expect(result.blocked).toBeTrue();
		expect(result.stopConditions).not.toHaveLength(0);
	});
});
