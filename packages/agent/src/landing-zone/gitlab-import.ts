// packages/agent/src/landing-zone/gitlab-import.ts

import {
	type GraphStore,
	getGraphStore,
	isKnowledgeGraphEnabled,
	type LandingZoneChangeRecord,
	type LandingZoneRepositoryRecord,
	type PipelineRecord,
	readLandingZoneGitLabImportCheckpoint,
	recordLandingZoneChange,
	recordLandingZoneGitLabImportCheckpoint,
	recordLandingZoneRepository,
	recordPipeline,
	recordTerraformPlan,
	type TerraformPlanRecord,
} from "@devops-agent/knowledge-graph";
import { z } from "zod";
import { getToolsForDataSource } from "../mcp-bridge.ts";

export type LandingZoneImportOutcome = "proposed" | "declined" | "pipeline-failed" | "merged-unverified" | "applied";

export interface HistoricalProject {
	id: number;
	path: string;
	defaultBranch: string;
	headSha: string;
}

export interface HistoricalMergeRequest {
	iid: number;
	title: string;
	state: "opened" | "closed" | "merged";
	webUrl: string;
	createdAt: string;
	updatedAt: string;
	mergeCommitSha?: string;
	commitSha?: string;
	verifiedLiveState?: boolean;
}

export interface HistoricalPipeline {
	id: number;
	status: string;
	webUrl: string;
	createdAt: string;
	updatedAt: string;
	hasTerraformPlan: boolean;
	isVerifiedDeployment: boolean;
}

export interface HistoricalProvenance {
	source: "gitlab";
	retrievedAt: string;
	truncated: boolean;
}

export interface LandingZoneImportOptions {
	repository: string;
	startAt?: string;
	checkpoint?: LandingZoneImportCheckpoint;
	maxPages?: number;
}

export interface LandingZoneImportCheckpoint {
	projectId: string;
	updatedAfter: string;
	inProgress?: { upperBound: string; expectedTotal: number; nextPage: number; seenMrIds: string[] };
}

export interface LandingZoneImportDependencies {
	listRepositories?: () => Promise<Array<{ name: string; availability: "active" | "no-git-refs" }>>;
	readCheckpoint?: (store: GraphStore, repository: string) => Promise<LandingZoneImportCheckpoint | undefined>;
	recordCheckpoint?: (store: GraphStore, checkpoint: LandingZoneImportCheckpoint) => Promise<void>;
	listMergeRequests: (input: {
		repository: string;
		updatedAfter: string;
		updatedBefore?: string;
		page: number;
	}) => Promise<{
		project: HistoricalProject;
		mergeRequests: HistoricalMergeRequest[];
		total: number;
		nextPage?: number;
		provenance?: HistoricalProvenance;
	}>;
	listPipelines: (input: {
		repository: string;
		iid: number;
	}) => Promise<{ pipelines: HistoricalPipeline[]; provenance?: HistoricalProvenance }>;
	store: GraphStore;
	writers: {
		recordRepository: (store: GraphStore, record: LandingZoneRepositoryRecord) => Promise<void>;
		recordChange: (store: GraphStore, change: LandingZoneChangeRecord) => Promise<void>;
		recordPipeline: (store: GraphStore, pipeline: PipelineRecord) => Promise<void>;
		recordPlan: (store: GraphStore, plan: TerraformPlanRecord) => Promise<void>;
	};
}

export interface LandingZoneImportResult {
	outcomes: LandingZoneImportOutcome[];
	checkpoint?: LandingZoneImportCheckpoint;
}

export interface LandingZoneGitLabImportSweepResult extends LandingZoneImportResult {
	requiresCheckpoint?: true;
}

const HistoricalProjectSchema = z
	.object({ id: z.number().int().positive(), path: z.string().min(1), defaultBranch: z.string(), headSha: z.string() })
	.strict();
const HistoricalMergeRequestSchema = z
	.object({
		iid: z.number().int().positive(),
		title: z.string(),
		state: z.enum(["opened", "closed", "merged"]),
		webUrl: z.string().url(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		mergeCommitSha: z.string().min(1).optional(),
		commitSha: z.string().min(1).optional(),
		verifiedLiveState: z.boolean().optional(),
	})
	.strict();
const HistoricalPipelineSchema = z
	.object({
		id: z.number().int().positive(),
		status: z.string().min(1),
		webUrl: z.string().url(),
		createdAt: z.string().datetime(),
		updatedAt: z.string().datetime(),
		hasTerraformPlan: z.boolean(),
		isVerifiedDeployment: z.boolean(),
	})
	.strict();
const HistoricalMergeRequestPageSchema = z
	.object({
		project: HistoricalProjectSchema,
		mergeRequests: z.array(HistoricalMergeRequestSchema),
		nextPage: z.number().int().positive().optional(),
		total: z.number().int().nonnegative(),
		provenance: z
			.object({ source: z.literal("gitlab"), retrievedAt: z.string().datetime(), truncated: z.boolean() })
			.optional(),
	})
	.passthrough();
const HistoricalPipelinePageSchema = z
	.object({
		pipelines: z.array(HistoricalPipelineSchema),
		provenance: z
			.object({ source: z.literal("gitlab"), retrievedAt: z.string().datetime(), truncated: z.boolean() })
			.optional(),
	})
	.passthrough();
const RepositoryCatalogSchema = z.object({
	repositories: z.array(z.object({ name: z.string(), availability: z.enum(["active", "no-git-refs"]) })),
});

interface LandingZoneReadTool {
	name: string;
	invoke(input: Record<string, unknown>): Promise<unknown>;
}

function parseToolPayload(value: unknown): unknown {
	if (typeof value === "string") return JSON.parse(value) as unknown;
	if (typeof value !== "object" || value === null) return value;
	const content = (value as { content?: unknown }).content;
	if (!Array.isArray(content)) return value;
	const text = content.find((part) => typeof part === "object" && part !== null && "text" in part) as
		| { text?: unknown }
		| undefined;
	if (!text || typeof text.text !== "string") return value;
	return JSON.parse(text.text) as unknown;
}

async function invokeReadTool(name: string, input: Record<string, unknown>): Promise<unknown> {
	const tool = getToolsForDataSource("landing-zone-iac").find((candidate) => candidate.name === name) as
		| LandingZoneReadTool
		| undefined;
	if (!tool) throw new Error(`${name} is not connected`);
	return parseToolPayload(await tool.invoke(input));
}

function defaultDependencies(): LandingZoneImportDependencies {
	return {
		listRepositories: async () =>
			RepositoryCatalogSchema.parse(await invokeReadTool("lz_list_repositories", {})).repositories,
		readCheckpoint: readLandingZoneGitLabImportCheckpoint,
		recordCheckpoint: async (store, checkpoint) =>
			recordLandingZoneGitLabImportCheckpoint(store, checkpoint.projectId, checkpoint),
		listMergeRequests: async (input) =>
			HistoricalMergeRequestPageSchema.parse(
				await invokeReadTool("lz_list_historical_merge_requests", {
					repository: input.repository,
					updatedAfter: input.updatedAfter,
					...(input.updatedBefore && { updatedBefore: input.updatedBefore }),
					page: input.page,
					perPage: 20,
				}),
			),
		listPipelines: async (input) =>
			HistoricalPipelinePageSchema.parse(
				await invokeReadTool("lz_list_merge_request_pipelines", { repository: input.repository, iid: input.iid }),
			),
		store: undefined as unknown as GraphStore,
		writers: {
			recordRepository: recordLandingZoneRepository,
			recordChange: recordLandingZoneChange,
			recordPipeline,
			recordPlan: recordTerraformPlan,
		},
	};
}

export function landingZoneGitLabImportEnabled(): boolean {
	return isKnowledgeGraphEnabled();
}

function outcomeFor(mr: HistoricalMergeRequest, pipelines: HistoricalPipeline[]): LandingZoneImportOutcome {
	if (mr.state === "opened") return "proposed";
	if (mr.state === "closed") return "declined";
	if (
		mr.verifiedLiveState ||
		pipelines.some((pipeline) => pipeline.isVerifiedDeployment && pipeline.status === "success")
	)
		return "applied";
	if (pipelines.some((pipeline) => pipeline.status === "failed")) return "pipeline-failed";
	return "merged-unverified";
}

export async function importLandingZoneGitLabHistory(
	options: LandingZoneImportOptions,
	dependencies?: LandingZoneImportDependencies,
): Promise<LandingZoneImportResult> {
	const resolvedDependencies = dependencies ?? defaultDependencies();
	if (!dependencies) resolvedDependencies.store = await getGraphStore();
	const updatedAfter = options.checkpoint?.updatedAfter ?? options.startAt;
	if (!updatedAfter) throw new Error("A startAt timestamp or checkpoint is required for Landing Zone history import");
	const maxPages = options.maxPages ?? 5;
	if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("maxPages must be a positive integer");
	const outcomes: LandingZoneImportOutcome[] = [];
	let projectId = options.checkpoint?.projectId;
	const upperBound = options.checkpoint?.inProgress?.upperBound ?? new Date().toISOString();
	let expectedTotal = options.checkpoint?.inProgress?.expectedTotal;
	let nextPage = options.checkpoint?.inProgress?.nextPage ?? 1;
	const pages = [];
	for (let pagesRead = 0; pagesRead < maxPages; pagesRead++) {
		const page = await resolvedDependencies.listMergeRequests({
			repository: options.repository,
			updatedAfter,
			updatedBefore: upperBound,
			page: nextPage,
		});
		if (expectedTotal !== undefined && page.total !== expectedTotal) {
			const pageProjectId = String(page.project.id);
			if (options.checkpoint?.projectId !== pageProjectId) {
				throw new Error(
					`Checkpoint project ${options.checkpoint?.projectId} does not match GitLab project ${pageProjectId}`,
				);
			}
			const checkpoint = {
				projectId: pageProjectId,
				updatedAfter,
				inProgress: { upperBound, expectedTotal: page.total, nextPage: 1, seenMrIds: [] },
			};
			await resolvedDependencies.recordCheckpoint?.(resolvedDependencies.store, checkpoint);
			return {
				outcomes,
				checkpoint,
			};
		}
		expectedTotal = page.total;
		pages.push(page);
		if (!page.nextPage) break;
		nextPage = page.nextPage;
	}
	const firstPage = pages[0];
	if (!firstPage) return { outcomes };
	projectId = String(firstPage.project.id);
	if (options.checkpoint && options.checkpoint.projectId !== projectId) {
		throw new Error(`Checkpoint project ${options.checkpoint.projectId} does not match GitLab project ${projectId}`);
	}
	const repositoryId = `gitlab-project:${projectId}`;
	await resolvedDependencies.writers.recordRepository(resolvedDependencies.store, {
		group: { id: "gitlab-group:pvhcorp", path: "pvhcorp", lastSyncedAt: firstPage.provenance?.retrievedAt },
		repository: {
			id: repositoryId,
			groupId: "gitlab-group:pvhcorp",
			path: firstPage.project.path,
			name: options.repository,
			defaultBranch: firstPage.project.defaultBranch,
			webUrl: `https://gitlab.com/${firstPage.project.path}`,
			commitSha: firstPage.project.headSha,
			lastSyncedAt: firstPage.provenance?.retrievedAt,
		},
		provenance: firstPage.provenance,
	});
	const seenMrIds = new Set(options.checkpoint?.inProgress?.seenMrIds ?? []);
	for (const page of pages) {
		for (const mr of page.mergeRequests) {
			const stableMrId = `${projectId}:${mr.iid}`;
			seenMrIds.add(stableMrId);
			if (seenMrIds.size > 10_000)
				throw new Error(`GitLab import stable MR ID safety limit exceeded for ${options.repository}`);
			const pipelinePage = await resolvedDependencies.listPipelines({ repository: options.repository, iid: mr.iid });
			const pipelines = pipelinePage.pipelines;
			const outcome = outcomeFor(mr, pipelines);
			outcomes.push(outcome);
			const mrId = `${projectId}:${mr.iid}`;
			const commitSha = mr.mergeCommitSha ?? mr.commitSha;
			if (!commitSha) throw new Error(`GitLab merge request ${mrId} did not provide a commit SHA`);
			await resolvedDependencies.writers.recordChange(resolvedDependencies.store, {
				id: `gitlab:${mrId}:${commitSha}`,
				repositoryId,
				summary: mr.title,
				createdAt: mr.createdAt,
				lastSyncedAt: page.provenance?.retrievedAt,
				source: page.provenance?.source,
				truncated: page.provenance?.truncated,
				outcome,
				mergeRequest: {
					id: mrId,
					projectId,
					iid: String(mr.iid),
					webUrl: mr.webUrl,
					lastSyncedAt: mr.updatedAt,
				},
			});
			for (const pipeline of pipelines) {
				await resolvedDependencies.writers.recordPipeline(resolvedDependencies.store, {
					mrUrl: mr.webUrl,
					mrId,
					projectId,
					iid: String(mr.iid),
					pipelineId: pipeline.id,
					status: pipeline.status,
					url: pipeline.webUrl,
					createdAt: pipeline.createdAt,
					updatedAt: pipeline.updatedAt,
					lastSyncedAt: pipelinePage.provenance?.retrievedAt,
					source: pipelinePage.provenance?.source,
					truncated: pipelinePage.provenance?.truncated,
				});
				if (pipeline.hasTerraformPlan) {
					await resolvedDependencies.writers.recordPlan(resolvedDependencies.store, {
						pipelineId: String(pipeline.id),
						plan: { id: `gitlab:plan:${pipeline.id}`, status: pipeline.status, createdAt: pipeline.createdAt },
						source: pipelinePage.provenance?.source,
						lastSyncedAt: pipelinePage.provenance?.retrievedAt,
						truncated: pipelinePage.provenance?.truncated,
					});
				}
			}
		}
	}
	if (!projectId) return { outcomes };
	const lastPage = pages.at(-1);
	if (!lastPage || expectedTotal === undefined)
		throw new Error("GitLab historical merge request response omitted a valid total");
	if (seenMrIds.size > expectedTotal)
		throw new Error(`GitLab historical merge request total changed for ${options.repository}`);
	const checkpoint = lastPage.nextPage
		? { projectId, updatedAfter, inProgress: { upperBound, expectedTotal, nextPage, seenMrIds: [...seenMrIds].sort() } }
		: seenMrIds.size === expectedTotal
			? {
					projectId,
					updatedAfter: new Date(Math.max(Date.parse(updatedAfter) + 1, Date.parse(upperBound) - 1)).toISOString(),
				}
			: {
					projectId,
					updatedAfter,
					inProgress: { upperBound, expectedTotal, nextPage: 1, seenMrIds: [...seenMrIds].sort() },
				};
	await resolvedDependencies.recordCheckpoint?.(resolvedDependencies.store, checkpoint);
	return { outcomes, checkpoint };
}

export async function runLandingZoneGitLabImportSweep(
	options?: LandingZoneImportOptions,
	providedDependencies?: LandingZoneImportDependencies,
): Promise<LandingZoneGitLabImportSweepResult> {
	if (options?.startAt || options?.checkpoint) return importLandingZoneGitLabHistory(options, providedDependencies);
	const dependencies = providedDependencies ?? defaultDependencies();
	if (!providedDependencies) dependencies.store = await getGraphStore();
	const repositories = (await dependencies.listRepositories?.()) ?? [];
	const outcomes: LandingZoneImportOutcome[] = [];
	let requiresCheckpoint = false;
	for (const repository of repositories) {
		if (repository.availability !== "active") continue;
		const checkpoint = await dependencies.readCheckpoint?.(dependencies.store, repository.name);
		if (!checkpoint) {
			requiresCheckpoint = true;
			continue;
		}
		const result = await importLandingZoneGitLabHistory({ repository: repository.name, checkpoint }, dependencies);
		outcomes.push(...result.outcomes);
	}
	return { outcomes, ...(requiresCheckpoint && { requiresCheckpoint: true }) };
}
