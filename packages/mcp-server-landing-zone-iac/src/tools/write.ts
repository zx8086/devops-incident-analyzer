import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Config } from "../config.ts";
import { type GitLabFile, type GitLabProject, resolveRepository } from "./repositories.ts";

const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/i, "must be a full 40-character commit SHA");
const BranchSchema = z
	.string()
	.min(1)
	.max(255)
	.refine(
		(value) =>
			!value.startsWith("-") &&
			!value.startsWith(".") &&
			!value.endsWith(".") &&
			!value.endsWith("/") &&
			!value.endsWith(".lock") &&
			!value.includes("..") &&
			!value.includes("//") &&
			!value.includes("@{") &&
			!Array.from(value).some((character) => {
				const code = character.charCodeAt(0);
				return code <= 32 || code === 127 || ":?*[\\~^".includes(character);
			}),
		"must be a safe Git branch name",
	);
const ReviewTokenSchema = z.string().min(1).max(1_024);

const CommonWriteInputSchema = z.object({
	repository: z.string().min(1),
	projectId: z.number().int().positive(),
	baseBranch: BranchSchema,
	baseSha: ShaSchema,
	targetBranch: BranchSchema,
	changeSummary: z.string().min(1).max(2_000),
	reviewToken: ReviewTokenSchema,
});

export const CreateBranchInputSchema = CommonWriteInputSchema;
export const CommitAllowedFilesInputSchema = CommonWriteInputSchema.extend({
	expectedBranchSha: ShaSchema,
	commitMessage: z.string().min(1).max(1_000),
	backendChangeApproved: z.boolean(),
	files: z
		.array(
			z.object({
				path: z.string().min(1).max(500),
				content: z.string().max(524_288),
				expectedFileSha: ShaSchema.nullable(),
			}),
		)
		.min(1)
		.max(20),
});
export const OpenMergeRequestInputSchema = CommonWriteInputSchema.extend({
	sourceSha: ShaSchema,
	title: z.string().min(1).max(240),
	evidence: z.array(z.string().min(1).max(2_000)).min(1).max(20),
	validationResults: z.array(z.string().min(1).max(2_000)).min(1).max(20),
	riskSummary: z.string().min(1).max(4_000),
	expectedPlanShape: z.string().min(1).max(4_000),
});

type CommonWriteInput = z.infer<typeof CommonWriteInputSchema>;
type CommitAllowedFilesInput = z.infer<typeof CommitAllowedFilesInputSchema>;
type OpenMergeRequestInput = z.infer<typeof OpenMergeRequestInputSchema>;

export interface GitLabBranch {
	name: string;
	sha: string;
	webUrl: string;
}

export interface GitLabCommitAction {
	action: "create" | "update";
	filePath: string;
	content: string;
	lastCommitId?: string;
}

export interface GitLabWriteClient {
	project(projectPath: string): Promise<GitLabProject>;
	branch(projectPath: string, name: string): Promise<GitLabBranch | undefined>;
	file(projectPath: string, filePath: string, ref: string): Promise<GitLabFile | undefined>;
	createBranch(projectPath: string, name: string, refSha: string): Promise<GitLabBranch>;
	commit(
		projectPath: string,
		input: {
			branch: string;
			commitMessage: string;
			actions: GitLabCommitAction[];
		},
	): Promise<{ sha: string; webUrl: string }>;
	openMergeRequest(
		projectPath: string,
		input: {
			sourceBranch: string;
			targetBranch: string;
			title: string;
			description: string;
		},
	): Promise<{ iid: number; webUrl: string }>;
}

interface GitLabWriteClientOptions {
	baseUrl: string;
	token: string;
	timeoutMs: number;
	maxResponseBytes: number;
	fetchImpl?: typeof fetch;
}

const ProjectResponseSchema = z.object({
	id: z.number().int(),
	path_with_namespace: z.string(),
	default_branch: z.string().nullable(),
	last_activity_at: z.string(),
});
const BranchResponseSchema = z.object({
	name: z.string(),
	web_url: z.string(),
	commit: z.object({ id: z.string() }),
});
const FileResponseSchema = z.object({
	content: z.string(),
	encoding: z.literal("base64"),
	blob_id: z.string(),
	last_commit_id: z.string(),
	size: z.number().int().nonnegative(),
});
const CommitResponseSchema = z.object({ id: z.string(), web_url: z.string() });
const MergeRequestResponseSchema = z.object({ iid: z.number().int().positive(), web_url: z.string() });

function projectApiPath(projectPath: string): string {
	return `/projects/${encodeURIComponent(projectPath)}`;
}

export function createGitLabWriteClient(options: GitLabWriteClientOptions): GitLabWriteClient {
	const apiRoot = `${options.baseUrl.replace(/\/$/, "")}/api/v4`;
	const fetchImpl = options.fetchImpl ?? fetch;

	async function request(path: string, init: RequestInit = {}, allowNotFound = false): Promise<unknown | undefined> {
		const response = await fetchImpl(`${apiRoot}${path}`, {
			...init,
			headers: {
				"PRIVATE-TOKEN": options.token,
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...init.headers,
			},
			signal: AbortSignal.timeout(options.timeoutMs),
		});
		if (allowNotFound && response.status === 404) return undefined;
		if (!response.ok) throw new Error(`GitLab write facade request failed with HTTP ${response.status}`);
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > options.maxResponseBytes) {
			throw new Error(`GitLab response exceeded ${options.maxResponseBytes} bytes`);
		}
		return JSON.parse(text) as unknown;
	}

	return {
		async project(projectPath) {
			const project = ProjectResponseSchema.parse(await request(projectApiPath(projectPath)));
			const defaultBranch = project.default_branch ?? "";
			const branch = defaultBranch
				? BranchResponseSchema.parse(
						await request(`${projectApiPath(projectPath)}/repository/branches/${encodeURIComponent(defaultBranch)}`),
					)
				: undefined;
			return {
				id: project.id,
				path: project.path_with_namespace,
				defaultBranch,
				headSha: branch?.commit.id ?? "",
				lastActivityAt: project.last_activity_at,
			};
		},
		async branch(projectPath, name) {
			const value = await request(
				`${projectApiPath(projectPath)}/repository/branches/${encodeURIComponent(name)}`,
				{},
				true,
			);
			if (value === undefined) return undefined;
			const branch = BranchResponseSchema.parse(value);
			return { name: branch.name, sha: branch.commit.id, webUrl: branch.web_url };
		},
		async file(projectPath, filePath, ref) {
			const value = await request(
				`${projectApiPath(projectPath)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
				{},
				true,
			);
			if (value === undefined) return undefined;
			const file = FileResponseSchema.parse(value);
			return {
				content: Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8"),
				blobId: file.blob_id,
				size: file.size,
				lastCommitId: file.last_commit_id,
			};
		},
		async createBranch(projectPath, name, refSha) {
			const branch = BranchResponseSchema.parse(
				await request(`${projectApiPath(projectPath)}/repository/branches`, {
					method: "POST",
					body: JSON.stringify({ branch: name, ref: refSha }),
				}),
			);
			return { name: branch.name, sha: branch.commit.id, webUrl: branch.web_url };
		},
		async commit(projectPath, input) {
			const actions = input.actions.map((action) => ({
				action: action.action,
				file_path: action.filePath,
				content: action.content,
				...(action.action === "update" ? { last_commit_id: action.lastCommitId } : {}),
			}));
			const commit = CommitResponseSchema.parse(
				await request(`${projectApiPath(projectPath)}/repository/commits`, {
					method: "POST",
					body: JSON.stringify({
						branch: input.branch,
						commit_message: input.commitMessage,
						actions,
					}),
				}),
			);
			return { sha: commit.id, webUrl: commit.web_url };
		},
		async openMergeRequest(projectPath, input) {
			const mergeRequest = MergeRequestResponseSchema.parse(
				await request(`${projectApiPath(projectPath)}/merge_requests`, {
					method: "POST",
					body: JSON.stringify({
						source_branch: input.sourceBranch,
						target_branch: input.targetBranch,
						title: input.title,
						description: input.description,
					}),
				}),
			);
			return { iid: mergeRequest.iid, webUrl: mergeRequest.web_url };
		},
	};
}

function tokensMatch(actual: string, expected: string | undefined): boolean {
	if (!expected) return false;
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function assertWriteContext(
	client: GitLabWriteClient,
	policy: Config["write"],
	input: CommonWriteInput,
): Promise<{ projectPath: string; defaultBranch: string }> {
	const repository = resolveRepository(input.repository);
	if (repository.availability !== "active") throw new Error(`${repository.name} has no writable Git refs`);
	if (!policy.enabled || !policy.allowedProjects.includes(repository.projectPath)) {
		throw new Error(`${repository.projectPath} is not write-allowlisted`);
	}
	if (!tokensMatch(input.reviewToken, policy.reviewToken)) throw new Error("Approved review token did not match");
	const project = await client.project(repository.projectPath);
	if (project.path !== repository.projectPath || project.id !== input.projectId) {
		throw new Error("GitLab project identity did not match the approved catalog entry");
	}
	if (!project.defaultBranch || input.baseBranch !== project.defaultBranch) {
		throw new Error("Base branch did not match the GitLab default branch");
	}
	if (input.targetBranch === project.defaultBranch) throw new Error("Writes to the default branch are forbidden");
	if (!input.targetBranch.startsWith("agent/landing-zone/")) {
		throw new Error("Target branch must use the agent/landing-zone/ namespace");
	}
	const base = await client.branch(repository.projectPath, project.defaultBranch);
	if (!base || base.sha !== input.baseSha || project.headSha !== input.baseSha) {
		throw new Error("The supplied base SHA is stale");
	}
	return { projectPath: repository.projectPath, defaultBranch: project.defaultBranch };
}

function validatePath(projectPath: string, path: string, policy: Config["write"]): void {
	const hasControlCharacter = Array.from(path).some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
	if (
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").some((part) => part === "" || part === "." || part === "..") ||
		hasControlCharacter
	) {
		throw new Error(`Unsafe repository path: ${path}`);
	}
	const prefixes = policy.allowedPathPrefixes[projectPath] ?? [];
	const isAllowed = prefixes.some(
		(prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(`${prefix.replace(/\/$/, "")}/`),
	);
	if (!isAllowed) throw new Error(`Path is not write-allowlisted: ${path}`);
	if (/(^|\/)\.git(?:\/|$)|(^|\/)\.terraform(?:\/|$)|(^|\/)\.env(?:\.|$)/i.test(path)) {
		throw new Error(`Protected path is not writable: ${path}`);
	}
	if (/\.(?:tfstate(?:\..*)?|tfvars(?:\.json)?|pem|key|p12|pfx)$/i.test(path)) {
		throw new Error(`Secret or state file is not writable: ${path}`);
	}
}

function validateContent(path: string, content: string): void {
	if (/BEGIN_TF_DOCS|END_TF_DOCS|generated by terraform-docs|do not edit.*generated/i.test(content)) {
		throw new Error(`Generated content must not be edited: ${path}`);
	}
	if (
		/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bglpat-[A-Za-z0-9_-]+|\bAKIA[0-9A-Z]{16}\b/i.test(content) ||
		/^\s*(?:password|token|secret|private_key|access_key)\s*[:=]\s*["']?\S+/im.test(content)
	) {
		throw new Error(`Potential secret detected in ${path}`);
	}
}

function isBackendChange(path: string, content: string): boolean {
	return /(^|\/)_?backend\.tf$/i.test(path) || /\bbackend\s+"[^"]+"\s*\{/i.test(content);
}

export async function createAllowedBranch(
	client: GitLabWriteClient,
	policy: Config["write"],
	rawInput: CommonWriteInput,
): Promise<{ projectPath: string; branch: string; sha: string; webUrl: string }> {
	const input = CreateBranchInputSchema.parse(rawInput);
	const { projectPath } = await assertWriteContext(client, policy, input);
	if (await client.branch(projectPath, input.targetBranch)) throw new Error("Target branch already exists");
	const branch = await client.createBranch(projectPath, input.targetBranch, input.baseSha);
	if (branch.name !== input.targetBranch || branch.sha !== input.baseSha) {
		throw new Error("GitLab did not create the target branch at the verified base SHA");
	}
	return { projectPath, branch: branch.name, sha: branch.sha, webUrl: branch.webUrl };
}

export async function commitAllowedFiles(
	client: GitLabWriteClient,
	policy: Config["write"],
	rawInput: CommitAllowedFilesInput,
): Promise<{ sha: string; webUrl: string }> {
	const input = CommitAllowedFilesInputSchema.parse(rawInput);
	const { projectPath } = await assertWriteContext(client, policy, input);
	const branch = await client.branch(projectPath, input.targetBranch);
	if (!branch || branch.sha !== input.expectedBranchSha) throw new Error("Target branch SHA is stale");
	const totalBytes = input.files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
	if (totalBytes > 1_048_576) throw new Error("Commit content exceeds the 1 MiB safety limit");

	const seen = new Set<string>();
	const actions: GitLabCommitAction[] = [];
	for (const file of input.files) {
		if (seen.has(file.path)) throw new Error(`Duplicate file path: ${file.path}`);
		seen.add(file.path);
		validatePath(projectPath, file.path, policy);
		validateContent(file.path, file.content);
		if (isBackendChange(file.path, file.content)) {
			if (!input.backendChangeApproved || !policy.backendProjects.includes(projectPath)) {
				throw new Error(`Backend change is not explicitly approved for ${projectPath}`);
			}
		}
		const existing = await client.file(projectPath, file.path, input.targetBranch);
		if (existing) validateContent(file.path, existing.content);
		if (file.expectedFileSha === null && existing) throw new Error(`Expected new file already exists: ${file.path}`);
		if (file.expectedFileSha !== null && (!existing || existing.blobId !== file.expectedFileSha)) {
			throw new Error(`Expected file SHA is stale for ${file.path}`);
		}
		if (existing && !existing.lastCommitId) {
			throw new Error(`GitLab did not provide file concurrency metadata for ${file.path}`);
		}
		actions.push({
			action: existing ? "update" : "create",
			filePath: file.path,
			content: file.content,
			...(existing?.lastCommitId && { lastCommitId: existing.lastCommitId }),
		});
	}
	return client.commit(projectPath, {
		branch: input.targetBranch,
		commitMessage: input.commitMessage,
		actions,
	});
}

function markdownList(values: string[]): string {
	return values.map((value) => `- ${value}`).join("\n");
}

export async function openAllowedMergeRequest(
	client: GitLabWriteClient,
	policy: Config["write"],
	rawInput: OpenMergeRequestInput,
): Promise<{ iid: number; webUrl: string }> {
	const input = OpenMergeRequestInputSchema.parse(rawInput);
	const { projectPath, defaultBranch } = await assertWriteContext(client, policy, input);
	const source = await client.branch(projectPath, input.targetBranch);
	if (!source || source.sha !== input.sourceSha) throw new Error("Source branch SHA is stale");
	const title = input.title.startsWith("Draft:") ? input.title : `Draft: ${input.title}`;
	const description = [
		"## Change summary",
		input.changeSummary,
		"## Evidence",
		markdownList(input.evidence),
		"## Validation results",
		markdownList(input.validationResults),
		"## Risk summary",
		input.riskSummary,
		"## Expected plan shape",
		input.expectedPlanShape,
		"## Guardrails",
		"This governed facade can never apply Terraform, merge, approve, tag, release, or deploy.",
	].join("\n\n");
	return client.openMergeRequest(projectPath, {
		sourceBranch: input.targetBranch,
		targetBranch: defaultBranch,
		title,
		description,
	});
}
