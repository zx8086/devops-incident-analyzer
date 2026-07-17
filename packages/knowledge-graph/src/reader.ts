// knowledge-graph/src/reader.ts
//
// SIO-850: read paths that enrich an investigation with prior graph knowledge.
// similarIncidents takes a precomputed embedding so this package never imports
// an LLM SDK; the caller (the agent's graphEnrich node) owns embedding
// generation via its existing @langchain/aws stack.

import { TOPOLOGY_DISCOVERED_BY, TOPOLOGY_KINDS, type TopologyEdgeKind } from "./schema.ts";
import type { GraphStore } from "./store.ts";

export interface ServiceDependency {
	from: string;
	to: string;
}

// Direct DEPENDS_ON neighbours (both directions) for the given services.
// SIO-1104 (5a): DEPENDS_ON is lifecycle-managed by the topology sweep now, so only
// currently-valid edges feed the enrichment (pre-ALTER rows hold '' -- the column
// DEFAULT -- and match; a swept-away dependency stops rendering).
export async function priorRelationshipsForServices(
	store: GraphStore,
	services: string[],
): Promise<ServiceDependency[]> {
	const out: ServiceDependency[] = [];
	for (const service of services) {
		if (!service) continue;
		const rows = await store.run<{ from: string; to: string }>(
			"MATCH (a:Service {name: $name})-[r:DEPENDS_ON]->(b:Service) WHERE r.tInvalid = '' RETURN a.name AS from, b.name AS to",
			{ name: service },
		);
		for (const row of rows) out.push({ from: String(row.from), to: String(row.to) });
	}
	return out;
}

// SIO-1103: runtime shared-infrastructure blast radius for the incident services --
// the OTHER services that could be affected via a shared runtime dependency. `via` is
// how they are related and `sharedResource` names the shared thing (empty for a direct
// DEPENDS_ON hop). Scoped to what the current schema records with Service edges:
//   - depends-on: a direct DEPENDS_ON neighbour (either direction)
//   - kafka-topic: another service PRODUCES_TO the same KafkaTopic (SIO-1100 topics)
//   - telemetry-source: another service OBSERVED_IN the same TelemetrySource (currently
//     valid only), i.e. they share a log group / index / APM coordinate
//   - aws-resource: another service RUNS_ON the same AwsResource (SIO-1104 5a --
//     populated by the scheduled topology sweep's ECS enumeration). Bucket fan-in
//     stays deferred: nothing produces Service->Bucket edges yet.
// This is the LOCAL, runtime radius -- distinct from GitLab Orbit's cross-project
// CODE/SDLC blast radius (SIO-1076).
// The incident service itself is never returned (lbug does NOT enforce relationship
// uniqueness in two-hop patterns, so the anchor comes back as its own neighbour --
// the `add` guard below is load-bearing, not defensive). Capped.
export interface BlastRadiusHit {
	service: string; // the focus service the hit is anchored to
	neighbour: string; // the potentially-affected other service
	via: "depends-on" | "kafka-topic" | "telemetry-source" | "aws-resource";
	sharedResource: string; // the shared thing (topic / telemetry id / arn); "" for depends-on
}

// SIO-1104 (5c): bi-temporal validity filter for the bi-temporal edge alias `edge`.
// Default (no asOf) is the original currently-valid form, byte-identical for existing
// callers. With an ISO `asOf` it answers "was this edge valid AT that instant":
// tValid <= asOf AND (still valid OR invalidated after asOf). ISO-8601 strings compare
// lexicographically in chronological order, so plain string comparison is correct.
function validityClause(edge: string, asOf?: string): string {
	return asOf
		? `${edge}.tValid <= $asOf AND (${edge}.tInvalid = '' OR ${edge}.tInvalid > $asOf)`
		: `${edge}.tInvalid = ''`;
}

export async function blastRadiusForServices(
	store: GraphStore,
	services: string[],
	limit = 25,
	asOf?: string,
): Promise<BlastRadiusHit[]> {
	const names = services.filter((s) => s.length > 0);
	if (names.length === 0) return [];
	const seen = new Set<string>();
	const out: BlastRadiusHit[] = [];
	const add = (service: string, neighbour: string, via: BlastRadiusHit["via"], sharedResource: string): void => {
		if (!neighbour || neighbour === service) return;
		const key = `${service}|${neighbour}|${via}|${sharedResource}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ service, neighbour, via, sharedResource });
	};

	for (const service of names) {
		// DEPENDS_ON, both directions -- valid now (or at asOf). SIO-1104 (5a): the
		// topology sweep can invalidate these, so stale dependencies stop producing
		// blast-radius hits (pre-ALTER rows hold '' and match the default form).
		const deps = await store.run<{ n: string }>(
			`MATCH (a:Service {name: $name})-[r:DEPENDS_ON]-(b:Service) WHERE ${validityClause("r", asOf)} RETURN b.name AS n`,
			asOf ? { name: service, asOf } : { name: service },
		);
		for (const r of deps) add(service, String(r.n), "depends-on", "");
		// Services sharing a KafkaTopic (producer side).
		const topics = await store.run<{ n: string; t: string }>(
			"MATCH (a:Service {name: $name})-[:PRODUCES_TO]->(t:KafkaTopic)<-[:PRODUCES_TO]-(b:Service) RETURN b.name AS n, t.name AS t",
			{ name: service },
		);
		for (const r of topics) add(service, String(r.n), "kafka-topic", String(r.t));
		// Services sharing a TelemetrySource valid now (or at asOf, SIO-1104 5c).
		const tele = await store.run<{ n: string; id: string }>(
			`MATCH (a:Service {name: $name})-[o1:OBSERVED_IN]->(t:TelemetrySource)<-[o2:OBSERVED_IN]-(b:Service) WHERE ${validityClause("o1", asOf)} AND ${validityClause("o2", asOf)} RETURN b.name AS n, t.id AS id`,
			asOf ? { name: service, asOf } : { name: service },
		);
		for (const r of tele) add(service, String(r.n), "telemetry-source", String(r.id));
		// Services running on the same AwsResource (SIO-1104 5a topology sweep).
		const aws = await store.run<{ n: string; id: string }>(
			`MATCH (a:Service {name: $name})-[r1:RUNS_ON]->(x:AwsResource)<-[r2:RUNS_ON]-(b:Service) WHERE ${validityClause("r1", asOf)} AND ${validityClause("r2", asOf)} RETURN b.name AS n, x.arn AS id`,
			asOf ? { name: service, asOf } : { name: service },
		);
		for (const r of aws) add(service, String(r.n), "aws-resource", String(r.id));
		if (out.length >= limit) break;
	}
	return out.slice(0, limit);
}

// SIO-1104 (5a): the currently-valid sweep-owned edges of one topology kind -- the
// read side of sweepStaleTopology's TS set-difference, and exported for tests/CLI.
export interface ValidTopologyEdge {
	from: string;
	to: string;
	consecutiveMisses: number;
}

export async function validTopologyEdges(store: GraphStore, kind: TopologyEdgeKind): Promise<ValidTopologyEdge[]> {
	const { rel, fromLabel, fromKey, toLabel, toKey } = TOPOLOGY_KINDS[kind];
	const rows = await store.run<{ from: string; to: string; misses: number }>(
		`MATCH (a:${fromLabel})-[r:${rel}]->(b:${toLabel}) WHERE r.discoveredBy = $discoveredBy AND r.tInvalid = '' RETURN a.${fromKey} AS from, b.${toKey} AS to, r.consecutiveMisses AS misses`,
		{ discoveredBy: TOPOLOGY_DISCOVERED_BY },
	);
	return rows.map((r) => ({ from: String(r.from), to: String(r.to), consecutiveMisses: Number(r.misses ?? 0) }));
}

// SIO-1104 (5a): every known canonical Service name. The AWS topology collector
// matches ECS service short names against these (P6: only write RUNS_ON for services
// the graph already knows -- never invent Service nodes from raw ECS names).
export async function serviceNames(store: GraphStore): Promise<string[]> {
	const rows = await store.run<{ name: string }>("MATCH (s:Service) RETURN s.name AS name");
	return rows.map((r) => String(r.name)).filter((n) => n.length > 0);
}

// SIO-1100: a currently-valid telemetry binding for a service. Powers the R7
// pre-fan-out scoping read (Stage 2) and the fact-dedup gate for the W8 writer.
export interface ServiceBinding {
	service: string;
	datasource: string;
	kind: string;
	resourceId: string;
	locator: string;
	confidence: number;
	discoveredBy: string;
	lastVerified: string;
}

type BindingRow = {
	service: string;
	datasource: string;
	kind: string;
	resourceId: string;
	locator: string | null;
	confidence: number;
	discoveredBy: string | null;
	lastVerified: string | null;
} & Record<string, unknown>;

function shapeBinding(r: BindingRow): ServiceBinding {
	return {
		service: String(r.service),
		datasource: String(r.datasource),
		kind: String(r.kind),
		resourceId: String(r.resourceId),
		locator: String(r.locator ?? ""),
		confidence: Number(r.confidence ?? 0),
		discoveredBy: String(r.discoveredBy ?? ""),
		lastVerified: String(r.lastVerified ?? ""),
	};
}

const BINDING_RETURN =
	"RETURN s.name AS service, t.datasource AS datasource, t.kind AS kind, t.resourceId AS resourceId, t.locator AS locator, o.confidence AS confidence, o.discoveredBy AS discoveredBy, o.lastVerified AS lastVerified ORDER BY o.lastVerified DESC LIMIT $limit";

// Currently-valid (tInvalid = '') bindings for the given services: direct
// Service-name matches plus alias hops (Alias.normalized IN the normalized set).
// Highest last-verified first, capped. The caller owns normalization (the same
// focus-match normalize() the writer used) so alias identity cannot drift.
//
// Two separate plain MATCH queries (direct + alias) merged/deduped in TS rather
// than one correlated-subquery statement: only basic MATCH/WHERE/IN is proven on
// the pinned lbug engine, and the alias path is the rare case.
// SIO-1104 (5c): pass `asOf` (ISO) for a postmortem time-travel read -- "which
// bindings were valid AT that instant". Default (no asOf) is unchanged.
export async function bindingsForServices(
	store: GraphStore,
	services: string[],
	normalized: string[],
	limit = 40,
	asOf?: string,
): Promise<ServiceBinding[]> {
	const names = services.filter((s) => s.length > 0);
	if (names.length === 0) return [];
	const norm = normalized.filter((n) => n.length > 0);

	const direct = await store.run<BindingRow>(
		`MATCH (s:Service)-[o:OBSERVED_IN]->(t:TelemetrySource) WHERE ${validityClause("o", asOf)} AND s.name IN $names ${BINDING_RETURN}`,
		asOf ? { names, limit, asOf } : { names, limit },
	);
	const viaAlias =
		norm.length > 0
			? await store.run<BindingRow>(
					`MATCH (a:Alias)-[rr:RESOLVES_TO]->(s:Service)-[o:OBSERVED_IN]->(t:TelemetrySource) WHERE ${validityClause("o", asOf)} AND ${validityClause("rr", asOf)} AND a.normalized IN $normalized ${BINDING_RETURN}`,
					asOf ? { normalized: norm, limit, asOf } : { normalized: norm, limit },
				)
			: [];

	// Merge, dedupe by (service, datasource, kind, resourceId), keep most-recent
	// first, then re-cap.
	const seen = new Set<string>();
	const merged: ServiceBinding[] = [];
	for (const r of [...direct, ...viaAlias].map(shapeBinding)) {
		const key = `${r.service}\u0000${r.datasource}\u0000${r.kind}\u0000${r.resourceId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(r);
	}
	merged.sort((a, b) => b.lastVerified.localeCompare(a.lastVerified));
	return merged.slice(0, limit);
}

// SIO-1100: does a currently-valid binding already exist for this exact
// (service, kind, resourceId)? The gate that keeps the W8 writer from enqueuing a
// duplicate durable fact (facts are append-only/undeletable, SIO-973) -- a
// re-confirmation bumps lastVerified graph-side only.
export async function hasBinding(
	store: GraphStore,
	service: string,
	kind: string,
	resourceId: string,
): Promise<boolean> {
	if (!service || !resourceId) return false;
	const rows = await store.run<{ n: number }>(
		"MATCH (s:Service {name: $service})-[o:OBSERVED_IN]->(t:TelemetrySource {kind: $kind, resourceId: $resourceId}) WHERE o.tInvalid = '' RETURN count(o) AS n",
		{ service, kind, resourceId },
	);
	return Number(rows[0]?.n ?? 0) > 0;
}

export interface SimilarIncident {
	id: string;
	summary: string;
	severity: string;
	distance: number;
	// SIO-1134: "" = uncurated run; non-empty = the Jira ticket this incident is
	// the canonical record for. graphEnrich surfaces curated incidents only.
	ticketKey: string;
}

// Vector-similarity search over Incident.embedding via Ladybug's native index.
// Returns [] when the vector extension/index is unavailable. excludeId drops the
// current turn's own incident (SIO-1100: graphEnrich persists this turn's embedding
// BEFORE the lookup, so without this filter the query returns the incident itself at
// distance ~0 and crowds out real historical matches). We over-fetch by one and drop
// the excluded id in TS -- QUERY_VECTOR_INDEX takes no WHERE clause.
export async function similarIncidents(
	store: GraphStore,
	embedding: number[],
	limit = 3,
	excludeId?: string,
): Promise<SimilarIncident[]> {
	if (embedding.length === 0) return [];
	try {
		const fetch = excludeId ? limit + 1 : limit;
		const rows = await store.run<{
			id: string;
			summary: string;
			severity: string;
			distance: number;
			ticketKey: string | null;
		}>(
			"CALL QUERY_VECTOR_INDEX('Incident', 'incident_embedding_idx', $embedding, $limit) RETURN node.id AS id, node.summary AS summary, node.severity AS severity, node.ticketKey AS ticketKey, distance AS distance",
			{ embedding, limit: fetch },
		);
		return rows
			.map((r) => ({
				id: String(r.id),
				summary: String(r.summary),
				severity: String(r.severity),
				distance: Number(r.distance),
				ticketKey: r.ticketKey ? String(r.ticketKey) : "",
			}))
			.filter((r) => r.id !== excludeId)
			.slice(0, limit);
	} catch {
		return [];
	}
}

// SIO-1134: exact curated lookup -- the incident this ticket is the canonical
// record for (set by ticket creation or a confirmed learn-from match).
export async function incidentByTicketKey(
	store: GraphStore,
	ticketKey: string,
): Promise<{ id: string; summary: string; severity: string } | null> {
	if (!ticketKey) return null;
	const rows = await store.run<{ id: string; summary: string; severity: string }>(
		"MATCH (i:Incident) WHERE i.ticketKey = $ticketKey RETURN i.id AS id, i.summary AS summary, i.severity AS severity LIMIT 1",
		{ ticketKey },
	);
	const row = rows[0];
	if (!row) return null;
	return { id: String(row.id), summary: String(row.summary ?? ""), severity: String(row.severity ?? "") };
}

// SIO-1135: fetch one incident's mirror-fact fields by node id (the id IS the turn's
// requestId). Returns services too (via AFFECTED_BY) so a curation-time kg-incident fact
// matches incidentFromAnnotations (rebuild.ts) byte-for-byte. services come from a
// separate one-row-per-service query -- collect() is unused in this package, so assemble
// the array in TS to stay on proven single-clause Cypher.
export interface IncidentRow {
	id: string;
	summary: string;
	severity: string;
	services: string[];
}

export async function incidentById(store: GraphStore, id: string): Promise<IncidentRow | null> {
	if (!id) return null;
	const rows = await store.run<{ id: string; summary: string; severity: string }>(
		"MATCH (i:Incident {id: $id}) RETURN i.id AS id, i.summary AS summary, i.severity AS severity LIMIT 1",
		{ id },
	);
	const row = rows[0];
	if (!row) return null;
	// ORDER BY so the services list is deterministic (CodeRabbit PR #404): the curation
	// mirror fact serializes services.join(","), and an unordered query would yield
	// different kg-incident bytes for the same incident across rebuilds.
	const serviceRows = await store.run<{ name: string }>(
		"MATCH (s:Service)-[:AFFECTED_BY]->(i:Incident {id: $id}) RETURN s.name AS name ORDER BY s.name",
		{ id },
	);
	const services = serviceRows.map((r) => String(r.name ?? "")).filter((n) => n.length > 0);
	return { id: String(row.id), summary: String(row.summary ?? ""), severity: String(row.severity ?? ""), services };
}

// SIO-1026: the root cause linked to one incident (0 or 1 via HAS_ROOT_CAUSE).
export interface RootCause {
	id: string;
	class: string;
	description: string;
	confidence: number;
	ruleName: string;
}

export async function rootCauseForIncident(store: GraphStore, incidentId: string): Promise<RootCause | null> {
	if (!incidentId) return null;
	// confidence + ruleName are per-incident and live on the HAS_ROOT_CAUSE edge (r),
	// not the shared RootCause node (rc) -- see writer.ts / schema.ts (SIO-1026).
	const rows = await store.run<{
		id: string;
		class: string;
		description: string;
		confidence: number;
		ruleName: string | null;
	}>(
		"MATCH (i:Incident {id: $id})-[r:HAS_ROOT_CAUSE]->(rc:RootCause) RETURN rc.id AS id, rc.class AS class, rc.description AS description, r.confidence AS confidence, r.ruleName AS ruleName LIMIT 1",
		{ id: incidentId },
	);
	const row = rows[0];
	if (!row) return null;
	return {
		id: String(row.id),
		class: String(row.class ?? ""),
		description: String(row.description ?? ""),
		confidence: Number(row.confidence ?? 0),
		ruleName: row.ruleName ? String(row.ruleName) : "",
	};
}

// SIO-1026: prior incidents that shared a root-cause class -- "have we seen this
// before, and what resolved it". Joins RootCause back to its incidents and any
// runbook that resolved them (RESOLVED_BY), most-recent incident first.
export interface PriorRootCause {
	incidentId: string;
	summary: string;
	severity: string;
	description: string;
	runbooks: string[];
}

export async function priorRootCauses(store: GraphStore, causeClass: string, limit = 5): Promise<PriorRootCause[]> {
	if (!causeClass) return [];
	// The OPTIONAL MATCH to Runbook fans out to one row per runbook, so a query-level
	// LIMIT would bound JOINED ROWS, not incidents -- a single incident with many
	// runbooks could crowd out newer incidents. lbug's binder is fragile with
	// multi-clause WITH...LIMIT restructures (vars don't cross clauses cleanly), so
	// instead we fetch all matching rows ordered newest-first and apply the incident
	// limit AFTER collapsing the fan-out, which is deterministic and lbug-safe.
	const rows = await store.run<{
		incidentId: string;
		summary: string | null;
		severity: string | null;
		description: string | null;
		runbook: string | null;
		createdAt: string | null;
	}>(
		"MATCH (i:Incident)-[:HAS_ROOT_CAUSE]->(rc:RootCause {class: $class}) OPTIONAL MATCH (i)-[:RESOLVED_BY]->(rb:Runbook) RETURN i.id AS incidentId, i.summary AS summary, i.severity AS severity, rc.description AS description, rb.filename AS runbook, i.createdAt AS createdAt ORDER BY i.createdAt DESC",
		{ class: causeClass },
	);
	// Collapse the OPTIONAL-MATCH fan-out (one row per runbook) into one entry per
	// incident, preserving newest-first order and deduping runbooks.
	const byIncident = new Map<string, PriorRootCause>();
	for (const row of rows) {
		const id = String(row.incidentId);
		const existing = byIncident.get(id);
		if (existing) {
			if (row.runbook && !existing.runbooks.includes(String(row.runbook))) existing.runbooks.push(String(row.runbook));
			continue;
		}
		byIncident.set(id, {
			incidentId: id,
			summary: String(row.summary ?? ""),
			severity: String(row.severity ?? ""),
			description: String(row.description ?? ""),
			runbooks: row.runbook ? [String(row.runbook)] : [],
		});
	}
	// Bound the DISTINCT-incident set (not the joined rows) to `limit`.
	return [...byIncident.values()].slice(0, limit);
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

// SIO-1053: every ConfigChange still at outcome 'proposed' (or with no outcome set) that
// has an MR to re-check. The reconcile sweep derives the MR iid from mrUrl and advances the
// outcome to its true merged+apply state -- terminal outcomes (applied/failed/rejected) are
// never returned, so they are not re-checked (mirrors enumerateUnreconciledChanges' terminal skip).
export interface ProposedConfigChange {
	id: string; // == the proposal turn's requestId == the agent-memory configChangeId
	mrUrl: string;
	outcome: string;
}

export async function proposedChangesWithMr(store: GraphStore, limit = 200): Promise<ProposedConfigChange[]> {
	const rows = await store.run<{ id: string; mrUrl: string | null; outcome: string | null }>(
		"MATCH (c:ConfigChange)-[:PROPOSED_IN]->(m:MergeRequest) WHERE c.outcome = 'proposed' OR c.outcome IS NULL RETURN c.id AS id, m.url AS mrUrl, c.outcome AS outcome LIMIT $limit",
		{ limit },
	);
	return rows
		.filter((r) => r.mrUrl)
		.map((r) => ({ id: String(r.id), mrUrl: String(r.mrUrl), outcome: r.outcome ? String(r.outcome) : "proposed" }));
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

// SIO-1026: a similar prior incident with its recorded root cause (if any),
// rendered inline in the graph context so the aggregator can reuse prior analysis.
// SIO-1104 (5b): resolvedBy carries the runbook filenames that resolved prior
// incidents of the same root-cause class (the priorRootCauses graph join).
export interface SimilarIncidentWithCause extends SimilarIncident {
	rootCause?: { class: string; description: string } | null;
	resolvedBy?: string[];
}

// SIO-1104 (5b): nothing downstream caps graphContext (the aggregator's byte cap
// applies only to datasource results), so the runbook render is bounded HERE.
const MAX_RESOLVED_BY_RENDERED = 3;

// Renders a compact prompt section from the read results. Empty string when
// there is nothing relevant, so the happy path is unchanged when the graph is
// empty or disabled. similar accepts the SIO-1026 cause-annotated shape; a plain
// SimilarIncident (no rootCause) renders exactly as before.
export function buildGraphContext(deps: ServiceDependency[], similar: SimilarIncidentWithCause[]): string {
	if (deps.length === 0 && similar.length === 0) return "";
	const lines: string[] = ["\n\n---\n\n## Knowledge Graph"];
	if (deps.length > 0) {
		lines.push("### Known dependencies");
		for (const d of deps) lines.push(`- ${d.from} -> ${d.to}`);
	}
	if (similar.length > 0) {
		lines.push("### Similar prior incidents");
		for (const s of similar) {
			const cause = s.rootCause ? ` -- prior root cause: ${s.rootCause.description || s.rootCause.class}` : "";
			// Same "resolved by" phrasing as the elastic-iac kg_prior_root_causes
			// tool, so runbook references render consistently across both consumers.
			const runbooks = s.resolvedBy?.length
				? ` -- resolved by ${s.resolvedBy.slice(0, MAX_RESOLVED_BY_RENDERED).join(", ")}`
				: "";
			lines.push(`- [${s.severity}] ${s.summary} (id ${s.id})${cause}${runbooks}`);
		}
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
