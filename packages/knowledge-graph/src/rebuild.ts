// knowledge-graph/src/rebuild.ts
//
// SIO-1100/1103: `knowledge-graph:rebuild` replays the durable Couchbase Agent Memory
// mirror facts back into a fresh graph -- the "graph is a rebuildable projection" story
// (P1). Replays kg-incident (Incident + AFFECTED_BY), kg-root-cause (RootCause +
// HAS_ROOT_CAUSE), and kg-binding (telemetry bindings), in that order (root-cause and
// binding provenance MATCH the Incident). Still graph-only: Incident EMBEDDINGS (facts
// carry no vector; re-embed is a Bedrock cost, not default) and Finding/CORRELATES_WITH.
// The CLI prints exactly what it could NOT rebuild so the gap is never silent.
//
// Rebuild targets a scratch --out dir by default. An in-process swap into the live
// path is impossible by construction: lbug takes an exclusive file lock and
// LadybugStore.close() is a deliberate no-op (SIO-954 teardown segfault), so the
// running web app never releases .data/knowledge-graph. The documented swap is:
// rebuild into scratch while the app runs, then stop app -> mv -> start app.

import {
	type AgentMemoryUserRef,
	type AnnotationMap,
	createFetchAgentMemoryClient,
	resolveAgentMemoryConfig,
} from "@devops-agent/shared";
import { BindingKindSchema, MIGRATIONS, VECTOR_INDEX_SETUP } from "./schema.ts";
import { type GraphStore, graphPath, isKnowledgeGraphEnabled, LadybugStore } from "./store.ts";
import {
	type IncidentRecord,
	invalidateBindingByHuman,
	linkIncidentTicket,
	type RootCauseRecord,
	recordIncident,
	recordRootCause,
	recordServiceBinding,
	type ServiceBindingRecord,
} from "./writer.ts";

// One Agent Memory user per agent (SIO-938). Bindings are the incident agent's.
const INCIDENT_USER = "incident-analyzer";
// A recall session id is required by the ref; a filter-only search across all
// sessions ignores it, so any stable value works.
const REBUILD_SESSION = "kg-rebuild";

interface RebuildOptions {
	out?: string;
	dryRun: boolean;
}

export function parseArgs(argv: string[]): RebuildOptions {
	let out: string | undefined;
	if (argv.includes("--out")) {
		const value = argv[argv.indexOf("--out") + 1];
		// A valueless `--out` (last arg) or one immediately followed by another flag
		// would otherwise fall through to graphPath() -- the LIVE graph. Reject it so
		// the operator can't accidentally rebuild over the running store's directory.
		if (!value || value.startsWith("--")) {
			throw new Error("--out requires a directory path (e.g. --out .data/kg-rebuild)");
		}
		out = value;
	}
	return { out, dryRun: argv.includes("--dry-run") };
}

// Map a kg-binding fact's annotations back to a writer record. Returns null when a
// required field is missing or the kind is not a known BindingKind (a poisoned or
// pre-schema fact) -- skipped and counted, never allowed to abort the replay.
export function bindingFromAnnotations(a: AnnotationMap): ServiceBindingRecord | null {
	const kind = BindingKindSchema.safeParse(a.binding_kind);
	if (!a.service || !a.resource_id || !a.datasource || !kind.success) return null;
	const confidence = Number(a.confidence);
	return {
		service: a.service,
		serviceNormalized: a.service_normalized ?? a.service,
		// SIO-1103: replay the alias so the RESOLVES_TO edge is reconstructed. Empty ->
		// undefined so recordServiceBinding's aliasRaw !== service guard behaves as if
		// no alias was recorded.
		aliasRaw: a.alias_raw && a.alias_raw.length > 0 ? a.alias_raw : undefined,
		datasource: a.datasource,
		kind: kind.data,
		resourceId: a.resource_id,
		locator: a.locator ?? "",
		confidence: Number.isFinite(confidence) ? confidence : 0.7,
		discoveredBy: a.discovered_by ?? "resolve-identifiers",
		incidentId: a.incident_id,
	};
}

// SIO-1127: a kg-binding-invalidated fact -> the args of invalidateBindingByHuman. Returns
// null on a missing required field (skipped + counted). Replays AFTER kg-binding so the
// edge it invalidates already exists.
export interface InvalidatedBindingRecord {
	service: string;
	datasource: string;
	kind: string;
	resourceId: string;
	reason: string;
}

export function invalidatedBindingFromAnnotations(a: AnnotationMap): InvalidatedBindingRecord | null {
	const kind = BindingKindSchema.safeParse(a.binding_kind);
	if (!a.service || !a.resource_id || !a.datasource || !kind.success) return null;
	return {
		service: a.service,
		datasource: a.datasource,
		kind: kind.data,
		resourceId: a.resource_id,
		reason: a.reason ?? "",
	};
}

async function applyInvalidatedBinding(store: GraphStore, rec: InvalidatedBindingRecord): Promise<void> {
	await invalidateBindingByHuman(store, rec.service, rec.datasource, rec.kind, rec.resourceId, rec.reason);
}

// SIO-1103: incident mirror fact -> IncidentRecord. Embedding is intentionally NOT
// replayed (facts carry no vector; re-embedding is a Bedrock cost gated behind a future
// --re-embed flag), so a rebuilt incident is recallable by id/service but not vector-
// similar until re-embedded. AFFECTED_BY is reconstructed from the services list.
// SIO-1134: curation-link replay record (kg-incident-ticket facts).
export interface TicketLinkRecord {
	incidentId: string;
	ticketKey: string;
}

export function ticketLinkFromAnnotations(a: AnnotationMap): TicketLinkRecord | null {
	if (!a.incident_id || !a.ticket) return null;
	return { incidentId: a.incident_id, ticketKey: a.ticket };
}

// Adapter to the (store, record) writer shape replayKind expects.
async function applyTicketLink(store: GraphStore, rec: TicketLinkRecord): Promise<void> {
	await linkIncidentTicket(store, rec.incidentId, rec.ticketKey);
}

export function incidentFromAnnotations(a: AnnotationMap): IncidentRecord | null {
	if (!a.incident_id) return null;
	return {
		id: a.incident_id,
		severity: a.severity ?? "",
		summary: a.summary ?? "",
		services: (a.services ?? "").split(",").filter((s) => s.length > 0),
	};
}

// SIO-1103: root-cause mirror fact -> RootCauseRecord (id is the caller-owned hash).
export function rootCauseFromAnnotations(a: AnnotationMap): RootCauseRecord | null {
	if (!a.incident_id || !a.root_cause_id || !a.rule_name) return null;
	const confidence = Number(a.confidence);
	return {
		id: a.root_cause_id,
		incidentId: a.incident_id,
		class: a.rule_name,
		description: a.description ?? "",
		confidence: Number.isFinite(confidence) ? confidence : 0,
		ruleName: a.rule_name,
	};
}

// Fetch every fact of one kind (deterministic filter-only recall, SIO-998 -- empty
// query so the annotation filter is authoritative with no top-k truncation). Returns []
// when the agent-memory backend is unselected/disabled.
async function fetchFactsByKind(kind: string): Promise<AnnotationMap[]> {
	// resolveAgentMemoryConfig throws if AGENT_MEMORY_BASE_URL is unset; only call it
	// when the agent-memory backend is actually selected.
	if (process.env.LIVE_MEMORY_BACKEND !== "agent-memory") return [];
	const config = resolveAgentMemoryConfig();
	if (!config.enabled) return [];
	const client = createFetchAgentMemoryClient(config);
	const ref: AgentMemoryUserRef = { userId: INCIDENT_USER, sessionId: REBUILD_SESSION };
	const hits = await client.searchMemory(ref, "", { allSessions: true, annotations: { kind } });
	return hits.map((h) => h.annotations ?? {});
}

// Replay one fact kind: fetch, map (skipping malformed), write. Returns counts.
// store is null on dry-run (fetch + count only, no store opened).
async function replayKind<T>(
	store: GraphStore | null,
	kind: string,
	map: (a: AnnotationMap) => T | null,
	write: (store: GraphStore, rec: T) => Promise<void>,
	dryRun: boolean,
): Promise<{ replayed: number; skipped: number }> {
	const facts = await fetchFactsByKind(kind);
	const records: T[] = [];
	let skipped = 0;
	for (const a of facts) {
		const rec = map(a);
		if (rec) records.push(rec);
		else skipped += 1;
	}
	if (!dryRun && store) for (const rec of records) await write(store, rec);
	process.stdout.write(`knowledge-graph rebuild: ${kind} -> ${records.length} replayed (${skipped} skipped).\n`);
	return { replayed: records.length, skipped };
}

async function rebuild(opts: RebuildOptions): Promise<void> {
	const targetPath = opts.out ?? graphPath();
	process.stdout.write(`knowledge-graph rebuild: target=${targetPath} dryRun=${opts.dryRun}\n`);

	// On dry-run we never open the store (init() would take the exclusive lock and could
	// contend with the live writer); replayKind just fetches + counts. Otherwise open a
	// dedicated store on the target path -- if the live app holds the lock, init() throws,
	// the intended guard: never rebuild under a running writer. Prefer --out to a scratch dir.
	const store = opts.dryRun ? null : new LadybugStore(targetPath);
	if (store) await store.init();

	// Replay order matters: incidents first (root-cause + binding provenance MATCH the
	// Incident node), then root-causes, then bindings.
	await replayKind(store, "kg-incident", incidentFromAnnotations, recordIncident, opts.dryRun);
	// SIO-1134: curation links replay AFTER incidents exist.
	await replayKind(store, "kg-incident-ticket", ticketLinkFromAnnotations, applyTicketLink, opts.dryRun);
	await replayKind(store, "kg-root-cause", rootCauseFromAnnotations, recordRootCause, opts.dryRun);
	await replayKind(store, "kg-binding", bindingFromAnnotations, recordServiceBinding, opts.dryRun);
	// SIO-1127: human invalidations replay AFTER the kg-binding that created the edge, so
	// tInvalid is set on an edge that already exists.
	await replayKind(
		store,
		"kg-binding-invalidated",
		invalidatedBindingFromAnnotations,
		applyInvalidatedBinding,
		opts.dryRun,
	);

	if (opts.dryRun) {
		process.stdout.write("knowledge-graph rebuild: --dry-run, no writes.\n");
	} else if (store) {
		await store.close();
		process.stdout.write(`knowledge-graph rebuild: replay complete into ${targetPath}.\n`);
	}
	printGaps();
}

// Honest not-rebuilt list. As of SIO-1103 (P1 forward-fill), incidents / root causes /
// bindings ARE rebuildable from their mirror facts; what remains graph-only is listed.
function printGaps(): void {
	process.stdout.write(
		[
			"knowledge-graph rebuild: rebuilt from Couchbase mirror facts (SIO-1103): Incident +",
			"  AFFECTED_BY (kg-incident), RootCause + HAS_ROOT_CAUSE (kg-root-cause), telemetry",
			"  bindings (kg-binding). NOT rebuilt (no system-of-record fact):",
			"  - Incident EMBEDDINGS (facts carry no vector; re-embed is a Bedrock cost, not default)",
			"  - Finding / CORRELATES_WITH (graph-only)",
			"  Static topology re-seeds via `knowledge-graph:seed` / `knowledge-graph:seed-iac`.",
			`  Vector index setup: run ${VECTOR_INDEX_SETUP.length} CALL(s) + re-embed if similarity search is needed.`,
			`  (schema = ${MIGRATIONS.length} tables applied by store.init())`,
		].join("\n") + "\n",
	);
}

async function main(): Promise<void> {
	if (!isKnowledgeGraphEnabled()) {
		process.stdout.write("knowledge-graph rebuild: KNOWLEDGE_GRAPH_ENABLED is not set; nothing to do.\n");
		return;
	}
	await rebuild(parseArgs(process.argv.slice(2)));
}

// Only run the CLI when invoked directly (bun run src/rebuild.ts), not when a test
// imports bindingFromAnnotations for unit coverage.
if (import.meta.main) {
	main().catch((error) => {
		process.stderr.write(`knowledge-graph rebuild failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
