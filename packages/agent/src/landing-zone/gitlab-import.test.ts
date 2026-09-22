// packages/agent/src/landing-zone/gitlab-import.test.ts

import { describe, expect, test } from "bun:test";
import { importLandingZoneGitLabHistory } from "./gitlab-import.ts";

const PROJECT = {
	id: 42,
	path: "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator",
	defaultBranch: "main",
	headSha: "head-sha",
};

function mr(overrides: Partial<{
	iid: number;
	title: string;
	state: "opened" | "closed" | "merged";
	webUrl: string;
	createdAt: string;
	updatedAt: string;
	mergeCommitSha: string;
	verifiedLiveState: boolean;
}> = {}) {
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

function pipeline(overrides: Partial<{
	id: number;
	status: string;
	webUrl: string;
	createdAt: string;
	updatedAt: string;
	hasTerraformPlan: boolean;
	isVerifiedDeployment: boolean;
}> = {}) {
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
		const first = dependencies([mr()], [pipeline()], { nextPage: 2 });
		const firstResult = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			first.dependencies,
		);
		expect(firstResult.checkpoint).toEqual({ projectId: "42", updatedAfter: "2026-09-01T00:00:00.000Z", page: 2 });

		const resumed = dependencies([mr({ iid: 8, updatedAt: "2026-09-04T00:00:00.000Z" })]);
		await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", checkpoint: firstResult.checkpoint, maxPages: 1 },
			resumed.dependencies,
		);
		expect(resumed.pages).toEqual([
			{ repository: "aws-lz-account-creator", updatedAfter: "2026-09-01T00:00:00.000Z", page: 2 },
		]);
	});

	test("advances the completed project watermark to the latest observed update", async () => {
		const fixture = dependencies([mr({ updatedAt: "2026-09-04T00:00:00.000Z" })]);
		const result = await importLandingZoneGitLabHistory(
			{ repository: "aws-lz-account-creator", startAt: "2026-09-01T00:00:00.000Z", maxPages: 1 },
			fixture.dependencies,
		);
		expect(result.checkpoint).toEqual({ projectId: "42", updatedAfter: "2026-09-04T00:00:00.000Z", page: 1 });
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
