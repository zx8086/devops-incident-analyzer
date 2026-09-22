// packages/agent/src/landing-zone/evidence.test.ts

import { describe, expect, test } from "bun:test";
import type { EvidenceItem, EvidenceSource } from "@devops-agent/shared";
import {
	collectEvidenceInParallel,
	collectEvidenceSource,
	collectGitLabEvidence,
	collectKnowledgeGraphEvidence,
	type EvidenceCollectionContext,
	type LandingZoneEvidenceCollectors,
} from "./evidence.ts";

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
	const context: EvidenceCollectionContext = {
		intent: "review",
		query: "review account vending",
		repositories: ["aws-lz-account-creator"],
		selectedKnowledge: ["repos/aws-lz-account-creator.md"],
		awsLiveStateRelevant: false,
		awsLiveStateAuthorized: false,
	};

	test("keeps successful sources when an optional collector fails", async () => {
		const calls: EvidenceSource[] = [];
		const results = await collectEvidenceInParallel(context, collectors(calls));

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

	test("times out a stuck optional collector into an unavailable result", async () => {
		const stuck = collectors([]);
		stuck.memory = () => new Promise<EvidenceItem[]>(() => {});
		const result = await collectEvidenceSource("memory", context, stuck, 5);
		expect(result.status).toBe("unavailable");
		expect(result.reason).toContain("timed out");
	});

	test("preserves successful GitLab repositories when a sibling read fails", async () => {
		const result = await collectGitLabEvidence(
			{ ...context, repositories: ["aws-lz-account-creator", "aws-lz-network-workloads"] },
			async (_name, input) => {
				if (input.repository === "aws-lz-network-workloads") throw new Error("not found");
				return { examples: ["accounts/example.yml"] };
			},
		);
		expect(result.find((entry) => entry.id === "gitlab:aws-lz-account-creator")?.status).toBe("observed");
		expect(result.find((entry) => entry.id === "gitlab:aws-lz-network-workloads:unavailable")?.status).toBe(
			"unverified",
		);
	});

	test("queries the knowledge graph before producing observed evidence", async () => {
		const calls: Record<string, unknown>[] = [];
		const result = await collectKnowledgeGraphEvidence(context, [
			{
				name: "kg_run_cypher",
				invoke: async (input) => {
					calls.push(input);
					return { rows: [] };
				},
			},
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cypher).toContain("MATCH (n)");
		expect(result[0]?.status).toBe("observed");
	});
});
