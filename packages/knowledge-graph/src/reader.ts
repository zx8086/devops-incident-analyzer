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

// SIO-965: change history scoped to one (deployment, stack) cell. createdAt is an
// ISO string so a lexicographic ORDER BY DESC is chronological.
export interface StackInstanceChange {
	id: string;
	workflow: string;
	summary: string;
	outcome: string;
	mrUrl: string;
	createdAt: string;
}

export async function changeHistoryForStackInstance(
	store: GraphStore,
	stackInstanceId: string,
	limit = 5,
): Promise<StackInstanceChange[]> {
	if (!stackInstanceId) return [];
	const rows = await store.run<{
		id: string;
		workflow: string;
		summary: string;
		outcome: string | null;
		mrUrl: string | null;
		createdAt: string;
	}>(
		"MATCH (c:ConfigChange)-[:TARGETS]->(si:StackInstance {id: $sid}) OPTIONAL MATCH (c)-[:PROPOSED_IN]->(m:MergeRequest) RETURN c.id AS id, c.workflow AS workflow, c.summary AS summary, c.outcome AS outcome, m.url AS mrUrl, c.createdAt AS createdAt ORDER BY c.createdAt DESC LIMIT $limit",
		{ sid: stackInstanceId, limit },
	);
	return rows.map((r) => ({
		id: String(r.id),
		workflow: String(r.workflow ?? ""),
		summary: String(r.summary ?? ""),
		// Pre-SIO-965 rows have no outcome column value -> coalesce to "proposed".
		outcome: r.outcome ? String(r.outcome) : "proposed",
		mrUrl: r.mrUrl ? String(r.mrUrl) : "",
		createdAt: String(r.createdAt ?? ""),
	}));
}

// SIO-965: blast radius -- which stacks wire a given module (cross-stack reuse).
export async function stacksUsingModule(store: GraphStore, module: string): Promise<string[]> {
	if (!module) return [];
	const rows = await store.run<{ stack: string }>(
		"MATCH (s:Stack)-[:USES_MODULE]->(m:Module {name: $name}) RETURN s.name AS stack ORDER BY s.name",
		{ name: module },
	);
	return rows.map((r) => String(r.stack));
}

// SIO-965: blast radius -- which deployments run a given stack (cross-deployment).
export async function deploymentsRunningStack(store: GraphStore, stack: string): Promise<string[]> {
	if (!stack) return [];
	const rows = await store.run<{ deployment: string }>(
		"MATCH (d:ElasticDeployment)<-[:ON_DEPLOYMENT]-(si:StackInstance)-[:OF_STACK]->(s:Stack {name: $name}) RETURN DISTINCT d.name AS deployment ORDER BY deployment",
		{ name: stack },
	);
	return rows.map((r) => String(r.deployment));
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

// SIO-965: optional richer sections appended after the deployment change history.
export interface IacGraphExtra {
	// Per-(deployment,stack) recent changes, with outcome.
	stackInstanceChanges?: StackInstanceChange[];
	// Blast radius: other deployments that also run the targeted stack.
	alsoRunningStack?: { stack: string; deployments: string[] };
}

// SIO-954/SIO-965: renders the deployment's recent change history into a compact
// prompt section. Empty string when there is nothing to show, so the proposer
// prompt is unchanged on a deployment's first-ever turn or when the graph is
// disabled. The two-arg form (extra omitted) renders identically to SIO-954.
export function buildIacGraphContext(deployment: string, changes: IacChange[], extra?: IacGraphExtra): string {
	const stackChanges = extra?.stackInstanceChanges ?? [];
	const alsoRunning = extra?.alsoRunningStack;
	const hasExtra = stackChanges.length > 0 || (alsoRunning?.deployments.length ?? 0) > 0;
	if (changes.length === 0 && !hasExtra) return "";
	const lines: string[] = ["\n\n---\n\n## Knowledge Graph"];
	if (changes.length > 0) {
		lines.push(`### Recent changes to ${deployment}`);
		for (const c of changes) {
			const workflow = c.workflow ? `${c.workflow}: ` : "";
			const mr = c.mrUrl ? ` (${c.mrUrl})` : "";
			lines.push(`- ${workflow}${c.summary}${mr}`);
		}
	}
	if (stackChanges.length > 0) {
		lines.push("### Recent changes to this stack");
		for (const c of stackChanges) {
			const workflow = c.workflow ? `${c.workflow}: ` : "";
			const mr = c.mrUrl ? ` (${c.mrUrl})` : "";
			lines.push(`- [${c.outcome}] ${workflow}${c.summary}${mr}`);
		}
	}
	if (alsoRunning && alsoRunning.deployments.length > 0) {
		lines.push(`### Other deployments running the ${alsoRunning.stack} stack`);
		lines.push(`- ${alsoRunning.deployments.join(", ")}`);
	}
	return lines.join("\n");
}
