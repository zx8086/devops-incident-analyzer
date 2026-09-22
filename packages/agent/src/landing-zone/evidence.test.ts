// packages/agent/src/landing-zone/evidence.test.ts

import { describe, expect, test } from "bun:test";
import type { EvidenceItem, EvidenceSource } from "@devops-agent/shared";
import {
	collectEvidenceInParallel,
	collectEvidenceSource,
	collectGitLabEvidence,
	collectKnowledgeGraphEvidence,
	DEFAULT_LANDING_ZONE_COLLECTORS,
	type EvidenceCollectionContext,
	type LandingZoneEvidenceCollectors,
} from "./evidence.ts";
import { reconcileEvidence } from "./reconciliation.ts";

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
		let collectorSignal: AbortSignal | undefined;
		let aborted = false;
		stuck.memory = (collectorContext) => {
			collectorSignal = collectorContext.signal;
			return new Promise<EvidenceItem[]>((_resolve, reject) => {
				collectorContext.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(collectorContext.signal?.reason);
				});
			});
		};
		const result = await collectEvidenceSource("memory", context, stuck, 5);
		expect(result.status).toBe("unavailable");
		expect(result.reason).toContain("timed out");
		expect(aborted).toBe(true);
		expect(collectorSignal?.aborted).toBe(true);
	});

	test("preserves successful GitLab repositories when a sibling read fails", async () => {
		const inputs: Record<string, unknown>[] = [];
		const result = await collectGitLabEvidence(
			{ ...context, repositories: ["aws-lz-account-creator", "aws-lz-network-workloads"] },
			async (_name, input) => {
				inputs.push(input);
				if (input.repository === "aws-lz-network-workloads") throw new Error("not found");
				return { examples: ["accounts/example.yml"] };
			},
		);
		expect(result.find((entry) => entry.id === "gitlab:aws-lz-account-creator")?.status).toBe("observed");
		expect(result.find((entry) => entry.id === "gitlab:aws-lz-network-workloads:unavailable")?.status).toBe(
			"unverified",
		);
		expect(result[0]?.claimKey).toBe("repository:aws-lz-account-creator:authoring-surface");
		expect(result[0]?.claimValue).toBe("accounts/*.yml");
		expect(inputs[0]?.path).toBe("accounts");
	});

	test("emits the same structured authoring-surface claim from PVH repository knowledge", async () => {
		const result = await DEFAULT_LANDING_ZONE_COLLECTORS["pvh-okf"](context);
		const account = result.find((entry) => entry.id === "pvh-okf:repos/aws-lz-account-creator.md");

		expect(account?.claimKey).toBe("repository:aws-lz-account-creator:authoring-surface");
		expect(account?.claimValue).toBe("accounts/*.yml");
	});

	test("reconciles default PVH knowledge with representative GitLab paths", async () => {
		const pvh = await DEFAULT_LANDING_ZONE_COLLECTORS["pvh-okf"](context);
		const gitlab = await collectGitLabEvidence(context, async () => ({
			examples: ["accounts/alpha.yml", "accounts/beta.yaml", "accounts/gamma.yml"],
		}));
		const comparison = reconcileEvidence([...pvh, ...gitlab]).find(
			(entry) => entry.claim === "repository:aws-lz-account-creator:authoring-surface",
		);

		expect(comparison?.alignment).toBe("aligned");
		expect(comparison?.pvhStandard?.claimValue).toBe("accounts/*.yml");
		expect(comparison?.liveImplementation?.claimValue).toBe("accounts/*.yml");
	});

	test("normalizes GitLab project declarations into the PVH repository claim", async () => {
		const projectContext = {
			...context,
			repositories: ["dhco-gitlab-terraform"],
			selectedKnowledge: ["repos/dhco-gitlab-terraform.md"],
		};
		const pvh = await DEFAULT_LANDING_ZONE_COLLECTORS["pvh-okf"](projectContext);
		const gitlab = await collectGitLabEvidence(projectContext, async () => ({
			examples: ["active-dir.tf", "aws.tf", "retail.tf"],
		}));
		const comparison = reconcileEvidence([...pvh, ...gitlab]).find(
			(entry) => entry.claim === "repository:dhco-gitlab-terraform:authoring-surface",
		);

		expect(comparison?.alignment).toBe("aligned");
		expect(comparison?.pvhStandard?.claimValue).toBe("root-domain/*.tf");
		expect(comparison?.liveImplementation?.claimValue).toBe("root-domain/*.tf");
	});

	test("queries the knowledge graph before producing observed evidence", async () => {
		const calls: Record<string, unknown>[] = [];
		const configs: { signal?: AbortSignal }[] = [];
		const controller = new AbortController();
		const result = await collectKnowledgeGraphEvidence({ ...context, signal: controller.signal }, [
			{
				name: "kg_run_cypher",
				invoke: async (input, config) => {
					calls.push(input);
					configs.push(config ?? {});
					return { rows: [] };
				},
			},
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.cypher).toContain("MATCH (n)");
		expect(configs[0]?.signal).toBe(controller.signal);
		expect(result[0]?.status).toBe("observed");
	});
});
