import { describe, expect, test } from "bun:test";
import {
	findRepresentativeExamples,
	listHistoricalMergeRequests,
	listMergeRequestPipelines,
	listProjectDeployments,
	readMergeRequest,
	readPipelinePlan,
} from "./evidence.ts";
import type { GitLabReadClient } from "./repositories.ts";

function fakeClient(): GitLabReadClient {
	return {
		async project() {
			return {
				id: 42,
				path: "pvhcorp/dhco/aws/aws-lz-renamed/account-creator",
				defaultBranch: "main",
				headSha: "abc123",
				lastActivityAt: "2026-09-22T08:00:00Z",
			};
		},
		async tree() {
			return {
				entries: [
					...Array.from({ length: 6 }, (_, index) => ({
						path: `accounts/app-${index + 1}.yml`,
						type: "blob" as const,
					})),
					{ path: "schemas/account.schema.json", type: "blob" as const },
					{ path: "scripts/generate_tf.py", type: "blob" as const },
					{ path: "tests/account.test.ts", type: "blob" as const },
				],
				truncated: false,
			};
		},
		async readFile(_projectPath, path) {
			return { content: `content:${path}`, blobId: `blob:${path}`, size: path.length };
		},
		async openChanges() {
			return [{ iid: 7, title: "Account schema work", webUrl: "https://gitlab.example/mr/7", updatedAt: "2026-09-22" }];
		},
		async changePaths() {
			return ["accounts/app-2.yml"];
		},
		async pipelineJobs() {
			return {
				jobs: [
					{ id: 10, name: "validate", status: "success", webUrl: "https://gitlab.example/jobs/10" },
					{ id: 11, name: "terraform-plan", status: "success", webUrl: "https://gitlab.example/jobs/11" },
				],
			};
		},
		async jobTrace() {
			return "Plan: 2 to add, 0 to change, 0 to destroy.";
		},
		async historicalMergeRequests() {
			return { mergeRequests: [], total: 0 };
		},
		async mergeRequestPipelines() {
			return { pipelines: [] };
		},
		async mergeRequest() {
			return {
				iid: 7,
				title: "Add account",
				state: "opened",
				webUrl: "https://gitlab.example/mr/7",
				createdAt: "2026-09-02T00:00:00.000Z",
				updatedAt: "2026-09-03T00:00:00.000Z",
				commitSha: "head-7",
			};
		},
	};
}

describe("representative evidence", () => {
	test("returns a direct MR with live project provenance", async () => {
		const result = await readMergeRequest(fakeClient(), { repository: "aws-lz-account-creator", iid: 7 });

		expect(result).toMatchObject({
			project: { id: 42, path: "pvhcorp/dhco/aws/aws-lz-renamed/account-creator" },
			mergeRequest: { iid: 7, state: "opened", commitSha: "head-7" },
			provenance: { source: "gitlab", projectPath: "pvhcorp/dhco/aws/aws-lz-renamed/account-creator" },
		});
	});
	test("filters bounded successful deployment evidence to the exact commit SHA", async () => {
		const client = fakeClient();
		client.projectDeployments = async () => ({
			deployments: [
				{ sha: "other-sha", status: "success" },
				{ sha: "merge-sha", status: "success", pipelineId: 99 },
			],
		});
		const result = await listProjectDeployments(client, {
			repository: "aws-lz-account-creator",
			commitSha: "merge-sha",
		});
		expect(result.deployments).toEqual([{ sha: "merge-sha", status: "success", pipelineId: 99 }]);
	});
	test("returns schema, generator, test, five active examples, and relevant open work", async () => {
		const evidence = await findRepresentativeExamples(fakeClient(), {
			repository: "aws-lz-account-creator",
			path: "accounts",
		});

		expect(evidence.examples).toHaveLength(5);
		expect(evidence.contracts.map((item) => item.kind).sort()).toEqual(["generator", "schema", "test"]);
		expect(evidence.openChanges).toHaveLength(1);
		expect(evidence.provenance.untrustedContent).toBe(true);
		expect(evidence.provenance.ref).toBe("abc123");
	});

	test("returns only plan jobs and bounded trace evidence", async () => {
		const result = await readPipelinePlan(fakeClient(), {
			repository: "aws-lz-account-creator",
			pipelineId: 99,
		});

		expect(result.jobs).toHaveLength(1);
		expect(result.jobs[0]?.name).toBe("terraform-plan");
		expect(result.jobs[0]?.trace).toContain("0 to destroy");
	});

	test("marks capped repository trees as truncated instead of treating them as complete", async () => {
		const client = fakeClient();
		client.tree = async () => ({
			entries: [
				{ path: "accounts/app-1.yml", type: "blob" },
				{ path: "accounts/app-2.yml", type: "blob" },
				{ path: "accounts/app-3.yml", type: "blob" },
			],
			truncated: true,
		});

		const result = await findRepresentativeExamples(client, {
			repository: "aws-lz-account-creator",
			path: "accounts",
		});

		expect(result.provenance.truncated).toBe(true);
		expect(result.warnings).toContain("Repository tree evidence was truncated at 500 entries");
	});

	test("returns one validated historical page with a resumable GitLab page number", async () => {
		const client = fakeClient();
		const calls: unknown[][] = [];
		client.historicalMergeRequests = async (...args) => {
			calls.push(args);
			return {
				mergeRequests: [
					{
						iid: 7,
						title: "Account update",
						state: "merged",
						webUrl: "https://gitlab.example/mr/7",
						createdAt: "2026-09-02T00:00:00.000Z",
						updatedAt: "2026-09-03T00:00:00.000Z",
						commitSha: "abc123",
					},
				],
				total: 1,
				nextPage: 3,
			};
		};

		const result = await listHistoricalMergeRequests(client, {
			repository: "aws-lz-account-creator",
			updatedAfter: "2026-09-01T00:00:00.000Z",
			page: 2,
			perPage: 10,
		});

		expect(calls).toEqual([
			["pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator", "2026-09-01T00:00:00.000Z", undefined, 2, 10],
		]);
		expect(result).toMatchObject({
			project: { id: 42, path: "pvhcorp/dhco/aws/aws-lz-renamed/account-creator" },
			nextPage: 3,
			mergeRequests: [{ commitSha: "abc123" }],
		});
	});

	test("exposes deployment and plan signals without persisting plan content", async () => {
		const client = fakeClient();
		client.mergeRequestPipelines = async (_project, _iid, page) => ({
			pipelines: [
				{
					id: 99,
					status: "success",
					webUrl: "https://gitlab.example/pipelines/99",
					createdAt: "2026-09-03T00:00:00.000Z",
					updatedAt: "2026-09-03T00:01:00.000Z",
				},
			],
			...(page === 1 && { nextPage: 2 }),
		});
		client.pipelineJobs = async (_project, pipelineId, page) => ({
			jobs: [
				{
					id: pipelineId * 10 + page,
					name: page === 1 ? "validate" : "terraform-plan",
					status: "success",
					webUrl: `https://gitlab.example/jobs/${pipelineId * 10 + page}`,
				},
			],
			...(page === 1 && { nextPage: 2 }),
		});

		const result = await listMergeRequestPipelines(client, { repository: "aws-lz-account-creator", iid: 7 });
		expect(result.pipelines).toHaveLength(2);
		expect(result.pipelines[0]).toMatchObject({ id: 99, planJobs: [{ id: 992, status: "success" }] });
		expect(JSON.stringify(result)).not.toContain("Plan: 2 to add");
	});

	test("marks pipeline and job evidence truncated when either page cap is reached", async () => {
		const client = fakeClient();
		client.mergeRequestPipelines = async (_project, _iid, page) => ({
			pipelines: [
				{
					id: page,
					status: "success",
					webUrl: `https://gitlab.example/pipelines/${page}`,
					createdAt: "2026-09-03T00:00:00.000Z",
					updatedAt: "2026-09-03T00:01:00.000Z",
				},
			],
			nextPage: page + 1,
		});
		client.pipelineJobs = async (_project, _pipeline, page) => ({
			jobs: [{ id: page, name: "terraform-plan", status: "success", webUrl: `https://gitlab.example/jobs/${page}` }],
			nextPage: page + 1,
		});
		const result = await listMergeRequestPipelines(client, { repository: "aws-lz-account-creator", iid: 7 });
		expect(result.pipelines).toHaveLength(3);
		expect(result.pipelines[0]?.planJobs).toHaveLength(3);
		expect(result.provenance.truncated).toBe(true);
	});
});
