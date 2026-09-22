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
	path: string;
	defaultBranch: string;
	headSha: string;
	lastActivityAt: string;
}

export interface GitLabTreeEntry {
	path: string;
	type: "blob" | "tree";
}

export interface GitLabTreeResult {
	entries: GitLabTreeEntry[];
	truncated: boolean;
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

export interface GitLabHistoricalMergeRequest {
	iid: number;
	title: string;
	state: "opened" | "closed" | "merged";
	webUrl: string;
	createdAt: string;
	updatedAt: string;
	mergeCommitSha?: string;
	commitSha: string;
}

export interface GitLabHistoricalPipeline {
	id: number;
	status: string;
	webUrl: string;
	createdAt: string;
	updatedAt: string;
}

export interface GitLabDeployment {
	sha: string;
	status: string;
	updatedAt: string;
	pipelineId?: number;
}

export interface GitLabReadClient {
	project(projectPath: string): Promise<GitLabProject>;
	tree(projectPath: string, ref?: string, recursive?: boolean, path?: string): Promise<GitLabTreeResult>;
	readFile(projectPath: string, path: string, ref?: string): Promise<GitLabFile>;
	openChanges(projectPath: string): Promise<GitLabOpenChange[]>;
	changePaths(projectPath: string, iid: number): Promise<string[]>;
	pipelineJobs(
		projectPath: string,
		pipelineId: number,
		page: number,
		perPage: number,
	): Promise<{ jobs: GitLabPipelineJob[]; nextPage?: number }>;
	jobTrace(projectPath: string, jobId: number): Promise<string>;
	historicalMergeRequests(
		projectPath: string,
		updatedAfter: string,
		updatedBefore: string | undefined,
		page: number,
		perPage: number,
	): Promise<{ mergeRequests: GitLabHistoricalMergeRequest[]; total?: number; nextPage?: number }>;
	mergeRequest(projectPath: string, iid: number): Promise<GitLabHistoricalMergeRequest>;
	mergeRequestPipelines(
		projectPath: string,
		iid: number,
		page: number,
		perPage: number,
	): Promise<{ pipelines: GitLabHistoricalPipeline[]; nextPage?: number }>;
	projectDeployments?(
		projectPath: string,
		page: number,
		perPage: number,
		updatedBefore?: string,
	): Promise<{
		deployments: GitLabDeployment[];
		nextPage?: number;
	}>;
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
	path_with_namespace: z.string(),
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
	z.object({
		id: z.number(),
		name: z.string(),
		status: z.string(),
		web_url: z.string(),
	}),
);
const GitLabHistoricalMergeRequestsResponseSchema = z.array(
	z.object({
		iid: z.number().int(),
		title: z.string(),
		state: z.enum(["opened", "closed", "merged"]),
		web_url: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
		merge_commit_sha: z.string().nullable(),
		sha: z.string(),
	}),
);
const GitLabHistoricalMergeRequestResponseSchema = GitLabHistoricalMergeRequestsResponseSchema.element;
const GitLabHistoricalPipelinesResponseSchema = z.array(
	z.object({
		id: z.number().int(),
		status: z.string(),
		web_url: z.string(),
		created_at: z.string(),
		updated_at: z.string(),
	}),
);
const GitLabDeploymentsResponseSchema = z.array(
	z.object({
		sha: z.string(),
		status: z.string(),
		updated_at: z.string(),
		deployable: z.object({ pipeline: z.object({ id: z.number().int() }).optional() }).optional(),
	}),
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

	async function responseFor(path: string): Promise<Response> {
		const response = await fetchImpl(`${apiRoot}${path}`, {
			headers: options.token ? { "PRIVATE-TOKEN": options.token } : undefined,
			signal: AbortSignal.timeout(options.timeoutMs),
		});
		if (!response.ok) throw new Error(`GitLab read failed with HTTP ${response.status}`);
		return response;
	}

	async function request(path: string): Promise<string> {
		const response = await responseFor(path);
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > options.maxResponseBytes) {
			throw new Error(`GitLab response exceeded ${options.maxResponseBytes} bytes`);
		}
		return text;
	}

	async function json(path: string): Promise<unknown> {
		return JSON.parse(await request(path)) as unknown;
	}

	async function responseJson(response: Response): Promise<unknown> {
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > options.maxResponseBytes) {
			throw new Error(`GitLab response exceeded ${options.maxResponseBytes} bytes`);
		}
		return JSON.parse(text) as unknown;
	}

	function projectApiPath(projectPath: string): string {
		return `/projects/${encodeURIComponent(projectPath)}`;
	}

	function parseDecimalHeader(headers: Headers, name: string, minimum: number): number | undefined {
		const raw = headers.get(name);
		if (raw === null) return undefined;
		if (!/^\d+$/.test(raw)) throw new Error(`GitLab response omitted a valid ${name} header`);
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value < minimum)
			throw new Error(`GitLab response omitted a valid ${name} header`);
		return value;
	}

	function validatePageHeaders(headers: Headers, page: number, perPage: number): void {
		const responsePage = parseDecimalHeader(headers, "X-Page", 1);
		if (responsePage !== undefined && responsePage !== page)
			throw new Error(`GitLab X-Page ${responsePage} did not match requested page ${page}`);
		const responsePerPage = parseDecimalHeader(headers, "X-Per-Page", 1);
		if (responsePerPage !== undefined && responsePerPage !== perPage)
			throw new Error(`GitLab X-Per-Page ${responsePerPage} did not match requested page size ${perPage}`);
	}

	function linkParts(value: string): string[] {
		const parts: string[] = [];
		let start = 0;
		let quoted = false;
		let angleDepth = 0;
		for (let index = 0; index < value.length; index++) {
			const character = value[index];
			if (character === '"' && value[index - 1] !== "\\") quoted = !quoted;
			if (quoted) continue;
			if (character === "<") angleDepth++;
			else if (character === ">" && angleDepth > 0) angleDepth--;
			else if (character === "," && angleDepth === 0) {
				parts.push(value.slice(start, index).trim());
				start = index + 1;
			}
		}
		parts.push(value.slice(start).trim());
		return parts.filter(Boolean);
	}

	function nextPageFromLink(value: string | null, requestedPage: number): number | undefined {
		if (!value) return undefined;
		let advertisedNext: number | undefined;
		for (const part of linkParts(value)) {
			const relationParameters = part
				.split(";")
				.slice(1)
				.map((parameter) => parameter.trim());
			const isNext = relationParameters.some((parameter) => {
				const match = parameter.match(/^rel\s*=\s*(?:"([^"]*)"|([^\s;]+))$/i);
				const relations = (match?.[1] ?? match?.[2] ?? "").split(/\s+/);
				return relations.some((relation) => relation.toLowerCase() === "next");
			});
			if (!isNext) continue;
			const target = part.match(/^<([^>]+)>/)?.[1];
			if (!target) throw new Error("GitLab response advertised a malformed next-page link");
			let rawPage: string | null;
			try {
				rawPage = new URL(target, apiRoot).searchParams.get("page");
			} catch {
				throw new Error("GitLab response advertised a malformed next-page link");
			}
			if (rawPage === null || !/^\d+$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage)) || Number(rawPage) < 1)
				throw new Error("GitLab response omitted a valid next-page link");
			const nextPage = Number(rawPage);
			if (nextPage <= requestedPage)
				throw new Error(`GitLab next-page link ${nextPage} did not advance beyond requested page ${requestedPage}`);
			if (advertisedNext !== undefined && advertisedNext !== nextPage)
				throw new Error("GitLab response advertised conflicting next-page links");
			advertisedNext = nextPage;
		}
		return advertisedNext;
	}

	function nextPageFrom(response: Response, requestedPage: number): number | undefined {
		const rawHeaderPage = response.headers.get("X-Next-Page");
		const headerPage = rawHeaderPage === "" ? undefined : parseDecimalHeader(response.headers, "X-Next-Page", 1);
		if (headerPage !== undefined) {
			if (headerPage <= requestedPage)
				throw new Error(`GitLab X-Next-Page ${headerPage} did not advance beyond requested page ${requestedPage}`);
		}
		const linkPage = nextPageFromLink(response.headers.get("link"), requestedPage);
		if (rawHeaderPage === "" && linkPage !== undefined)
			throw new Error("GitLab X-Next-Page advertised completion but Link advertised a next page");
		if (headerPage !== undefined && linkPage !== undefined && headerPage !== linkPage)
			throw new Error(`GitLab X-Next-Page ${headerPage} disagreed with next-page Link ${linkPage}`);
		return headerPage ?? linkPage;
	}

	function shapeMergeRequest(
		mr: z.infer<typeof GitLabHistoricalMergeRequestResponseSchema>,
	): GitLabHistoricalMergeRequest {
		return {
			iid: mr.iid,
			title: mr.title,
			state: mr.state,
			webUrl: mr.web_url,
			createdAt: mr.created_at,
			updatedAt: mr.updated_at,
			...(mr.merge_commit_sha && { mergeCommitSha: mr.merge_commit_sha }),
			commitSha: mr.sha,
		};
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
				path: project.path_with_namespace,
				defaultBranch,
				headSha: commits[0]?.id ?? "",
				lastActivityAt: project.last_activity_at,
			};
		},
		async tree(projectPath, ref, recursive = false, path) {
			const entries: GitLabTreeEntry[] = [];
			let truncated = false;
			for (let page = 1; page <= 5; page++) {
				const params = new URLSearchParams({ page: String(page), per_page: "100", recursive: String(recursive) });
				if (ref) params.set("ref", ref);
				if (path) params.set("path", path);
				const batch = GitLabTreeResponseSchema.parse(
					await json(`${projectApiPath(projectPath)}/repository/tree?${params.toString()}`),
				);
				entries.push(...batch);
				if (batch.length < 100) break;
				if (page === 5) truncated = true;
			}
			return { entries, truncated };
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
		async pipelineJobs(projectPath, pipelineId, page, perPage) {
			const response = await responseFor(
				`${projectApiPath(projectPath)}/pipelines/${pipelineId}/jobs?${new URLSearchParams({ page: String(page), per_page: String(perPage) }).toString()}`,
			);
			validatePageHeaders(response.headers, page, perPage);
			const jobs = GitLabJobsResponseSchema.parse(await responseJson(response));
			const nextPage = nextPageFrom(response, page);
			return {
				jobs: jobs.map((job) => ({
					id: job.id,
					name: job.name,
					status: job.status,
					webUrl: job.web_url,
				})),
				...(nextPage && { nextPage }),
			};
		},
		jobTrace(projectPath, jobId) {
			return request(`${projectApiPath(projectPath)}/jobs/${jobId}/trace`);
		},
		async historicalMergeRequests(projectPath, updatedAfter, updatedBefore, page, perPage) {
			const params = new URLSearchParams({
				scope: "all",
				state: "all",
				order_by: "updated_at",
				sort: "asc",
				updated_after: updatedAfter,
				page: String(page),
				per_page: String(perPage),
			});
			if (updatedBefore) params.set("updated_before", updatedBefore);
			const response = await responseFor(`${projectApiPath(projectPath)}/merge_requests?${params.toString()}`);
			const text = await response.text();
			if (Buffer.byteLength(text, "utf8") > options.maxResponseBytes) {
				throw new Error(`GitLab response exceeded ${options.maxResponseBytes} bytes`);
			}
			validatePageHeaders(response.headers, page, perPage);
			const mergeRequests = GitLabHistoricalMergeRequestsResponseSchema.parse(JSON.parse(text) as unknown).map(
				shapeMergeRequest,
			);
			const nextPage = nextPageFrom(response, page);
			const totalHeader = response.headers.get("x-total");
			const total = totalHeader === null ? undefined : parseDecimalHeader(response.headers, "X-Total", 0);
			return { mergeRequests, ...(total !== undefined && { total }), ...(nextPage && { nextPage }) };
		},
		async mergeRequest(projectPath, iid) {
			return shapeMergeRequest(
				GitLabHistoricalMergeRequestResponseSchema.parse(
					await json(`${projectApiPath(projectPath)}/merge_requests/${iid}`),
				),
			);
		},
		async mergeRequestPipelines(projectPath, iid, page, perPage) {
			const response = await responseFor(
				`${projectApiPath(projectPath)}/merge_requests/${iid}/pipelines?${new URLSearchParams({ page: String(page), per_page: String(perPage) }).toString()}`,
			);
			validatePageHeaders(response.headers, page, perPage);
			const pipelines = GitLabHistoricalPipelinesResponseSchema.parse(await responseJson(response));
			const nextPage = nextPageFrom(response, page);
			return {
				pipelines: pipelines.map((pipeline) => ({
					id: pipeline.id,
					status: pipeline.status,
					webUrl: pipeline.web_url,
					createdAt: pipeline.created_at,
					updatedAt: pipeline.updated_at,
				})),
				...(nextPage && { nextPage }),
			};
		},
		async projectDeployments(projectPath, page, perPage, updatedBefore) {
			const params = new URLSearchParams({
				status: "success",
				order_by: "updated_at",
				sort: "desc",
				page: String(page),
				per_page: String(perPage),
			});
			if (updatedBefore) params.set("updated_before", updatedBefore);
			const response = await responseFor(`${projectApiPath(projectPath)}/deployments?${params.toString()}`);
			validatePageHeaders(response.headers, page, perPage);
			const deployments = GitLabDeploymentsResponseSchema.parse(await responseJson(response)).map((deployment) => ({
				sha: deployment.sha,
				status: deployment.status,
				updatedAt: deployment.updated_at,
				...(deployment.deployable?.pipeline?.id && { pipelineId: deployment.deployable.pipeline.id }),
			}));
			const nextPage = nextPageFrom(response, page);
			return {
				deployments,
				...(nextPage && { nextPage }),
			};
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
			/^(\s*(?:export\s+)?["']?[a-z0-9_]*(?:password|token|secret|private_key|access_key)[a-z0-9_]*["']?\s*[:=]\s*)([^\r\n,}]+)/gim,
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
			projectPath: project.path,
			webUrl: `https://gitlab.com/${project.path}`,
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
