// packages/agent/src/landing-zone/gitlab-import.test.ts

import { describe, expect, test } from "bun:test";
import {
	importLandingZoneGitLabHistory,
	type LandingZoneImportDependencies,
	runLandingZoneGitLabImportSweep,
} from "./gitlab-import.ts";

const PROJECT = {
	id: 42,
	path: "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator",
	defaultBranch: "main",
	headSha: "head-sha",
};

function mr(
	overrides: Partial<{
		iid: number;
		title: string;
		state: "opened" | "closed" | "merged";
		webUrl: string;
		createdAt: string;
		updatedAt: string;
		mergeCommitSha: string;
		verifiedLiveState: boolean;
	}> = {},
) {
	return {
		iid: 7,
		title: "Add account",
		state: "merged" as const,
		webUrl: "https://gitlab.example/mr/7",
		createdAt: "2026-09-02T00:00:00.000Z",
		updatedAt: "2026-09-03T00:00:00.000Z",
		mergeCommitSha: "commit-7",
		...overrides,
	};
}

function pipeline(
	overrides: Partial<{
		id: number;
		status: string;
		webUrl: string;
		createdAt: string;
		updatedAt: string;
		hasTerraformPlan: boolean;
		isVerifiedDeployment: boolean;
	}> = {},
) {
	return {
		id: 99,
		status: "success",
		webUrl: "https://gitlab.example/pipeline/99",
		createdAt: "2026-09-03T00:00:00.000Z",
		updatedAt: "2026-09-03T00:01:00.000Z",
		hasTerraformPlan: false,
		isVerifiedDeployment: false,
		...overrides,
	};
}

function dependencies(
	mergeRequests = [mr()],
	pipelines: ReadonlyArray<ReturnType<typeof pipeline>> = [pipeline()],
	options: { nextPage?: number; project?: typeof PROJECT } = {},
) {
	const recorded: Array<Record<string, unknown>> = [];
	const pages: Array<Record<string, unknown>> = [];
	return {
		recorded,
		pages,
		dependencies: {
			listMergeRequests: async (input: Record<string, unknown>) => {
				pages.push(input);
				return { project: options.project ?? PROJECT, mergeRequests, nextPage: options.nextPage };
			},
			listPipelines: async () => ({ pipelines: [...pipelines] }),
			writers: {
				recordRepository: async (_store: unknown, value: unknown) => {
					recorded.push({ type: "repository", value });
				},
				recordChange: async (_store: unknown, value: unknown) => {
					recorded.push({ type: "change", value });
				},
				recordPipeline: async (_store: unknown, value: unknown) => {
					recorded.push({ type: "pipeline", value });
				},
				recordPlan: async (_store: unknown, value: unknown) => {
					recorded.push({ type: "plan", value });
				},
			},
			store: {} as never,
		},
	};
}

describe("importLandingZoneGitLabHistory", () => {
	test("rescans a fixed timestamp window until reordered equal-time pages contain no new stable MRs", async () => {
		const sameTimestamp = "2026-09-03T00:00:00.000Z";
		const changes = Array.from({ length: 25 }, (_, index) =>
			mr({ iid: index + 1, updatedAt: sameTimestamp, mergeCommitSha: `commit-${index + 1}` }),
		);
		const recorded: string[] = [];
		let pass = 0;
		const testDependencies = {
			listMergeRequests: async ({ page }: { page: number }) => {
				const ordered = pass === 0 ? changes : [...changes.slice(5), ...changes.slice(0, 5)];
				return {
					project: PROJECT,
					mergeRequests: ordered.slice((page - 1) * 20, page * 20),
					...(page === 1 && { nextPage: 2 }),
				};
			},
			listPipelines: async () => ({ pipelines: [] }),
			writers: {
				recordRepository: async () => {},
				recordChange: async (_store: unknown, change: { mergeRequest?: { id: string } }) => {
					if (change.mergeRequest) recorded.push(change.mergeRequest.id);
				},
				recordPipeline: async () => {},
				recordPlan: async () => {},
			},
			store: {} as never,
		};
		const first = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 2 },
			testDependencies,
		);
		expect(first.checkpoint?.inProgress?.seenMrIds).toHaveLength(25);
		const upperBound = first.checkpoint?.inProgress?.upperBound;
		expect(upperBound).toBeString();
		if (!upperBound) throw new Error("Expected an in-progress upper bound");
		pass = 1;
		const second = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", checkpoint: first.checkpoint, maxPages: 2 },
			testDependencies,
		);
		expect(second.checkpoint).toEqual({ projectId: "42", updatedAfter: upperBound });
		expect(new Set(recorded)).toEqual(new Set(changes.map((change) => `42:${change.iid}`)));
	});

	test("records a merged MR with a successful plan as merged-unverified", async () => {
		const recorded: Array<Record<string, unknown>> = [];
		const result = await importLandingZoneGitLabHistory(
			{
				repository: "aws-lz-account-creator",
				startAt: "2026-09-01T00:00:00.000Z",
				maxPages: 1,
			},
			{
				listMergeRequests: async () => ({
					project: {
						id: 42,
						path: "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator",
						defaultBranch: "main",
						headSha: "head-sha",
					},
					mergeRequests: [
						{
							iid: 7,
							title: "Add account",
							state: "merged",
							webUrl: "https://gitlab.example/mr/7",
							createdAt: "2026-09-02T00:00:00.000Z",
							updatedAt: "2026-09-03T00:00:00.000Z",
							mergeCommitSha: "commit-7",
						},
					],
					nextPage: undefined,
				}),
				listPipelines: async () => ({
					pipelines: [
						{
							id: 99,
							status: "success",
							webUrl: "https://gitlab.example/pipeline/99",
							createdAt: "2026-09-03T00:00:00.000Z",
							updatedAt: "2026-09-03T00:01:00.000Z",
							hasTerraformPlan: true,
							isVerifiedDeployment: false,
						},
					],
				}),
				writers: {
					recordRepository: async (_store, value) => {
						recorded.push({ type: "repository", value });
					},
					recordChange: async (_store, value) => {
						recorded.push({ type: "change", value });
					},
					recordPipeline: async (_store, value) => {
						recorded.push({ type: "pipeline", value });
					},
					recordPlan: async (_store, value) => {
						recorded.push({ type: "plan", value });
					},
				},
				store: {} as never,
			},
		);

		expect(result.outcomes).toEqual(["merged-unverified"]);
		expect(recorded.find((entry) => entry.type === "change")).toMatchObject({
			value: { id: "gitlab:42:7:commit-7", outcome: "merged-unverified", repositoryId: "gitlab-project:42" },
		});
		expect(recorded.find((entry) => entry.type === "plan")).toMatchObject({
			value: { pipelineId: "99", plan: { id: "gitlab:plan:99", status: "success" } },
		});
	});

	test.each([
		["open MR", mr({ state: "opened" }), [pipeline()], "proposed"],
		["closed unmerged MR", mr({ state: "closed" }), [pipeline()], "declined"],
		["failed pipeline", mr(), [pipeline({ status: "failed" })], "pipeline-failed"],
		["verified deployment", mr(), [pipeline({ isVerifiedDeployment: true })], "applied"],
		["missing artifacts", mr(), [pipeline()], "merged-unverified"],
	] as const)("maps %s to the safe outcome", async (_fixture, mergeRequest, pipelines, expected) => {
		const fixture = dependencies([mergeRequest], pipelines);
		const result = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			fixture.dependencies,
		);

		expect(result.outcomes).toEqual([expected]);
		if (expected === "merged-unverified") expect(fixture.recorded.filter((entry) => entry.type === "plan")).toEqual([]);
	});

	test("does not treat a merged MR as applied without verified deployment evidence", async () => {
		const fixture = dependencies([mr()], [pipeline({ status: "success", hasTerraformPlan: true })]);
		const result = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			fixture.dependencies,
		);
		expect(result.outcomes).toEqual(["merged-unverified"]);
	});

	test("allows verified live-state evidence to establish applied", async () => {
		const fixture = dependencies([mr({ verifiedLiveState: true })], [pipeline()]);
		const result = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			fixture.dependencies,
		);
		expect(result.outcomes).toEqual(["applied"]);
	});

	test("keeps a stable repository ID when GitLab reports a renamed project path", async () => {
		const fixture = dependencies([], [], {
			project: { ...PROJECT, path: "pvhcorp/dhco/aws/aws-lz-renamed/account-creator" },
		});
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			fixture.dependencies,
		);

		expect(fixture.recorded[0]).toMatchObject({
			value: { repository: { id: "gitlab-project:42", path: "pvhcorp/dhco/aws/aws-lz-renamed/account-creator" } },
		});
	});

	test("returns a project checkpoint after a bounded page and resumes from it", async () => {
		const first = dependencies([mr()], [pipeline()]);
		const firstResult = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			first.dependencies,
		);
		expect(firstResult.checkpoint).toMatchObject({
			projectId: "42",
			updatedAfter: "2026-09-01T00:00:00.000Z",
			inProgress: { completedScan: true },
		});

		const resumed = dependencies([mr({ iid: 8, updatedAt: "2026-09-04T00:00:00.000Z" })]);
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", checkpoint: firstResult.checkpoint, maxPages: 1 },
			resumed.dependencies,
		);
		expect(resumed.pages[0]).toMatchObject({
			repository: "aws-lz-account-creator",
			updatedAfter: "2026-09-01T00:00:00.000Z",
			page: 1,
		});
	});

	test("advances the completed project watermark to the latest observed update", async () => {
		const fixture = dependencies([mr({ updatedAt: "2026-09-04T00:00:00.000Z" })]);
		const result = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			fixture.dependencies,
		);
		expect(result.checkpoint).toMatchObject({
			projectId: "42",
			updatedAfter: "2026-09-01T00:00:00.000Z",
			inProgress: { completedScan: true },
		});
	});

	test("persists the completed project checkpoint for scheduled reconciliation", async () => {
		const fixture = dependencies([mr({ updatedAt: "2026-09-04T00:00:00.000Z" })]);
		const checkpoints: unknown[] = [];
		const persisted = fixture.dependencies as LandingZoneImportDependencies;
		persisted.recordCheckpoint = async (_store, checkpoint) => {
			checkpoints.push(checkpoint);
		};
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			persisted,
		);
		expect(checkpoints).toEqual([
			expect.objectContaining({
				projectId: "42",
				updatedAfter: "2026-09-01T00:00:00.000Z",
				inProgress: expect.any(Object),
			}),
		]);
	});

	test("carries bounded GitLab provenance into every imported graph record", async () => {
		const recorded: Array<Record<string, unknown>> = [];
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			{
				listMergeRequests: async () => ({
					project: PROJECT,
					mergeRequests: [mr()],
					provenance: { source: "gitlab" as const, retrievedAt: "2026-09-04T10:00:00.000Z", truncated: true },
				}),
				listPipelines: async () => ({
					pipelines: [pipeline({ hasTerraformPlan: true })],
					provenance: { source: "gitlab" as const, retrievedAt: "2026-09-04T10:01:00.000Z", truncated: false },
				}),
				writers: {
					recordRepository: async (_store, value) => {
						recorded.push({ type: "repository", value });
					},
					recordChange: async (_store, value) => {
						recorded.push({ type: "change", value });
					},
					recordPipeline: async (_store, value) => {
						recorded.push({ type: "pipeline", value });
					},
					recordPlan: async (_store, value) => {
						recorded.push({ type: "plan", value });
					},
				},
				store: {} as never,
			},
		);

		expect(recorded).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "repository",
					value: expect.objectContaining({
						provenance: { source: "gitlab", retrievedAt: "2026-09-04T10:00:00.000Z", truncated: true },
					}),
				}),
				expect.objectContaining({
					type: "change",
					value: expect.objectContaining({
						source: "gitlab",
						lastSyncedAt: "2026-09-04T10:00:00.000Z",
						truncated: true,
					}),
				}),
				expect.objectContaining({
					type: "pipeline",
					value: expect.objectContaining({
						source: "gitlab",
						updatedAt: "2026-09-03T00:01:00.000Z",
						lastSyncedAt: "2026-09-04T10:01:00.000Z",
						truncated: false,
					}),
				}),
				expect.objectContaining({
					type: "plan",
					value: expect.objectContaining({
						source: "gitlab",
						lastSyncedAt: "2026-09-04T10:01:00.000Z",
						truncated: false,
					}),
				}),
			]),
		);
	});

	test("scheduled reconciliation enumerates active repositories and advances seeded checkpoints", async () => {
		const fixture = dependencies([mr()]);
		const scheduled = fixture.dependencies as LandingZoneImportDependencies;
		scheduled.listRepositories = async () => [
			{ name: "aws-lz-account-creator", availability: "active" },
			{ name: "aws-lz-shared-tools", availability: "no-git-refs" },
		];
		scheduled.readCheckpoint = async () => ({ projectId: "42", updatedAfter: "2026-09-01T00:00:00.000Z" });
		const result = await runLandingZoneGitLabImportSweep(undefined, scheduled);
		expect(result).toMatchObject({ outcomes: ["merged-unverified"] });
	});

	test("keeps replay writes idempotent through stable GitLab entity keys", async () => {
		const fixture = dependencies([mr()], [pipeline({ hasTerraformPlan: true })]);
		const options = { repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 };
		await importLandingZoneGitLabHistory(options, fixture.dependencies);
		await importLandingZoneGitLabHistory(options, fixture.dependencies);

		const changes = fixture.recorded.filter((entry) => entry.type === "change");
		expect(changes.map((entry) => (entry.value as { id: string }).id)).toEqual([
			"gitlab:42:7:commit-7",
			"gitlab:42:7:commit-7",
		]);
	});
});
