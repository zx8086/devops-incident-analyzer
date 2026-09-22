import { z } from "zod";

export type RepositoryArchetype =
	| "generated-root"
	| "flat-root"
	| "orchestration-root"
	| "gitlab-as-code-root"
	| "k8s-platform-root"
	| "runner-module-root"
	| "empty-project";

export interface LandingZoneRepository {
	name: string;
	projectPath: string;
	archetype: RepositoryArchetype;
	availability: "active" | "no-git-refs";
}

const LANDING_ZONE_GROUP = "pvhcorp/dhco/aws/aws-landing-zone";

export const LANDING_ZONE_REPOSITORIES: readonly LandingZoneRepository[] = [
	{
		name: "aws-lz-account-creator",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-account-creator`,
		archetype: "generated-root",
		availability: "active",
	},
	{
		name: "aws-lz-ami",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-shared-components/aws-lz-ami`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-app-proxy",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-security-components/aws-lz-app-proxy`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-backup",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-backup`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-citrix",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-citrix`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-dc",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-security-components/aws-lz-dc`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-dfs",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-dfs`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-f5-ingress",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-networking-components/aws-lz-f5-ingress`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-finops",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-finops`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-infra-ss-components",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-infra-ss-components`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-logging",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-logging`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-monitoring",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-monitoring`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-network-core",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-networking-components/aws-lz-network-core`,
		archetype: "orchestration-root",
		availability: "active",
	},
	{
		name: "aws-lz-network-workloads",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-networking-components/aws-lz-network-workloads`,
		archetype: "generated-root",
		availability: "active",
	},
	{
		name: "aws-lz-post-vending",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-post-vending`,
		archetype: "generated-root",
		availability: "active",
	},
	{
		name: "aws-lz-security-tools",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-security-tools`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-shared-tools",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-shared-tools`,
		archetype: "empty-project",
		availability: "no-git-refs",
	},
	{
		name: "aws-lz-ssm",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-shared-components/aws-lz-ssm`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-storage",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-storage`,
		archetype: "flat-root",
		availability: "active",
	},
	{
		name: "aws-lz-vending-orchestrator",
		projectPath: `${LANDING_ZONE_GROUP}/aws-lz-vending-orchestrator`,
		archetype: "orchestration-root",
		availability: "active",
	},
	{
		name: "dhco-gitlab-terraform",
		projectPath: "pvhcorp/dhco/dhco-gitlab-terraform",
		archetype: "gitlab-as-code-root",
		availability: "active",
	},
	{
		name: "gitlab-k8s-runners-lzv2",
		projectPath: "pvhcorp/dhco/gitlab-k8s-runners-lzv2",
		archetype: "k8s-platform-root",
		availability: "active",
	},
	{
		name: "gitlab-k8s-runners-terraform",
		projectPath: "pvhcorp/dhco/gitlab-k8s-runners-terraform",
		archetype: "runner-module-root",
		availability: "active",
	},
] as const;

const catalogByAlias = new Map<string, LandingZoneRepository>();
for (const repository of LANDING_ZONE_REPOSITORIES) {
	catalogByAlias.set(repository.name.toLowerCase(), repository);
	catalogByAlias.set(repository.projectPath.toLowerCase(), repository);
}

export function resolveRepository(alias: string): LandingZoneRepository {
	const repository = catalogByAlias.get(alias.trim().toLowerCase());
	if (!repository) throw new Error(`Repository is not in the Landing Zone catalog: ${alias}`);
	return repository;
}

export interface GitLabProject {
	id: number;
	defaultBranch: string;
	headSha: string;
	lastActivityAt: string;
}

export interface GitLabTreeEntry {
	path: string;
	type: "blob" | "tree";
}

export interface GitLabFile {
	content: string;
	blobId: string;
	size: number;
}

export interface GitLabOpenChange {
	iid: number;
	title: string;
	webUrl: string;
	updatedAt: string;
}

export interface GitLabPipelineJob {
	id: number;
	name: string;
	status: string;
	webUrl: string;
}

export interface GitLabReadClient {
	project(projectPath: string): Promise<GitLabProject>;
	tree(projectPath: string, ref?: string, recursive?: boolean, path?: string): Promise<GitLabTreeEntry[]>;
	readFile(projectPath: string, path: string, ref?: string): Promise<GitLabFile>;
	openChanges(projectPath: string): Promise<GitLabOpenChange[]>;
	changePaths(projectPath: string, iid: number): Promise<string[]>;
	pipelineJobs(projectPath: string, pipelineId: number): Promise<GitLabPipelineJob[]>;
	jobTrace(projectPath: string, jobId: number): Promise<string>;
}

export interface Provenance {
	source: "gitlab";
	projectPath: string;
	webUrl: string;
	ref: string;
	defaultBranch: string;
	retrievedAt: string;
	lastActivityAt: string;
	untrustedContent: true;
	truncated: boolean;
}

const GitLabProjectResponseSchema = z.object({
	id: z.number().int(),
	default_branch: z.string().nullable(),
	last_activity_at: z.string(),
});
const GitLabCommitResponseSchema = z.array(z.object({ id: z.string() }));
const GitLabTreeResponseSchema = z.array(z.object({ path: z.string(), type: z.enum(["blob", "tree"]) }));
const GitLabFileResponseSchema = z.object({
	content: z.string(),
	encoding: z.string(),
	blob_id: z.string(),
	size: z.number(),
});
const GitLabOpenChangesResponseSchema = z.array(
	z.object({ iid: z.number(), title: z.string(), web_url: z.string(), updated_at: z.string() }),
);
const GitLabChangeResponseSchema = z.object({ changes: z.array(z.object({ new_path: z.string() })) });
const GitLabJobsResponseSchema = z.array(
	z.object({ id: z.number(), name: z.string(), status: z.string(), web_url: z.string() }),
);

interface GitLabClientOptions {
	baseUrl: string;
	token?: string;
	timeoutMs: number;
	maxResponseBytes: number;
	fetchImpl?: typeof fetch;
}

export function createGitLabReadClient(options: GitLabClientOptions): GitLabReadClient {
	const fetchImpl = options.fetchImpl ?? fetch;
	const apiRoot = `${options.baseUrl.replace(/\/$/, "")}/api/v4`;

	async function request(path: string): Promise<string> {
		const response = await fetchImpl(`${apiRoot}${path}`, {
			headers: options.token ? { "PRIVATE-TOKEN": options.token } : undefined,
			signal: AbortSignal.timeout(options.timeoutMs),
		});
		if (!response.ok) throw new Error(`GitLab read failed with HTTP ${response.status}`);
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > options.maxResponseBytes) {
			throw new Error(`GitLab response exceeded ${options.maxResponseBytes} bytes`);
		}
		return text;
	}

	async function json(path: string): Promise<unknown> {
		return JSON.parse(await request(path)) as unknown;
	}

	function projectApiPath(projectPath: string): string {
		return `/projects/${encodeURIComponent(projectPath)}`;
	}

	return {
		async project(projectPath) {
			const project = GitLabProjectResponseSchema.parse(await json(projectApiPath(projectPath)));
			const defaultBranch = project.default_branch ?? "";
			const commits = defaultBranch
				? GitLabCommitResponseSchema.parse(
						await json(
							`${projectApiPath(projectPath)}/repository/commits?ref_name=${encodeURIComponent(defaultBranch)}&per_page=1`,
						),
					)
				: [];
			return {
				id: project.id,
				defaultBranch,
				headSha: commits[0]?.id ?? "",
				lastActivityAt: project.last_activity_at,
			};
		},
		async tree(projectPath, ref, recursive = false, path) {
			const entries: GitLabTreeEntry[] = [];
			for (let page = 1; page <= 5; page++) {
				const params = new URLSearchParams({ page: String(page), per_page: "100", recursive: String(recursive) });
				if (ref) params.set("ref", ref);
				if (path) params.set("path", path);
				const batch = GitLabTreeResponseSchema.parse(
					await json(`${projectApiPath(projectPath)}/repository/tree?${params.toString()}`),
				);
				entries.push(...batch);
				if (batch.length < 100) break;
			}
			return entries;
		},
		async readFile(projectPath, path, ref) {
			const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
			const file = GitLabFileResponseSchema.parse(
				await json(`${projectApiPath(projectPath)}/repository/files/${encodeURIComponent(path)}${suffix}`),
			);
			return {
				content: file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content,
				blobId: file.blob_id,
				size: file.size,
			};
		},
		async openChanges(projectPath) {
			const changes = GitLabOpenChangesResponseSchema.parse(
				await json(`${projectApiPath(projectPath)}/merge_requests?state=opened&per_page=20`),
			);
			return changes.map((change) => ({
				iid: change.iid,
				title: change.title,
				webUrl: change.web_url,
				updatedAt: change.updated_at,
			}));
		},
		async changePaths(projectPath, iid) {
			const change = GitLabChangeResponseSchema.parse(
				await json(`${projectApiPath(projectPath)}/merge_requests/${iid}/changes`),
			);
			return change.changes.slice(0, 500).map((item) => item.new_path);
		},
		async pipelineJobs(projectPath, pipelineId) {
			const jobs = GitLabJobsResponseSchema.parse(
				await json(`${projectApiPath(projectPath)}/pipelines/${pipelineId}/jobs?per_page=100`),
			);
			return jobs.map((job) => ({ id: job.id, name: job.name, status: job.status, webUrl: job.web_url }));
		},
		jobTrace(projectPath, jobId) {
			return request(`${projectApiPath(projectPath)}/jobs/${jobId}/trace`);
		},
	};
}

const MAX_FILE_BYTES = 64_000;
const MAX_TOTAL_BYTES = 180_000;
const sensitivePath = /(^|\/)(\.env(?:\..*)?|\.terraform)(\/|$)|\.(?:tfstate(?:\.backup)?|pem|key)$/i;

export function assertSafeRepositoryPath(path: string): void {
	if (path.startsWith("/") || path.split("/").includes("..") || sensitivePath.test(path)) {
		throw new Error(`Repository path is not available through the evidence facade: ${path}`);
	}
}

export function sanitizeEvidenceText(content: string): string {
	return content
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
		.replace(
			/^(\s*["']?(?:password|secret|token|access_key|secret_key|private_key)["']?\s*[:=]\s*)([^\r\n,}]+)/gim,
			"$1[REDACTED]",
		);
}

export function boundText(content: string, maxBytes = MAX_FILE_BYTES): { content: string; truncated: boolean } {
	const bytes = Buffer.from(content, "utf8");
	if (bytes.byteLength <= maxBytes) return { content, truncated: false };
	return { content: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export async function repositoryProvenance(
	client: GitLabReadClient,
	repository: LandingZoneRepository,
	requestedRef?: string,
): Promise<{ project: GitLabProject; provenance: Provenance }> {
	const project = await client.project(repository.projectPath);
	const ref = requestedRef ?? (project.headSha || project.defaultBranch);
	return {
		project,
		provenance: {
			source: "gitlab",
			projectPath: repository.projectPath,
			webUrl: `https://gitlab.com/${repository.projectPath}`,
			ref,
			defaultBranch: project.defaultBranch,
			retrievedAt: new Date().toISOString(),
			lastActivityAt: project.lastActivityAt,
			untrustedContent: true,
			truncated: false,
		},
	};
}

export interface ReadRepositoryFilesInput {
	repository: string;
	paths: string[];
	ref?: string;
}

export async function readRepositoryFiles(client: GitLabReadClient, input: ReadRepositoryFilesInput) {
	const repository = resolveRepository(input.repository);
	if (repository.availability === "no-git-refs") throw new Error(`${repository.name} has no Git refs`);
	if (input.paths.length === 0 || input.paths.length > 20)
		throw new Error("paths must contain between 1 and 20 entries");
	const { provenance } = await repositoryProvenance(client, repository, input.ref);
	let remaining = MAX_TOTAL_BYTES;
	let truncated = false;
	const files = [];
	for (const path of input.paths) {
		assertSafeRepositoryPath(path);
		const file = await client.readFile(repository.projectPath, path, provenance.ref);
		const bounded = boundText(sanitizeEvidenceText(file.content), Math.min(MAX_FILE_BYTES, remaining));
		remaining -= Buffer.byteLength(bounded.content, "utf8");
		truncated ||= bounded.truncated;
		files.push({ path, blobId: file.blobId, size: file.size, content: bounded.content, truncated: bounded.truncated });
		if (remaining <= 0) break;
	}
	return { repository, files, provenance: { ...provenance, truncated } };
}
