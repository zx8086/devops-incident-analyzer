import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Config } from "../config.ts";
import {
	commitAllowedFiles,
	createAllowedBranch,
	createGitLabWriteClient,
	createReviewToken,
	type GitLabWriteClient,
	openAllowedMergeRequest,
	type ReviewManifest,
} from "./write.ts";

const repository = "aws-lz-account-creator";
const projectPath = "pvhcorp/dhco/aws/aws-landing-zone/aws-lz-account-creator";
const baseSha = "a".repeat(40);
const branchSha = "b".repeat(40);
const commitSha = "c".repeat(40);
const fileSha = "d".repeat(40);
const fileCommitSha = "e".repeat(40);
const reviewSecret = "review-signing-secret-at-least-32-bytes";
const defaultContent = "application_name: prod";

const policy: Config["write"] = {
	enabled: true,
	token: "write-token",
	reviewSecret,
	allowedProjects: [projectPath],
	allowedPathPrefixes: { [projectPath]: ["accounts/"] },
	backendProjects: [],
};

function sha256(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

function reviewManifest(
	overrides: Partial<ReviewManifest> & {
		file?: { path: string; content: string; expectedFileSha: string | null };
	} = {},
): ReviewManifest {
	const file = overrides.file ?? { path: "accounts/prod.yml", content: defaultContent, expectedFileSha: null };
	const issuedAt = new Date();
	return {
		approvalId: "11111111-1111-4111-8111-111111111111",
		issuedAt: issuedAt.toISOString(),
		expiresAt: new Date(issuedAt.getTime() + 10 * 60_000).toISOString(),
		repository,
		projectId: 42,
		baseBranch: "main",
		baseSha,
		targetBranch: "agent/landing-zone/change",
		changeSummary: "Add the reviewed account request",
		backendChangeApproved: false,
		mergeRequest: {
			title: "Add reviewed account request",
			evidence: ["accounts/schema.json at base SHA"],
			validationResults: ["generator validation passed"],
			riskSummary: "No destructive resources expected.",
			expectedPlanShape: "One account module addition; no replacement or deletion.",
		},
		...overrides,
		files: overrides.files ?? [
			{ path: file.path, contentSha256: sha256(file.content), expectedFileSha: file.expectedFileSha },
		],
	};
}

function approvedCommon(manifest: ReviewManifest) {
	return {
		repository: manifest.repository,
		projectId: manifest.projectId,
		baseBranch: manifest.baseBranch,
		baseSha: manifest.baseSha,
		targetBranch: manifest.targetBranch,
		changeSummary: manifest.changeSummary,
		reviewManifest: manifest,
		reviewToken: createReviewToken(reviewSecret, manifest),
	};
}

function reviewedCommit(input: {
	path?: string;
	content?: string;
	expectedFileSha?: string | null;
	backendChangeApproved?: boolean;
}) {
	const file = {
		path: input.path ?? "accounts/prod.yml",
		content: input.content ?? defaultContent,
		expectedFileSha: input.expectedFileSha ?? null,
	};
	const manifest = reviewManifest({ file, backendChangeApproved: input.backendChangeApproved ?? false });
	return {
		...approvedCommon(manifest),
		expectedBranchSha: branchSha,
		commitMessage: "feat: add reviewed request",
		backendChangeApproved: manifest.backendChangeApproved,
		files: [file],
	};
}

function reviewedMergeRequest(manifest = reviewManifest()) {
	return { ...approvedCommon(manifest), sourceSha: branchSha, ...manifest.mergeRequest };
}

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
		changedPaths: async () => ["accounts/prod.yml"],
		createBranch: async (_path, name, sha) => ({
			name,
			sha,
			webUrl: `https://gitlab.example/${name}`,
		}),
		commit: async () => ({
			sha: branchSha,
			parentShas: [branchSha],
			webUrl: `https://gitlab.example/commit/${branchSha}`,
		}),
		openMergeRequest: async () => ({ iid: 7, webUrl: "https://gitlab.example/merge_requests/7" }),
		...overrides,
	};
}

describe("Landing Zone write guards", () => {
	test("rejects non-allowlisted repositories, default-branch targets, stale bases, and invalid review tokens", async () => {
		const approved = approvedCommon(reviewManifest());
		await expect(createAllowedBranch(client(), { ...policy, allowedProjects: [] }, approved)).rejects.toThrow(
			"not write-allowlisted",
		);
		await expect(
			createAllowedBranch(client(), policy, approvedCommon(reviewManifest({ targetBranch: "main" }))),
		).rejects.toThrow("default branch");
		await expect(
			createAllowedBranch(client(), policy, approvedCommon(reviewManifest({ baseSha: "f".repeat(40) }))),
		).rejects.toThrow("base SHA");
		await expect(
			createAllowedBranch(client(), policy, { ...approved, reviewToken: `v1.${"0".repeat(64)}` }),
		).rejects.toThrow("review token");
		const expired = reviewManifest({
			issuedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
			expiresAt: new Date(Date.now() - 10 * 60_000).toISOString(),
		});
		await expect(createAllowedBranch(client(), policy, approvedCommon(expired))).rejects.toThrow("expired");
		expect(() => approvedCommon(reviewManifest({ targetBranch: "agent/landing-zone/../main" }))).toThrow(
			"safe Git branch name",
		);
	});

	test("rejects replaying an approval token with changed content or backend scope", async () => {
		const approved = reviewedCommit({ content: defaultContent });
		const approvedFile = approved.files[0];
		if (!approvedFile) throw new Error("Test fixture must contain one reviewed file");
		await expect(
			commitAllowedFiles(client(), policy, {
				...approved,
				files: [{ ...approvedFile, content: "application_name: replayed" }],
			}),
		).rejects.toThrow("review manifest");
		await expect(commitAllowedFiles(client(), policy, { ...approved, backendChangeApproved: true })).rejects.toThrow(
			"Backend approval",
		);
	});

	test.each([
		["disallowed path", "modules/main.tf", "resource {}", false],
		["state file", "accounts/terraform.tfstate", "{}", false],
		["secret path", "accounts/prod.tfvars", 'password = "x"', false],
		["GitLab token", "accounts/prod.yml", "token: glpat-secret", false],
		["client secret", "accounts/prod.yml", "client_secret: credential", false],
		["API key", "accounts/prod.yml", "api_key: credential", false],
		["secret key", "accounts/prod.yml", "secret_key: credential", false],
		["generated section", "accounts/prod.yml", "<!-- BEGIN_TF_DOCS -->", false],
		["backend outside scope", "accounts/backend.tf", 'terraform { backend "s3" {} }', true],
	] as const)("rejects %s", async (_label, path, content, backendChangeApproved) => {
		await expect(
			commitAllowedFiles(client(), policy, reviewedCommit({ path, content, backendChangeApproved })),
		).rejects.toThrow();
	});

	test("rejects a stale expected file SHA instead of overwriting", async () => {
		await expect(
			commitAllowedFiles(
				client({ file: async () => ({ content: "old", blobId: "0".repeat(40), size: 3 }) }),
				policy,
				reviewedCommit({ expectedFileSha: "f".repeat(40) }),
			),
		).rejects.toThrow("file SHA");
	});

	test("stops when the branch changes during verification or GitLab returns an unexpected parent", async () => {
		const input = reviewedCommit({});
		let targetReads = 0;
		await expect(
			commitAllowedFiles(
				client({
					branch: async (_path, name) => {
						if (name === "main") return { name, sha: baseSha, webUrl: "https://gitlab.example/main" };
						targetReads++;
						return {
							name,
							sha: targetReads < 2 ? branchSha : "9".repeat(40),
							webUrl: "https://gitlab.example/change",
						};
					},
				}),
				policy,
				input,
			),
		).rejects.toThrow("changed while files were being verified");

		await expect(
			commitAllowedFiles(
				client({
					commit: async () => ({
						sha: commitSha,
						parentShas: ["9".repeat(40)],
						webUrl: "https://gitlab.example/commit/new",
					}),
				}),
				policy,
				input,
			),
		).rejects.toThrow("commit parent");
	});
});

describe("Landing Zone governed GitOps writes", () => {
	test("collects every compare page and fails closed when GitLab reports an incomplete comparison", async () => {
		const requestedPages: string[] = [];
		const pagedClient = createGitLabWriteClient({
			baseUrl: "https://gitlab.example",
			token: "dedicated-write-token",
			timeoutMs: 30_000,
			maxResponseBytes: 200_000,
			fetchImpl: (async (url: string | URL | Request) => {
				const parsed = new URL(String(url));
				const page = parsed.searchParams.get("page") ?? "1";
				requestedPages.push(page);
				return new Response(
					JSON.stringify({
						compare_timeout: false,
						diffs: [
							page === "1"
								? { old_path: "accounts/prod.yml", new_path: "accounts/prod.yml" }
								: { old_path: "modules/unreviewed.tf", new_path: "modules/unreviewed.tf" },
						],
					}),
					{ headers: page === "1" ? { "X-Next-Page": "2" } : {} },
				);
			}) as typeof fetch,
		});

		await expect(pagedClient.changedPaths(projectPath, baseSha, branchSha)).resolves.toEqual([
			"accounts/prod.yml",
			"modules/unreviewed.tf",
		]);
		expect(requestedPages).toEqual(["1", "2"]);

		const incompleteClient = createGitLabWriteClient({
			baseUrl: "https://gitlab.example",
			token: "dedicated-write-token",
			timeoutMs: 30_000,
			maxResponseBytes: 200_000,
			fetchImpl: (async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						compare_timeout: true,
						diffs: [{ old_path: "accounts/prod.yml", new_path: "accounts/prod.yml" }],
					}),
				)) as typeof fetch,
		});
		await expect(incompleteClient.changedPaths(projectPath, baseSha, branchSha)).rejects.toThrow(
			"incomplete comparison",
		);
	});

	test("maps per-file concurrency metadata to GitLab without exposing the read credential", async () => {
		let request: { url: string; init?: RequestInit } | undefined;
		const writeClient = createGitLabWriteClient({
			baseUrl: "https://gitlab.example",
			token: "dedicated-write-token",
			timeoutMs: 30_000,
			maxResponseBytes: 200_000,
			fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
				request = { url: String(url), init };
				return new Response(
					JSON.stringify({ id: commitSha, parent_ids: [branchSha], web_url: "https://gitlab.example/commit" }),
				);
			}) as typeof fetch,
		});

		await writeClient.commit(projectPath, {
			branch: "agent/landing-zone/change",
			commitMessage: "feat: update reviewed account",
			actions: [
				{
					action: "update",
					filePath: "accounts/prod.yml",
					content: defaultContent,
					lastCommitId: fileCommitSha,
				},
			],
		});

		expect(request?.url).toEndWith("/repository/commits");
		expect(new Headers(request?.init?.headers).get("PRIVATE-TOKEN")).toBe("dedicated-write-token");
		expect(JSON.parse(String(request?.init?.body))).toMatchObject({
			branch: "agent/landing-zone/change",
			actions: [{ action: "update", file_path: "accounts/prod.yml", last_commit_id: fileCommitSha }],
		});
	});

	test("creates a branch from the exact verified base SHA", async () => {
		const calls: unknown[][] = [];
		const manifest = reviewManifest();
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
			approvedCommon(manifest),
		);
		expect(calls).toEqual([[projectPath, manifest.targetBranch, baseSha]]);
		expect(result).toMatchObject({ projectPath, branch: manifest.targetBranch, sha: baseSha });
	});

	test("commits only guarded files with exact branch, file, and parent SHAs", async () => {
		let captured: unknown;
		let targetSha = branchSha;
		const result = await commitAllowedFiles(
			client({
				branch: async (_path, name) =>
					name === "main"
						? { name, sha: baseSha, webUrl: "https://gitlab.example/main" }
						: { name, sha: targetSha, webUrl: "https://gitlab.example/change" },
				file: async () => ({
					content: "application_name: old",
					blobId: fileSha,
					size: 21,
					lastCommitId: fileCommitSha,
				}),
				commit: async (_path, input) => {
					captured = input;
					targetSha = commitSha;
					return { sha: commitSha, parentShas: [branchSha], webUrl: "https://gitlab.example/commit/new" };
				},
			}),
			policy,
			reviewedCommit({ expectedFileSha: fileSha }),
		);
		expect(captured).toEqual({
			branch: "agent/landing-zone/change",
			commitMessage: "feat: add reviewed request",
			actions: [
				{
					action: "update",
					filePath: "accounts/prod.yml",
					content: defaultContent,
					lastCommitId: fileCommitSha,
				},
			],
		});
		expect(result.sha).toBe(commitSha);
	});

	test("opens a ready-for-review MR only when changed paths and metadata match the reviewed manifest", async () => {
		let captured: unknown;
		const input = reviewedMergeRequest();
		await expect(
			openAllowedMergeRequest(
				client({ changedPaths: async () => ["accounts/prod.yml", "modules/unreviewed.tf"] }),
				policy,
				input,
			),
		).rejects.toThrow("outside the approved review manifest");

		const result = await openAllowedMergeRequest(
			client({
				openMergeRequest: async (_path, input) => {
					captured = input;
					return { iid: 7, webUrl: "https://gitlab.example/merge_requests/7" };
				},
			}),
			policy,
			input,
		);
		expect(captured).toMatchObject({
			sourceBranch: "agent/landing-zone/change",
			targetBranch: "main",
			title: "Add reviewed account request",
		});
		expect(JSON.stringify(captured)).toContain("generator validation passed");
		expect(JSON.stringify(captured).toLowerCase()).toContain("never apply");
		expect(result).toEqual({ iid: 7, webUrl: "https://gitlab.example/merge_requests/7" });
	});
});
