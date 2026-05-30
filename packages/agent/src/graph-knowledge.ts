// agent/src/graph-knowledge.ts
//
// SIO-850: knowledge-graph pipeline nodes. recordEntities writes the turn's
// entities + incident; graphEnrich reads prior dependencies + similar incidents
// and produces state.graphContext for the aggregator prompt. Both are gated by
// KNOWLEDGE_GRAPH_ENABLED and soft-fail (never throw) so a cold/absent embedded
// graph degrades to empty context, mirroring the mitigation deadline soft-fail.

import {
	buildGraphContext,
	getGraphStore,
	isKnowledgeGraphEnabled,
	priorRelationshipsForServices,
	recordIncident,
	similarIncidents,
	upsertEntities,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { registerGraphWarmer } from "./lifecycle.ts";
import { extractTextFromContent } from "./message-utils.ts";
import type { AgentStateType } from "./state.ts";

const logger = getLogger("agent:graph-knowledge");

// Embedder is injectable so graphEnrich is unit-testable without Bedrock. The
// default lazily constructs a Bedrock Titan embedder; it is only built/called
// when the knowledge graph is enabled.
export type EmbedFn = (text: string) => Promise<number[]>;

let embedder: EmbedFn | null = null;

export function _setEmbedderForTesting(fn: EmbedFn | null): void {
	embedder = fn;
}

export function createBedrockEmbedder(): EmbedFn {
	const model =
		process.env.EMBEDDINGS_MODEL && process.env.EMBEDDINGS_MODEL !== ""
			? process.env.EMBEDDINGS_MODEL
			: "amazon.titan-embed-text-v2:0";
	const region = process.env.AWS_REGION && process.env.AWS_REGION !== "" ? process.env.AWS_REGION : "eu-central-1";
	// Lazy import so @langchain/aws is only loaded on the enabled path.
	let embedQuery: ((text: string) => Promise<number[]>) | null = null;
	return async (text: string) => {
		if (!embedQuery) {
			const { BedrockEmbeddings } = await import("@langchain/aws");
			const instance = new BedrockEmbeddings({ model, region });
			embedQuery = (t) => instance.embedQuery(t);
		}
		return embedQuery(text);
	};
}

function getEmbedder(): EmbedFn {
	if (!embedder) embedder = createBedrockEmbedder();
	return embedder;
}

function lastUserQuery(state: AgentStateType): string {
	const lastHuman = state.messages.filter((m) => m._getType() === "human").pop();
	return lastHuman ? extractTextFromContent(lastHuman.content) : "";
}

function affectedServiceNames(state: AgentStateType): string[] {
	return (state.normalizedIncident.affectedServices ?? []).map((s) => s.name).filter((n) => n.length > 0);
}

// recordEntities node: persist the turn's services + incident into the graph.
export async function recordGraphEntities(state: AgentStateType): Promise<Partial<AgentStateType>> {
	if (!isKnowledgeGraphEnabled()) return {};
	try {
		const store = await getGraphStore();
		const services = affectedServiceNames(state);
		await upsertEntities(store, { services });
		await recordIncident(store, {
			id: state.requestId,
			severity: state.normalizedIncident.severity,
			summary: lastUserQuery(state).slice(0, 280),
			services,
		});
		return {};
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"recordEntities graph write failed; continuing",
		);
		return { partialFailures: [{ node: "recordEntities", reason: "graph-write-failed" }] };
	}
}

// graphEnrich node: read prior dependencies + similar incidents -> graphContext.
export async function graphEnrich(state: AgentStateType): Promise<Partial<AgentStateType>> {
	if (!isKnowledgeGraphEnabled()) return {};
	try {
		const store = await getGraphStore();
		const services = affectedServiceNames(state);
		const deps = await priorRelationshipsForServices(store, services);

		let similar: Awaited<ReturnType<typeof similarIncidents>> = [];
		const query = lastUserQuery(state);
		if (query) {
			try {
				const embedding = await getEmbedder()(query);
				similar = await similarIncidents(store, embedding);
			} catch (error) {
				// Embedding/vector failure is non-fatal: keep the dependency context.
				logger.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					"graphEnrich similarity lookup failed; using dependencies only",
				);
			}
		}

		return { graphContext: buildGraphContext(deps, similar) };
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"graphEnrich failed; continuing without graph context",
		);
		return {};
	}
}

// Wire the lifecycle warm_knowledge_graph seam to open + migrate the embedded
// store. No-op when disabled. Call once at startup.
export function installGraphWarmer(): void {
	registerGraphWarmer(async () => {
		if (!isKnowledgeGraphEnabled()) return;
		const store = await getGraphStore();
		await store.init();
	});
}
