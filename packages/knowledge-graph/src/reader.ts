// knowledge-graph/src/reader.ts
//
// SIO-850: read paths that enrich an investigation with prior graph knowledge.
// similarIncidents takes a precomputed embedding so this package never imports
// an LLM SDK; the caller (the agent's graphEnrich node) owns embedding
// generation via its existing @langchain/aws stack.

import { z } from "zod";
import { TOPOLOGY_DISCOVERED_BY, TOPOLOGY_KINDS, type TopologyEdgeKind } from "./schema.ts";
import type { GraphStore } from "./store.ts";

// SIO-1202: the exported readers bind numeric args straight into `LIMIT $limit`,
// so a caller outside the Zod-guarded MCP tool layer (this function is public
// package API) could otherwise pass 0/negative/fractional/NaN/Infinity. Mirrors
// the MCP tool's own z.number().int().positive().max(200) rule so both stay in
// sync without a cross-package import (packages/knowledge-graph has no
// dependency on the mcp-server-knowledge-graph tool layer).
const LIMIT_SCHEMA = z.number().int().positive().max(200);

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
// SIO-1127 (CodeRabbit PR #406): the persisted telemetry identity is
// datasource:kind:resourceId, so pass `datasource` to scope to the FULL identity --
// otherwise the same (kind, resourceId) under a different datasource is a distinct node
// but this gate would report it as existing and suppress its mirror fact (rebuild loss).
// datasource is optional for back-compat: omit it for the legacy (kind, resourceId) match.
export async function hasBinding(
	store: GraphStore,
	service: string,
	kind: string,
	resourceId: string,
	datasource?: string,
): Promise<boolean> {
	if (!service || !resourceId) return false;
	const sourceMatch = datasource
		? "TelemetrySource {datasource: $datasource, kind: $kind, resourceId: $resourceId}"
		: "TelemetrySource {kind: $kind, resourceId: $resourceId}";
	const rows = await store.run<{ n: number }>(
		`MATCH (s:Service {name: $service})-[o:OBSERVED_IN]->(t:${sourceMatch}) WHERE o.tInvalid = '' RETURN count(o) AS n`,
		datasource ? { service, kind, resourceId, datasource } : { service, kind, resourceId },
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

// SIO-1202: prompts that produced a successfully APPLIED change, newest first --
// "what to ask to get a working change" for documentation. recordIacPrompt and
// recordIacChange both write with id == the turn's requestId (graph-knowledge.ts),
// so Prompt.id == ConfigChange.id joins a turn's verbatim prompt to its change for
// free, same idiom as the Prompt/ConfigChange linkage noted in schema.ts.
export interface SuccessfulPrompt {
	prompt: string;
	summary: string;
	workflow: string;
	mrUrl: string;
	createdAt: string;
}

export async function successfulPromptChanges(store: GraphStore, limit = 20): Promise<SuccessfulPrompt[]> {
	const safeLimit = LIMIT_SCHEMA.parse(limit);
	const rows = await store.run<{
		prompt: string;
		summary: string | null;
		workflow: string | null;
		mrUrl: string;
		createdAt: string;
	}>(
		"MATCH (p:Prompt) MATCH (c:ConfigChange {id: p.id})-[:PROPOSED_IN]->(m:MergeRequest) WHERE c.outcome = 'applied' RETURN p.text AS prompt, c.summary AS summary, c.workflow AS workflow, m.url AS mrUrl, c.createdAt AS createdAt ORDER BY c.createdAt DESC LIMIT $limit",
		{ limit: safeLimit },
	);
	return rows.map((r) => ({
		prompt: String(r.prompt ?? ""),
		summary: String(r.summary ?? ""),
		workflow: String(r.workflow ?? ""),
		mrUrl: String(r.mrUrl ?? ""),
		createdAt: String(r.createdAt ?? ""),
	}));
}

// SIO-1203: every applied ConfigChange, newest first, WITHOUT requiring a linked
// Prompt -- the fallback for successfulPromptChanges' INNER join. The Prompt node
// only exists from SIO-1038 onward (recordIacPromptNode); ConfigChange/MergeRequest
// have existed since SIO-954, so a change applied before SIO-1038 shipped has no
// Prompt to join and is invisible to kg_successful_prompts even though it is a
// perfectly real applied change. OPTIONAL MATCH on Prompt so a pre-SIO-1038 row still
// surfaces (with prompt: "") instead of being dropped, while a post-SIO-1038 row still
// gets its verbatim prompt text for free via the same Prompt.id == ConfigChange.id join.
export interface AppliedChange {
	prompt: string; // "" for a change recorded before the Prompt node existed (SIO-1038)
	summary: string;
	workflow: string;
	mrUrl: string;
	createdAt: string;
}

export async function appliedChanges(store: GraphStore, limit = 20): Promise<AppliedChange[]> {
	const safeLimit = LIMIT_SCHEMA.parse(limit);
	const rows = await store.run<{
		prompt: string | null;
		summary: string | null;
		workflow: string | null;
		mrUrl: string;
		createdAt: string;
	}>(
		"MATCH (c:ConfigChange)-[:PROPOSED_IN]->(m:MergeRequest) WHERE c.outcome = 'applied' OPTIONAL MATCH (p:Prompt {id: c.id}) RETURN p.text AS prompt, c.summary AS summary, c.workflow AS workflow, m.url AS mrUrl, c.createdAt AS createdAt ORDER BY c.createdAt DESC LIMIT $limit",
		{ limit: safeLimit },
	);
	return rows.map((r) => ({
		prompt: String(r.prompt ?? ""),
		summary: String(r.summary ?? ""),
		workflow: String(r.workflow ?? ""),
		mrUrl: String(r.mrUrl ?? ""),
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

// --- SIO-1204/SIO-1207 (slice 3a): network-map readers -----------------------
//
// Multi-query-assemble-in-TS idiom (bindingsForServices): each layer is one
// single-MATCH statement (a chained multi-hop pattern is still ONE clause) and the
// join/dedupe/cap happens in TS -- lbug's binder prefers separate simple queries
// over correlated subqueries. Every bi-temporal hop goes through validityClause,
// so `asOf` gives a postmortem time-travel read.

export interface NetworkMapTargetGroup {
	arn: string;
	name: string;
	port: number;
	protocol: string;
	workloadArn: string;
}

export interface NetworkMapLoadBalancer {
	arn: string;
	name: string;
	dnsName: string;
	type: string;
	scheme: string;
	targetGroupArn: string;
}

export interface NetworkMapDnsRecord {
	name: string;
	type: string;
	target: string;
	loadBalancerArn: string;
}

export interface NetworkMapPlacement {
	loadBalancerArn: string;
	subnetId: string;
	subnetCidr: string;
	az: string;
	vpcId: string;
	vpcCidr: string;
	vpcName: string;
}

export interface NetworkMapIpAddress {
	ip: string;
	workloadArn: string;
	subnetId: string;
	lastVerified: string;
	discoveredBy: string;
}

export interface NetworkMapEndpoint {
	id: string;
	host: string;
	port: number;
	protocol: string;
	datasource: string;
	confidence: number;
	lastVerified: string;
}

export interface NetworkMap {
	service: string;
	// AwsResource arns the service RUNS_ON (the anchor for every AWS-side layer).
	workloads: string[];
	targetGroups: NetworkMapTargetGroup[];
	loadBalancers: NetworkMapLoadBalancer[];
	dnsRecords: NetworkMapDnsRecord[];
	placements: NetworkMapPlacement[];
	ipAddresses: NetworkMapIpAddress[];
	endpoints: NetworkMapEndpoint[];
}

// Per-layer bound so a shared ALB with hundreds of TGs cannot flood the prompt.
// Downstream LB/DNS/placement layers inherit the cap transitively: their anchor
// sets derive from the capped tgArns, so no later layer can exceed it either.
const NETWORK_MAP_CAP = 50;

function dedupeAndCap<T>(rows: T[], key: (row: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const row of rows) {
		const k = key(row);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(row);
		if (out.length >= NETWORK_MAP_CAP) break;
	}
	return out;
}

// The service's ingress/placement chain: RUNS_ON workloads, the target groups
// forwarding to them, their load balancers, DNS records, subnet/VPC placement, the
// currently-bound IPs (with per-hit IN_SUBNET context), and the service's observed
// endpoints. Layers whose anchor set is empty are skipped (no wasted queries);
// endpoints hang off the Service directly, so they are read even with no workload.
export async function networkMapForService(store: GraphStore, service: string, asOf?: string): Promise<NetworkMap> {
	const map: NetworkMap = {
		service,
		workloads: [],
		targetGroups: [],
		loadBalancers: [],
		dnsRecords: [],
		placements: [],
		ipAddresses: [],
		endpoints: [],
	};
	if (!service) return map;
	const params = (base: Record<string, unknown>): Record<string, unknown> => (asOf ? { ...base, asOf } : base);

	const workloadRows = await store.run<{ arn: string }>(
		`MATCH (s:Service {name: $name})-[r:RUNS_ON]->(x:AwsResource) WHERE ${validityClause("r", asOf)} RETURN x.arn AS arn`,
		params({ name: service }),
	);
	map.workloads = dedupeAndCap(
		workloadRows.map((row) => String(row.arn)).filter((arn) => arn.length > 0),
		(arn) => arn,
	);

	if (map.workloads.length > 0) {
		const tgRows = await store.run<{
			arn: string;
			name: string | null;
			port: number | null;
			protocol: string | null;
			workloadArn: string;
		}>(
			`MATCH (tg:TargetGroup)-[f:FORWARDS_TO]->(x:AwsResource) WHERE ${validityClause("f", asOf)} AND x.arn IN $arns RETURN tg.arn AS arn, tg.name AS name, tg.port AS port, tg.protocol AS protocol, x.arn AS workloadArn`,
			params({ arns: map.workloads }),
		);
		map.targetGroups = dedupeAndCap(
			tgRows.map((row) => ({
				arn: String(row.arn),
				name: String(row.name ?? ""),
				port: Number(row.port ?? 0),
				protocol: String(row.protocol ?? ""),
				workloadArn: String(row.workloadArn),
			})),
			(row) => `${row.arn} ${row.workloadArn}`,
		);
	}

	const tgArns = [...new Set(map.targetGroups.map((row) => row.arn))];
	if (tgArns.length > 0) {
		const lbRows = await store.run<{
			arn: string;
			name: string | null;
			dnsName: string | null;
			type: string | null;
			scheme: string | null;
			targetGroupArn: string;
		}>(
			`MATCH (lb:LoadBalancer)-[h:HAS_TARGET_GROUP]->(tg:TargetGroup) WHERE ${validityClause("h", asOf)} AND tg.arn IN $tgArns RETURN lb.arn AS arn, lb.name AS name, lb.dnsName AS dnsName, lb.type AS type, lb.scheme AS scheme, tg.arn AS targetGroupArn`,
			params({ tgArns }),
		);
		map.loadBalancers = dedupeAndCap(
			lbRows.map((row) => ({
				arn: String(row.arn),
				name: String(row.name ?? ""),
				dnsName: String(row.dnsName ?? ""),
				type: String(row.type ?? ""),
				scheme: String(row.scheme ?? ""),
				targetGroupArn: String(row.targetGroupArn),
			})),
			(row) => `${row.arn} ${row.targetGroupArn}`,
		);
	}

	const lbArns = [...new Set(map.loadBalancers.map((row) => row.arn))];
	if (lbArns.length > 0) {
		const dnsRows = await store.run<{ name: string; type: string; target: string | null; loadBalancerArn: string }>(
			`MATCH (d:DnsRecord)-[rl:RESOLVES_TO_LB]->(lb:LoadBalancer) WHERE ${validityClause("rl", asOf)} AND lb.arn IN $lbArns RETURN d.name AS name, d.type AS type, d.target AS target, lb.arn AS loadBalancerArn`,
			params({ lbArns }),
		);
		map.dnsRecords = dedupeAndCap(
			dnsRows.map((row) => ({
				name: String(row.name),
				type: String(row.type),
				target: String(row.target ?? ""),
				loadBalancerArn: String(row.loadBalancerArn),
			})),
			(row) => `${row.name} ${row.type} ${row.loadBalancerArn}`,
		);
		// Placement is one chained single-MATCH clause (LB -> Subnet -> Vpc).
		const placementRows = await store.run<{
			loadBalancerArn: string;
			subnetId: string;
			subnetCidr: string | null;
			az: string | null;
			vpcId: string;
			vpcCidr: string | null;
			vpcName: string | null;
		}>(
			`MATCH (lb:LoadBalancer)-[at:ATTACHED_TO]->(sn:Subnet)-[iv:IN_VPC]->(v:Vpc) WHERE ${validityClause("at", asOf)} AND ${validityClause("iv", asOf)} AND lb.arn IN $lbArns RETURN lb.arn AS loadBalancerArn, sn.id AS subnetId, sn.cidr AS subnetCidr, sn.az AS az, v.id AS vpcId, v.cidr AS vpcCidr, v.name AS vpcName`,
			params({ lbArns }),
		);
		map.placements = dedupeAndCap(
			placementRows.map((row) => ({
				loadBalancerArn: String(row.loadBalancerArn),
				subnetId: String(row.subnetId),
				subnetCidr: String(row.subnetCidr ?? ""),
				az: String(row.az ?? ""),
				vpcId: String(row.vpcId),
				vpcCidr: String(row.vpcCidr ?? ""),
				vpcName: String(row.vpcName ?? ""),
			})),
			(row) => `${row.loadBalancerArn} ${row.subnetId}`,
		);
	}

	if (map.workloads.length > 0) {
		const ipRows = await store.run<{
			ip: string;
			workloadArn: string;
			lastVerified: string | null;
			discoveredBy: string | null;
		}>(
			`MATCH (i:IpAddress)-[b:BOUND_TO]->(x:AwsResource) WHERE ${validityClause("b", asOf)} AND x.arn IN $arns RETURN i.ip AS ip, x.arn AS workloadArn, b.lastVerified AS lastVerified, b.discoveredBy AS discoveredBy`,
			params({ arns: map.workloads }),
		);
		map.ipAddresses = dedupeAndCap(
			ipRows.map((row) => ({
				ip: String(row.ip),
				workloadArn: String(row.workloadArn),
				subnetId: "",
				lastVerified: String(row.lastVerified ?? ""),
				discoveredBy: String(row.discoveredBy ?? ""),
			})),
			(row) => `${row.ip} ${row.workloadArn}`,
		);
		const ips = [...new Set(map.ipAddresses.map((row) => row.ip))];
		if (ips.length > 0) {
			const subnetRows = await store.run<{ ip: string; subnetId: string }>(
				`MATCH (i:IpAddress)-[sn:IN_SUBNET]->(s:Subnet) WHERE ${validityClause("sn", asOf)} AND i.ip IN $ips RETURN i.ip AS ip, s.id AS subnetId`,
				params({ ips }),
			);
			const subnetByIp = new Map<string, string>();
			for (const row of subnetRows) {
				const key = String(row.ip);
				if (!subnetByIp.has(key)) subnetByIp.set(key, String(row.subnetId ?? ""));
			}
			for (const hit of map.ipAddresses) hit.subnetId = subnetByIp.get(hit.ip) ?? "";
		}
	}

	const endpointRows = await store.run<{
		id: string;
		host: string;
		port: number | null;
		protocol: string | null;
		datasource: string | null;
		confidence: number | null;
		lastVerified: string | null;
	}>(
		`MATCH (s:Service {name: $name})-[h:HAS_ENDPOINT]->(e:Endpoint) WHERE ${validityClause("h", asOf)} RETURN e.id AS id, e.host AS host, e.port AS port, e.protocol AS protocol, e.datasource AS datasource, h.confidence AS confidence, h.lastVerified AS lastVerified`,
		params({ name: service }),
	);
	map.endpoints = dedupeAndCap(
		endpointRows.map((row) => ({
			id: String(row.id),
			host: String(row.host),
			port: Number(row.port ?? 0),
			protocol: String(row.protocol ?? ""),
			datasource: String(row.datasource ?? ""),
			confidence: Number(row.confidence ?? 0),
			lastVerified: String(row.lastVerified ?? ""),
		})),
		(row) => row.id,
	);

	return map;
}

export interface IpWorkloadHit {
	ip: string;
	workloadArn: string;
	service: string;
	subnetId: string;
	vpcId: string;
	lastVerified: string;
	discoveredBy: string;
	tValid: string;
	tInvalid: string;
}

// Reverse IP lookup: which workload owns this IP now (or at asOf)? Private IPs are
// unique only per VPC, so ALL matching hits are returned with subnet/VPC context and
// the caller disambiguates. Per-hit service context comes from separate single-MATCH
// queries assembled in TS; the subnet/VPC placement is per-IP (IN_SUBNET hangs off
// the IpAddress node, and vpcId is the Subnet.vpcId property the writer SET).
export async function ipToWorkload(store: GraphStore, ip: string, asOf?: string): Promise<IpWorkloadHit[]> {
	if (!ip) return [];
	const params = (base: Record<string, unknown>): Record<string, unknown> => (asOf ? { ...base, asOf } : base);

	const bound = await store.run<{
		arn: string;
		lastVerified: string | null;
		discoveredBy: string | null;
		tValid: string | null;
		tInvalid: string | null;
	}>(
		`MATCH (i:IpAddress {ip: $ip})-[b:BOUND_TO]->(r:AwsResource) WHERE ${validityClause("b", asOf)} RETURN r.arn AS arn, b.lastVerified AS lastVerified, b.discoveredBy AS discoveredBy, b.tValid AS tValid, b.tInvalid AS tInvalid`,
		params({ ip }),
	);
	if (bound.length === 0) return [];

	const subnetRows = await store.run<{ subnetId: string; vpcId: string | null }>(
		`MATCH (i:IpAddress {ip: $ip})-[sn:IN_SUBNET]->(s:Subnet) WHERE ${validityClause("sn", asOf)} RETURN s.id AS subnetId, s.vpcId AS vpcId`,
		params({ ip }),
	);
	// Ambiguous multi-VPC placement emits no placement: the IpAddress node is keyed
	// by the bare ip, so a reused private IP can carry valid IN_SUBNET edges from
	// several VPCs -- stamping the first row onto every hit would misattribute them.
	const uniqueSubnets = new Set(subnetRows.map((row) => String(row.subnetId ?? "")));
	const subnetId = uniqueSubnets.size === 1 ? String(subnetRows[0]?.subnetId ?? "") : "";
	const vpcId = uniqueSubnets.size === 1 ? String(subnetRows[0]?.vpcId ?? "") : "";

	const hits: IpWorkloadHit[] = [];
	for (const row of bound) {
		const arn = String(row.arn);
		const serviceRows = await store.run<{ name: string }>(
			`MATCH (s:Service)-[r:RUNS_ON]->(x:AwsResource {arn: $arn}) WHERE ${validityClause("r", asOf)} RETURN s.name AS name`,
			params({ arn }),
		);
		hits.push({
			ip,
			workloadArn: arn,
			service: String(serviceRows[0]?.name ?? ""),
			subnetId,
			vpcId,
			lastVerified: String(row.lastVerified ?? ""),
			discoveredBy: String(row.discoveredBy ?? ""),
			tValid: String(row.tValid ?? ""),
			tInvalid: String(row.tInvalid ?? ""),
		});
	}
	return hits;
}

// SIO-1457: prior-knowledge application-map edges for a bounded service set --
// the KG overlay behind the ApplicationTopologyCard's dashed edges. One flat
// edge list (not a per-service map): the consumer (graphEnrich) converts rows
// straight into ApplicationTopologyEdge values keyed by the shared id-prefix
// contract, so no per-service structure is needed. discoveredBy is carried so
// the card tooltip can attribute an edge to its collector (topology-job /
// orbit-name-match / app-map).
export interface AppMapEdge {
	kind: "depends-on" | "consumes-from" | "routes-to" | "runs-on";
	from: string; // Service.name | ConsumerGroup.name | ApiRoute.path
	to: string; // Service.name | KafkaTopic.name | AwsResource.arn
	discoveredBy: string;
}

const APP_MAP_LAYER_CAP = 50;

// ConsumerGroup has no Service edge in the schema, so group relevance is a name
// affinity check (group ids conventionally embed the service name). Normalized
// substring either way; a 3-char floor keeps a short service name like "api"
// from claiming every group.
function nameAffinity(groupName: string, service: string): boolean {
	const g = groupName.toLowerCase();
	const s = service.toLowerCase();
	if (g.length < 3 || s.length < 3) return false;
	return g.includes(s) || s.includes(g);
}

// CodeRabbit PR #644: GraphStore.run<T> does not validate returned rows, so a
// missing endpoint would otherwise become "null"/"undefined" via String(...) and
// enter the topology as a valid-looking identifier. Non-empty endpoints are
// required; discoveredBy tolerates null/absent (pre-lifecycle rows).
const DependsOnRowSchema = z.object({
	from: z.string().min(1),
	to: z.string().min(1),
	discoveredBy: z.string().nullish(),
});
const RunsOnRowSchema = z.object({ arn: z.string().min(1), discoveredBy: z.string().nullish() });
const RoutesRowSchema = z.object({ path: z.string().min(1), discoveredBy: z.string().nullish() });
const ConsumesRowSchema = z.object({
	group: z.string().min(1),
	topic: z.string().min(1),
	discoveredBy: z.string().nullish(),
});

export async function appMapForServices(store: GraphStore, services: string[], asOf?: string): Promise<AppMapEdge[]> {
	const out: AppMapEdge[] = [];
	const seen = new Set<string>();
	// CodeRabbit PR #644: every query binds LIMIT $limit so a high-degree service
	// is capped in the engine, not after all rows have been fetched.
	const params = (base: Record<string, unknown>): Record<string, unknown> => {
		const bound = { ...base, limit: APP_MAP_LAYER_CAP };
		return asOf ? { ...bound, asOf } : bound;
	};
	const add = (edge: AppMapEdge): void => {
		const key = `${edge.kind}|${edge.from}|${edge.to}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(edge);
	};
	const cleanServices = services.filter((s) => s.length > 0);

	for (const service of cleanServices) {
		const outgoing = await store.run(
			`MATCH (a:Service {name: $name})-[r:DEPENDS_ON]->(b:Service) WHERE ${validityClause("r", asOf)} RETURN a.name AS from, b.name AS to, r.discoveredBy AS discoveredBy LIMIT $limit`,
			params({ name: service }),
		);
		const incoming = await store.run(
			`MATCH (a:Service)-[r:DEPENDS_ON]->(b:Service {name: $name}) WHERE ${validityClause("r", asOf)} RETURN a.name AS from, b.name AS to, r.discoveredBy AS discoveredBy LIMIT $limit`,
			params({ name: service }),
		);
		for (const raw of [...outgoing, ...incoming].slice(0, APP_MAP_LAYER_CAP)) {
			const row = DependsOnRowSchema.safeParse(raw);
			if (!row.success) continue;
			add({ kind: "depends-on", from: row.data.from, to: row.data.to, discoveredBy: row.data.discoveredBy ?? "" });
		}

		const runsOn = await store.run(
			`MATCH (s:Service {name: $name})-[r:RUNS_ON]->(x:AwsResource) WHERE ${validityClause("r", asOf)} RETURN x.arn AS arn, r.discoveredBy AS discoveredBy LIMIT $limit`,
			params({ name: service }),
		);
		for (const raw of runsOn.slice(0, APP_MAP_LAYER_CAP)) {
			const row = RunsOnRowSchema.safeParse(raw);
			if (!row.success) continue;
			add({ kind: "runs-on", from: service, to: row.data.arn, discoveredBy: row.data.discoveredBy ?? "" });
		}

		const routes = await store.run(
			`MATCH (a:ApiRoute)-[r:ROUTES_TO]->(s:Service {name: $name}) WHERE ${validityClause("r", asOf)} RETURN a.path AS path, r.discoveredBy AS discoveredBy LIMIT $limit`,
			params({ name: service }),
		);
		for (const raw of routes.slice(0, APP_MAP_LAYER_CAP)) {
			const row = RoutesRowSchema.safeParse(raw);
			if (!row.success) continue;
			add({ kind: "routes-to", from: row.data.path, to: service, discoveredBy: row.data.discoveredBy ?? "" });
		}
	}

	// One capped fetch (not per-service): CONSUMES_FROM has no Service anchor to
	// MATCH on, so relevance is decided in TS by name affinity against ANY focus
	// service. The engine LIMIT is wider than a per-layer cap because affinity
	// filtering happens after the fetch.
	if (cleanServices.length > 0) {
		const consumes = await store.run(
			`MATCH (g:ConsumerGroup)-[r:CONSUMES_FROM]->(t:KafkaTopic) WHERE ${validityClause("r", asOf)} RETURN g.name AS group, t.name AS topic, r.discoveredBy AS discoveredBy LIMIT $limit`,
			asOf ? { limit: APP_MAP_LAYER_CAP * 4, asOf } : { limit: APP_MAP_LAYER_CAP * 4 },
		);
		// CodeRabbit PR #644 round 2: the layer cap applies to ACCEPTED edges, after
		// affinity filtering -- the wider fetch limit only buys filtering headroom.
		let accepted = 0;
		for (const raw of consumes) {
			if (accepted >= APP_MAP_LAYER_CAP) break;
			const row = ConsumesRowSchema.safeParse(raw);
			if (!row.success) continue;
			if (!cleanServices.some((s) => nameAffinity(row.data.group, s))) continue;
			add({
				kind: "consumes-from",
				from: row.data.group,
				to: row.data.topic,
				discoveredBy: row.data.discoveredBy ?? "",
			});
			accepted += 1;
		}
	}
	return out;
}
