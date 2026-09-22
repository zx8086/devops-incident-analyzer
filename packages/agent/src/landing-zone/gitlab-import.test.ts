// packages/agent/src/landing-zone/gitlab-import.test.ts

import { afterEach, describe, expect, test } from "bun:test";
import {
	importLandingZoneGitLabHistory,
	LANDING_ZONE_GITLAB_IMPORT_REQUIRED_TOOLS,
	type LandingZoneImportCheckpoint,
	type LandingZoneImportDependencies,
	landingZoneGitLabImportEnabled,
	MAX_PENDING_MERGE_REQUESTS,
	recoveryAnchorNeedsWrite,
	resetLandingZoneGitLabImportStateForTests,
	runLandingZoneGitLabImportSweep,
} from "./gitlab-import.ts";

afterEach(() => resetLandingZoneGitLabImportStateForTests());

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
		state: "opened" | "closed" | "locked" | "merged";
		webUrl: string;
		createdAt: string;
		updatedAt: string;
		mergeCommitSha: string;
		commitSha: string;
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
		planJobs: Array<{ id: number; status: string; webUrl: string }>;
	}> = {},
) {
	return {
		id: 99,
		status: "success",
		webUrl: "https://gitlab.example/pipeline/99",
		createdAt: "2026-09-03T00:00:00.000Z",
		updatedAt: "2026-09-03T00:01:00.000Z",
		planJobs: [],
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
				return {
					project: options.project ?? PROJECT,
					mergeRequests,
					total: mergeRequests.length,
					nextPage: options.nextPage,
				};
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
					total: ordered.length,
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
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			testDependencies,
		);
		expect(first.checkpoint?.inProgress).toMatchObject({ expectedTotal: 25, nextPage: 2 });
		pass = 1;
		const second = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", checkpoint: first.checkpoint, maxPages: 2 },
			testDependencies,
		);
		expect(second.checkpoint?.inProgress?.nextPage).toBe(1);
		const third = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", checkpoint: second.checkpoint, maxPages: 2 },
			testDependencies,
		);
		expect(third.checkpoint?.inProgress).toBeUndefined();
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
					total: 1,
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
							planJobs: [{ id: 991, status: "success", webUrl: "https://gitlab.example/jobs/991" }],
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
			value: {
				id: "gitlab:42:7",
				commitSha: "commit-7",
				outcome: "merged-unverified",
				repositoryId: "gitlab-project:42",
			},
		});
		expect(recorded.find((entry) => entry.type === "plan")).toMatchObject({
			value: {
				pipelineId: "99",
				plan: { id: "gitlab:plan-job:991", status: "success", artifactUrl: "https://gitlab.example/jobs/991" },
			},
		});
	});

	test.each([
		["open MR", mr({ state: "opened" }), [pipeline()], "proposed"],
		["temporarily locked MR", mr({ state: "locked" }), [pipeline()], "proposed"],
		["closed unmerged MR", mr({ state: "closed" }), [pipeline()], "declined"],
		["failed pipeline", mr(), [pipeline({ status: "failed" })], "pipeline-failed"],
		["successful CI pipeline", mr(), [pipeline()], "merged-unverified"],
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
		const fixture = dependencies(
			[mr()],
			[
				pipeline({
					status: "success",
					planJobs: [{ id: 991, status: "success", webUrl: "https://gitlab.example/jobs/991" }],
				}),
			],
		);
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

	test("requires a successful deployment for the exact merge SHA before marking an MR applied", async () => {
		const fixture = dependencies([mr()], [pipeline()]);
		const result = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			{
				...fixture.dependencies,
				listDeployments: async () => ({
					deployments: [{ sha: "commit-7", status: "success", updatedAt: "2026-09-03T00:02:00.000Z", pipelineId: 99 }],
					provenance: { source: "gitlab" as const, retrievedAt: "2026-09-03T00:03:00.000Z", truncated: false },
				}),
			} as LandingZoneImportDependencies & {
				listDeployments: () => Promise<{
					deployments: Array<{ sha: string; status: string; updatedAt: string; pipelineId: number }>;
				}>;
			},
		);
		expect(result.outcomes).toEqual(["applied"]);
		expect(fixture.recorded.find((entry) => entry.type === "change")).toMatchObject({
			value: {
				source: "gitlab-deployment",
				outcomeEvidence: {
					source: "gitlab-deployment",
					commitSha: "commit-7",
					pipelineId: "99",
					observedAt: "2026-09-03T00:02:00.000Z",
					truncated: false,
				},
			},
		});
	});

	test("uses the newest MR pipeline instead of allowing an old failure to dominate a successful retry", async () => {
		const fixture = dependencies(
			[mr()],
			[
				pipeline({ id: 99, status: "failed", updatedAt: "2026-09-03T00:01:00.000Z" }),
				pipeline({ id: 100, status: "success", updatedAt: "2026-09-03T00:02:00.000Z" }),
			],
		);

		const result = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			fixture.dependencies,
		);

		expect(result.outcomes).toEqual(["merged-unverified"]);
		expect(fixture.recorded.find((entry) => entry.type === "change")).toMatchObject({
			value: {
				source: "gitlab-pipeline",
				outcomeEvidence: {
					source: "gitlab-pipeline",
					pipelineId: "100",
					observedAt: "2026-09-03T00:02:00.000Z",
				},
			},
		});
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
		expect(firstResult.checkpoint?.projectId).toBe("42");

		const resumed = dependencies([mr({ iid: 8, updatedAt: "2026-09-04T00:00:00.000Z" })]);
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", checkpoint: firstResult.checkpoint, maxPages: 1 },
			resumed.dependencies,
		);
		expect(resumed.pages[0]).toMatchObject({
			repository: "aws-lz-account-creator",
			updatedAfter: firstResult.checkpoint?.updatedAfter,
			page: 1,
		});
	});

	test("advances the completed project watermark to the latest observed update", async () => {
		const fixture = dependencies([mr({ updatedAt: "2026-09-04T00:00:00.000Z" })]);
		const result = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			fixture.dependencies,
		);
		expect(result.checkpoint?.projectId).toBe("42");
	});

	test("persists the completed project checkpoint for scheduled reconciliation", async () => {
		const fixture = dependencies([mr({ updatedAt: "2026-09-04T00:00:00.000Z" })]);
		const checkpoints: unknown[] = [];
		const recoveryStarts: unknown[] = [];
		const persisted = fixture.dependencies as LandingZoneImportDependencies;
		persisted.recordCheckpoint = async (_store, checkpoint) => {
			checkpoints.push(checkpoint);
		};
		persisted.recordRecoveryStart = async (repository, checkpoint) => {
			recoveryStarts.push({ repository, checkpoint });
		};
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			persisted,
		);
		expect(checkpoints).toEqual([
			expect.objectContaining({
				projectId: "42",
				updatedAfter: expect.any(String),
				backfillStartAt: "2026-09-01T00:00:00.000Z",
				repositoryPath: PROJECT.path,
			}),
		]);
		expect(recoveryStarts).toEqual([
			{
				repository: "aws-lz-account-creator",
				checkpoint: expect.objectContaining({
					projectId: "42",
					backfillStartAt: "2026-09-01T00:00:00.000Z",
					repositoryPath: PROJECT.path,
				}),
			},
		]);
	});

	test("does not advance the graph checkpoint when the durable recovery anchor fails", async () => {
		const fixture = dependencies([mr({ updatedAt: "2026-09-04T00:00:00.000Z" })]);
		const checkpoints: unknown[] = [];
		const persisted: LandingZoneImportDependencies = {
			...fixture.dependencies,
			recordCheckpoint: async (_store, checkpoint) => {
				checkpoints.push(checkpoint);
			},
			recordRecoveryStart: async () => {
				throw new Error("Landing Zone GitLab recovery anchor was not persisted");
			},
		};

		await expect(
			importLandingZoneGitLabHistory(
				{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
				persisted,
			),
		).rejects.toThrow("recovery anchor was not persisted");
		expect(checkpoints).toEqual([]);
	});

	test("records an older recovery boundary even when a later anchor already exists", () => {
		const anchor = (backfillStartAt: string) => ({
			text: "Landing Zone GitLab import recovery anchor",
			annotations: { backfill_start_at: backfillStartAt },
		});
		expect(recoveryAnchorNeedsWrite([anchor("2026-09-10T00:00:00.000Z")], "2026-09-01T00:00:00.000Z")).toBe(true);
		expect(recoveryAnchorNeedsWrite([anchor("2026-08-01T00:00:00.000Z")], "2026-09-01T00:00:00.000Z")).toBe(false);
	});

	test("persists a reset checkpoint when GitLab's fixed-window total changes", async () => {
		const fixture = dependencies();
		const checkpoints: unknown[] = [];
		const persisted: LandingZoneImportDependencies = {
			...fixture.dependencies,
			listMergeRequests: async () => ({ project: PROJECT, mergeRequests: [], total: 3 }),
			recordCheckpoint: async (_store, checkpoint) => {
				checkpoints.push(checkpoint);
			},
		};

		const result = await importLandingZoneGitLabHistory(
			{
				repository: "aws-lz-account-creator",
				checkpoint: {
					projectId: "42",
					updatedAfter: "2026-09-01T00:00:00.000Z",
					inProgress: {
						upperBound: "2026-09-04T00:00:00.000Z",
						expectedTotal: 2,
						nextPage: 2,
						seenMrIds: ["42:7", "42:8"],
					},
				},
			},
			persisted,
		);

		expect(result.checkpoint?.inProgress).toMatchObject({ expectedTotal: 3, nextPage: 1, seenMrIds: [] });
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]).toMatchObject({ inProgress: { expectedTotal: 3, nextPage: 1, seenMrIds: [] } });
	});

	test("rejects a later historical page from another GitLab project before writing its window", async () => {
		const writes: string[] = [];
		const checkpoints: unknown[] = [];
		const firstPage = { project: PROJECT, mergeRequests: [mr()], total: 2, nextPage: 2 };
		const secondPage = {
			project: { ...PROJECT, id: 99, path: "pvhcorp/dhco/aws/aws-landing-zone/other-project" },
			mergeRequests: [mr({ iid: 8, mergeCommitSha: "commit-8" })],
			total: 2,
		};
		const dependencies: LandingZoneImportDependencies = {
			listMergeRequests: async ({ page }) => {
				if (page === 1) return firstPage;
				if (page === 2) return secondPage;
				throw new Error(`Unexpected historical page ${page}`);
			},
			listPipelines: async () => ({ pipelines: [] }),
			recordCheckpoint: async (_store, checkpoint) => {
				checkpoints.push(checkpoint);
			},
			writers: {
				recordRepository: async () => {
					writes.push("repository");
				},
				recordChange: async () => {
					writes.push("change");
				},
				recordPipeline: async () => {
					writes.push("pipeline");
				},
				recordPlan: async () => {
					writes.push("plan");
				},
			},
			store: {} as never,
		};

		let failure: unknown;
		try {
			await importLandingZoneGitLabHistory(
				{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 2 },
				dependencies,
			);
		} catch (error) {
			failure = error;
		}

		expect(failure).toMatchObject({ message: "Historical MR page project 99 does not match GitLab project 42" });
		expect(writes).toEqual([]);
		expect(checkpoints).toEqual([]);
	});

	test("carries bounded GitLab provenance into every imported graph record", async () => {
		const recorded: Array<Record<string, unknown>> = [];
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			{
				listMergeRequests: async () => ({
					project: PROJECT,
					total: 1,
					mergeRequests: [mr()],
					provenance: { source: "gitlab" as const, retrievedAt: "2026-09-04T10:00:00.000Z", truncated: true },
				}),
				listPipelines: async () => ({
					pipelines: [
						pipeline({
							planJobs: [{ id: 991, status: "success", webUrl: "https://gitlab.example/jobs/991" }],
						}),
					],
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
						source: "gitlab-pipeline",
						lastSyncedAt: "2026-09-04T10:01:00.000Z",
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

	test("scheduled reconciliation revisits the durable pending queue", async () => {
		const fixture = dependencies([], []);
		const directReads: number[] = [];
		const scheduled: LandingZoneImportDependencies = {
			...fixture.dependencies,
			listRepositories: async () => [{ name: "aws-lz-account-creator", availability: "active" }],
			readCheckpoint: async () => ({
				projectId: "42",
				updatedAfter: "2026-09-01T00:00:00.000Z",
				pendingMrIids: [7],
				pendingCursor: 0,
			}),
			readMergeRequest: async ({ iid }) => {
				directReads.push(iid);
				return {
					project: PROJECT,
					mergeRequest: mr({ state: "opened", mergeCommitSha: undefined, commitSha: "head-7" }),
				};
			},
		};

		await runLandingZoneGitLabImportSweep(undefined, scheduled);
		expect(directReads).toEqual([7]);
	});

	test("continues scheduled reconciliation after one repository fails", async () => {
		const fixture = dependencies([mr()]);
		const scheduled: LandingZoneImportDependencies = {
			...fixture.dependencies,
			listRepositories: async () => [
				{ name: "aws-lz-ami", availability: "active" },
				{ name: "aws-lz-account-creator", availability: "active" },
			],
			readCheckpoint: async () => ({ projectId: "42", updatedAfter: "2026-09-01T00:00:00.000Z" }),
			listMergeRequests: async ({ repository }) => {
				if (repository === "aws-lz-ami") throw new Error("GitLab unavailable");
				return { project: PROJECT, mergeRequests: [mr()], total: 1 };
			},
		};

		const result = await runLandingZoneGitLabImportSweep(undefined, scheduled);
		expect(result.outcomes).toEqual(["merged-unverified"]);
		expect(result.projectErrors).toEqual([{ repository: "aws-lz-ami", message: "GitLab unavailable" }]);
	});

	test("halts the catalog sweep after an authentication rejection", async () => {
		const previousToken = process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
		process.env.GITLAB_PERSONAL_ACCESS_TOKEN = "rejected-token";
		const fixture = dependencies([mr()]);
		const visited: string[] = [];
		const scheduled: LandingZoneImportDependencies = {
			...fixture.dependencies,
			listRepositories: async () => [
				{ name: "aws-lz-ami", availability: "active" },
				{ name: "aws-lz-account-creator", availability: "active" },
			],
			readCheckpoint: async () => ({ projectId: "42", updatedAfter: "2026-09-01T00:00:00.000Z" }),
			listMergeRequests: async ({ repository }) => {
				visited.push(repository);
				throw new Error("GitLab read failed with HTTP 401");
			},
		};

		try {
			const result = await runLandingZoneGitLabImportSweep(undefined, scheduled);
			expect(visited).toEqual(["aws-lz-ami"]);
			expect(result.projectErrors).toEqual([{ repository: "aws-lz-ami", message: "GitLab read failed with HTTP 401" }]);
			expect(result.authBackoff).toBe(true);

			await expect(runLandingZoneGitLabImportSweep(undefined, scheduled)).resolves.toEqual({
				outcomes: [],
				authBackoff: true,
			});
			expect(visited).toEqual(["aws-lz-ami"]);

			process.env.GITLAB_PERSONAL_ACCESS_TOKEN = "rotated-token";
			await runLandingZoneGitLabImportSweep(undefined, scheduled);
			expect(visited).toEqual(["aws-lz-ami", "aws-lz-ami"]);
		} finally {
			if (previousToken === undefined) delete process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
			else process.env.GITLAB_PERSONAL_ACCESS_TOKEN = previousToken;
		}
	});

	test("isolates a checkpoint read failure and continues with later repositories", async () => {
		const fixture = dependencies([mr()]);
		const scheduled: LandingZoneImportDependencies = {
			...fixture.dependencies,
			listRepositories: async () => [
				{ name: "aws-lz-ami", availability: "active" },
				{ name: "aws-lz-account-creator", availability: "active" },
			],
			readCheckpoint: async (_store, repository) => {
				if (repository === "aws-lz-ami") throw new Error("Malformed checkpoint state");
				return { projectId: "42", updatedAfter: "2026-09-01T00:00:00.000Z" };
			},
		};

		const result = await runLandingZoneGitLabImportSweep(undefined, scheduled);
		expect(result.outcomes).toEqual(["merged-unverified"]);
		expect(result.projectErrors).toEqual([{ repository: "aws-lz-ami", message: "Malformed checkpoint state" }]);
	});

	test("keeps replay writes idempotent through stable GitLab entity keys", async () => {
		const fixture = dependencies(
			[mr()],
			[pipeline({ planJobs: [{ id: 991, status: "success", webUrl: "https://gitlab.example/jobs/991" }] })],
		);
		const options = { repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 };
		await importLandingZoneGitLabHistory(options, fixture.dependencies);
		await importLandingZoneGitLabHistory(options, fixture.dependencies);

		const changes = fixture.recorded.filter((entry) => entry.type === "change");
		expect(changes.map((entry) => (entry.value as { id: string }).id)).toEqual(["gitlab:42:7", "gitlab:42:7"]);
	});

	test("uses one logical change identity when an MR advances from open to merged", async () => {
		const fixture = dependencies([mr({ state: "opened", mergeCommitSha: undefined, commitSha: "head-7" })], []);
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			fixture.dependencies,
		);
		const merged = dependencies([mr({ mergeCommitSha: "merge-7" })], []);
		merged.dependencies.writers = fixture.dependencies.writers;
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			merged.dependencies,
		);

		const changes = fixture.recorded.filter((entry) => entry.type === "change");
		expect(changes.map((entry) => (entry.value as { id: string }).id)).toEqual(["gitlab:42:7", "gitlab:42:7"]);
		expect(changes.map((entry) => (entry.value as { commitSha?: string }).commitSha)).toEqual(["head-7", "merge-7"]);
	});

	test("stores the Terraform plan job status instead of the overall pipeline status", async () => {
		const fixture = dependencies(
			[mr()],
			[
				pipeline({
					status: "failed",
					planJobs: [{ id: 991, status: "success", webUrl: "https://gitlab.example/jobs/991" }],
				}),
			],
		);
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			fixture.dependencies,
		);

		expect(fixture.recorded.find((entry) => entry.type === "plan")).toMatchObject({
			value: { plan: { id: "gitlab:plan-job:991", status: "success" } },
		});
	});

	test.each([
		["proposed", mr({ state: "opened", mergeCommitSha: undefined, commitSha: "head-7" })],
		["pipeline-failed", mr()],
		["merged-unverified", mr()],
	] as const)("reconciles unchanged %s pending evidence to applied", async (initialOutcome, initialMr) => {
		const initialPipelines = initialOutcome === "pipeline-failed" ? [pipeline({ status: "failed" })] : [];
		const first = dependencies([initialMr], initialPipelines);
		const seeded = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			first.dependencies,
		);
		expect(seeded.outcomes).toEqual([initialOutcome]);
		expect(seeded.checkpoint?.pendingMrIids).toEqual([7]);

		const reconciled = dependencies([], []);
		reconciled.dependencies.writers = first.dependencies.writers;
		const directReads: number[] = [];
		const result = await importLandingZoneGitLabHistory(
			{
				repository: "aws-lz-account-creator",
				checkpoint: seeded.checkpoint,
				maxPages: 1,
				reconcilePending: true,
			},
			{
				...reconciled.dependencies,
				readMergeRequest: async ({ iid }) => {
					directReads.push(iid);
					return { project: PROJECT, mergeRequest: mr({ updatedAt: initialMr.updatedAt }) };
				},
				listDeployments: async () => ({
					deployments: [{ sha: "commit-7", status: "success", updatedAt: "2026-09-04T00:00:00.000Z" }],
				}),
			},
		);

		expect(directReads).toEqual([7]);
		expect(result.outcomes).toContain("applied");
		expect(result.checkpoint?.pendingMrIids).toEqual([]);
		const changes = first.recorded.filter((entry) => entry.type === "change");
		expect(changes.at(-1)).toMatchObject({ value: { id: "gitlab:42:7", outcome: "applied" } });
	});

	test("persists a per-MR deployment cursor until an exact SHA beyond sixty newer deployments is found", async () => {
		const deploymentCalls: Array<{ page?: number; updatedBefore?: string }> = [];
		let checkpoint: LandingZoneImportCheckpoint = {
			projectId: "42",
			updatedAfter: "2026-09-01T00:00:00.000Z",
			pendingMrIids: [7],
			pendingCursor: 0,
		};
		for (let run = 0; run < 2; run++) {
			const fixture = dependencies([], []);
			const result = await importLandingZoneGitLabHistory(
				{
					repository: "aws-lz-account-creator",
					checkpoint,
					reconcilePending: true,
					maxPages: 1,
				},
				{
					...fixture.dependencies,
					readMergeRequest: async () => ({ project: PROJECT, mergeRequest: mr() }),
					listDeployments: async ({ page = 1, updatedBefore }) => {
						deploymentCalls.push({ page, updatedBefore });
						if (page === 1) {
							return {
								deployments: [],
								nextPage: 4,
								provenance: {
									source: "gitlab" as const,
									retrievedAt: "2026-09-04T00:00:00.000Z",
									truncated: true,
								},
							};
						}
						return {
							deployments: [{ sha: "commit-7", status: "success", updatedAt: "2026-09-05T00:00:00.000Z" }],
							provenance: {
								source: "gitlab" as const,
								retrievedAt: "2026-09-05T00:01:00.000Z",
								truncated: false,
							},
						};
					},
				},
			);
			if (run === 0) {
				expect(result.outcomes).toContain("merged-unverified");
				expect(result.checkpoint?.pendingDeploymentScans?.["7"]).toMatchObject({
					sha: "commit-7",
					nextPage: 4,
				});
			}
			checkpoint = result.checkpoint as LandingZoneImportCheckpoint;
		}

		expect(deploymentCalls.map(({ page }) => page)).toEqual([1, 4]);
		expect(deploymentCalls[0]?.updatedBefore).toBeString();
		expect(deploymentCalls[1]?.updatedBefore).toBe(deploymentCalls[0]?.updatedBefore);
		expect(checkpoint.pendingMrIids).toEqual([]);
	});

	test("resets a persisted deployment scan when the MR commit SHA changes", async () => {
		const calls: Array<{ commitSha: string; page?: number; updatedBefore?: string }> = [];
		const fixture = dependencies([], []);
		const result = await importLandingZoneGitLabHistory(
			{
				repository: "aws-lz-account-creator",
				checkpoint: {
					projectId: "42",
					updatedAfter: "2026-09-01T00:00:00.000Z",
					pendingMrIids: [7],
					pendingDeploymentScans: {
						"7": { sha: "head-7", nextPage: 4, updatedBefore: "2026-09-03T00:00:00.000Z" },
					},
				},
				reconcilePending: true,
				maxPages: 1,
			},
			{
				...fixture.dependencies,
				readMergeRequest: async () => ({ project: PROJECT, mergeRequest: mr({ mergeCommitSha: "merge-7" }) }),
				listDeployments: async (input) => {
					calls.push(input);
					return { deployments: [], nextPage: 2 };
				},
			},
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ commitSha: "merge-7", page: 1 });
		const updatedBefore = calls[0]?.updatedBefore;
		expect(updatedBefore).toBeString();
		if (!updatedBefore) throw new Error("expected a fixed deployment boundary");
		expect(updatedBefore).not.toBe("2026-09-03T00:00:00.000Z");
		expect(result.checkpoint?.pendingDeploymentScans?.["7"]).toEqual({
			sha: "merge-7",
			nextPage: 2,
			updatedBefore,
		});
	});

	test("refreshes an exhausted deployment snapshot so a later deployment is found", async () => {
		const boundaries: string[] = [];
		let checkpoint: LandingZoneImportCheckpoint = {
			projectId: "42",
			updatedAfter: "2026-09-01T00:00:00.000Z",
			pendingMrIids: [7],
			pendingDeploymentScans: {
				"7": { sha: "commit-7", nextPage: 4, updatedBefore: "2026-09-03T00:00:00.000Z" },
			},
		};
		for (let run = 0; run < 2; run++) {
			const fixture = dependencies([], []);
			const result = await importLandingZoneGitLabHistory(
				{ repository: "aws-lz-account-creator", checkpoint, reconcilePending: true, maxPages: 1 },
				{
					...fixture.dependencies,
					readMergeRequest: async () => ({ project: PROJECT, mergeRequest: mr() }),
					listDeployments: async ({ updatedBefore }) => {
						if (!updatedBefore) throw new Error("missing fixed deployment boundary");
						boundaries.push(updatedBefore);
						return run === 0
							? { deployments: [] }
							: {
									deployments: [{ sha: "commit-7", status: "success", updatedAt: "2026-09-04T00:00:00.000Z" }],
								};
					},
				},
			);
			checkpoint = result.checkpoint as LandingZoneImportCheckpoint;
			if (run === 0) {
				expect(checkpoint.pendingDeploymentScans?.["7"]?.nextPage).toBe(1);
				expect(checkpoint.pendingDeploymentScans?.["7"]?.updatedBefore).not.toBe(boundaries[0]);
			}
		}

		expect(boundaries[1]).not.toBe(boundaries[0]);
		expect(checkpoint.pendingMrIids).toEqual([]);
	});

	test("persists pending reconciliation state while history pagination remains in progress", async () => {
		const fixture = dependencies([mr({ state: "opened", mergeCommitSha: undefined, commitSha: "head-7" })], [], {
			nextPage: 2,
		});
		const result = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			fixture.dependencies,
		);

		expect(result.checkpoint).toMatchObject({
			pendingMrIids: [7],
			inProgress: { nextPage: 2 },
		});
		const resumed = dependencies([], []);
		const completed = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", checkpoint: result.checkpoint, maxPages: 1 },
			{
				...resumed.dependencies,
				listMergeRequests: async () => ({ project: PROJECT, mergeRequests: [], total: 1 }),
			},
		);
		expect(completed.checkpoint?.pendingMrIids).toEqual([7]);
		expect(completed.checkpoint?.inProgress).toBeUndefined();
	});

	test("rotates fairly through a capped pending queue", async () => {
		const visited: number[] = [];
		let checkpoint = {
			projectId: "42",
			updatedAfter: "2026-09-01T00:00:00.000Z",
			pendingMrIids: [1, 2, 3],
			pendingCursor: 0,
		};
		for (let run = 0; run < 2; run++) {
			const fixture = dependencies([], []);
			const result = await importLandingZoneGitLabHistory(
				{
					repository: "aws-lz-account-creator",
					checkpoint,
					maxPages: 1,
					maxPendingReconciliations: 1,
					reconcilePending: true,
				},
				{
					...fixture.dependencies,
					readMergeRequest: async ({ iid }) => {
						visited.push(iid);
						return {
							project: PROJECT,
							mergeRequest: mr({ iid, state: "opened", mergeCommitSha: undefined, commitSha: `head-${iid}` }),
						};
					},
				},
			);
			checkpoint = result.checkpoint as typeof checkpoint;
		}

		expect(visited).toEqual([1, 2]);
	});

	test("fails closed when the durable pending queue exceeds its explicit safety bound", async () => {
		const fixture = dependencies([], []);
		await expect(
			importLandingZoneGitLabHistory(
				{
					repository: "aws-lz-account-creator",
					checkpoint: {
						projectId: "42",
						updatedAfter: "2026-09-01T00:00:00.000Z",
						pendingMrIids: Array.from({ length: MAX_PENDING_MERGE_REQUESTS + 1 }, (_, index) => index + 1),
					},
				},
				fixture.dependencies,
			),
		).rejects.toThrow("Invalid bounded pending merge request queue");
	});

	test("bisects a fixed window when GitLab omits the exact total and resumes the child window", async () => {
		const checkpoints: unknown[] = [];
		const fixture = dependencies([], []);
		const split = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			{
				...fixture.dependencies,
				listMergeRequests: async () => ({ project: PROJECT, mergeRequests: [] }),
				recordCheckpoint: async (_store, checkpoint) => {
					checkpoints.push(checkpoint);
				},
			},
		);
		const childUpperBound = split.checkpoint?.inProgress?.upperBound;
		if (!childUpperBound) throw new Error("Expected a persisted split-window upper bound");
		expect(Date.parse(childUpperBound)).toBeGreaterThan(Date.parse("2026-09-01T00:00:00.000Z"));

		const exact = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", checkpoint: split.checkpoint, maxPages: 1 },
			{
				...fixture.dependencies,
				listMergeRequests: async () => ({
					project: PROJECT,
					mergeRequests: [
						mr({ state: "opened", mergeCommitSha: undefined, commitSha: "boundary-sha", updatedAt: childUpperBound }),
					],
					total: 1,
				}),
			},
		);
		expect(exact.checkpoint?.inProgress).toBeUndefined();
		expect(Date.parse(exact.checkpoint?.updatedAfter ?? "")).toBe(Date.parse(childUpperBound) - 1);
		expect(exact.checkpoint?.pendingMrIids).toEqual([7]);
		expect(exact.outcomes).toEqual(["proposed"]);
		expect(checkpoints).toHaveLength(1);
	});

	test("records the GitLab repository before persisting a missing-total split checkpoint", async () => {
		let repositoryExists = false;
		const fixture = dependencies([], []);
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			{
				...fixture.dependencies,
				listMergeRequests: async () => ({ project: PROJECT, mergeRequests: [] }),
				recordCheckpoint: async () => {
					if (!repositoryExists) throw new Error("checkpoint repository does not exist");
				},
				writers: {
					...fixture.dependencies.writers,
					recordRepository: async () => {
						repositoryExists = true;
					},
				},
			},
		);

		expect(repositoryExists).toBe(true);
	});

	test("fails closed when an exact total is unavailable at one-millisecond resolution", async () => {
		const fixture = dependencies([], []);
		await expect(
			importLandingZoneGitLabHistory(
				{
					repository: "aws-lz-account-creator",
					checkpoint: {
						projectId: "42",
						updatedAfter: "2026-09-01T00:00:00.000Z",
						inProgress: { upperBound: "2026-09-01T00:00:00.001Z", nextPage: 1, seenMrIds: [] },
					},
				},
				{ ...fixture.dependencies, listMergeRequests: async () => ({ project: PROJECT, mergeRequests: [] }) },
			),
		).rejects.toThrow("single timestamp");
	});
});

describe("Landing Zone GitLab importer readiness", () => {
	test("requires graph availability and every importer read tool", () => {
		expect(landingZoneGitLabImportEnabled(true, LANDING_ZONE_GITLAB_IMPORT_REQUIRED_TOOLS.slice(0, -1))).toBe(false);
		expect(landingZoneGitLabImportEnabled(false, LANDING_ZONE_GITLAB_IMPORT_REQUIRED_TOOLS)).toBe(false);
		expect(landingZoneGitLabImportEnabled(true, LANDING_ZONE_GITLAB_IMPORT_REQUIRED_TOOLS)).toBe(true);
		expect(LANDING_ZONE_GITLAB_IMPORT_REQUIRED_TOOLS).toContain("lz_read_merge_request");
	});

	test("reports explicit unavailability when the runtime tool set is not ready", async () => {
		await expect(runLandingZoneGitLabImportSweep()).resolves.toEqual({
			outcomes: [],
			unavailable: "Landing Zone graph or required GitLab read tools are unavailable",
		});
	});
});
