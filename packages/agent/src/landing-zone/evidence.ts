// packages/agent/src/landing-zone/evidence.ts

import type { EvidenceItem, EvidenceSource } from "@devops-agent/shared";
import type { BaseMessage } from "@langchain/core/messages";
import { getToolsForDataSource } from "../mcp-bridge.ts";
import { searchAgentMemory } from "../memory-backend.ts";
import { getAgentByName } from "../prompt-context.ts";
import type { LandingZoneIntent, LandingZoneRequestResolution } from "./types.ts";

export type EvidenceCollectionStatus = "collected" | "unavailable" | "skipped";

export interface EvidenceCollectionOutcome {
	source: EvidenceSource;
	status: EvidenceCollectionStatus;
	evidence: EvidenceItem[];
	reason?: string;
}

export interface EvidenceCollectionContext {
	intent: LandingZoneIntent;
	query: string;
	repositories: string[];
	accountIds: string[];
	selectedKnowledge: string[];
	subject: LandingZoneRequestResolution["subject"];
	awsLiveStateRelevant: boolean;
	awsLiveStateAuthorized: boolean;
	signal?: AbortSignal;
}

export type EvidenceCollector = (context: EvidenceCollectionContext) => Promise<EvidenceItem[]>;
export type LandingZoneEvidenceCollectors = Record<EvidenceSource, EvidenceCollector>;

const COLLECTOR_TIMEOUT_MS = 5_000;

const REPOSITORY_PATH_PREFIX: Record<string, string> = {
	"aws-lz-account-creator": "accounts",
	"aws-lz-network-core": "environments",
	"aws-lz-network-workloads": "environments",
	"aws-lz-post-vending": "workloads",
	"gitlab-k8s-runners-lzv2": "runners",
};

interface EvidenceTool {
	name: string;
	invoke(input: Record<string, unknown>, config?: { signal?: AbortSignal }): Promise<unknown>;
}

function textFromMessages(messages: BaseMessage[]): string {
	const content = messages.at(-1)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join(" ");
}

function evidence(
	source: EvidenceSource,
	id: string,
	summary: string,
	provenance: EvidenceItem["provenance"],
	claim?: { key: string; value: string },
): EvidenceItem {
	return {
		id,
		claimKey: claim?.key ?? `${source}-context`,
		...(claim && { claimValue: claim.value }),
		source,
		retrievedAt: new Date().toISOString(),
		status: "observed",
		summary: summary.slice(0, 8_192) || `${source} returned evidence`,
		provenance,
		freshness: { status: "current" },
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function toolPayload(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") return record(parseJson(value));
	const direct = record(value);
	if (!direct) return undefined;
	const content = direct.content;
	if (!Array.isArray(content)) return direct;
	for (const part of content) {
		const text = record(part)?.text;
		if (typeof text !== "string") continue;
		const parsed = record(parseJson(text));
		if (parsed) return parsed;
	}
	return direct;
}

function resultPaths(value: unknown, field: "contracts" | "examples"): string[] {
	const entries = toolPayload(value)?.[field];
	if (!Array.isArray(entries)) return [];
	return entries.flatMap((entry) => {
		if (typeof entry === "string") return [entry];
		const path = record(entry)?.path;
		return typeof path === "string" ? [path] : [];
	});
}

function boundedEvidenceFiles(value: unknown, field: "contracts" | "examples", contentLimit: number): unknown[] {
	const entries = toolPayload(value)?.[field];
	if (!Array.isArray(entries)) return [];
	return entries.slice(0, 5).flatMap((entry) => {
		if (typeof entry === "string") return [{ path: entry }];
		const item = record(entry);
		if (!item || typeof item.path !== "string") return [];
		return [
			{
				path: item.path,
				...(typeof item.kind === "string" && { kind: item.kind }),
				...(typeof item.content === "string" && { content: item.content.slice(0, contentLimit) }),
				...(typeof item.truncated === "boolean" && { truncated: item.truncated }),
			},
		];
	});
}

function repositoryEvidenceSummary(value: unknown): Record<string, unknown> {
	const payload = toolPayload(value) ?? {};
	return {
		...(record(payload.repository) && { repository: payload.repository }),
		...(record(payload.project) && { project: payload.project }),
		contracts: boundedEvidenceFiles(value, "contracts", 1_000),
		examples: boundedEvidenceFiles(value, "examples", 1_500),
		...(Array.isArray(payload.warnings) && { warnings: payload.warnings.slice(0, 10) }),
		...(record(payload.provenance) && { provenance: payload.provenance }),
	};
}

function canonicalSurfacePath(repository: string, path: string): string | undefined {
	const normalized = path.replaceAll("<application>", "*").replaceAll("<app>", "*").replaceAll("<env>", "*");
	if (repository === "aws-lz-account-creator" && /^accounts\/[^/]+\.ya?ml$/i.test(normalized)) {
		return "accounts/*.yml";
	}
	if (repository === "aws-lz-network-workloads" && /^environments\/[^/]+\/vpcs\/[^/]+\.ya?ml$/i.test(normalized)) {
		return "environments/*/vpcs/*.yaml";
	}
	if (repository === "aws-lz-network-core" && /^environments\/[^/]+\/WAN\/dns\/[^/]+\.ya?ml$/i.test(normalized)) {
		return "environments/*/WAN/dns/*.yaml";
	}
	if (repository === "aws-lz-network-core" && /^environments\/[^/]+\/WAN\/[^/]+\.ya?ml$/i.test(normalized)) {
		return "environments/*/WAN/*.yaml";
	}
	if (repository === "aws-lz-post-vending" && /^workloads\/[^/]+\.ya?ml$/i.test(normalized)) {
		return "workloads/*.yml";
	}
	if (repository === "gitlab-k8s-runners-lzv2" && /^runners\/[^/]+\/[^/]+\.ya?ml$/i.test(normalized)) {
		return "runners/*/*.yaml";
	}
	if (repository === "dhco-gitlab-terraform" && /^(?!_)[^/]+\.tf$/i.test(normalized)) {
		return "root-domain/*.tf";
	}
	return undefined;
}

function surfaceClaim(repository: string, paths: string[]): { key: string; value: string } | undefined {
	const surfaces = [...new Set(paths.flatMap((path) => canonicalSurfacePath(repository, path) ?? []))].sort();
	if (surfaces.length === 0) return undefined;
	return { key: `repository:${repository}:authoring-surface`, value: surfaces.join(" | ") };
}

function knowledgeSurfaceClaim(path: string, content: string): { key: string; value: string } | undefined {
	const repository = path.match(/^repos\/([^/]+)\.md$/)?.[1];
	if (!repository) return undefined;
	const surface = content.match(/# Surface([\s\S]*?)(?=\n# Traps|$)/)?.[1] ?? "";
	const editSurface = surface.split("**Never edit:**")[0] ?? "";
	const paths = [...editSurface.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
	return surfaceClaim(repository, paths);
}

async function invokeTool(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
	const tool = getToolsForDataSource("landing-zone-iac").find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`${name} is not connected`);
	return tool.invoke(input, { signal });
}

function unavailableGitLabEvidence(repository: string, reason: string): EvidenceItem {
	return {
		...evidence("gitlab", `gitlab:${repository}:unavailable`, `Repository evidence unavailable: ${reason}`, {
			repository,
			path: ".",
		}),
		status: "unverified",
		freshness: { status: "unknown" },
	};
}

export async function collectGitLabEvidence(
	context: EvidenceCollectionContext,
	invoke: (name: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown> = invokeTool,
): Promise<EvidenceItem[]> {
	if (context.repositories.length === 0) throw new Error("no repository scope was resolved");
	const results = await Promise.allSettled(
		context.repositories.map(async (repository) => {
			const result = await invoke(
				"lz_find_representative_examples",
				{
					repository,
					limit: 5,
					...(REPOSITORY_PATH_PREFIX[repository] && { path: REPOSITORY_PATH_PREFIX[repository] }),
				},
				context.signal,
			);
			const claim = surfaceClaim(repository, resultPaths(result, "examples"));
			return evidence(
				"gitlab",
				`gitlab:${repository}`,
				JSON.stringify(repositoryEvidenceSummary(result)),
				{ repository, path: "." },
				claim,
			);
		}),
	);
	const items = results.flatMap((result, index) => {
		if (result.status === "fulfilled") return [result.value];
		const repository = context.repositories[index];
		if (!repository) return [];
		return [
			unavailableGitLabEvidence(repository, result.reason instanceof Error ? result.reason.message : "read failed"),
		];
	});
	if (!items.some((item) => item.status === "observed")) throw new Error("all repository evidence reads failed");
	return items;
}

export async function collectKnowledgeGraphEvidence(
	context: EvidenceCollectionContext,
	tools: EvidenceTool[] = getToolsForDataSource("knowledge-graph"),
): Promise<EvidenceItem[]> {
	const tool = tools.find((candidate) => candidate.name === "kg_run_cypher");
	if (!tool) throw new Error("knowledge graph query tool is not connected");
	const result = await tool.invoke(
		{
			cypher:
				"MATCH (f:TopologyFact) WHERE f.validTo = '' AND f.accountId IN $accountIds RETURN f.id AS id, f.accountId AS accountId, f.payload AS payload ORDER BY f.id LIMIT 25",
			params: { accountIds: context.accountIds },
		},
		{ signal: context.signal },
	);
	return [
		evidence("knowledge-graph", "knowledge-graph:landing-zone", JSON.stringify(result), {
			graphEntityId: (context.repositories.join(",") || "landing-zone").slice(0, 512),
		}),
	];
}

function withCollectorTimeout<T>(
	collector: EvidenceCollector,
	context: EvidenceCollectionContext,
	source: EvidenceSource,
	timeoutMs: number,
): Promise<T> {
	const controller = new AbortController();
	const timeoutError = new Error(`${source} collector timed out after ${timeoutMs}ms`);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort(timeoutError);
			reject(timeoutError);
		}, timeoutMs);
		timer.unref?.();
	});
	const collection = collector({ ...context, signal: controller.signal }) as Promise<T>;
	return Promise.race([collection, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

export const DEFAULT_LANDING_ZONE_COLLECTORS: LandingZoneEvidenceCollectors = {
	gitlab: collectGitLabEvidence,
	"pvh-okf": async (context) => {
		const selected = new Set(context.selectedKnowledge);
		const entries = getAgentByName("landing-zone-terraform").knowledge.filter((entry) =>
			selected.has(`${entry.category}/${entry.filename}`),
		);
		if (entries.length === 0) throw new Error("no selected PVH knowledge concepts were loaded");
		return entries.map((entry) => {
			const path = `${entry.category}/${entry.filename}`;
			return evidence(
				"pvh-okf",
				`pvh-okf:${path}`,
				entry.content,
				{ path },
				knowledgeSurfaceClaim(path, entry.content),
			);
		});
	},
	"terraform-docs": async () => {
		throw new Error("Terraform documentation collector is not configured");
	},
	"aws-docs": async () => {
		throw new Error("AWS documentation collector is not configured");
	},
	"aws-api": async () => {
		throw new Error("AWS live-state collector is not configured");
	},
	memory: async (context) => {
		const hits = await searchAgentMemory("landing-zone-terraform", context.query, {}, 5, {
			signal: context.signal,
		});
		return hits.map((hit, index) =>
			evidence("memory", `memory:${hit.blockId ?? index}`, hit.text, {
				memoryBlockId: hit.blockId ?? `result-${index}`,
			}),
		);
	},
	"knowledge-graph": collectKnowledgeGraphEvidence,
};

export function evidenceContext(
	state: {
		messages: BaseMessage[];
		intent: LandingZoneIntent;
		repositoryScope: string[];
		accountScope: string[];
		selectedKnowledge: string[];
		requestResolution?: { subject: LandingZoneRequestResolution["subject"] } | null;
	},
	awsLiveStateAuthorized = false,
): EvidenceCollectionContext {
	const query = textFromMessages(state.messages);
	return {
		intent: state.intent,
		query,
		repositories: state.repositoryScope,
		accountIds: state.accountScope,
		selectedKnowledge: state.selectedKnowledge,
		subject: state.requestResolution?.subject ?? "general",
		awsLiveStateRelevant: /\b(live|deployed|actual|drift|aws api|resource state)\b/i.test(query),
		awsLiveStateAuthorized,
	};
}

export async function collectEvidenceSource(
	source: EvidenceSource,
	context: EvidenceCollectionContext,
	collectors: LandingZoneEvidenceCollectors = DEFAULT_LANDING_ZONE_COLLECTORS,
	timeoutMs = COLLECTOR_TIMEOUT_MS,
): Promise<EvidenceCollectionOutcome> {
	if ((source === "terraform-docs" || source === "aws-docs") && context.subject !== "standards-comparison") {
		return { source, status: "skipped", evidence: [], reason: `${source} was not required for this request.` };
	}
	if (source === "knowledge-graph" && context.subject !== "topology") {
		return { source, status: "skipped", evidence: [], reason: "Topology history was not required for this request." };
	}
	if (source === "aws-api" && !context.awsLiveStateRelevant) {
		return { source, status: "skipped", evidence: [], reason: "AWS live state was not relevant to this request." };
	}
	if (source === "aws-api" && !context.awsLiveStateAuthorized) {
		return { source, status: "skipped", evidence: [], reason: "AWS live state was not authorized for this turn." };
	}
	try {
		return {
			source,
			status: "collected",
			evidence: await withCollectorTimeout<EvidenceItem[]>(collectors[source], context, source, timeoutMs),
		};
	} catch (error) {
		return {
			source,
			status: "unavailable",
			evidence: [],
			reason: error instanceof Error ? error.message : `${source} collection failed`,
		};
	}
}

export async function collectEvidenceInParallel(
	context: EvidenceCollectionContext,
	collectors: LandingZoneEvidenceCollectors,
): Promise<EvidenceCollectionOutcome[]> {
	const sources = Object.keys(collectors) as EvidenceSource[];
	return Promise.all(sources.map((source) => collectEvidenceSource(source, context, collectors)));
}
