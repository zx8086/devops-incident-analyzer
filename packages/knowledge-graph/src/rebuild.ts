// knowledge-graph/src/rebuild.ts
//
// SIO-1100: `knowledge-graph:rebuild` replays the durable Couchbase Agent Memory
// facts back into a fresh graph -- the "graph is a rebuildable projection" story
// (P1). Stage 1 replays ONLY kg-binding facts (the W8 writer's output); IaC change
// history and incident/root-cause mirror facts are Stage 4 forward-fill, and some
// graph-only writes (Incident embeddings, AFFECTED_BY, HAS_ROOT_CAUSE) have no
// Couchbase counterpart yet -- the CLI prints exactly what it could NOT rebuild so
// the gap is never silent.
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
import { graphPath, isKnowledgeGraphEnabled, LadybugStore } from "./store.ts";
import { recordServiceBinding, type ServiceBindingRecord } from "./writer.ts";

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

async function fetchBindingFacts(): Promise<AnnotationMap[]> {
	// resolveAgentMemoryConfig throws if AGENT_MEMORY_BASE_URL is unset; only call it
	// when the agent-memory backend is actually selected.
	if (process.env.LIVE_MEMORY_BACKEND !== "agent-memory") return [];
	const config = resolveAgentMemoryConfig();
	if (!config.enabled) return [];
	const client = createFetchAgentMemoryClient(config);
	const ref: AgentMemoryUserRef = { userId: INCIDENT_USER, sessionId: REBUILD_SESSION };
	// Empty query = deterministic filter-only mode (SIO-998): the annotation filter is
	// the authoritative WHERE clause, no top-k truncation.
	const hits = await client.searchMemory(ref, "", { allSessions: true, annotations: { kind: "kg-binding" } });
	return hits.map((h) => h.annotations ?? {});
}

async function rebuild(opts: RebuildOptions): Promise<void> {
	const targetPath = opts.out ?? graphPath();
	process.stdout.write(`knowledge-graph rebuild: target=${targetPath} dryRun=${opts.dryRun}\n`);

	const annotationSets = await fetchBindingFacts();
	const records: ServiceBindingRecord[] = [];
	let skipped = 0;
	for (const a of annotationSets) {
		const rec = bindingFromAnnotations(a);
		if (rec) records.push(rec);
		else skipped += 1;
	}
	process.stdout.write(`knowledge-graph rebuild: ${records.length} binding facts to replay (${skipped} skipped).\n`);

	if (opts.dryRun) {
		process.stdout.write("knowledge-graph rebuild: --dry-run, no writes.\n");
		printGaps();
		return;
	}

	// A dedicated store on the target path. If the live app holds the lock on this
	// path, init() throws -- which is the intended guard: never rebuild under a
	// running writer. Prefer --out to a scratch dir.
	const store = new LadybugStore(targetPath);
	await store.init();
	for (const rec of records) await recordServiceBinding(store, rec);
	await store.close();

	process.stdout.write(`knowledge-graph rebuild: replayed ${records.length} bindings into ${targetPath}.\n`);
	printGaps();
}

// Honest not-rebuilt list (P1 scope). These graph writes have no Couchbase system
// of record in Stage 1; a full rebuild recovers them only once Stage 4 mirror facts
// land (and even then, embeddings are re-generated only with an explicit flag).
function printGaps(): void {
	process.stdout.write(
		[
			"knowledge-graph rebuild: NOT rebuilt from Couchbase (no system-of-record fact yet):",
			"  - Incident nodes + embeddings, AFFECTED_BY edges (graph-only; Stage 4 mirror facts)",
			"  - RootCause nodes + HAS_ROOT_CAUSE edges (graph-only; Stage 4 mirror facts)",
			"  - Finding / CORRELATES_WITH (graph-only)",
			"  Static topology re-seeds via `knowledge-graph:seed` / `knowledge-graph:seed-iac`.",
			`  Vector index setup: run ${VECTOR_INDEX_SETUP.length} CALL(s) after rebuild if similarity search is needed.`,
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
