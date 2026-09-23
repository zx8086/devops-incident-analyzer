import {
	assertSafeRepositoryPath,
	boundText,
	type GitLabOpenChange,
	type GitLabReadClient,
	repositoryProvenance,
	resolveRepository,
	sanitizeEvidenceText,
} from "./repositories.ts";

type ContractKind = "schema" | "generator" | "test";

interface EvidenceFile {
	path: string;
	blobId: string;
	kind: ContractKind | "example";
	content: string;
	truncated: boolean;
}

export interface RepresentativeExamplesInput {
	repository: string;
	path?: string;
	ref?: string;
	limit?: number;
}

const archivedPath = /(^|\/)(\.archive|archive|archived|fixtures?|examples?\/fixtures?)(\/|$)/i;
const testPath = /(^|\/)(__tests__|tests?|testdata)(\/|$)|\.(spec|test)\./i;
const schemaPath = /(^|\/)(schemas?)(\/|$)|\.schema\.json$/i;
const generatorPath = /(^|\/)(scripts?)(\/|$).*(generate|render)|(^|\/)(generate|render)[^/]*\.(py|ts|js)$/i;
const activeExtension = /\.(ya?ml|tf|json)$/i;

function contractKind(path: string): ContractKind | undefined {
	if (schemaPath.test(path)) return "schema";
	if (generatorPath.test(path)) return "generator";
	if (testPath.test(path)) return "test";
	return undefined;
}

async function readEvidenceFile(
	client: GitLabReadClient,
	projectPath: string,
	path: string,
	ref: string,
	kind: EvidenceFile["kind"],
): Promise<EvidenceFile> {
	assertSafeRepositoryPath(path);
	const file = await client.readFile(projectPath, path, ref);
	const bounded = boundText(sanitizeEvidenceText(file.content), 20_000);
	return { path, blobId: file.blobId, kind, content: bounded.content, truncated: bounded.truncated };
}

async function relevantOpenChanges(
	client: GitLabReadClient,
	projectPath: string,
	pathPrefix: string | undefined,
): Promise<Array<GitLabOpenChange & { paths: string[] }>> {
	const openChanges = await client.openChanges(projectPath);
	const withPaths = await Promise.all(
		openChanges.slice(0, 20).map(async (change) => ({
			...change,
			paths: await client.changePaths(projectPath, change.iid),
		})),
	);
	if (!pathPrefix) return withPaths;
	return withPaths.filter((change) => change.paths.some((path) => path.startsWith(pathPrefix)));
}

export async function findRepresentativeExamples(client: GitLabReadClient, input: RepresentativeExamplesInput) {
	const repository = resolveRepository(input.repository);
	if (repository.availability === "no-git-refs") throw new Error(`${repository.name} has no Git refs`);
	const { project, provenance } = await repositoryProvenance(client, repository, input.ref);
	const tree = await client.tree(repository.projectPath, provenance.ref, true);
	const blobs = tree.entries.filter((entry) => entry.type === "blob").map((entry) => entry.path);

	const contractPaths = new Map<ContractKind, string>();
	for (const path of blobs) {
		const kind = contractKind(path);
		if (kind && !contractPaths.has(kind)) contractPaths.set(kind, path);
	}

	const limit = Math.min(Math.max(input.limit ?? 5, 3), 5);
	const examples = blobs
		.filter((path) => !input.path || path.startsWith(input.path))
		.filter(
			(path) =>
				activeExtension.test(path) && !archivedPath.test(path) && !testPath.test(path) && !schemaPath.test(path),
		)
		.slice(0, limit);

	const contracts = await Promise.all(
		[...contractPaths.entries()].map(([kind, path]) =>
			readEvidenceFile(client, repository.projectPath, path, provenance.ref, kind),
		),
	);
	const exampleEvidence = await Promise.all(
		examples.map((path) => readEvidenceFile(client, repository.projectPath, path, provenance.ref, "example")),
	);
	const openChanges = await relevantOpenChanges(client, repository.projectPath, input.path);
	const truncated = [...contracts, ...exampleEvidence].some((item) => item.truncated);
	const missingContracts = (["schema", "generator", "test"] as const).filter((kind) => !contractPaths.has(kind));
	const warnings = [
		...(exampleEvidence.length < 3 ? [`Only ${exampleEvidence.length} active examples were available`] : []),
		...(missingContracts.length > 0 ? [`Contract evidence not found: ${missingContracts.join(", ")}`] : []),
		...(tree.truncated ? ["Repository tree evidence was truncated at 500 entries"] : []),
	];

	return {
		repository,
		project: { id: project.id, path: project.path, defaultBranch: project.defaultBranch, headSha: project.headSha },
		contracts,
		examples: exampleEvidence,
		openChanges,
		warnings,
		provenance: { ...provenance, truncated: truncated || tree.truncated },
	};
}

export async function listOpenChanges(client: GitLabReadClient, input: { repository: string; path?: string }) {
	const repository = resolveRepository(input.repository);
	const { provenance } = await repositoryProvenance(client, repository);
	return {
		repository,
		openChanges: await relevantOpenChanges(client, repository.projectPath, input.path),
		provenance,
	};
}

export async function listHistoricalMergeRequests(
	client: GitLabReadClient,
	input: { repository: string; updatedAfter: string; updatedBefore?: string; page?: number; perPage?: number },
) {
	const repository = resolveRepository(input.repository);
	if (repository.availability === "no-git-refs") throw new Error(`${repository.name} has no Git refs`);
	const { project, provenance } = await repositoryProvenance(client, repository);
	const page = input.page ?? 1;
	const perPage = input.perPage ?? 20;
	if (!Number.isInteger(page) || page < 1) throw new Error("page must be a positive integer");
	if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) throw new Error("perPage must be between 1 and 100");
	const result = await client.historicalMergeRequests(
		repository.projectPath,
		input.updatedAfter,
		input.updatedBefore,
		page,
		perPage,
	);
	return {
		repository,
		project: { id: project.id, path: project.path, defaultBranch: project.defaultBranch, headSha: project.headSha },
		mergeRequests: result.mergeRequests,
		...(result.total !== undefined && { total: result.total }),
		...(result.nextPage && { nextPage: result.nextPage }),
		provenance,
	};
}

export async function readMergeRequest(client: GitLabReadClient, input: { repository: string; iid: number }) {
	const repository = resolveRepository(input.repository);
	if (repository.availability === "no-git-refs") throw new Error(`${repository.name} has no Git refs`);
	if (!Number.isInteger(input.iid) || input.iid < 1) throw new Error("iid must be a positive integer");
	const { project, provenance } = await repositoryProvenance(client, repository);
	return {
		repository,
		project: { id: project.id, path: project.path, defaultBranch: project.defaultBranch, headSha: project.headSha },
		mergeRequest: await client.mergeRequest(project.path, input.iid),
		provenance,
	};
}

const MAX_PIPELINE_PAGES = 3;
const MAX_JOB_PAGES = 3;
const PIPELINES_PER_PAGE = 20;
const JOBS_PER_PAGE = 100;

async function listBoundedPipelineJobs(client: GitLabReadClient, projectPath: string, pipelineId: number) {
	const jobs = [];
	let page = 1;
	let truncated = false;
	for (let pagesRead = 0; pagesRead < MAX_JOB_PAGES; pagesRead++) {
		const result = await client.pipelineJobs(projectPath, pipelineId, page, JOBS_PER_PAGE);
		jobs.push(...result.jobs);
		if (!result.nextPage) break;
		if (pagesRead === MAX_JOB_PAGES - 1) {
			truncated = true;
			break;
		}
		page = result.nextPage;
	}
	return { jobs, truncated };
}

export async function listMergeRequestPipelines(client: GitLabReadClient, input: { repository: string; iid: number }) {
	const repository = resolveRepository(input.repository);
	if (repository.availability === "no-git-refs") throw new Error(`${repository.name} has no Git refs`);
	const { provenance } = await repositoryProvenance(client, repository);
	const pipelines = [];
	let page = 1;
	let truncated = false;
	for (let pagesRead = 0; pagesRead < MAX_PIPELINE_PAGES; pagesRead++) {
		const result = await client.mergeRequestPipelines(repository.projectPath, input.iid, page, PIPELINES_PER_PAGE);
		for (const pipeline of result.pipelines) {
			const jobsPage = await listBoundedPipelineJobs(client, repository.projectPath, pipeline.id);
			truncated ||= jobsPage.truncated;
			pipelines.push({
				...pipeline,
				planJobs: jobsPage.jobs
					.filter((job) => /(^|[-_:])(terraform[-_:]?)?plan($|[-_:])/i.test(job.name))
					.map((job) => ({ id: job.id, status: job.status, webUrl: job.webUrl })),
			});
		}
		if (!result.nextPage) break;
		if (pagesRead === MAX_PIPELINE_PAGES - 1) {
			truncated = true;
			break;
		}
		page = result.nextPage;
	}
	return {
		repository,
		iid: input.iid,
		pipelines,
		provenance: { ...provenance, truncated },
	};
}

export async function listProjectDeployments(
	client: GitLabReadClient,
	input: { repository: string; commitSha: string; page?: number; updatedBefore?: string },
) {
	const repository = resolveRepository(input.repository);
	if (repository.availability === "no-git-refs") throw new Error(`${repository.name} has no Git refs`);
	if (!client.projectDeployments) throw new Error("GitLab deployments evidence is unavailable");
	const { project, provenance } = await repositoryProvenance(client, repository);
	const deployments = [];
	let page = input.page ?? 1;
	if (!Number.isInteger(page) || page < 1) throw new Error("page must be a positive integer");
	let truncated = false;
	let nextPage: number | undefined;
	for (let read = 0; read < 3; read++) {
		const result = await client.projectDeployments(project.path, page, 20, input.updatedBefore);
		deployments.push(...result.deployments.filter((deployment) => deployment.sha === input.commitSha));
		if (deployments.length > 0 || !result.nextPage) {
			nextPage = result.nextPage;
			truncated = result.nextPage !== undefined;
			break;
		}
		if (result.nextPage <= page) throw new Error("GitLab deployment cursor did not advance");
		nextPage = result.nextPage;
		if (read === 2) {
			truncated = true;
			break;
		}
		page = result.nextPage;
	}
	return {
		repository,
		deployments,
		...(nextPage && { nextPage }),
		provenance: { ...provenance, truncated },
	};
}

export async function readPipelinePlan(client: GitLabReadClient, input: { repository: string; pipelineId: number }) {
	const repository = resolveRepository(input.repository);
	const { provenance } = await repositoryProvenance(client, repository);
	const boundedJobs = await listBoundedPipelineJobs(client, repository.projectPath, input.pipelineId);
	const jobs = boundedJobs.jobs.filter((job) => /(^|[-_:])(terraform[-_:]?)?plan($|[-_:])/i.test(job.name));
	const planJobs = await Promise.all(
		jobs.slice(0, 10).map(async (job) => {
			const trace = boundText(sanitizeEvidenceText(await client.jobTrace(repository.projectPath, job.id)), 18_000);
			return { ...job, trace: trace.content, truncated: trace.truncated };
		}),
	);
	return {
		repository,
		pipelineId: input.pipelineId,
		jobs: planJobs,
		provenance: { ...provenance, truncated: boundedJobs.truncated || planJobs.some((job) => job.truncated) },
	};
}
