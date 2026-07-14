// knowledge-graph/src/writer.ts
//
// SIO-850: idempotent writes into the knowledge graph. Every statement is a
// parameterized MERGE -- values are bound ($params), never interpolated into the
// Cypher string, so a service name like "); DROP" cannot alter the query.

import { type BindingKind, VECTOR_INDEX_NAME, VECTOR_INDEX_PROPERTY, VECTOR_INDEX_TABLE } from "./schema.ts";
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
		await store.run(
			"MATCH (a:Alias {name: $name}), (s:Service {name: $service}) MERGE (a)-[r:RESOLVES_TO]->(s) SET r.confidence = $confidence, r.discoveredBy = $discoveredBy, r.createdAt = coalesce(r.createdAt, $now), r.tValid = coalesce(r.tValid, $now), r.tInvalid = ''",
			{
				name: b.aliasRaw,
				service: b.service,
				confidence: b.confidence,
				discoveredBy: b.discoveredBy,
				now,
			},
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
	// Re-MERGE keeps the first tValid (coalesce) but always bumps lastVerified and
	// clears tInvalid: re-observing a binding revalidates it.
	await store.run(
		"MATCH (s:Service {name: $service}), (t:TelemetrySource {id: $id}) MERGE (s)-[o:OBSERVED_IN]->(t) SET o.confidence = $confidence, o.discoveredBy = $discoveredBy, o.evidence = $evidence, o.lastVerified = $now, o.tValid = coalesce(o.tValid, $now), o.tInvalid = ''",
		{
			service: b.service,
			id: sourceId,
			confidence: b.confidence,
			discoveredBy: b.discoveredBy,
			evidence: b.evidence ?? "",
			now,
		},
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
