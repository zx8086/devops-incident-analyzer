// agent/src/graph-knowledge.ts
//
// SIO-850: knowledge-graph pipeline nodes. recordEntities writes the turn's
// entities + incident; graphEnrich reads prior dependencies + similar incidents
// and produces state.graphContext for the aggregator prompt. Both are gated by
// KNOWLEDGE_GRAPH_ENABLED and soft-fail (never throw) so a cold/absent embedded
// graph degrades to empty context, mirroring the mitigation deadline soft-fail.

import { createHash } from "node:crypto";
import {
	blastRadiusForServices,
	buildGraphContext,
	getGraphStore,
	isKnowledgeGraphEnabled,
	priorRelationshipsForServices,
	recordIncident,
	recordRootCause,
	rootCauseForIncident,
	type SimilarIncidentWithCause,
	setIncidentEmbedding,
	similarIncidents,
	upsertEntities,
} from "@devops-agent/knowledge-graph";
import { getLogger } from "@devops-agent/observability";
import { truncateForEmbedding } from "@devops-agent/shared";
import { evaluate } from "./correlation/engine.ts";
import { correlationRules } from "./correlation/rules.ts";
import { registerGraphWarmer } from "./lifecycle.ts";
import { recordKeyDecision } from "./memory-writer.ts";
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
			// SIO-1081: cap retries at 2 (down from the AsyncCaller default of 6). The original
			// retry storm was a 400 ValidationException (input over Titan's 8192-token cap) that
			// LangChain retried because the Bedrock error carries its status under $metadata, not
			// error.status, so its STATUS_NO_RETRY 400-check never sees it. truncateForEmbedding
			// below now prevents that 400 entirely, so retries only fire on genuinely transient
			// errors (throttling / 5xx / network) -- keep a small budget for those (graphEnrich
			// soft-fails, so a dropped embed just loses similarity context for one turn) while
			// bounding any residual storm to 2 attempts instead of 6.
			const instance = new BedrockEmbeddings({ model, region, maxRetries: 2 });
			embedQuery = (t) => instance.embedQuery(t);
		}
		// SIO-1081: head-truncate before embedding so a large pasted incident (used as the
		// similarity seed) stays under the 8192-token cap instead of failing the embed.
		return embedQuery(truncateForEmbedding(text));
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
		const summary = lastUserQuery(state).slice(0, 280);
		await upsertEntities(store, { services });
		await recordIncident(store, {
			id: state.requestId,
			severity: state.normalizedIncident.severity,
			summary,
			services,
		});
		// SIO-1103 (P1 forward-fill): mirror the incident to a durable Couchbase fact so
		// the graph is rebuildable from the system of record. recordKeyDecision self-gates
		// on the agent-memory backend (no-op on the file backend), independent of the graph
		// write above (SIO-970). Annotations are the rebuild's replay source.
		recordKeyDecision({
			requestId: state.requestId,
			decision: `Incident ${state.requestId}: ${summary}`,
			annotations: {
				kind: "kg-incident",
				incident_id: state.requestId,
				services: services.join(","),
				severity: state.normalizedIncident.severity ?? "",
				// SIO-1103 CodeRabbit: mirror summary too so a rebuilt incident keeps it.
				summary,
			},
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
		// SIO-1103: the runtime shared-infra blast radius, read here (async) into state so
		// the SYNCHRONOUS shared-infra-blast-radius correlation rule can consume it. Its own
		// try/catch keeps a blast-radius failure from dropping the rest of the enrichment.
		let graphBlastRadius: Awaited<ReturnType<typeof blastRadiusForServices>> = [];
		try {
			graphBlastRadius = await blastRadiusForServices(store, services);
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"graphEnrich blast-radius read failed; continuing",
			);
		}

		let similar: SimilarIncidentWithCause[] = [];
		const query = lastUserQuery(state);
		if (query) {
			try {
				const embedding = await getEmbedder()(query);
				// SIO-1100: persist the embedding onto this turn's Incident so FUTURE
				// investigations can vector-recall it. recordEntities creates the Incident
				// node without an embedding (this package owns no LLM SDK); without this
				// write no incident ever gets one and similarIncidents can never return a
				// hit. Reuses the vector we just computed -- zero extra Bedrock calls.
				await setIncidentEmbedding(store, state.requestId, embedding);
				// Exclude this turn's own incident: we just wrote its embedding, so an
				// unfiltered lookup would return it at distance ~0 (SIO-1100).
				const nearest = await similarIncidents(store, embedding, 3, state.requestId);
				// SIO-1026: annotate each similar incident with its recorded root cause
				// so the aggregator can reuse prior analysis ("we've seen this before").
				similar = await Promise.all(
					nearest.map(async (inc) => {
						const rc = await rootCauseForIncident(store, inc.id);
						return { ...inc, rootCause: rc ? { class: rc.class, description: rc.description } : null };
					}),
				);
			} catch (error) {
				// Embedding/vector failure is non-fatal: keep the dependency context.
				logger.warn(
					{ error: error instanceof Error ? error.message : String(error) },
					"graphEnrich similarity lookup failed; using dependencies only",
				);
			}
		}

		return { graphContext: buildGraphContext(deps, similar), graphBlastRadius };
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"graphEnrich failed; continuing without graph context",
		);
		return {};
	}
}

// SIO-1026: derive the turn's root cause from the strongest satisfied correlation.
// The engine (a pure function of state) is re-run here; the cause is the rule that
// FIRED (trigger present) AND was covered by cross-domain findings -- reason
// "already covered by prior agent findings". Trivially-satisfied rules (trigger
// absent, fail-open, or degraded) are NOT a cause: we never fabricate one when no
// cross-domain correlation held (mirrors the SIO-1013 grounded-gaps discipline).
// When several covered rules hold on one incident we pick a DETERMINISTIC winner
// (lowest rule name) rather than whichever happens to sit first in the
// correlationRules array, so the persisted HAS_ROOT_CAUSE edge is reproducible
// across re-analyses of the same state.
function topSatisfiedCorrelation(state: AgentStateType): { ruleName: string; description: string } | null {
	const decisions = evaluate(state, correlationRules);
	const covered = decisions
		.filter(
			(d) => d.status === "satisfied" && d.match !== null && d.reason === "already covered by prior agent findings",
		)
		.sort((a, b) => a.rule.name.localeCompare(b.rule.name));
	const winner = covered[0];
	if (!winner) return null;
	return { ruleName: winner.rule.name, description: winner.rule.description };
}

// recordRootCause node: persist a RootCause for the turn's Incident when a
// cross-domain correlation held. Runs LATE (after mitigation) so it can see the
// final confidenceScore. Soft-fails like the other graph nodes.
export async function recordRootCauseData(state: AgentStateType): Promise<Partial<AgentStateType>> {
	if (!isKnowledgeGraphEnabled()) return {};
	const cause = topSatisfiedCorrelation(state);
	if (!cause) return {};
	try {
		const store = await getGraphStore();
		// PK is a stable hash of the normalized class so recurrences MERGE to one node.
		const id = createHash("sha256").update(cause.ruleName).digest("hex").slice(0, 16);
		await recordRootCause(store, {
			id,
			incidentId: state.requestId,
			class: cause.ruleName,
			description: cause.description,
			confidence: state.confidenceScore,
			ruleName: cause.ruleName,
		});
		// SIO-1103 (P1 forward-fill): mirror the root cause to a durable fact so a rebuild
		// reconstructs the RootCause + HAS_ROOT_CAUSE edge. Self-gates on the agent-memory
		// backend; independent of the graph write above (SIO-970).
		recordKeyDecision({
			requestId: state.requestId,
			decision: `Root cause for incident ${state.requestId}: ${cause.ruleName}`,
			annotations: {
				kind: "kg-root-cause",
				incident_id: state.requestId,
				root_cause_id: id,
				rule_name: cause.ruleName,
				description: cause.description,
				confidence: String(state.confidenceScore),
			},
		});
		return {};
	} catch (error) {
		logger.warn(
			{ error: error instanceof Error ? error.message : String(error) },
			"recordRootCause graph write failed; continuing",
		);
		return { partialFailures: [{ node: "recordRootCause", reason: "graph-write-failed" }] };
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
