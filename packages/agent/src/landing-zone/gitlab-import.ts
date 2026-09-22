// packages/agent/src/landing-zone/gitlab-import.ts

import { createHash } from "node:crypto";
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
import { recordAgentFactNow, searchAgentMemory, selectedBackend } from "../memory-backend.ts";

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
	state: "opened" | "closed" | "locked" | "merged";
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
	planJobs: Array<{ id: number; status: string; webUrl: string }>;
}

export interface HistoricalDeployment {
	sha: string;
	status: string;
	updatedAt: string;
	pipelineId?: number;
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
	reconcilePending?: boolean;
	maxPendingReconciliations?: number;
}

export interface LandingZoneImportCheckpoint {
	projectId: string;
	updatedAfter: string;
	backfillStartAt?: string;
	repositoryPath?: string;
	inProgress?: { upperBound: string; expectedTotal?: number; nextPage: number; seenMrIds: string[] };
	pendingMrIids?: number[];
	pendingCursor?: number;
	pendingDeploymentScans?: Record<string, { sha: string; nextPage: number; updatedBefore: string }>;
}

export interface LandingZoneImportDependencies {
	listRepositories?: () => Promise<Array<{ name: string; availability: "active" | "no-git-refs" }>>;
	readCheckpoint?: (store: GraphStore, repository: string) => Promise<LandingZoneImportCheckpoint | undefined>;
	recordCheckpoint?: (store: GraphStore, checkpoint: LandingZoneImportCheckpoint) => Promise<void>;
	recordRecoveryStart?: (repository: string, checkpoint: LandingZoneImportCheckpoint) => Promise<void>;
	listMergeRequests: (input: {
		repository: string;
		updatedAfter: string;
		updatedBefore?: string;
		page: number;
	}) => Promise<{
		project: HistoricalProject;
		mergeRequests: HistoricalMergeRequest[];
		total?: number;
		nextPage?: number;
		provenance?: HistoricalProvenance;
	}>;
	readMergeRequest?: (input: { repository: string; iid: number }) => Promise<{
		project: HistoricalProject;
		mergeRequest: HistoricalMergeRequest;
		provenance?: HistoricalProvenance;
	}>;
	listPipelines: (input: {
		repository: string;
		iid: number;
	}) => Promise<{ pipelines: HistoricalPipeline[]; provenance?: HistoricalProvenance }>;
	listDeployments?: (input: {
		repository: string;
		commitSha: string;
		page?: number;
		updatedBefore?: string;
	}) => Promise<{
		deployments: HistoricalDeployment[];
		nextPage?: number;
		provenance?: HistoricalProvenance;
	}>;
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
	authBackoff?: true;
	projectErrors?: Array<{ repository: string; message: string }>;
	unavailable?: string;
}

export const LANDING_ZONE_GITLAB_IMPORT_REQUIRED_TOOLS = [
	"lz_list_repositories",
	"lz_list_historical_merge_requests",
	"lz_read_merge_request",
	"lz_list_merge_request_pipelines",
	"lz_list_project_deployments",
] as const;

export const MAX_PENDING_MERGE_REQUESTS = 1_000;
const DEFAULT_PENDING_RECONCILIATIONS = 20;

const HistoricalProjectSchema = z
	.object({ id: z.number().int().positive(), path: z.string().min(1), defaultBranch: z.string(), headSha: z.string() })
	.strict();
const HistoricalMergeRequestSchema = z
	.object({
		iid: z.number().int().positive(),
		title: z.string(),
		state: z.enum(["opened", "closed", "locked", "merged"]),
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
		planJobs: z.array(
			z.object({ id: z.number().int().positive(), status: z.string().min(1), webUrl: z.string().url() }).strict(),
		),
	})
	.strict();
const HistoricalMergeRequestPageSchema = z
	.object({
		project: HistoricalProjectSchema,
		mergeRequests: z.array(HistoricalMergeRequestSchema),
		nextPage: z.number().int().positive().optional(),
		total: z.number().int().nonnegative().optional(),
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
const HistoricalMergeRequestReadSchema = z
	.object({
		project: HistoricalProjectSchema,
		mergeRequest: HistoricalMergeRequestSchema,
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
		recordRecoveryStart: async (repository, checkpoint) => {
			if (!checkpoint.backfillStartAt || !checkpoint.repositoryPath) return;
			const annotations = {
				kind: "kg-lz-gitlab-import-start",
				repository,
				project_id: checkpoint.projectId,
			};
			const existing = await searchAgentMemory("landing-zone-terraform", "", annotations, 1, {
				allSessions: true,
				deterministic: true,
			});
			if (existing.length > 0) return;
			const recorded = await recordAgentFactNow(
				"landing-zone-terraform",
				`Landing Zone GitLab import recovery anchor for ${repository}`,
				{
					...annotations,
					project_path: checkpoint.repositoryPath,
					backfill_start_at: checkpoint.backfillStartAt,
				},
			);
			if (!recorded && selectedBackend() === "agent-memory") {
				throw new Error(`Landing Zone GitLab recovery anchor was not persisted for ${repository}`);
			}
		},
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
		readMergeRequest: async (input) =>
			HistoricalMergeRequestReadSchema.parse(
				await invokeReadTool("lz_read_merge_request", { repository: input.repository, iid: input.iid }),
			),
		listPipelines: async (input) =>
			HistoricalPipelinePageSchema.parse(
				await invokeReadTool("lz_list_merge_request_pipelines", { repository: input.repository, iid: input.iid }),
			),
		listDeployments: async (input) =>
			z
				.object({
					deployments: z.array(
						z.object({
							sha: z.string().min(1),
							status: z.string().min(1),
							updatedAt: z.string().datetime(),
							pipelineId: z.number().int().positive().optional(),
						}),
					),
					nextPage: z.number().int().positive().optional(),
					provenance: z
						.object({ source: z.literal("gitlab"), retrievedAt: z.string().datetime(), truncated: z.boolean() })
						.optional(),
				})
				.parse(await invokeReadTool("lz_list_project_deployments", input)),
		store: undefined as unknown as GraphStore,
		writers: {
			recordRepository: recordLandingZoneRepository,
			recordChange: recordLandingZoneChange,
			recordPipeline,
			recordPlan: recordTerraformPlan,
		},
	};
}

export function landingZoneGitLabImportEnabled(
	graphAvailable = isKnowledgeGraphEnabled(),
	toolNames: readonly string[] = getToolsForDataSource("landing-zone-iac").map((tool) => tool.name),
): boolean {
	const available = new Set(toolNames);
	return graphAvailable && LANDING_ZONE_GITLAB_IMPORT_REQUIRED_TOOLS.every((name) => available.has(name));
}

type OutcomeEvidenceSource = "gitlab-deployment" | "gitlab-pipeline" | "gitlab-mr" | "live-state";

interface OutcomeEvidence {
	source: OutcomeEvidenceSource;
	observedAt: string;
	retrievedAt?: string;
	commitSha?: string;
	pipelineId?: string;
	truncated: boolean;
}

function latestPipeline(pipelines: HistoricalPipeline[]): HistoricalPipeline | undefined {
	return [...pipelines].sort((left, right) => {
		const timeOrder = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
		return timeOrder === 0 ? right.id - left.id : timeOrder;
	})[0];
}

function outcomeFor(
	mr: HistoricalMergeRequest,
	pipelines: HistoricalPipeline[],
	deployments: HistoricalDeployment[],
	commitSha: string,
	provenance: {
		mr?: HistoricalProvenance;
		pipelines?: HistoricalProvenance;
		deployments?: HistoricalProvenance;
	},
): { outcome: LandingZoneImportOutcome; evidence: OutcomeEvidence } {
	const truncated = Boolean(
		provenance.mr?.truncated || provenance.pipelines?.truncated || provenance.deployments?.truncated,
	);
	const successfulDeployment = deployments.find(
		(deployment) => deployment.sha === commitSha && deployment.status === "success",
	);
	if (mr.state === "opened" || mr.state === "locked") {
		return {
			outcome: "proposed",
			evidence: {
				source: "gitlab-mr",
				observedAt: mr.updatedAt,
				retrievedAt: provenance.mr?.retrievedAt,
				commitSha,
				truncated,
			},
		};
	}
	if (mr.state === "closed") {
		return {
			outcome: "declined",
			evidence: {
				source: "gitlab-mr",
				observedAt: mr.updatedAt,
				retrievedAt: provenance.mr?.retrievedAt,
				commitSha,
				truncated,
			},
		};
	}
	if (mr.verifiedLiveState) {
		return {
			outcome: "applied",
			evidence: {
				source: "live-state",
				observedAt: provenance.mr?.retrievedAt ?? mr.updatedAt,
				retrievedAt: provenance.mr?.retrievedAt,
				commitSha,
				truncated,
			},
		};
	}
	if (successfulDeployment) {
		return {
			outcome: "applied",
			evidence: {
				source: "gitlab-deployment",
				observedAt: successfulDeployment.updatedAt,
				retrievedAt: provenance.deployments?.retrievedAt,
				commitSha: successfulDeployment.sha,
				pipelineId: successfulDeployment.pipelineId ? String(successfulDeployment.pipelineId) : undefined,
				truncated,
			},
		};
	}
	const currentPipeline = latestPipeline(pipelines);
	if (currentPipeline) {
		return {
			outcome: currentPipeline.status === "failed" ? "pipeline-failed" : "merged-unverified",
			evidence: {
				source: "gitlab-pipeline",
				observedAt: currentPipeline.updatedAt,
				retrievedAt: provenance.pipelines?.retrievedAt,
				commitSha,
				pipelineId: String(currentPipeline.id),
				truncated,
			},
		};
	}
	return {
		outcome: "merged-unverified",
		evidence: {
			source: "gitlab-mr",
			observedAt: mr.updatedAt,
			retrievedAt: provenance.mr?.retrievedAt,
			commitSha,
			truncated,
		},
	};
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
	const maxPendingReconciliations = options.maxPendingReconciliations ?? DEFAULT_PENDING_RECONCILIATIONS;
	if (!Number.isInteger(maxPendingReconciliations) || maxPendingReconciliations < 1)
		throw new Error("maxPendingReconciliations must be a positive integer");
	const outcomes: LandingZoneImportOutcome[] = [];
	let projectId = options.checkpoint?.projectId;
	const backfillStartAt = options.checkpoint?.backfillStartAt ?? options.startAt ?? updatedAfter;
	let repositoryPath = options.checkpoint?.repositoryPath;
	let expectedProjectId = options.checkpoint?.projectId;
	const upperBound = options.checkpoint?.inProgress?.upperBound ?? new Date().toISOString();
	let expectedTotal = options.checkpoint?.inProgress?.expectedTotal;
	let nextPage = options.checkpoint?.inProgress?.nextPage ?? 1;
	let pendingMrIids = [...new Set(options.checkpoint?.pendingMrIids ?? [])];
	let pendingCursor = options.checkpoint?.pendingCursor ?? 0;
	const pendingDeploymentScans = { ...(options.checkpoint?.pendingDeploymentScans ?? {}) };
	if (
		pendingMrIids.length > MAX_PENDING_MERGE_REQUESTS ||
		!pendingMrIids.every((iid) => Number.isInteger(iid) && iid > 0) ||
		!Number.isInteger(pendingCursor) ||
		pendingCursor < 0 ||
		Object.entries(pendingDeploymentScans).some(
			([iid, scan]) =>
				!/^\d+$/.test(iid) ||
				!pendingMrIids.includes(Number(iid)) ||
				typeof scan !== "object" ||
				scan === null ||
				typeof scan.sha !== "string" ||
				scan.sha.length < 1 ||
				scan.sha.length > 128 ||
				!Number.isInteger(scan.nextPage) ||
				scan.nextPage < 1 ||
				!z.string().datetime().safeParse(scan.updatedBefore).success,
		)
	) {
		throw new Error(`Invalid bounded pending merge request queue for ${options.repository}`);
	}

	const checkpointWithPending = (
		base: Omit<LandingZoneImportCheckpoint, "pendingMrIids" | "pendingCursor">,
	): LandingZoneImportCheckpoint => ({
		...base,
		backfillStartAt,
		...(repositoryPath && { repositoryPath }),
		pendingMrIids,
		pendingCursor: pendingMrIids.length > 0 ? pendingCursor % pendingMrIids.length : 0,
		pendingDeploymentScans,
	});

	const recordRepository = async (project: HistoricalProject, provenance?: HistoricalProvenance) => {
		const currentProjectId = String(project.id);
		if (expectedProjectId && currentProjectId !== expectedProjectId) {
			throw new Error(
				`Historical MR page project ${currentProjectId} does not match GitLab project ${expectedProjectId}`,
			);
		}
		expectedProjectId ??= currentProjectId;
		projectId ??= currentProjectId;
		repositoryPath = project.path;
		await resolvedDependencies.writers.recordRepository(resolvedDependencies.store, {
			group: { id: "gitlab-group:pvhcorp", path: "pvhcorp", lastSyncedAt: provenance?.retrievedAt },
			repository: {
				id: `gitlab-project:${currentProjectId}`,
				groupId: "gitlab-group:pvhcorp",
				path: project.path,
				name: options.repository,
				defaultBranch: project.defaultBranch,
				webUrl: `https://gitlab.com/${project.path}`,
				commitSha: project.headSha,
				lastSyncedAt: provenance?.retrievedAt,
			},
			provenance,
		});
	};

	const persistCheckpoint = async (checkpoint: LandingZoneImportCheckpoint): Promise<void> => {
		await resolvedDependencies.recordRecoveryStart?.(options.repository, checkpoint);
		await resolvedDependencies.recordCheckpoint?.(resolvedDependencies.store, checkpoint);
	};

	const processMergeRequest = async (
		mr: HistoricalMergeRequest,
		project: HistoricalProject,
		provenance?: HistoricalProvenance,
	) => {
		await recordRepository(project, provenance);
		const currentProjectId = String(project.id);
		const mrId = `${currentProjectId}:${mr.iid}`;
		const commitSha = mr.mergeCommitSha ?? mr.commitSha;
		if (!commitSha) throw new Error(`GitLab merge request ${mrId} did not provide a commit SHA`);
		const pipelinePage = await resolvedDependencies.listPipelines({ repository: options.repository, iid: mr.iid });
		const pipelines = pipelinePage.pipelines;
		const previousDeploymentScan = pendingDeploymentScans[String(mr.iid)];
		const deploymentScan = resolvedDependencies.listDeployments
			? previousDeploymentScan?.sha === commitSha
				? previousDeploymentScan
				: { sha: commitSha, nextPage: 1, updatedBefore: new Date().toISOString() }
			: undefined;
		const deploymentPage = deploymentScan
			? await resolvedDependencies.listDeployments?.({
					repository: options.repository,
					commitSha,
					page: deploymentScan.nextPage,
					updatedBefore: deploymentScan.updatedBefore,
				})
			: undefined;
		if (deploymentPage?.nextPage !== undefined && deploymentPage.nextPage <= (deploymentScan?.nextPage ?? 0)) {
			throw new Error(`GitLab deployment cursor did not advance for ${options.repository} MR !${mr.iid}`);
		}
		const deployments = deploymentPage?.deployments ?? [];
		const decision = outcomeFor(mr, pipelines, deployments, commitSha, {
			mr: provenance,
			pipelines: pipelinePage.provenance,
			deployments: deploymentPage?.provenance,
		});
		const { outcome, evidence } = decision;
		const terminal = outcome === "declined" || outcome === "applied";
		if (!terminal && !pendingMrIids.includes(mr.iid) && pendingMrIids.length >= MAX_PENDING_MERGE_REQUESTS) {
			throw new Error(`Pending merge request safety limit exceeded for ${options.repository}`);
		}
		outcomes.push(outcome);
		await resolvedDependencies.writers.recordChange(resolvedDependencies.store, {
			id: `gitlab:${mrId}`,
			repositoryId: `gitlab-project:${currentProjectId}`,
			commitSha,
			summary: mr.title,
			createdAt: mr.createdAt,
			lastSyncedAt: evidence.retrievedAt ?? provenance?.retrievedAt,
			source: evidence.source,
			truncated: evidence.truncated,
			outcomeEvidence: evidence,
			outcome,
			mergeRequest: {
				id: mrId,
				projectId: currentProjectId,
				iid: String(mr.iid),
				webUrl: mr.webUrl,
				lastSyncedAt: mr.updatedAt,
			},
		});
		for (const pipeline of pipelines) {
			await resolvedDependencies.writers.recordPipeline(resolvedDependencies.store, {
				mrUrl: mr.webUrl,
				mrId,
				projectId: currentProjectId,
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
			for (const planJob of pipeline.planJobs) {
				await resolvedDependencies.writers.recordPlan(resolvedDependencies.store, {
					pipelineId: String(pipeline.id),
					plan: {
						id: `gitlab:plan-job:${planJob.id}`,
						status: planJob.status,
						artifactUrl: planJob.webUrl,
						createdAt: pipeline.createdAt,
					},
					source: pipelinePage.provenance?.source,
					lastSyncedAt: pipelinePage.provenance?.retrievedAt,
					truncated: pipelinePage.provenance?.truncated,
				});
			}
		}
		if (terminal) {
			pendingMrIids = pendingMrIids.filter((pendingIid) => pendingIid !== mr.iid);
			delete pendingDeploymentScans[String(mr.iid)];
		} else {
			pendingMrIids = [...new Set([...pendingMrIids, mr.iid])];
			if (deploymentScan && deploymentPage?.nextPage)
				pendingDeploymentScans[String(mr.iid)] = { ...deploymentScan, nextPage: deploymentPage.nextPage };
			else if (deploymentScan)
				pendingDeploymentScans[String(mr.iid)] = {
					sha: commitSha,
					nextPage: 1,
					updatedBefore: new Date().toISOString(),
				};
		}
	};

	if (options.reconcilePending && pendingMrIids.length > 0) {
		if (!resolvedDependencies.readMergeRequest) throw new Error("lz_read_merge_request is not connected");
		const originalPending = [...pendingMrIids];
		const start = pendingCursor % originalPending.length;
		const count = Math.min(maxPendingReconciliations, originalPending.length);
		for (let offset = 0; offset < count; offset++) {
			const iid = originalPending[(start + offset) % originalPending.length];
			if (iid === undefined) continue;
			const current = await resolvedDependencies.readMergeRequest({ repository: options.repository, iid });
			await processMergeRequest(current.mergeRequest, current.project, current.provenance);
		}
		const nextIid = originalPending[(start + count) % originalPending.length];
		pendingCursor = nextIid === undefined ? 0 : Math.max(0, pendingMrIids.indexOf(nextIid));
		const reconciledCheckpoint = checkpointWithPending({
			projectId: expectedProjectId ?? options.checkpoint?.projectId ?? "",
			updatedAfter,
			...(options.checkpoint?.inProgress && { inProgress: options.checkpoint.inProgress }),
		});
		if (!reconciledCheckpoint.projectId) throw new Error("Pending reconciliation did not provide a GitLab project ID");
		await persistCheckpoint(reconciledCheckpoint);
	}

	const pages: Array<{
		project: HistoricalProject;
		mergeRequests: HistoricalMergeRequest[];
		total?: number;
		nextPage?: number;
		provenance?: HistoricalProvenance;
	}> = [];
	for (let pagesRead = 0; pagesRead < maxPages; pagesRead++) {
		const page = await resolvedDependencies.listMergeRequests({
			repository: options.repository,
			updatedAfter,
			updatedBefore: upperBound,
			page: nextPage,
		});
		const pageProjectId = String(page.project.id);
		if (expectedProjectId && pageProjectId !== expectedProjectId) {
			throw new Error(`Historical MR page project ${pageProjectId} does not match GitLab project ${expectedProjectId}`);
		}
		expectedProjectId ??= pageProjectId;
		if (page.total === undefined) {
			await recordRepository(page.project, page.provenance);
			if (nextPage !== 1) throw new Error("GitLab omitted the exact total after a historical window scan started");
			const lowerMillis = Date.parse(updatedAfter);
			const upperMillis = Date.parse(upperBound);
			if (!Number.isFinite(lowerMillis) || !Number.isFinite(upperMillis) || upperMillis - lowerMillis <= 1) {
				throw new Error(
					`GitLab cannot provide an exact total for a single timestamp window in ${options.repository}; choose a narrower operator backfill source`,
				);
			}
			const midpoint = lowerMillis + Math.floor((upperMillis - lowerMillis) / 2);
			if (midpoint <= lowerMillis || midpoint >= upperMillis)
				throw new Error(`GitLab historical window bisection made no forward progress for ${options.repository}`);
			const checkpoint = checkpointWithPending({
				projectId: expectedProjectId,
				updatedAfter,
				inProgress: { upperBound: new Date(midpoint).toISOString(), nextPage: 1, seenMrIds: [] },
			});
			await persistCheckpoint(checkpoint);
			return { outcomes, checkpoint };
		}
		if (expectedTotal !== undefined && page.total !== expectedTotal) {
			const checkpoint = checkpointWithPending({
				projectId: expectedProjectId,
				updatedAfter,
				inProgress: { upperBound, expectedTotal: page.total, nextPage: 1, seenMrIds: [] },
			});
			await persistCheckpoint(checkpoint);
			return { outcomes, checkpoint };
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
	await recordRepository(firstPage.project, firstPage.provenance);
	const seenMrIds = new Set(options.checkpoint?.inProgress?.seenMrIds ?? []);
	for (const page of pages) {
		for (const mr of page.mergeRequests) {
			const stableMrId = `${projectId}:${mr.iid}`;
			seenMrIds.add(stableMrId);
			if (seenMrIds.size > 10_000)
				throw new Error(`GitLab import stable MR ID safety limit exceeded for ${options.repository}`);
			await processMergeRequest(mr, page.project, page.provenance);
		}
	}
	if (!projectId) return { outcomes };
	const lastPage = pages.at(-1);
	if (!lastPage || expectedTotal === undefined)
		throw new Error("GitLab historical merge request response omitted a valid total");
	if (seenMrIds.size > expectedTotal)
		throw new Error(`GitLab historical merge request total changed for ${options.repository}`);
	const checkpoint = lastPage.nextPage
		? checkpointWithPending({
				projectId,
				updatedAfter,
				inProgress: {
					upperBound,
					expectedTotal,
					nextPage: lastPage.nextPage,
					seenMrIds: [...seenMrIds].sort(),
				},
			})
		: seenMrIds.size === expectedTotal
			? checkpointWithPending({
					projectId,
					updatedAfter: new Date(Math.max(Date.parse(updatedAfter) + 1, Date.parse(upperBound) - 1)).toISOString(),
				})
			: checkpointWithPending({
					projectId,
					updatedAfter,
					inProgress: { upperBound, expectedTotal, nextPage: 1, seenMrIds: [...seenMrIds].sort() },
				});
	await persistCheckpoint(checkpoint);
	return { outcomes, checkpoint };
}

export async function runLandingZoneGitLabImportSweep(
	options?: LandingZoneImportOptions,
	providedDependencies?: LandingZoneImportDependencies,
): Promise<LandingZoneGitLabImportSweepResult> {
	if (!providedDependencies && !landingZoneGitLabImportEnabled()) {
		return { outcomes: [], unavailable: "Landing Zone graph or required GitLab read tools are unavailable" };
	}
	if (options?.startAt || options?.checkpoint) return importLandingZoneGitLabHistory(options, providedDependencies);
	if (landingZoneGitLabAuthBackoffActive()) return { outcomes: [], authBackoff: true };
	const dependencies = providedDependencies ?? defaultDependencies();
	if (!providedDependencies) dependencies.store = await getGraphStore();
	const repositories = (await dependencies.listRepositories?.()) ?? [];
	const outcomes: LandingZoneImportOutcome[] = [];
	const projectErrors: Array<{ repository: string; message: string }> = [];
	let requiresCheckpoint = false;
	for (const repository of repositories) {
		if (repository.availability !== "active") continue;
		try {
			const checkpoint = await dependencies.readCheckpoint?.(dependencies.store, repository.name);
			if (!checkpoint) {
				requiresCheckpoint = true;
				continue;
			}
			const result = await importLandingZoneGitLabHistory(
				{ repository: repository.name, checkpoint, reconcilePending: true },
				dependencies,
			);
			outcomes.push(...result.outcomes);
		} catch (error) {
			if (isLandingZoneGitLabAuthRejection(error)) {
				armLandingZoneGitLabAuthBackoff();
				projectErrors.push({
					repository: repository.name,
					message: error instanceof Error ? error.message : "Landing Zone GitLab authentication failed",
				});
				return { outcomes, authBackoff: true, projectErrors };
			}
			projectErrors.push({
				repository: repository.name,
				message: error instanceof Error ? error.message : "Landing Zone GitLab import failed",
			});
		}
	}
	return {
		outcomes,
		...(requiresCheckpoint && { requiresCheckpoint: true }),
		...(projectErrors.length > 0 && { projectErrors }),
	};
}

const LANDING_ZONE_GITLAB_AUTH_BACKOFF_MS = 15 * 60 * 1000;
let landingZoneGitLabAuthBackoff: { until: number; tokenFingerprint: string } | undefined;

function landingZoneGitLabTokenFingerprint(): string {
	return createHash("sha256")
		.update(process.env.GITLAB_PERSONAL_ACCESS_TOKEN ?? "")
		.digest("hex")
		.slice(0, 16);
}

export function isLandingZoneGitLabAuthRejection(error: unknown): boolean {
	return error instanceof Error && /GitLab read failed with HTTP (?:401|403)\b/.test(error.message);
}

function landingZoneGitLabAuthBackoffActive(now = Date.now()): boolean {
	return (
		landingZoneGitLabAuthBackoff !== undefined &&
		now < landingZoneGitLabAuthBackoff.until &&
		landingZoneGitLabAuthBackoff.tokenFingerprint === landingZoneGitLabTokenFingerprint()
	);
}

function armLandingZoneGitLabAuthBackoff(now = Date.now()): void {
	landingZoneGitLabAuthBackoff = {
		until: now + LANDING_ZONE_GITLAB_AUTH_BACKOFF_MS,
		tokenFingerprint: landingZoneGitLabTokenFingerprint(),
	};
}

export function resetLandingZoneGitLabImportStateForTests(): void {
	landingZoneGitLabAuthBackoff = undefined;
}
