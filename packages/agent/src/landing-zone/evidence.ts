// packages/agent/src/landing-zone/evidence.ts

import type { EvidenceItem, EvidenceSource } from "@devops-agent/shared";
import type { BaseMessage } from "@langchain/core/messages";
import { getToolsForDataSource } from "../mcp-bridge.ts";
import { searchAgentMemory } from "../memory-backend.ts";
import { getAgentByName } from "../prompt-context.ts";
import type { LandingZoneIntent } from "./types.ts";

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
	selectedKnowledge: string[];
	awsLiveStateRelevant: boolean;
	awsLiveStateAuthorized: boolean;
}

export type EvidenceCollector = (context: EvidenceCollectionContext) => Promise<EvidenceItem[]>;
export type LandingZoneEvidenceCollectors = Record<EvidenceSource, EvidenceCollector>;

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
): EvidenceItem {
	return {
		id,
		claimKey: `${source}-context`,
		source,
		retrievedAt: new Date().toISOString(),
		status: "observed",
		summary: summary.slice(0, 8_192) || `${source} returned evidence`,
		provenance,
		freshness: { status: "current" },
	};
}

async function invokeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
	const tool = getToolsForDataSource("landing-zone-iac").find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`${name} is not connected`);
	return tool.invoke(input);
}

export const DEFAULT_LANDING_ZONE_COLLECTORS: LandingZoneEvidenceCollectors = {
	gitlab: async (context) => {
		const items = await Promise.all(
			context.repositories.map(async (repository) => {
				const result = await invokeTool("lz_find_representative_examples", { repository, limit: 5 });
				return evidence("gitlab", `gitlab:${repository}`, JSON.stringify(result), { repository, path: "." });
			}),
		);
		if (items.length === 0) throw new Error("no repository scope was resolved");
		return items;
	},
	"pvh-okf": async (context) => {
		const selected = new Set(context.selectedKnowledge);
		const entries = getAgentByName("landing-zone-terraform").knowledge.filter((entry) =>
			selected.has(`${entry.category}/${entry.filename}`),
		);
		if (entries.length === 0) throw new Error("no selected PVH knowledge concepts were loaded");
		return entries.map((entry) => {
			const path = `${entry.category}/${entry.filename}`;
			return evidence("pvh-okf", `pvh-okf:${path}`, entry.content, { path });
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
		const hits = await searchAgentMemory("landing-zone-terraform", context.query, {}, 5);
		return hits.map((hit, index) =>
			evidence("memory", `memory:${hit.blockId ?? index}`, hit.text, {
				memoryBlockId: hit.blockId ?? `result-${index}`,
			}),
		);
	},
	"knowledge-graph": async () => {
		const tool = getToolsForDataSource("knowledge-graph").find((candidate) => candidate.name.startsWith("kg_"));
		if (!tool) throw new Error("knowledge graph query tools are not connected");
		return [
			evidence("knowledge-graph", "knowledge-graph:available", "Knowledge graph query surface is available.", {
				graphEntityId: "landing-zone",
			}),
		];
	},
};

export function evidenceContext(
	state: {
		messages: BaseMessage[];
		intent: LandingZoneIntent;
		repositoryScope: string[];
		selectedKnowledge: string[];
	},
	awsLiveStateAuthorized = false,
): EvidenceCollectionContext {
	const query = textFromMessages(state.messages);
	return {
		intent: state.intent,
		query,
		repositories: state.repositoryScope,
		selectedKnowledge: state.selectedKnowledge,
		awsLiveStateRelevant: /\b(live|deployed|actual|drift|aws api|resource state)\b/i.test(query),
		awsLiveStateAuthorized,
	};
}

export async function collectEvidenceSource(
	source: EvidenceSource,
	context: EvidenceCollectionContext,
	collectors: LandingZoneEvidenceCollectors = DEFAULT_LANDING_ZONE_COLLECTORS,
): Promise<EvidenceCollectionOutcome> {
	if (source === "aws-api" && (!context.awsLiveStateRelevant || !context.awsLiveStateAuthorized)) {
		return { source, status: "skipped", evidence: [], reason: "AWS live state was not both relevant and authorised." };
	}
	try {
		return { source, status: "collected", evidence: await collectors[source](context) };
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
