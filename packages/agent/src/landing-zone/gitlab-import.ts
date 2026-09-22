// packages/agent/src/landing-zone/gitlab-import.ts

import {
	getGraphStore,
	isKnowledgeGraphEnabled,
	recordLandingZoneChange,
	recordLandingZoneRepository,
	recordPipeline,
	recordTerraformPlan,
	type GraphStore,
	type LandingZoneChangeRecord,
	type LandingZoneRepositoryRecord,
	type PipelineRecord,
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
}

export interface LandingZoneImportDependencies {
	listRepositories?: () => Promise<Array<{ name: string; availability: "active" | "no-git-refs" }>>;
	readCheckpoint?: (store: GraphStore, repository: string) => Promise<LandingZoneImportCheckpoint | undefined>;
	recordCheckpoint?: (store: GraphStore, checkpoint: LandingZoneImportCheckpoint) => Promise<void>;
	listMergeRequests: (input: { repository: string; updatedAfter: string; page: number }) => Promise<{
		project: HistoricalProject;
		mergeRequests: HistoricalMergeRequest[];
		nextPage?: number;
		provenance?: HistoricalProvenance;
	}>;
	listPipelines: (input: { repository: string; iid: number }) => Promise<{ pipelines: HistoricalPipeline[]; provenance?: HistoricalProvenance }>;
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
		provenance: z.object({ source: z.literal("gitlab"), retrievedAt: z.string().datetime(), truncated: z.boolean() }).optional(),
	})
	.passthrough();
const HistoricalPipelinePageSchema = z.object({ pipelines: z.array(HistoricalPipelineSchema), provenance: z.object({ source: z.literal("gitlab"), retrievedAt: z.string().datetime(), truncated: z.boolean() }).optional() }).passthrough();
const RepositoryCatalogSchema = z.object({ repositories: z.array(z.object({ name: z.string(), availability: z.enum(["active", "no-git-refs"]) })) });

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
		listRepositories: async () => RepositoryCatalogSchema.parse(await invokeReadTool("lz_list_repositories", {})).repositories,
		readCheckpoint: async (store, repository) => {
			const rows = await store.run<{ id?: string; updatedAfter?: string }>(
				"MATCH (r:Repository {name: $repository}) RETURN r.id AS id, r.gitlabImportUpdatedAfter AS updatedAfter",
				{ repository },
			);
			const updatedAfter = rows[0]?.updatedAfter;
			const projectId = rows[0]?.id?.replace("gitlab-project:", "");
			return updatedAfter && projectId ? { projectId, updatedAfter } : undefined;
		},
		recordCheckpoint: async (store, checkpoint) => {
			await store.run(
				"MATCH (r:Repository {id: $repositoryId}) SET r.gitlabImportUpdatedAfter = $updatedAfter, r.gitlabImportCheckpointedAt = $checkpointedAt",
				{ repositoryId: `gitlab-project:${checkpoint.projectId}`, updatedAfter: checkpoint.updatedAfter, checkpointedAt: new Date().toISOString() },
			);
		},
		listMergeRequests: async (input) =>
			HistoricalMergeRequestPageSchema.parse(
				await invokeReadTool("lz_list_historical_merge_requests", {
					repository: input.repository,
					updatedAfter: input.updatedAfter,
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
	if (options.maxPages !== undefined && options.maxPages !== 1) {
		throw new Error("maxPages must be 1 when importing GitLab history with an overlap checkpoint");
	}
	const outcomes: LandingZoneImportOutcome[] = [];
	let projectId = options.checkpoint?.projectId;
	let latestUpdatedAt = updatedAfter;
	const page = await resolvedDependencies.listMergeRequests({
		repository: options.repository,
		updatedAfter,
		page: 1,
	});
	projectId = String(page.project.id);
	if (options.checkpoint && options.checkpoint.projectId !== projectId) {
		throw new Error(`Checkpoint project ${options.checkpoint.projectId} does not match GitLab project ${projectId}`);
	}
	const repositoryId = `gitlab-project:${projectId}`;
	await resolvedDependencies.writers.recordRepository(resolvedDependencies.store, {
		group: { id: "gitlab-group:pvhcorp", path: "pvhcorp", lastSyncedAt: page.provenance?.retrievedAt },
		repository: {
			id: repositoryId,
			groupId: "gitlab-group:pvhcorp",
			path: page.project.path,
			name: options.repository,
			defaultBranch: page.project.defaultBranch,
			webUrl: `https://gitlab.com/${page.project.path}`,
			commitSha: page.project.headSha,
			lastSyncedAt: page.provenance?.retrievedAt,
		},
		provenance: page.provenance,
	});
	for (const mr of page.mergeRequests) {
		if (mr.updatedAt > latestUpdatedAt) latestUpdatedAt = mr.updatedAt;
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
	const bounded = page.nextPage !== undefined;
	if (!projectId) return { outcomes };
	const overlap =
		bounded && latestUpdatedAt !== updatedAfter
			? new Date(Date.parse(latestUpdatedAt) - 1_000).toISOString()
			: latestUpdatedAt;
	const checkpoint = { projectId, updatedAfter: overlap };
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
