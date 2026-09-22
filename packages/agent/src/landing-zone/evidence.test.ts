// packages/agent/src/landing-zone/evidence.test.ts

import { describe, expect, test } from "bun:test";
import type { EvidenceItem, EvidenceSource } from "@devops-agent/shared";
import { collectEvidenceInParallel, type LandingZoneEvidenceCollectors } from "./evidence.ts";

function item(source: EvidenceSource): EvidenceItem {
	return {
		id: `${source}:1`,
		claimKey: `${source}-claim`,
		source,
		retrievedAt: "2026-09-22T10:00:00.000Z",
		status: "observed",
		summary: `${source} evidence`,
		provenance: { path: source },
		freshness: { status: "current" },
	};
}

function collectors(calls: EvidenceSource[]): LandingZoneEvidenceCollectors {
	return Object.fromEntries(
		(["pvh-okf", "gitlab", "terraform-docs", "aws-docs", "aws-api", "memory", "knowledge-graph"] as const).map(
			(source) => [
				source,
				async () => {
					calls.push(source);
					if (source === "terraform-docs") throw new Error("offline");
					return [item(source)];
				},
			],
		),
	) as unknown as LandingZoneEvidenceCollectors;
}

describe("parallel Landing Zone evidence collection", () => {
	test("keeps successful sources when an optional collector fails", async () => {
		const calls: EvidenceSource[] = [];
		const results = await collectEvidenceInParallel(
			{
				intent: "review",
				query: "review account vending",
				repositories: ["aws-lz-account-creator"],
				selectedKnowledge: ["repos/aws-lz-account-creator.md"],
				awsLiveStateRelevant: false,
				awsLiveStateAuthorized: false,
			},
			collectors(calls),
		);

		expect(calls).toContainAllValues(["pvh-okf", "gitlab", "terraform-docs", "aws-docs", "memory", "knowledge-graph"]);
		expect(calls).not.toContain("aws-api");
		expect(results.find((result) => result.source === "terraform-docs")?.status).toBe("unavailable");
		expect(results.find((result) => result.source === "gitlab")?.evidence).toHaveLength(1);
	});

	test("runs AWS live-state collection only when relevant and authorised", async () => {
		const calls: EvidenceSource[] = [];
		await collectEvidenceInParallel(
			{
				intent: "review",
				query: "compare deployed resource state",
				repositories: [],
				selectedKnowledge: [],
				awsLiveStateRelevant: true,
				awsLiveStateAuthorized: true,
			},
			collectors(calls),
		);
		expect(calls).toContain("aws-api");
	});
});
