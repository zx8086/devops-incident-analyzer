// knowledge-graph/src/writer.ts
//
// SIO-850: idempotent writes into the knowledge graph. Every statement is a
// parameterized MERGE -- values are bound ($params), never interpolated into the
// Cypher string, so a service name like "); DROP" cannot alter the query.

import { validTopologyEdges } from "./reader.ts";
import {
	APP_MAP_DISCOVERED_BY,
	type BindingKind,
	type IpBindingRecord,
	NETWORK_DISCOVERED_BY,
	type NetworkTopologyRecord,
	NetworkTopologyRecordSchema,
	ORBIT_DISCOVERED_BY,
	TOPOLOGY_DISCOVERED_BY,
	TOPOLOGY_KINDS,
	type TopologyEdgeKind,
	type TopologyEdgeRecord,
	TopologyEdgeRecordSchema,
	VECTOR_INDEX_NAME,
	VECTOR_INDEX_PROPERTY,
	VECTOR_INDEX_TABLE,
} from "./schema.ts";
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
	await store.run(
		"MERGE (i:Incident {id: $id}) SET i.severity = $severity, i.summary = $summary, i.createdAt = $createdAt",
		{
			id: incident.id,
			severity: incident.severity ?? "",
			summary: incident.summary ?? "",
			createdAt: incident.createdAt ?? new Date().toISOString(),
		},
	);
	// SIO-1100: the embedding cannot be SET inline -- it backs the HNSW index, which
	// rejects a plain SET. Route it through the drop/set/recreate path.
	if (incident.embedding && incident.embedding.length > 0) {
		await setIncidentEmbedding(store, incident.id, incident.embedding);
	}

	for (const service of incident.services ?? []) {
		if (!service) continue;
		await store.run("MERGE (s:Service {name: $name})", { name: service });
		await store.run("MATCH (s:Service {name: $name}), (i:Incident {id: $id}) MERGE (s)-[:AFFECTED_BY]->(i)", {
			name: service,
			id: incident.id,
		});
	}
}

// SIO-1026: a derived root cause linked to one incident. id is a stable hash of
// the normalized class (the caller owns hashing) so recurrences MERGE to one node
// and the HAS_ROOT_CAUSE edge accumulates across incidents that share a cause.
export interface RootCauseRecord {
	id: string;
	incidentId: string;
	class?: string;
	description?: string;
	confidence?: number;
	createdAt?: string;
	// The satisfied correlation rule that produced this cause; stored on the edge.
	ruleName?: string;
}

export async function recordRootCause(store: GraphStore, rootCause: RootCauseRecord): Promise<void> {
	if (!rootCause.id || !rootCause.incidentId) return;
	// The node is shared across incidents (PK = class hash): only set identity.
	await store.run("MERGE (rc:RootCause {id: $id}) SET rc.class = $class, rc.description = $description", {
		id: rootCause.id,
		class: rootCause.class ?? "",
		description: rootCause.description ?? "",
	});
	// An incident has at most one root cause. A re-analysis may pick a different
	// rule, so drop any prior HAS_ROOT_CAUSE edge for this incident before linking
	// the new one -- otherwise edges accumulate and rootCauseForIncident (LIMIT 1)
	// would return an arbitrary one.
	await store.run("MATCH (i:Incident {id: $incidentId})-[r:HAS_ROOT_CAUSE]->(:RootCause) DELETE r", {
		incidentId: rootCause.incidentId,
	});
	// Per-incident metadata lives on the edge, not the shared node.
	await store.run(
		"MATCH (i:Incident {id: $incidentId}), (rc:RootCause {id: $id}) MERGE (i)-[r:HAS_ROOT_CAUSE]->(rc) SET r.ruleName = $ruleName, r.confidence = $confidence, r.createdAt = $createdAt",
		{
			incidentId: rootCause.incidentId,
			id: rootCause.id,
			ruleName: rootCause.ruleName ?? "",
			confidence: rootCause.confidence ?? 0,
			createdAt: rootCause.createdAt ?? new Date().toISOString(),
		},
	);
}

// SIO-1100: set ONLY the embedding on an existing (or new) Incident. Distinct from
// recordIncident, which SETs severity/summary/createdAt -- calling that with just an
// embedding would blank those. Used by graphEnrich to persist the vector it already
// computed for similarity search, so future incidents are actually recallable.
//
// The Kuzu/Ladybug engine FORBIDS a bare `SET i.embedding` while the HNSW vector
// index backs that column ("Cannot set property ... used in one or more indexes")
// -- an integration test caught this against the real engine, and it is why the
// original recordIncident embedding path never actually worked once the index
// existed. The supported update path is DROP_VECTOR_INDEX -> SET -> recreate. The
// drop/recreate is best-effort (soft-fail, same idiom as the store's index setup):
// if the vector extension is unavailable the SET simply proceeds against an
// un-indexed column. Safe under the single-writer lock (writes are serialized); a
// concurrent similarIncidents read during the brief indexless window already
// soft-fails to [] (reader.ts), so it degrades rather than errors.
export async function setIncidentEmbedding(store: GraphStore, incidentId: string, embedding: number[]): Promise<void> {
	if (!incidentId || !embedding || embedding.length === 0) return;
	// Drop the index if present so the column becomes writable. Tolerate "no such
	// index" / missing-extension: the SET below still needs to run.
	try {
		await store.run(`CALL DROP_VECTOR_INDEX('${VECTOR_INDEX_TABLE}', '${VECTOR_INDEX_NAME}')`);
	} catch {
		// index absent or extension unavailable -- proceed to the write regardless.
	}
	await store.run("MERGE (i:Incident {id: $id}) SET i.embedding = $embedding", { id: incidentId, embedding });
	// Rebuild the index so similarity search sees the new vector. Best-effort: a
	// graph without the vector extension keeps working, just without similarity.
	try {
		await store.run(
			`CALL CREATE_VECTOR_INDEX('${VECTOR_INDEX_TABLE}', '${VECTOR_INDEX_NAME}', '${VECTOR_INDEX_PROPERTY}')`,
		);
	} catch {
		// extension unavailable -- the embedding is stored; similarity stays disabled.
	}
}

// SIO-1100: W8 investigation-learnings writer. One confirmed telemetry binding =
// a Service observed to use a TelemetrySource (a log group, index, APM name, topic).
// discoveredBy distinguishes agent-inferred (confidence 0.7) from human-confirmed
// (1.0, Stage 4); tInvalid="" marks the edge currently valid. Re-observing a binding
// bumps lastVerified and clears any prior tInvalid (a fresh sighting revalidates it).
// serviceNormalized is caller-owned (this package does not import the agent's
// focus-match module) so the rebuild replay can reconstruct RESOLVES_TO verbatim.
export interface ServiceBindingRecord {
	service: string;
	serviceNormalized: string;
	// A raw source-specific name distinct from the canonical service, if any.
	aliasRaw?: string;
	datasource: string;
	kind: BindingKind;
	resourceId: string;
	locator?: string;
	confidence: number;
	discoveredBy: string;
	evidence?: string;
	// The investigation that taught us this binding (provenance edge to the Incident).
	incidentId?: string;
	createdAt?: string;
}

export async function recordServiceBinding(store: GraphStore, b: ServiceBindingRecord): Promise<void> {
	if (!b.service || !b.resourceId || !b.datasource) return;
	const now = b.createdAt ?? new Date().toISOString();
	await store.run("MERGE (s:Service {name: $name})", { name: b.service });

	// Alias -> Service only when the raw name differs from the canonical service.
	if (b.aliasRaw && b.aliasRaw !== b.service) {
		await store.run("MERGE (a:Alias {name: $name}) SET a.normalized = $normalized", {
			name: b.aliasRaw,
			normalized: b.serviceNormalized,
		});
		// An alias resolves to exactly one service at a time. Invalidate any prior
		// still-valid RESOLVES_TO edge from this alias to a DIFFERENT service before
		// merging the new one -- otherwise bindingsForServices' alias hop would follow
		// both and surface the wrong service's bindings.
		await store.run(
			"MATCH (a:Alias {name: $name})-[r:RESOLVES_TO]->(s:Service) WHERE s.name <> $service AND r.tInvalid = '' SET r.tInvalid = $now",
			{ name: b.aliasRaw, service: b.service, now },
		);
		await store.run(
			"MATCH (a:Alias {name: $name}), (s:Service {name: $service}) MERGE (a)-[r:RESOLVES_TO]->(s) SET r.confidence = $confidence, r.discoveredBy = $discoveredBy, r.createdAt = coalesce(r.createdAt, $now), r.tInvalid = ''",
			{
				name: b.aliasRaw,
				service: b.service,
				confidence: b.confidence,
				discoveredBy: b.discoveredBy,
				now,
			},
		);
		// Keep-first tValid via conditional backfill, NOT coalesce-in-SET: the rel
		// table declares tValid STRING DEFAULT '', so a MERGE-created edge already
		// holds '' when SET evaluates and coalesce(r.tValid, $now) keeps '' forever
		// (proven on lbug 0.14.3, SIO-1207). This also self-heals pre-fix edges
		// still holding '' on their next re-observation. createdAt above is safe in
		// coalesce because it has no DDL DEFAULT and materializes as NULL.
		await store.run(
			"MATCH (a:Alias {name: $name})-[r:RESOLVES_TO]->(s:Service {name: $service}) WHERE coalesce(r.tValid, '') = '' SET r.tValid = $now",
			{ name: b.aliasRaw, service: b.service, now },
		);
	}

	const sourceId = `${b.datasource}:${b.kind}:${b.resourceId}`;
	await store.run(
		"MERGE (t:TelemetrySource {id: $id}) SET t.datasource = $datasource, t.kind = $kind, t.resourceId = $resourceId, t.locator = $locator",
		{
			id: sourceId,
			datasource: b.datasource,
			kind: b.kind,
			resourceId: b.resourceId,
			locator: b.locator ?? "",
		},
	);
	// Re-MERGE always bumps lastVerified and clears tInvalid: re-observing a binding
	// revalidates it. tValid is keep-first via the conditional backfill below.
	await store.run(
		"MATCH (s:Service {name: $service}), (t:TelemetrySource {id: $id}) MERGE (s)-[o:OBSERVED_IN]->(t) SET o.confidence = $confidence, o.discoveredBy = $discoveredBy, o.evidence = $evidence, o.lastVerified = $now, o.tInvalid = ''",
		{
			service: b.service,
			id: sourceId,
			confidence: b.confidence,
			discoveredBy: b.discoveredBy,
			evidence: b.evidence ?? "",
			now,
		},
	);
	// Same DDL-DEFAULT-'' trap as RESOLVES_TO above (SIO-1207): backfill tValid only
	// when empty, so a fresh edge gets a real timestamp, a re-observed edge keeps its
	// first one, and pre-fix edges in live graphs (all holding '') self-heal on their
	// next re-observation.
	await store.run(
		"MATCH (s:Service {name: $service})-[o:OBSERVED_IN]->(t:TelemetrySource {id: $id}) WHERE coalesce(o.tValid, '') = '' SET o.tValid = $now",
		{ service: b.service, id: sourceId, now },
	);

	if (b.incidentId) {
		// MERGE the Incident node first: recordEntities normally created it earlier in
		// the same turn, but the writer must not assume node-creation ordering.
		await store.run("MERGE (i:Incident {id: $id})", { id: b.incidentId });
		await store.run(
			"MATCH (t:TelemetrySource {id: $sid}), (i:Incident {id: $iid}) MERGE (t)-[:DISCOVERED_DURING]->(i)",
			{ sid: sourceId, iid: b.incidentId },
		);
	}
}

// SIO-1103: staleness lifecycle. invalidateBinding retires an agent-discovered binding
// that was used but produced nothing (invalidate-not-delete, P3): set tInvalid and
// append the reason to evidence, so bindingsForServices (WHERE tInvalid='') stops
// surfacing it while the history is preserved for as-of queries. Only ever called for
// discoveredBy != "human" (P5: human-confirmed bindings are never auto-invalidated --
// use flagBindingForReview instead). Matches on the FULL (datasource, kind, resourceId)
// identity so identical (kind, resourceId) values from separate sources stay isolated
// (SIO-1103 CodeRabbit). No-op if there is no currently-valid matching edge.
export async function invalidateBinding(
	store: GraphStore,
	service: string,
	datasource: string,
	kind: string,
	resourceId: string,
	reason: string,
): Promise<void> {
	if (!service || !resourceId || !datasource) return;
	const now = new Date().toISOString();
	await store.run(
		"MATCH (s:Service {name: $service})-[o:OBSERVED_IN]->(t:TelemetrySource {datasource: $datasource, kind: $kind, resourceId: $resourceId}) WHERE o.tInvalid = '' AND o.discoveredBy <> 'human' SET o.tInvalid = $now, o.evidence = o.evidence + ' | invalidated: ' + $reason",
		{ service, datasource, kind, resourceId, now, reason },
	);
}

// SIO-1103: flag a HUMAN-confirmed binding for review instead of invalidating it (P5:
// a single failed lookup must not auto-retire knowledge a human vouched for). Appends
// a review note to evidence; the edge stays valid. The caller decides which path to
// take based on discoveredBy.
export async function flagBindingForReview(
	store: GraphStore,
	service: string,
	datasource: string,
	kind: string,
	resourceId: string,
	reason: string,
): Promise<void> {
	if (!service || !resourceId || !datasource) return;
	const now = new Date().toISOString();
	await store.run(
		"MATCH (s:Service {name: $service})-[o:OBSERVED_IN]->(t:TelemetrySource {datasource: $datasource, kind: $kind, resourceId: $resourceId}) WHERE o.tInvalid = '' AND o.discoveredBy = 'human' SET o.evidence = o.evidence + ' | flagged-for-review ' + $now + ': ' + $reason",
		{ service, datasource, kind, resourceId, now, reason },
	);
}

// SIO-1127: a HUMAN explicit-invalidate of a telemetry binding (HIL learning
// "action: invalidate"). Unlike invalidateBinding (which hard-filters human edges by
// design, P5 -- an automatic single miss must not retire human knowledge) and
// flagBindingForReview (which only annotates), this sets tInvalid on ANY currently-valid
// edge regardless of discoveredBy: an explicit human verdict overrides even a prior
// human confirmation. Single-clause lbug-safe Cypher; matches the FULL (datasource, kind,
// resourceId) identity so sibling sources stay isolated. No-op if nothing currently valid.
export async function invalidateBindingByHuman(
	store: GraphStore,
	service: string,
	datasource: string,
	kind: string,
	resourceId: string,
	reason: string,
): Promise<void> {
	if (!service || !resourceId || !datasource) return;
	const now = new Date().toISOString();
	await store.run(
		"MATCH (s:Service {name: $service})-[o:OBSERVED_IN]->(t:TelemetrySource {datasource: $datasource, kind: $kind, resourceId: $resourceId}) WHERE o.tInvalid = '' SET o.tInvalid = $now, o.evidence = o.evidence + ' | invalidated-by-human: ' + $reason",
		{ service, datasource, kind, resourceId, now, reason },
	);
}

// SIO-965: the change-outcome lifecycle. A turn opens as "proposed"; the
// recordIacOutcome node later promotes it to applied/rejected/failed.
export type ChangeOutcome = "proposed" | "applied" | "rejected" | "failed";

// SIO-954: one elastic-iac maker turn's proposed change. filePaths is collapsed
// to a single filePath property on the ConfigChange node (the first path, or a
// "N files" marker for multi-file rollouts) so the node stays single-valued; the
// full list lives in the turn's MR. mrUrl is set only after openMr.
export interface IacChangeRecord {
	id: string;
	deployment: string;
	workflow?: string;
	filePaths?: string[];
	summary?: string;
	mrUrl?: string;
	createdAt?: string;
	// SIO-965: three-layer attachments. stackInstanceId is "<deployment>/<stack>";
	// threadId groups turns of one conversation; outcome defaults to "proposed".
	stackInstanceId?: string;
	threadId?: string;
	outcome?: ChangeOutcome;
}

function summariseFilePaths(filePaths: string[] | undefined): string {
	const paths = (filePaths ?? []).filter((p) => p.length > 0);
	const first = paths[0];
	if (!first) return "";
	if (paths.length === 1) return first;
	return `${first} (+${paths.length - 1} more)`;
}

export async function recordIacChange(store: GraphStore, change: IacChangeRecord): Promise<void> {
	if (!change.id || !change.deployment) return;
	await store.run("MERGE (d:ElasticDeployment {name: $name})", { name: change.deployment });
	await store.run(
		"MERGE (c:ConfigChange {id: $id}) SET c.workflow = $workflow, c.filePath = $filePath, c.summary = $summary, c.createdAt = $createdAt, c.outcome = $outcome",
		{
			id: change.id,
			workflow: change.workflow ?? "",
			filePath: summariseFilePaths(change.filePaths),
			summary: change.summary ?? "",
			createdAt: change.createdAt ?? new Date().toISOString(),
			outcome: change.outcome ?? "proposed",
		},
	);
	await store.run(
		"MATCH (d:ElasticDeployment {name: $name}), (c:ConfigChange {id: $id}) MERGE (d)-[:CHANGED_BY]->(c)",
		{ name: change.deployment, id: change.id },
	);
	if (change.mrUrl) {
		await store.run("MERGE (m:MergeRequest {url: $url})", { url: change.mrUrl });
		await store.run("MATCH (c:ConfigChange {id: $id}), (m:MergeRequest {url: $url}) MERGE (c)-[:PROPOSED_IN]->(m)", {
			id: change.id,
			url: change.mrUrl,
		});
	}
	// SIO-965: three-layer attachments. Each is independently optional so older
	// callers (and the SIO-954 tests) that pass none get the unchanged behaviour.
	if (change.workflow) {
		await store.run("MERGE (w:Workflow {name: $name})", { name: change.workflow });
		await store.run("MATCH (c:ConfigChange {id: $id}), (w:Workflow {name: $name}) MERGE (c)-[:VIA_WORKFLOW]->(w)", {
			id: change.id,
			name: change.workflow,
		});
	}
	if (change.threadId) {
		await store.run("MERGE (s:Session {threadId: $tid})", { tid: change.threadId });
		await store.run("MATCH (c:ConfigChange {id: $id}), (s:Session {threadId: $tid}) MERGE (c)-[:IN_SESSION]->(s)", {
			id: change.id,
			tid: change.threadId,
		});
	}
	if (change.stackInstanceId) {
		await store.run("MERGE (si:StackInstance {id: $sid})", { sid: change.stackInstanceId });
		await store.run("MATCH (c:ConfigChange {id: $id}), (si:StackInstance {id: $sid}) MERGE (c)-[:TARGETS]->(si)", {
			id: change.id,
			sid: change.stackInstanceId,
		});
	}
}

// SIO-965: record (or update) the GitLab CI pipeline for an MR. pipelineId is the
// numeric GitLab id; it is stringified for primary-key uniformity.
export interface PipelineRecord {
	mrUrl: string;
	pipelineId: number | string;
	status?: string;
	url?: string;
}

export async function recordPipeline(store: GraphStore, pipeline: PipelineRecord): Promise<void> {
	const id = String(pipeline.pipelineId ?? "");
	if (!pipeline.mrUrl || !id) return;
	await store.run("MERGE (pl:Pipeline {id: $id}) SET pl.status = $status, pl.url = $url", {
		id,
		status: pipeline.status ?? "",
		url: pipeline.url ?? "",
	});
	await store.run("MERGE (m:MergeRequest {url: $url})", { url: pipeline.mrUrl });
	await store.run("MATCH (m:MergeRequest {url: $mr}), (pl:Pipeline {id: $id}) MERGE (m)-[:RAN]->(pl)", {
		mr: pipeline.mrUrl,
		id,
	});
}

// SIO-965: promote a change's outcome once its pipeline reaches a terminal state.
export async function setChangeOutcome(store: GraphStore, changeId: string, outcome: ChangeOutcome): Promise<void> {
	if (!changeId) return;
	await store.run("MATCH (c:ConfigChange {id: $id}) SET c.outcome = $outcome", { id: changeId, outcome });
}

// SIO-1525: existence probes for the gitlab-import sweep's dedupe. configChangeExists keys the
// per-record idempotency check; mrUrlHasChange answers "did THIS agent already record the change
// behind this MR" (an MR url only gets a PROPOSED_IN edge through the agent's own write paths).
export async function configChangeExists(store: GraphStore, changeId: string): Promise<boolean> {
	if (!changeId) return false;
	const rows = await store.run<{ id: string }>("MATCH (c:ConfigChange {id: $id}) RETURN c.id AS id LIMIT 1", {
		id: changeId,
	});
	return rows.length > 0;
}

export async function mrUrlHasChange(store: GraphStore, url: string): Promise<boolean> {
	if (!url) return false;
	const rows = await store.run<{ url: string }>(
		"MATCH (:ConfigChange)-[:PROPOSED_IN]->(m:MergeRequest {url: $url}) RETURN m.url AS url LIMIT 1",
		{ url },
	);
	return rows.length > 0;
}

// SIO-1062: re-key a ConfigChange's MergeRequest from a poisoned url (a "[409] {...}" GitLab
// error blob stored as mrUrl before the openMr guard existed) to the MR's real web_url.
// MERGE-first ordering so a crash mid-repair leaves both links (safe: reconcile still works via
// the good one). DETACH DELETE of the bad node is best-effort -- lbug's support for it is
// unverified (only relationship DELETE is proven in this file, see recordRootCause); an orphaned
// MergeRequest node is unreachable by every reader query (all traverse PROPOSED_IN / RAN edges)
// and therefore harmless. Plain DELETE is NOT a safe fallback: recordPipeline may have attached
// RAN edges to the blob node, which makes a non-detach delete fail.
export async function repairChangeMrUrl(
	store: GraphStore,
	changeId: string,
	badUrl: string,
	goodUrl: string,
): Promise<void> {
	if (!changeId || !badUrl || !goodUrl || badUrl === goodUrl) return;
	await store.run("MERGE (m:MergeRequest {url: $url})", { url: goodUrl });
	await store.run("MATCH (c:ConfigChange {id: $id}), (m:MergeRequest {url: $url}) MERGE (c)-[:PROPOSED_IN]->(m)", {
		id: changeId,
		url: goodUrl,
	});
	await store.run("MATCH (c:ConfigChange {id: $id})-[r:PROPOSED_IN]->(:MergeRequest {url: $bad}) DELETE r", {
		id: changeId,
		bad: badUrl,
	});
	try {
		await store.run("MATCH (m:MergeRequest {url: $bad}) DETACH DELETE m", { bad: badUrl });
	} catch {
		// Best-effort only: the orphaned blob node is unreachable by all reader queries.
	}
}

// SIO-1038: persist one elastic-iac turn's VERBATIM user prompt. id is the turn's
// requestId (== its ConfigChange id when it opens an MR). text is RAW and NOT
// truncated -- unlike Incident.summary's .slice(0, 280) cap. When threadId is
// present, link the prompt to its Session. Values are bound (never interpolated),
// so raw prompt text with Cypher metacharacters is safe.
export interface IacPromptRecord {
	id: string;
	text?: string;
	agent?: string;
	threadId?: string;
	createdAt?: string;
}

export async function recordIacPrompt(store: GraphStore, prompt: IacPromptRecord): Promise<void> {
	if (!prompt.id) return;
	await store.run("MERGE (p:Prompt {id: $id}) SET p.text = $text, p.agent = $agent, p.createdAt = $createdAt", {
		id: prompt.id,
		text: prompt.text ?? "",
		agent: prompt.agent ?? "",
		createdAt: prompt.createdAt ?? new Date().toISOString(),
	});
	if (prompt.threadId) {
		await store.run("MERGE (s:Session {threadId: $tid})", { tid: prompt.threadId });
		await store.run("MATCH (p:Prompt {id: $id}), (s:Session {threadId: $tid}) MERGE (p)-[:PROMPTED_IN]->(s)", {
			id: prompt.id,
			tid: prompt.threadId,
		});
	}
}

// --- SIO-965 repo-structure seeders -----------------------------------------
//
// Pure, network-free, idempotent (all MERGE). The seed-iac CLI owns all GitLab
// I/O and feeds these already-parsed lists, so the package stays dependency-free.

export interface DeploymentSeed {
	name: string;
	ecId?: string;
	region?: string;
}

export async function seedModules(store: GraphStore, modules: string[]): Promise<void> {
	await mergeNodes(store, "Module", "name", modules);
}

export async function seedStacks(store: GraphStore, stacks: string[]): Promise<void> {
	await mergeNodes(store, "Stack", "name", stacks);
}

// One Stack -> Module edge (a stack can wire several modules, e.g. `deployments`).
export async function linkStackModule(store: GraphStore, stack: string, module: string): Promise<void> {
	if (!stack || !module) return;
	await store.run("MERGE (s:Stack {name: $stack})", { stack });
	await store.run("MERGE (m:Module {name: $module})", { module });
	await store.run("MATCH (s:Stack {name: $stack}), (m:Module {name: $module}) MERGE (s)-[:USES_MODULE]->(m)", {
		stack,
		module,
	});
}

export async function seedDeployments(store: GraphStore, deployments: DeploymentSeed[]): Promise<void> {
	for (const d of deployments) {
		if (!d.name) continue;
		await store.run("MERGE (d:ElasticDeployment {name: $name}) SET d.ecId = $ecId, d.region = $region", {
			name: d.name,
			ecId: d.ecId ?? "",
			region: d.region ?? "",
		});
	}
}

// Each StackInstance is the (deployment, stack) state cell; id is "<dep>/<stack>".
export async function seedStackInstances(
	store: GraphStore,
	instances: Array<{ deployment: string; stack: string }>,
): Promise<void> {
	for (const inst of instances) {
		if (!inst.deployment || !inst.stack) continue;
		const id = `${inst.deployment}/${inst.stack}`;
		await store.run("MERGE (si:StackInstance {id: $id}) SET si.deployment = $deployment, si.stack = $stack", {
			id,
			deployment: inst.deployment,
			stack: inst.stack,
		});
		await store.run("MERGE (s:Stack {name: $stack})", { stack: inst.stack });
		await store.run("MERGE (d:ElasticDeployment {name: $deployment})", { deployment: inst.deployment });
		await store.run("MATCH (si:StackInstance {id: $id}), (s:Stack {name: $stack}) MERGE (si)-[:OF_STACK]->(s)", {
			id,
			stack: inst.stack,
		});
		await store.run(
			"MATCH (si:StackInstance {id: $id}), (d:ElasticDeployment {name: $deployment}) MERGE (si)-[:ON_DEPLOYMENT]->(d)",
			{ id, deployment: inst.deployment },
		);
	}
}

// SIO-1134: curation link. The human act of creating a Jira ticket from this
// incident's report (or confirming a learn-from match against the ticket) marks
// the incident as the CANONICAL record for that ticket -- learn-from resolves it
// by exact lookup thereafter, and enrichment surfaces curated incidents only.
export async function linkIncidentTicket(store: GraphStore, incidentId: string, ticketKey: string): Promise<void> {
	if (!incidentId || !ticketKey) return;
	await store.run("MATCH (i:Incident {id: $id}) SET i.ticketKey = $ticketKey", { id: incidentId, ticketKey });
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

export interface PurgeUncuratedResult {
	incidents: number;
	edges: number;
}

// SIO-1135: physically remove uncurated Incident rows older than a retention cutoff.
// Uncurated == ticketKey empty (only human-curated investigations are durable memory,
// SIO-1134); stale == createdAt < cutoff (createdAt is an ISO STRING, so a lexicographic
// compare is chronological). SIO-1136: legacy rows created before the CREATE-DDL default
// carry ticketKey = NULL (not ''), so the uncurated predicate must match BOTH. lbug 0.14.3
// constraint: DETACH DELETE on a node is unverified (only relationship DELETE is proven,
// see recordRootCause) -- so delete every Incident-touching edge first, each as its OWN
// single-clause statement matching the edge's schema direction, then delete the now-orphaned
// nodes. Additive/soft by nature: the caller owns soft-failing. Returns counts for logging.
const UNCURATED_STALE_WHERE = "(i.ticketKey IS NULL OR i.ticketKey = '') AND i.createdAt < $cutoff";

export async function purgeUncuratedIncidents(store: GraphStore, cutoffIso: string): Promise<PurgeUncuratedResult> {
	// Guard: never run with an empty/invalid cutoff -- a blank cutoff string compares
	// greater than every real createdAt and would delete EVERY uncurated incident.
	if (!cutoffIso || Number.isNaN(Date.parse(cutoffIso))) return { incidents: 0, edges: 0 };

	// Count the doomed nodes before deleting so the sweep can log what it removed.
	const [countRow] = await store.run<{ n: number }>(
		`MATCH (i:Incident) WHERE ${UNCURATED_STALE_WHERE} RETURN count(i) AS n`,
		{ cutoff: cutoffIso },
	);
	const incidents = Number(countRow?.n ?? 0);
	if (incidents === 0) return { incidents: 0, edges: 0 };

	// Delete every Incident-touching edge, one type at a time, matching the schema
	// direction (schema.ts): AFFECTED_BY Service->Incident, DISCOVERED_DURING
	// TelemetrySource->Incident (inbound); RESOLVED_BY Incident->Runbook, HAS_ROOT_CAUSE
	// Incident->RootCause (outbound). Count then DELETE as SEPARATE single-clause
	// statements -- mixing count(r) aggregation with DELETE in one query is not a proven
	// lbug shape, so keep each statement single-purpose.
	const edgeMatches = [
		"MATCH (:Service)-[r:AFFECTED_BY]->(i:Incident)",
		"MATCH (:TelemetrySource)-[r:DISCOVERED_DURING]->(i:Incident)",
		"MATCH (i:Incident)-[r:RESOLVED_BY]->(:Runbook)",
		"MATCH (i:Incident)-[r:HAS_ROOT_CAUSE]->(:RootCause)",
	];
	let edges = 0;
	for (const match of edgeMatches) {
		const [row] = await store.run<{ n: number }>(`${match} WHERE ${UNCURATED_STALE_WHERE} RETURN count(r) AS n`, {
			cutoff: cutoffIso,
		});
		edges += Number(row?.n ?? 0);
		await store.run(`${match} WHERE ${UNCURATED_STALE_WHERE} DELETE r`, { cutoff: cutoffIso });
	}

	// Now the nodes are edge-free; a plain DELETE (not DETACH) succeeds.
	await store.run(`MATCH (i:Incident) WHERE ${UNCURATED_STALE_WHERE} DELETE i`, { cutoff: cutoffIso });
	return { incidents, edges };
}

// SIO-1104 (5a): topology-sweep writers. Pure and network-free -- the cron collector
// (packages/agent/src/kg-topology.ts) owns all MCP I/O and feeds parsed edge lists.
// Labels/keys come from the internal TOPOLOGY_KINDS map (never caller input); values
// are always bound.
export type { TopologyEdgeRecord } from "./schema.ts";

export async function recordTopologyEdges(store: GraphStore, edges: TopologyEdgeRecord[]): Promise<void> {
	for (const raw of edges) {
		// Collector output is parsed EXTERNAL data -- validate the whole record at
		// the writer boundary (kind, non-empty endpoints), not just the kind.
		const parsed = TopologyEdgeRecordSchema.safeParse(raw);
		if (!parsed.success) continue;
		const edge = parsed.data;
		const { rel, fromLabel, fromKey, toLabel, toKey } = TOPOLOGY_KINDS[edge.kind];
		const now = edge.createdAt ?? new Date().toISOString();
		await store.run(`MERGE (a:${fromLabel} {${fromKey}: $from})`, { from: edge.from });
		await store.run(`MERGE (b:${toLabel} {${toKey}: $to})`, { to: edge.to });
		// Re-observe revalidates: clear tInvalid, reset the miss counter, and claim
		// lifecycle ownership (discoveredBy) -- an agent-written edge the sweep
		// re-observes deliberately becomes sweep-managed from then on.
		// KNOWN LIMITATION (single-interval bi-temporality, the SIO-1100 substrate
		// design shared with OBSERVED_IN): revival keeps the FIRST tValid and clears
		// tInvalid, so an as-of read inside the invalidated gap reports the edge as
		// valid. Interval versioning is a deliberate non-goal of Stage 5.
		await store.run(
			`MATCH (a:${fromLabel} {${fromKey}: $from}), (b:${toLabel} {${toKey}: $to}) MERGE (a)-[r:${rel}]->(b) SET r.discoveredBy = $discoveredBy, r.tInvalid = '', r.consecutiveMisses = 0`,
			{ from: edge.from, to: edge.to, discoveredBy: TOPOLOGY_DISCOVERED_BY },
		);
		// Keep-first tValid. Rows hold '' (the column DEFAULT), not NULL, so the
		// coalesce-in-SET idiom cannot apply -- backfill via a conditional WHERE
		// instead (verified on lbug 0.14.3; recordServiceBinding uses the same idiom).
		await store.run(
			`MATCH (a:${fromLabel} {${fromKey}: $from})-[r:${rel}]->(b:${toLabel} {${toKey}: $to}) WHERE coalesce(r.tValid, '') = '' SET r.tValid = $now`,
			{ from: edge.from, to: edge.to, now },
		);
	}
}

// SIO-1305: DEPENDS_ON edges derived from Orbit's SIO-1303 definition name-match
// consumers (code-derived downstream-impact evidence, resolved to canonical Service
// names by the caller -- this writer never guesses a Service from a raw repo path).
// These coexist with the APM topology sweep's DEPENDS_ON edges on the SAME rel
// table, disambiguated only by discoveredBy, so a collision policy is mandatory:
// NEVER demote an edge the APM sweep already confirmed (discoveredBy ==
// TOPOLOGY_DISCOVERED_BY) to Orbit provenance. recordTopologyEdges's unconditional
// re-observe-claims-ownership SET is correct for its own single-writer sweep, but
// wrong here where two independent, differently-trusted sources write the same
// table -- so this is NOT a call to recordTopologyEdges; it duplicates the MERGE
// shape with a pre-check gating the discoveredBy SET, modeled on recordIpBinding's
// invalidate-the-conflict-before-merge shape (also in this file) rather than a
// conditional SET clause.
export async function recordOrbitDependsOnEdges(store: GraphStore, edges: TopologyEdgeRecord[]): Promise<void> {
	const { rel, fromLabel, fromKey, toLabel, toKey } = TOPOLOGY_KINDS["depends-on"];
	for (const raw of edges) {
		const parsed = TopologyEdgeRecordSchema.safeParse(raw);
		if (!parsed.success || parsed.data.kind !== "depends-on") continue;
		const edge = parsed.data;
		const now = edge.createdAt ?? new Date().toISOString();
		await store.run(`MERGE (a:${fromLabel} {${fromKey}: $from})`, { from: edge.from });
		await store.run(`MERGE (b:${toLabel} {${toKey}: $to})`, { to: edge.to });
		// Pre-check: does a currently-valid, sweep-owned edge already exist for this
		// exact pair? If so, this write is a no-op -- the APM sweep's confirmation
		// stands, never overwritten by a lower-trust code co-occurrence signal.
		const owned = await store.run<{ n: number }>(
			`MATCH (a:${fromLabel} {${fromKey}: $from})-[r:${rel}]->(b:${toLabel} {${toKey}: $to}) WHERE r.discoveredBy = $topologyDiscoveredBy AND r.tInvalid = '' RETURN count(r) AS n`,
			{ from: edge.from, to: edge.to, topologyDiscoveredBy: TOPOLOGY_DISCOVERED_BY },
		);
		if ((owned[0]?.n ?? 0) > 0) continue;
		// MERGE with a discoveredBy guard: only claim/re-claim Orbit ownership when
		// the edge is new or already Orbit-owned -- never when it's owned by anyone
		// else (the pre-check above covers the sweep; this WHERE covers any other
		// future writer sharing this table).
		await store.run(
			`MATCH (a:${fromLabel} {${fromKey}: $from}), (b:${toLabel} {${toKey}: $to}) MERGE (a)-[r:${rel}]->(b) WITH r WHERE coalesce(r.discoveredBy, '') = '' OR r.discoveredBy = $orbitDiscoveredBy SET r.discoveredBy = $orbitDiscoveredBy, r.tInvalid = '', r.consecutiveMisses = 0`,
			{ from: edge.from, to: edge.to, orbitDiscoveredBy: ORBIT_DISCOVERED_BY },
		);
		await backfillEdgeTValid(
			store,
			`(a:${fromLabel} {${fromKey}: $from})-[r:${rel}]->(b:${toLabel} {${toKey}: $to})`,
			"r",
			{ from: edge.from, to: edge.to },
			now,
		);
	}
}

// SIO-1457: DEPENDS_ON / CONSUMES_FROM edges observed by the per-incident
// application map (APM destination aggregation, kafka consumer-group tools).
// Third writer on these rel tables (after the topology sweep and Orbit), so it
// reuses recordOrbitDependsOnEdges's never-demote collision policy verbatim:
//   1. a currently-valid sweep-owned edge for the pair -> no-op (the sweep's
//      confirmation is authoritative and lifecycle-managed; a per-incident
//      sighting adds nothing and must not perturb miss-counting state);
//   2. claim/re-claim only unowned or app-map-owned edges -- an edge owned by
//      ANY other writer (orbit today, future collectors tomorrow) is left
//      untouched.
// Not a call to recordTopologyEdges (its unconditional re-observe-claims-
// ownership SET is only correct for the single-writer sweep). App-map edges are
// create-only/revalidate-on-reobservation: deliberately OUTSIDE the sweep's
// K-miss lifecycle (see APP_MAP_DISCOVERED_BY in schema.ts).
export async function recordAppMapTopologyEdges(
	store: GraphStore,
	kind: Extract<TopologyEdgeKind, "depends-on" | "consumes-from">,
	edges: TopologyEdgeRecord[],
): Promise<void> {
	const { rel, fromLabel, fromKey, toLabel, toKey } = TOPOLOGY_KINDS[kind];
	for (const raw of edges) {
		const parsed = TopologyEdgeRecordSchema.safeParse(raw);
		if (!parsed.success || parsed.data.kind !== kind) continue;
		const edge = parsed.data;
		const now = edge.createdAt ?? new Date().toISOString();
		await store.run(`MERGE (a:${fromLabel} {${fromKey}: $from})`, { from: edge.from });
		await store.run(`MERGE (b:${toLabel} {${toKey}: $to})`, { to: edge.to });
		const owned = await store.run<{ n: number }>(
			`MATCH (a:${fromLabel} {${fromKey}: $from})-[r:${rel}]->(b:${toLabel} {${toKey}: $to}) WHERE r.discoveredBy = $topologyDiscoveredBy AND r.tInvalid = '' RETURN count(r) AS n`,
			{ from: edge.from, to: edge.to, topologyDiscoveredBy: TOPOLOGY_DISCOVERED_BY },
		);
		if ((owned[0]?.n ?? 0) > 0) continue;
		await store.run(
			`MATCH (a:${fromLabel} {${fromKey}: $from}), (b:${toLabel} {${toKey}: $to}) MERGE (a)-[r:${rel}]->(b) WITH r WHERE coalesce(r.discoveredBy, '') = '' OR r.discoveredBy = $appMapDiscoveredBy SET r.discoveredBy = $appMapDiscoveredBy, r.tInvalid = '', r.consecutiveMisses = 0`,
			{ from: edge.from, to: edge.to, appMapDiscoveredBy: APP_MAP_DISCOVERED_BY },
		);
		await backfillEdgeTValid(
			store,
			`(a:${fromLabel} {${fromKey}: $from})-[r:${rel}]->(b:${toLabel} {${toKey}: $to})`,
			"r",
			{ from: edge.from, to: edge.to },
			now,
		);
	}
}

export interface TopologySweepResult {
	checked: number;
	missed: number;
	invalidated: number;
}

// K-consecutive-miss staleness for sweep-owned edges of one kind. The set-difference
// is computed in TS (read valid edges, diff against the fresh collection) and each
// missing edge gets one simple parameterized statement -- the lbug binder is fragile
// with multi-clause restructures. Only discoveredBy='topology-job' edges are ever
// touched; a re-observed edge was already reset to 0 by recordTopologyEdges. The
// caller MUST NOT sweep on a partial collection (a failed estate/deployment would
// accrue false misses) -- that gate lives in the collector's `complete` flag.
export async function sweepStaleTopology(
	store: GraphStore,
	kind: TopologyEdgeKind,
	fresh: Array<{ from: string; to: string }>,
	opts?: { maxMisses?: number; now?: string },
): Promise<TopologySweepResult> {
	const maxMisses = opts?.maxMisses ?? 3;
	const now = opts?.now ?? new Date().toISOString();
	const valid = await validTopologyEdges(store, kind);
	const freshSet = new Set(fresh.map((e) => `${e.from}\u0000${e.to}`));
	const { rel, fromLabel, fromKey, toLabel, toKey } = TOPOLOGY_KINDS[kind];
	let missed = 0;
	let invalidated = 0;
	for (const edge of valid) {
		if (freshSet.has(`${edge.from}\u0000${edge.to}`)) continue;
		missed++;
		const misses = edge.consecutiveMisses + 1;
		if (misses >= maxMisses) {
			invalidated++;
			await store.run(
				`MATCH (a:${fromLabel} {${fromKey}: $from})-[r:${rel}]->(b:${toLabel} {${toKey}: $to}) WHERE r.discoveredBy = $discoveredBy AND r.tInvalid = '' SET r.consecutiveMisses = $misses, r.tInvalid = $now`,
				{ from: edge.from, to: edge.to, discoveredBy: TOPOLOGY_DISCOVERED_BY, misses, now },
			);
		} else {
			await store.run(
				`MATCH (a:${fromLabel} {${fromKey}: $from})-[r:${rel}]->(b:${toLabel} {${toKey}: $to}) WHERE r.discoveredBy = $discoveredBy AND r.tInvalid = '' SET r.consecutiveMisses = $misses`,
				{ from: edge.from, to: edge.to, discoveredBy: TOPOLOGY_DISCOVERED_BY, misses },
			);
		}
	}
	return { checked: valid.length, missed, invalidated };
}

// --- SIO-1204/SIO-1207 (slice 3a): per-incident network-map writers ----------
//
// The aws-agent's collector owns all AWS I/O and CIDR math and feeds parsed
// records; these writers are pure, parameterized and idempotent. Structural edges
// (placement + ingress chain) get the RUNS_ON-style lifecycle stamp with
// discoveredBy = NETWORK_DISCOVERED_BY; HAS_ENDPOINT / BOUND_TO carry the
// OBSERVED_IN provenance SET (re-observation bumps lastVerified and revalidates).
//
// Keep-first tValid uses the recordTopologyEdges conditional-WHERE backfill, NOT
// recordServiceBinding's coalesce-in-SET: every network rel table is born with
// tValid STRING DEFAULT '', and on lbug 0.14.3 a MERGE-created edge materializes
// that DEFAULT before the SET evaluates, so coalesce(r.tValid, $now) reads '' and
// keeps it -- the edge would never gain a real tValid and as-of reads would treat
// it as valid-from-the-beginning (verified against the real engine by the SIO-1207
// integration test).

// HAS_ENDPOINT default confidence: the 0.7 agent-observed convention from SIO-1100
// (human confirmation would be 1.0 and is out of scope for slice 3a -- EndpointRecord
// deliberately carries no confidence field).
const NETWORK_ENDPOINT_CONFIDENCE = 0.7;

// Keep-first tValid backfill for one just-merged edge (the SIO-1104 idiom): only an
// edge whose tValid is still the column DEFAULT '' (or NULL) gets stamped, so a
// re-observed edge keeps its FIRST tValid.
async function backfillEdgeTValid(
	store: GraphStore,
	pattern: string,
	edge: string,
	params: Record<string, unknown>,
	now: string,
): Promise<void> {
	await store.run(`MATCH ${pattern} WHERE coalesce(${edge}.tValid, '') = '' SET ${edge}.tValid = $now`, {
		...params,
		now,
	});
}

// One structural network edge: MERGE both endpoints bare (never assume node
// ordering), then MATCH + MERGE the edge with the lifecycle stamp. Labels/keys/rel
// come from internal constants (never caller input); values are always bound.
async function mergeNetworkEdge(
	store: GraphStore,
	rel: string,
	from: { label: string; key: string; value: string },
	to: { label: string; key: string; value: string },
	now: string,
): Promise<void> {
	await store.run(`MERGE (a:${from.label} {${from.key}: $from})`, { from: from.value });
	await store.run(`MERGE (b:${to.label} {${to.key}: $to})`, { to: to.value });
	await store.run(
		`MATCH (a:${from.label} {${from.key}: $from}), (b:${to.label} {${to.key}: $to}) MERGE (a)-[r:${rel}]->(b) SET r.discoveredBy = $discoveredBy, r.tInvalid = '', r.consecutiveMisses = 0`,
		{ from: from.value, to: to.value, discoveredBy: NETWORK_DISCOVERED_BY },
	);
	await backfillEdgeTValid(
		store,
		`(a:${from.label} {${from.key}: $from})-[r:${rel}]->(b:${to.label} {${to.key}: $to})`,
		"r",
		{ from: from.value, to: to.value },
		now,
	);
}

// One incident turn's observed AWS network map. Zod-parses the WHOLE record at the
// boundary (collector output is parsed EXTERNAL data; throws before anything is
// written). MERGE order is parents-before-children -- vpcs -> subnets -> load
// balancers -> target groups -> targets -> dns -> endpoints -> ip bindings -- so
// SET-carrying node MERGEs land before the bare edge-endpoint MERGEs reference them.
export async function recordNetworkTopology(
	store: GraphStore,
	record: NetworkTopologyRecord,
	incidentId?: string,
): Promise<void> {
	const r = NetworkTopologyRecordSchema.parse(record);
	const now = new Date().toISOString();

	for (const vpc of r.vpcs) {
		await store.run(
			"MERGE (v:Vpc {id: $id}) SET v.cidr = $cidr, v.accountId = $accountId, v.region = $region, v.name = $name",
			{
				id: vpc.id,
				cidr: vpc.cidr ?? "",
				accountId: vpc.accountId ?? "",
				region: vpc.region ?? "",
				name: vpc.name ?? "",
			},
		);
	}
	for (const subnet of r.subnets) {
		await store.run("MERGE (s:Subnet {id: $id}) SET s.cidr = $cidr, s.az = $az, s.vpcId = $vpcId", {
			id: subnet.id,
			cidr: subnet.cidr ?? "",
			az: subnet.az ?? "",
			vpcId: subnet.vpcId ?? "",
		});
		if (subnet.vpcId) {
			await mergeNetworkEdge(
				store,
				"IN_VPC",
				{ label: "Subnet", key: "id", value: subnet.id },
				{ label: "Vpc", key: "id", value: subnet.vpcId },
				now,
			);
		}
	}
	for (const lb of r.loadBalancers) {
		await store.run(
			"MERGE (lb:LoadBalancer {arn: $arn}) SET lb.name = $name, lb.dnsName = $dnsName, lb.type = $type, lb.scheme = $scheme",
			{ arn: lb.arn, name: lb.name ?? "", dnsName: lb.dnsName ?? "", type: lb.type ?? "", scheme: lb.scheme ?? "" },
		);
		for (const subnetId of lb.subnetIds ?? []) {
			await mergeNetworkEdge(
				store,
				"ATTACHED_TO",
				{ label: "LoadBalancer", key: "arn", value: lb.arn },
				{ label: "Subnet", key: "id", value: subnetId },
				now,
			);
		}
	}
	for (const tg of r.targetGroups) {
		await store.run(
			"MERGE (tg:TargetGroup {arn: $arn}) SET tg.name = $name, tg.port = $port, tg.protocol = $protocol",
			{
				arn: tg.arn,
				name: tg.name ?? "",
				port: tg.port ?? 0,
				protocol: tg.protocol ?? "",
			},
		);
		if (tg.loadBalancerArn) {
			await mergeNetworkEdge(
				store,
				"HAS_TARGET_GROUP",
				{ label: "LoadBalancer", key: "arn", value: tg.loadBalancerArn },
				{ label: "TargetGroup", key: "arn", value: tg.arn },
				now,
			);
		}
		for (const target of tg.targets ?? []) {
			// isIp routes to the FORWARDS_TO_IP table (two tables deliberately -- see schema.ts).
			if (target.isIp) {
				await mergeNetworkEdge(
					store,
					"FORWARDS_TO_IP",
					{ label: "TargetGroup", key: "arn", value: tg.arn },
					{ label: "IpAddress", key: "ip", value: target.id },
					now,
				);
			} else {
				await mergeNetworkEdge(
					store,
					"FORWARDS_TO",
					{ label: "TargetGroup", key: "arn", value: tg.arn },
					{ label: "AwsResource", key: "arn", value: target.id },
					now,
				);
			}
		}
	}
	for (const dns of r.dnsRecords) {
		// id = "<name>:<type>": one DNS name legitimately carries A + AAAA + CNAME rows.
		const id = `${dns.name}:${dns.type}`;
		await store.run("MERGE (d:DnsRecord {id: $id}) SET d.name = $name, d.type = $type, d.target = $target", {
			id,
			name: dns.name,
			type: dns.type,
			target: dns.target ?? "",
		});
		if (dns.loadBalancerArn) {
			await mergeNetworkEdge(
				store,
				"RESOLVES_TO_LB",
				{ label: "DnsRecord", key: "id", value: id },
				{ label: "LoadBalancer", key: "arn", value: dns.loadBalancerArn },
				now,
			);
		}
	}
	for (const ep of r.endpoints) {
		// MERGE the Service first -- never assume an earlier pipeline node created it.
		await store.run("MERGE (s:Service {name: $name})", { name: ep.service });
		const id = ep.port !== undefined ? `${ep.host}:${ep.port}` : ep.host;
		await store.run(
			"MERGE (e:Endpoint {id: $id}) SET e.host = $host, e.port = $port, e.protocol = $protocol, e.datasource = $datasource",
			{ id, host: ep.host, port: ep.port ?? 0, protocol: ep.protocol ?? "", datasource: ep.datasource },
		);
		// The OBSERVED_IN provenance SET (recordServiceBinding): re-observation bumps
		// lastVerified and clears tInvalid (revalidation). Keep-first tValid goes via
		// the conditional backfill -- see the module comment above.
		await store.run(
			"MATCH (s:Service {name: $service}), (e:Endpoint {id: $id}) MERGE (s)-[o:HAS_ENDPOINT]->(e) SET o.confidence = $confidence, o.discoveredBy = $discoveredBy, o.evidence = $evidence, o.lastVerified = $now, o.tInvalid = ''",
			{
				service: ep.service,
				id,
				confidence: NETWORK_ENDPOINT_CONFIDENCE,
				discoveredBy: NETWORK_DISCOVERED_BY,
				evidence: "",
				now,
			},
		);
		await backfillEdgeTValid(
			store,
			"(s:Service {name: $service})-[o:HAS_ENDPOINT]->(e:Endpoint {id: $id})",
			"o",
			{ service: ep.service, id },
			now,
		);
	}
	for (const binding of r.ipBindings) {
		// The call-level incidentId is provenance fallback for bindings without their own.
		await recordIpBinding(store, { ...binding, incidentId: binding.incidentId ?? incidentId });
	}
}

// One IP -> workload binding. ONE-OWNER rule (the RESOLVES_TO alias mechanism): an
// IP is bound to exactly one workload at a time, so any still-valid BOUND_TO edge to
// a DIFFERENT AwsResource is invalidated (with a supersession note appended to its
// evidence) BEFORE the new edge is merged -- otherwise ipToWorkload would surface
// both owners as currently valid. The IN_SUBNET edge is written only when the CALLER
// provided subnetId (the caller computes CIDR placement -- writers stay lookup-free;
// no CIDR code in this package).
export async function recordIpBinding(store: GraphStore, b: IpBindingRecord): Promise<void> {
	if (!b.ip || !b.workloadArn) return;
	const now = b.createdAt ?? new Date().toISOString();
	await store.run("MERGE (i:IpAddress {ip: $ip})", { ip: b.ip });
	await store.run(
		"MATCH (i:IpAddress {ip: $ip})-[b:BOUND_TO]->(r:AwsResource) WHERE r.arn <> $arn AND b.tInvalid = '' SET b.tInvalid = $now, b.evidence = coalesce(b.evidence, '') + ' | superseded: rebound to ' + $arn",
		{ ip: b.ip, arn: b.workloadArn, now },
	);
	await store.run("MERGE (r:AwsResource {arn: $arn})", { arn: b.workloadArn });
	// Re-MERGE always bumps lastVerified and clears tInvalid (re-observing a binding
	// revalidates it); keep-first tValid goes via the conditional backfill.
	await store.run(
		"MATCH (i:IpAddress {ip: $ip}), (r:AwsResource {arn: $arn}) MERGE (i)-[b:BOUND_TO]->(r) SET b.confidence = $confidence, b.discoveredBy = $discoveredBy, b.evidence = $evidence, b.lastVerified = $now, b.incidentId = $incidentId, b.tInvalid = ''",
		{
			ip: b.ip,
			arn: b.workloadArn,
			confidence: b.confidence,
			discoveredBy: b.discoveredBy,
			evidence: b.evidence ?? "",
			incidentId: b.incidentId ?? "",
			now,
		},
	);
	await backfillEdgeTValid(
		store,
		"(i:IpAddress {ip: $ip})-[b:BOUND_TO]->(r:AwsResource {arn: $arn})",
		"b",
		{ ip: b.ip, arn: b.workloadArn },
		now,
	);
	if (b.subnetId) {
		await store.run("MERGE (s:Subnet {id: $id})", { id: b.subnetId });
		await store.run(
			"MATCH (i:IpAddress {ip: $ip}), (s:Subnet {id: $id}) MERGE (i)-[r:IN_SUBNET]->(s) SET r.discoveredBy = $discoveredBy, r.tInvalid = ''",
			{ ip: b.ip, id: b.subnetId, discoveredBy: b.discoveredBy },
		);
		await backfillEdgeTValid(
			store,
			"(i:IpAddress {ip: $ip})-[r:IN_SUBNET]->(s:Subnet {id: $id})",
			"r",
			{ ip: b.ip, id: b.subnetId },
			now,
		);
	}
}
