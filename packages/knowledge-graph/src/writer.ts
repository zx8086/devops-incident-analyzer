// knowledge-graph/src/writer.ts
//
// SIO-850: idempotent writes into the knowledge graph. Every statement is a
// parameterized MERGE -- values are bound ($params), never interpolated into the
// Cypher string, so a service name like "); DROP" cannot alter the query.

import type { GraphStore } from "./store.ts";

export interface EntityGraph {
	services?: string[];
	kafkaTopics?: string[];
	consumerGroups?: string[];
	buckets?: string[];
	apiRoutes?: string[];
	// Service-to-service dependency edges.
	dependencies?: Array<{ from: string; to: string }>;
}

async function mergeNodes(store: GraphStore, label: string, key: string, values: string[] | undefined): Promise<void> {
	for (const value of values ?? []) {
		if (!value) continue;
		await store.run(`MERGE (n:${label} {${key}: $value})`, { value });
	}
}

export async function upsertEntities(store: GraphStore, graph: EntityGraph): Promise<void> {
	await mergeNodes(store, "Service", "name", graph.services);
	await mergeNodes(store, "KafkaTopic", "name", graph.kafkaTopics);
	await mergeNodes(store, "ConsumerGroup", "name", graph.consumerGroups);
	await mergeNodes(store, "Bucket", "name", graph.buckets);
	await mergeNodes(store, "ApiRoute", "path", graph.apiRoutes);

	for (const dep of graph.dependencies ?? []) {
		if (!dep.from || !dep.to) continue;
		await store.run("MERGE (a:Service {name: $from})", { from: dep.from });
		await store.run("MERGE (b:Service {name: $to})", { to: dep.to });
		await store.run("MATCH (a:Service {name: $from}), (b:Service {name: $to}) MERGE (a)-[:DEPENDS_ON]->(b)", {
			from: dep.from,
			to: dep.to,
		});
	}
}

export interface CorrelationLink {
	findingA: string;
	findingB: string;
	findingAKind?: string;
	findingBKind?: string;
	ruleName: string;
	confidence: number;
}

export async function linkCorrelation(store: GraphStore, link: CorrelationLink): Promise<void> {
	await store.run("MERGE (a:Finding {id: $id}) SET a.kind = $kind", {
		id: link.findingA,
		kind: link.findingAKind ?? "",
	});
	await store.run("MERGE (b:Finding {id: $id}) SET b.kind = $kind", {
		id: link.findingB,
		kind: link.findingBKind ?? "",
	});
	await store.run(
		"MATCH (a:Finding {id: $a}), (b:Finding {id: $b}) MERGE (a)-[r:CORRELATES_WITH {ruleName: $rule}]->(b) SET r.confidence = $confidence",
		{ a: link.findingA, b: link.findingB, rule: link.ruleName, confidence: link.confidence },
	);
}

export interface IncidentRecord {
	id: string;
	severity?: string;
	summary?: string;
	createdAt?: string;
	services?: string[];
	// Precomputed embedding (the caller owns embedding generation so this package
	// stays free of any LLM SDK dependency).
	embedding?: number[];
}

export async function recordIncident(store: GraphStore, incident: IncidentRecord): Promise<void> {
	const setClauses = ["i.severity = $severity", "i.summary = $summary", "i.createdAt = $createdAt"];
	const params: Record<string, unknown> = {
		id: incident.id,
		severity: incident.severity ?? "",
		summary: incident.summary ?? "",
		createdAt: incident.createdAt ?? new Date().toISOString(),
	};
	if (incident.embedding && incident.embedding.length > 0) {
		setClauses.push("i.embedding = $embedding");
		params.embedding = incident.embedding;
	}
	await store.run(`MERGE (i:Incident {id: $id}) SET ${setClauses.join(", ")}`, params);

	for (const service of incident.services ?? []) {
		if (!service) continue;
		await store.run("MERGE (s:Service {name: $name})", { name: service });
		await store.run("MATCH (s:Service {name: $name}), (i:Incident {id: $id}) MERGE (s)-[:AFFECTED_BY]->(i)", {
			name: service,
			id: incident.id,
		});
	}
}

export async function linkResolution(store: GraphStore, incidentId: string, runbookFilenames: string[]): Promise<void> {
	for (const filename of runbookFilenames) {
		if (!filename) continue;
		await store.run("MERGE (r:Runbook {filename: $filename})", { filename });
		await store.run("MATCH (i:Incident {id: $id}), (r:Runbook {filename: $filename}) MERGE (i)-[:RESOLVED_BY]->(r)", {
			id: incidentId,
			filename,
		});
	}
}
