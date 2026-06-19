// knowledge-graph/src/reader.ts
//
// SIO-850: read paths that enrich an investigation with prior graph knowledge.
// similarIncidents takes a precomputed embedding so this package never imports
// an LLM SDK; the caller (the agent's graphEnrich node) owns embedding
// generation via its existing @langchain/aws stack.

import type { GraphStore } from "./store.ts";

export interface ServiceDependency {
	from: string;
	to: string;
}

// Direct DEPENDS_ON neighbours (both directions) for the given services.
export async function priorRelationshipsForServices(
	store: GraphStore,
	services: string[],
): Promise<ServiceDependency[]> {
	const out: ServiceDependency[] = [];
	for (const service of services) {
		if (!service) continue;
		const rows = await store.run<{ from: string; to: string }>(
			"MATCH (a:Service {name: $name})-[:DEPENDS_ON]->(b:Service) RETURN a.name AS from, b.name AS to",
			{ name: service },
		);
		for (const row of rows) out.push({ from: String(row.from), to: String(row.to) });
	}
	return out;
}

export interface SimilarIncident {
	id: string;
	summary: string;
	severity: string;
	distance: number;
}

// Vector-similarity search over Incident.embedding via Ladybug's native index.
// Returns [] when the vector extension/index is unavailable.
export async function similarIncidents(store: GraphStore, embedding: number[], limit = 3): Promise<SimilarIncident[]> {
	if (embedding.length === 0) return [];
	try {
		const rows = await store.run<{ id: string; summary: string; severity: string; distance: number }>(
			"CALL QUERY_VECTOR_INDEX('Incident', 'incident_embedding_idx', $embedding, $limit) RETURN node.id AS id, node.summary AS summary, node.severity AS severity, distance AS distance",
			{ embedding, limit },
		);
		return rows.map((r) => ({
			id: String(r.id),
			summary: String(r.summary),
			severity: String(r.severity),
			distance: Number(r.distance),
		}));
	} catch {
		return [];
	}
}

// SIO-954: recent IaC change history for one deployment, most-recent first.
// createdAt is an ISO string so a lexicographic ORDER BY DESC is chronological.
export interface IacChange {
	id: string;
	workflow: string;
	summary: string;
	mrUrl: string;
	createdAt: string;
}

export async function priorChangesForDeployment(
	store: GraphStore,
	deployment: string,
	limit = 5,
): Promise<IacChange[]> {
	if (!deployment) return [];
	const rows = await store.run<{
		id: string;
		workflow: string;
		summary: string;
		mrUrl: string | null;
		createdAt: string;
	}>(
		"MATCH (d:ElasticDeployment {name: $name})-[:CHANGED_BY]->(c:ConfigChange) OPTIONAL MATCH (c)-[:PROPOSED_IN]->(m:MergeRequest) RETURN c.id AS id, c.workflow AS workflow, c.summary AS summary, m.url AS mrUrl, c.createdAt AS createdAt ORDER BY c.createdAt DESC LIMIT $limit",
		{ name: deployment, limit },
	);
	return rows.map((r) => ({
		id: String(r.id),
		workflow: String(r.workflow ?? ""),
		summary: String(r.summary ?? ""),
		mrUrl: r.mrUrl ? String(r.mrUrl) : "",
		createdAt: String(r.createdAt ?? ""),
	}));
}

export interface TopologyEdge {
	from: string;
	to: string;
}

export async function topology(store: GraphStore): Promise<TopologyEdge[]> {
	const rows = await store.run<{ from: string; to: string }>(
		"MATCH (a:Service)-[:DEPENDS_ON]->(b:Service) RETURN a.name AS from, b.name AS to",
	);
	return rows.map((r) => ({ from: String(r.from), to: String(r.to) }));
}

// Renders a compact prompt section from the read results. Empty string when
// there is nothing relevant, so the happy path is unchanged when the graph is
// empty or disabled.
export function buildGraphContext(deps: ServiceDependency[], similar: SimilarIncident[]): string {
	if (deps.length === 0 && similar.length === 0) return "";
	const lines: string[] = ["\n\n---\n\n## Knowledge Graph"];
	if (deps.length > 0) {
		lines.push("### Known dependencies");
		for (const d of deps) lines.push(`- ${d.from} -> ${d.to}`);
	}
	if (similar.length > 0) {
		lines.push("### Similar prior incidents");
		for (const s of similar) lines.push(`- [${s.severity}] ${s.summary} (id ${s.id})`);
	}
	return lines.join("\n");
}

// SIO-954: renders the deployment's recent change history into a compact prompt
// section. Empty string when there is no history, so the proposer prompt is
// unchanged on a deployment's first-ever turn or when the graph is disabled.
export function buildIacGraphContext(deployment: string, changes: IacChange[]): string {
	if (changes.length === 0) return "";
	const lines: string[] = ["\n\n---\n\n## Knowledge Graph", `### Recent changes to ${deployment}`];
	for (const c of changes) {
		const workflow = c.workflow ? `${c.workflow}: ` : "";
		const mr = c.mrUrl ? ` (${c.mrUrl})` : "";
		lines.push(`- ${workflow}${c.summary}${mr}`);
	}
	return lines.join("\n");
}
