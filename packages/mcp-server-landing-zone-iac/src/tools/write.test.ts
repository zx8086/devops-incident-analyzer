import { describe, expect, test } from "bun:test";
import type { Config } from "../config.ts";
import {
	commitAllowedFiles,
	createAllowedBranch,
	createGitLabWriteClient,
	type GitLabWriteClient,
	openAllowedMergeRequest,
} from "./write.ts";

const repository = "aws-lz-account-creator";
const projectPath = "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator";
const baseSha = "a".repeat(40);
const branchSha = "b".repeat(40);
const fileSha = "d".repeat(40);
const fileCommitSha = "e".repeat(40);
const reviewToken = "approved-review-token";

const policy: Config["write"] = {
	enabled: true,
	token: "write-token",
	reviewToken,
	allowedProjects: [projectPath],
	allowedPathPrefixes: { [projectPath]: ["accounts/"] },
	backendProjects: [],
};

function client(overrides: Partial<GitLabWriteClient> = {}): GitLabWriteClient {
	return {
		project: async () => ({
			id: 42,
			path: projectPath,
			defaultBranch: "main",
			headSha: baseSha,
			lastActivityAt: "2026-09-23T00:00:00.000Z",
		}),
		branch: async (_path, name) =>
			name === "main"
				? { name, sha: baseSha, webUrl: "https://gitlab.example/main" }
				: name === "agent/landing-zone/change"
					? { name, sha: branchSha, webUrl: "https://gitlab.example/change" }
					: undefined,
		file: async () => undefined,
		createBranch: async (_path, name, sha) => ({
			name,
			sha,
			webUrl: `https://gitlab.example/${name}`,
		}),
		commit: async () => ({ sha: branchSha, webUrl: `https://gitlab.example/commit/${branchSha}` }),
		openMergeRequest: async () => ({ iid: 7, webUrl: "https://gitlab.example/merge_requests/7" }),
		...overrides,
	};
}

const common = {
	repository,
	projectId: 42,
	baseBranch: "main",
	baseSha,
	targetBranch: "agent/landing-zone/change",
	changeSummary: "Add the reviewed account request",
	reviewToken,
};

describe("Landing Zone write guards", () => {
	test("rejects non-allowlisted repositories, default-branch targets, stale bases, and invalid review tokens", async () => {
		await expect(createAllowedBranch(client(), { ...policy, allowedProjects: [] }, common)).rejects.toThrow(
			"not write-allowlisted",
		);
		await expect(createAllowedBranch(client(), policy, { ...common, targetBranch: "main" })).rejects.toThrow(
			"default branch",
		);
		await expect(createAllowedBranch(client(), policy, { ...common, baseSha: "c".repeat(40) })).rejects.toThrow(
			"base SHA",
		);
		await expect(createAllowedBranch(client(), policy, { ...common, reviewToken: "wrong" })).rejects.toThrow(
			"review token",
		);
		await expect(
			createAllowedBranch(client(), policy, { ...common, targetBranch: "agent/landing-zone/../main" }),
		).rejects.toThrow("safe Git branch name");
	});

	test.each([
		["disallowed path", "modules/main.tf", "resource {}", false],
		["state file", "accounts/terraform.tfstate", "{}", false],
		["secret path", "accounts/prod.tfvars", 'password = "x"', false],
		["secret content", "accounts/prod.yml", "token: glpat-secret", false],
		["generated section", "accounts/prod.yml", "<!-- BEGIN_TF_DOCS -->", false],
		["backend outside scope", "accounts/backend.tf", 'terraform { backend "s3" {} }', true],
	] as const)("rejects %s", async (_label, path, content, backendChangeApproved) => {
		await expect(
			commitAllowedFiles(client(), policy, {
				...common,
				expectedBranchSha: branchSha,
				commitMessage: "feat: add reviewed request",
				backendChangeApproved,
				files: [{ path, content, expectedFileSha: null }],
			}),
		).rejects.toThrow();
	});

	test("rejects a stale expected file SHA instead of overwriting", async () => {
		await expect(
			commitAllowedFiles(client({ file: async () => ({ content: "old", blobId: "actual-sha", size: 3 }) }), policy, {
				...common,
				expectedBranchSha: branchSha,
				commitMessage: "feat: update account",
				backendChangeApproved: false,
				files: [{ path: "accounts/prod.yml", content: "application_name: prod", expectedFileSha: "f".repeat(40) }],
			}),
		).rejects.toThrow("file SHA");
	});
});

describe("Landing Zone governed GitOps writes", () => {
	test("maps per-file concurrency metadata to GitLab without exposing the read credential", async () => {
		let request: { url: string; init?: RequestInit } | undefined;
		const writeClient = createGitLabWriteClient({
			baseUrl: "https://gitlab.example",
			token: "dedicated-write-token",
			timeoutMs: 30_000,
			maxResponseBytes: 200_000,
			fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
				request = { url: String(url), init };
				return new Response(JSON.stringify({ id: "c".repeat(40), web_url: "https://gitlab.example/commit" }));
			}) as typeof fetch,
		});

		await writeClient.commit(projectPath, {
			branch: common.targetBranch,
			commitMessage: "feat: update reviewed account",
			actions: [
				{
					action: "update",
					filePath: "accounts/prod.yml",
					content: "application_name: prod",
					lastCommitId: fileCommitSha,
				},
			],
		});

		expect(request?.url).toEndWith("/repository/commits");
		expect(new Headers(request?.init?.headers).get("PRIVATE-TOKEN")).toBe("dedicated-write-token");
		expect(JSON.parse(String(request?.init?.body))).toMatchObject({
			branch: common.targetBranch,
			actions: [{ action: "update", file_path: "accounts/prod.yml", last_commit_id: fileCommitSha }],
		});
	});

	test("creates a branch from the exact verified base SHA", async () => {
		const calls: unknown[][] = [];
		const result = await createAllowedBranch(
			client({
				branch: async (_path, name) =>
					name === "main" ? { name, sha: baseSha, webUrl: "https://gitlab.example/main" } : undefined,
				createBranch: async (...args) => {
					calls.push(args);
					return { name: args[1], sha: args[2], webUrl: "https://gitlab.example/change" };
				},
			}),
			policy,
			common,
		);
		expect(calls).toEqual([[projectPath, common.targetBranch, baseSha]]);
		expect(result).toMatchObject({ projectPath, branch: common.targetBranch, sha: baseSha });
	});

	test("commits only guarded files with exact branch and file SHAs", async () => {
		let captured: unknown;
		const result = await commitAllowedFiles(
			client({
				file: async () => ({
					content: "application_name: old",
					blobId: fileSha,
					size: 21,
					lastCommitId: fileCommitSha,
				}),
				commit: async (_path, input) => {
					captured = input;
					return { sha: "c".repeat(40), webUrl: "https://gitlab.example/commit/new" };
				},
			}),
			policy,
			{
				...common,
				expectedBranchSha: branchSha,
				commitMessage: "feat: update reviewed account",
				backendChangeApproved: false,
				files: [
					{
						path: "accounts/prod.yml",
						content: "application_name: prod",
						expectedFileSha: fileSha,
					},
				],
			},
		);
		expect(captured).toEqual({
			branch: common.targetBranch,
			commitMessage: "feat: update reviewed account",
			actions: [
				{
					action: "update",
					filePath: "accounts/prod.yml",
					content: "application_name: prod",
					lastCommitId: fileCommitSha,
				},
			],
		});
		expect(result.sha).toBe("c".repeat(40));
	});

	test("opens a draft MR containing evidence, validations, risk, and expected plan without triggering apply", async () => {
		let captured: unknown;
		const result = await openAllowedMergeRequest(
			client({
				openMergeRequest: async (_path, input) => {
					captured = input;
					return { iid: 7, webUrl: "https://gitlab.example/merge_requests/7" };
				},
			}),
			policy,
			{
				...common,
				sourceSha: branchSha,
				title: "Add reviewed account request",
				evidence: ["accounts/schema.json at base SHA"],
				validationResults: ["generator validation passed"],
				riskSummary: "No destructive resources expected.",
				expectedPlanShape: "One account module addition; no replacement or deletion.",
			},
		);
		expect(captured).toMatchObject({
			sourceBranch: common.targetBranch,
			targetBranch: "main",
			title: "Draft: Add reviewed account request",
		});
		expect(JSON.stringify(captured)).toContain("generator validation passed");
		expect(JSON.stringify(captured).toLowerCase()).toContain("never apply");
		expect(result).toEqual({ iid: 7, webUrl: "https://gitlab.example/merge_requests/7" });
	});
});
