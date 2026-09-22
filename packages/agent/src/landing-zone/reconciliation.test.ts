// packages/agent/src/landing-zone/reconciliation.test.ts

import { describe, expect, test } from "bun:test";
import type { EvidenceItem } from "@devops-agent/shared";
import { reconcileEvidence } from "./reconciliation.ts";

function evidence(
	id: string,
	source: EvidenceItem["source"],
	summary: string,
	overrides: Partial<EvidenceItem> = {},
): EvidenceItem {
	return {
		id,
		claimKey: "account-authoring-surface",
		source,
		retrievedAt: "2026-09-22T12:00:00.000Z",
		status: "observed",
		summary,
		provenance: { path: `${source}/${id}` },
		freshness: { status: "current" },
		...overrides,
	};
}

describe("reconcileEvidence", () => {
	test("retains live repository behaviour when historical PVH guidance disagrees", () => {
		const comparisons = reconcileEvidence([
			evidence("guide", "pvh-okf", "Create accounts with a root aws_organizations_account resource.", {
				freshness: { status: "stale" },
			}),
			evidence("repo", "gitlab", "Create accounts through accounts/<application>.yml and the generator."),
		]);

		expect(comparisons).toHaveLength(1);
		expect(comparisons[0]?.liveImplementation?.id).toBe("repo");
		expect(comparisons[0]?.alignment).toBe("divergent");
		expect(comparisons[0]?.action).toBe("explain");
	});

	test("treats accepted PVH policy as authoritative and AWS guidance as advisory", () => {
		const comparisons = reconcileEvidence([
			evidence("policy", "pvh-okf", "Accepted PVH policy requires private subnets."),
			evidence("aws", "aws-docs", "AWS recommends evaluating public subnets for this workload."),
		]);

		expect(comparisons[0]?.pvhStandard?.id).toBe("policy");
		expect(comparisons[0]?.awsRecommendation?.id).toBe("aws");
		expect(comparisons[0]?.alignment).toBe("divergent");
		expect(comparisons[0]?.action).toBe("explain");
	});

	test("selects current evidence ahead of a stale observation from the same authority", () => {
		const comparisons = reconcileEvidence([
			evidence("stale", "pvh-okf", "Historical policy", { freshness: { status: "stale" } }),
			evidence("current", "pvh-okf", "Current accepted policy", { status: "inferred" }),
		]);

		expect(comparisons[0]?.pvhStandard?.id).toBe("current");
	});

	test("never turns accepted-policy and production divergence into an automatic proposal", () => {
		const comparisons = reconcileEvidence([
			evidence("policy", "pvh-okf", "Accepted policy requires native S3 locking."),
			evidence("repo", "gitlab", "Production still uses DynamoDB locking."),
		]);

		const comparison = comparisons[0];
		if (!comparison) throw new Error("expected a standards comparison");
		expect(["divergent", "exception"]).toContain(comparison.alignment);
		expect(comparison.action).toBe("escalate");
	});

	test("marks memory-only and empty graph observations as not recorded, not never happened", () => {
		const comparisons = reconcileEvidence([
			evidence("memory", "memory", "No matching memory was recorded."),
			evidence("graph", "knowledge-graph", '{"rows":[]}'),
		]);

		expect(comparisons[0]?.alignment).toBe("unverified");
		expect(comparisons[0]?.action).toBe("monitor");
	});
});
