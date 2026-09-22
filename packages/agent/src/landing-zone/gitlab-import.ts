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

export interface LandingZoneImportOptions {
	repository: string;
	startAt?: string;
	checkpoint?: LandingZoneImportCheckpoint;
	maxPages?: number;
}

export interface LandingZoneImportCheckpoint {
	projectId: string;
	updatedAfter: string;
	page: number;
}

export interface LandingZoneImportDependencies {
	listMergeRequests: (input: { repository: string; updatedAfter: string; page: number }) => Promise<{
		project: HistoricalProject;
		mergeRequests: HistoricalMergeRequest[];
		nextPage?: number;
	}>;
	listPipelines: (input: { repository: string; iid: number }) => Promise<{ pipelines: HistoricalPipeline[] }>;
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
	})
	.passthrough();
const HistoricalPipelinePageSchema = z.object({ pipelines: z.array(HistoricalPipelineSchema) }).passthrough();

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
	const maxPages = options.maxPages ?? 1;
	if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("maxPages must be a positive integer");
	let currentPage = options.checkpoint?.page ?? 1;
	let pagesRead = 0;
	const outcomes: LandingZoneImportOutcome[] = [];
	let checkpoint: LandingZoneImportCheckpoint | undefined;
	let projectId = options.checkpoint?.projectId;
	let latestUpdatedAt = updatedAfter;
	while (pagesRead < maxPages) {
		const page = await resolvedDependencies.listMergeRequests({
			repository: options.repository,
			updatedAfter,
			page: currentPage,
		});
		projectId = String(page.project.id);
		if (options.checkpoint && options.checkpoint.projectId !== projectId) {
			throw new Error(`Checkpoint project ${options.checkpoint.projectId} does not match GitLab project ${projectId}`);
		}
		const repositoryId = `gitlab-project:${projectId}`;
		await resolvedDependencies.writers.recordRepository(resolvedDependencies.store, {
			group: { id: "gitlab-group:pvhcorp", path: "pvhcorp" },
			repository: {
				id: repositoryId,
				groupId: "gitlab-group:pvhcorp",
				path: page.project.path,
				name: options.repository,
				defaultBranch: page.project.defaultBranch,
				webUrl: `https://gitlab.com/${page.project.path}`,
				commitSha: page.project.headSha,
			},
		});
		for (const mr of page.mergeRequests) {
			if (mr.updatedAt > latestUpdatedAt) latestUpdatedAt = mr.updatedAt;
			const pipelines = (
				await resolvedDependencies.listPipelines({ repository: options.repository, iid: mr.iid })
			).pipelines;
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
				});
				if (pipeline.hasTerraformPlan) {
					await resolvedDependencies.writers.recordPlan(resolvedDependencies.store, {
						pipelineId: String(pipeline.id),
						plan: { id: `gitlab:plan:${pipeline.id}`, status: pipeline.status, createdAt: pipeline.createdAt },
					});
				}
			}
		}
		pagesRead++;
		if (!page.nextPage) break;
		currentPage = page.nextPage;
		checkpoint = { projectId, updatedAfter, page: currentPage };
	}
	if (!checkpoint && projectId) checkpoint = { projectId, updatedAfter: latestUpdatedAt, page: 1 };
	return { outcomes, ...(checkpoint && { checkpoint }) };
}

export async function runLandingZoneGitLabImportSweep(
	options?: LandingZoneImportOptions,
): Promise<LandingZoneGitLabImportSweepResult> {
	if (!options?.startAt && !options?.checkpoint) return { outcomes: [], requiresCheckpoint: true };
	return importLandingZoneGitLabHistory(options);
}
