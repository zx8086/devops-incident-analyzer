# Handover — SIO-1104: KG bindings Stage 5 (topology writer + as-of reads + graph-join similarity)

- **Date**: 2026-07-14
- **Ticket**: SIO-1104 — https://linear.app/siobytes/issue/SIO-1104 (Backlog; blocked-by SIO-1103, now merged)
- **Parent program**: the "KG bindings build-out" — 5 stages extending `packages/knowledge-graph` from an enrichment side-channel into the incident correlation/learning substrate. Full plan: `~/.claude/plans/users-simon-owusu-tommy-com-downloads-k-squishy-bubble.md` (Stage 5 spec is the "Stage 5 — Topology writer + as-of + graph-join similarity" section).
- **Repo state**: `main` @ `6eb5645` — Stages 1–4 are ALL merged (PRs #365, #366, #367, #368, #369, #370). Build/lint/tests green on main.
- **Suggested branch**: `claude/sio-1104-topology-writer` (branch off `origin/main`; per project rule, no direct push to main for code).
- **Prior stages (context)**: SIO-1100 (W8 writer + schema), SIO-1101 (R7 read), SIO-1102 (identifier-level confirm + eval), SIO-1103 (staleness + mirror facts + blast-radius rule).

---

## TL;DR

Stage 5 is the last slice. Three independent pieces, best shipped as separate sub-PRs (5a/5b/5c) the same way Stage 4 was split:

1. **Topology writer cron (5a, biggest)** — a scheduled job that populates the runtime topology edges (`DEPENDS_ON`, `ROUTES_TO`, `PRODUCES_TO`/`CONSUMES_FROM`, and a NEW `RUNS_ON(Service→AwsResource)`) from live sources (elastic APM `service_destination` metrics, Kong Konnect configs, Kafka describes, AWS ECS enumeration). Fresh edges get `tValid=now`; edges absent for K consecutive runs get `tInvalid` set (invalidate-not-delete). This is what unblocks the `Bucket`/`AwsResource` blast-radius fan-in that Stage 4's `blastRadiusForServices` explicitly deferred.
2. **Graph-join similarity (5b, small)** — wire the EXISTING-BUT-UNWIRED `priorRootCauses` reader (RootCause → incidents → `RESOLVED_BY` → Runbook = "what resolved it") into `graphEnrich`'s similar-incident rendering, line-capped.
3. **As-of reads (5c, small)** — optional `asOf` param on the binding/topology readers: `tValid <= $asOf AND (tInvalid = '' OR tInvalid > $asOf)`.

Success = topology edges kept fresh by a cron (staleness < interval × K), one as-of query demonstrated, `priorRootCauses` surfaced in enrichment. Recommend doing 5b first (smallest, warms you up on the code), then 5c, then 5a.

---

## Context — how this ticket came to be

Stages 1–4 built the telemetry-binding substrate (Service→TelemetrySource `OBSERVED_IN` edges learned per-investigation) and, in Stage 4, a shared-infra blast-radius correlation rule. That rule (`shared-infra-blast-radius` in `packages/agent/src/correlation/rules.ts`) can only traverse the edges the graph actually has: `DEPENDS_ON`, shared `KafkaTopic` (via `PRODUCES_TO`), shared `TelemetrySource` (via `OBSERVED_IN`). The guide assumed a `RUNS_ON(Service→AwsResource)` edge and `Bucket` fan-in, but **those Service→resource edges don't exist** — nothing populates them today. Stage 5's topology writer is what creates them, closing that gap. The `blastRadiusForServices` reader (`packages/knowledge-graph/src/reader.ts`) has a comment saying exactly this: "Bucket/AwsResource fan-in awaits the Stage 5 topology writer."

---

## Where the bodies are buried (precise refs, all against `main` @ `6eb5645`)

### The cron idiom to clone (5a)
`apps/web/src/lib/server/iac-reconcile-cron.ts` — the canonical Bun.cron-with-Node-fallback pattern. Key mechanics:
- `Bun.cron(schedule, sweep)` under Bun; `setInterval` fallback under Node (apps/web runs under Vite's Node dev server / Node adapter, where `Bun` is undefined and `Bun.cron` throws). Rationale at lines 8–12.
- `let sweeping = false` re-entrancy guard emulates Bun.cron's no-overlap for the setInterval path (line 29).
- `.unref()` so the timer never blocks shutdown (line 6).
- `startIacReconcileCron()` is the exported installer.

Registered in `apps/web/src/lib/server/agent.ts`:
```
38  installGraphWarmer();
41  installAgentMemory();
51  startIacReconcileCron();
```
The Stage-5 topology cron (`apps/web/src/lib/server/kg-topology-cron.ts`, NEW) registers here too, right after `startIacReconcileCron()`. Flags: `KG_TOPOLOGY_CRON_ENABLED` (default OFF for this one — it does live MCP I/O; unlike the read/write flags which default ON), `KG_TOPOLOGY_CRON_SCHEDULE` (default hourly `0 * * * *`).

### Schema: adding RUNS_ON + the ALTER-on-rel-table open question (5a)
`packages/knowledge-graph/src/schema.ts`:
- `MIGRATIONS` array is lines 212–275; the last statement is the SIO-1100 `DISCOVERED_DURING` at line 274, array closes line 275. Append the new `RUNS_ON` table there:
  ```
  "CREATE REL TABLE IF NOT EXISTS RUNS_ON(FROM Service TO AwsResource, tValid STRING, tInvalid STRING, consecutiveMisses INT64)",
  ```
  Also add `"RUNS_ON"` to `REL_TYPES` (near line 99 where `DISCOVERED_DURING` is).
- **OPEN QUESTION (guide Q2)**: topology refresh wants VALIDITY columns (`tValid`/`tInvalid`) on the EXISTING `DEPENDS_ON`/`ROUTES_TO`/`PRODUCES_TO` rel tables, which currently have NO columns. `ALTER TABLE ... ADD` is proven only on NODE tables — see `ALTER_MIGRATIONS` (lines 282–286): `ALTER TABLE ConfigChange ADD outcome ...` etc., all NODE tables. **Whether lbug 0.14.3 supports `ALTER TABLE <relTable> ADD` is UNVERIFIED.** MUST validate against the real engine first (see "Verification" — clone a probe like the ones already used). If it rejects rel-table ALTER, the fallback is: don't ALTER; instead drop `.data/knowledge-graph` and rebuild (cheap now that Stage 4 mirror facts exist — `knowledge-graph:rebuild`). Simplest safe path: give the NEW `RUNS_ON` the validity columns (as above), and leave the existing untimed edges untimed unless the ALTER probe passes.

### Topology writer: the seed-writer pattern to follow (5a)
`packages/knowledge-graph/src/writer.ts`:
- `mergeNodes(store, label, key, values)` at line 20 — the generic idempotent MERGE helper.
- `upsertEntities` (line 26) already merges `Service`/`KafkaTopic`/`ConsumerGroup`/`Bucket`/`ApiRoute` + `DEPENDS_ON` edges — the topology writer's node/edge writes mirror this.
- `seedModules`/`seedStacks`/`linkStackModule` (lines 502+) show the "pure, network-free, idempotent MERGE, caller owns I/O" convention. The topology writer should be the same: a pure `recordTopology*` writer in `writer.ts` that takes already-parsed edge lists, and a cron/collector (`packages/agent/src/kg-topology.ts`, NEW) that owns all the live MCP I/O and feeds it parsed lists. This keeps `knowledge-graph` dependency-free of the MCP bridge.
- ALL writers are parameterized MERGE (never string-interpolate). Every new writer needs an `index.ts` export (`packages/knowledge-graph/src/index.ts`).

### Live-source collectors (5a) — where the topology comes from
The agent already talks to every MCP server via the bridge. `packages/agent/src/kg-topology.ts` (NEW) collectors, each mapping a live query → edges:
- **elastic APM `service_destination`** exit-span metrics → `DEPENDS_ON(Service→Service)`. (APM service maps live in `packages/mcp-server-elastic`; the `resolve-identifiers.ts` `probeElastic` shows how to call elastic tools via `getToolsForDataSource("elastic")`.)
- **Konnect** service/route/upstream configs → `ROUTES_TO(ApiRoute→Service)`. (Konnect tools via `getToolsForDataSource("konnect")`; see `probeKonnect` in `resolve-identifiers.ts`.)
- **Kafka** consumer-group describes → `PRODUCES_TO`/`CONSUMES_FROM`. (See `probeKafka`.)
- **AWS** ECS enumeration → `RUNS_ON(Service→AwsResource)`. (AWS via the SigV4 proxy; see `probeAws` and the AWS estate router. AWS is multi-estate — cross-account AssumeRole; the collector must iterate estates like `awsEstateRouter` does.)
Reference pattern for calling a datasource tool off the hot path: `packages/agent/src/resolve-identifiers.ts` `toolFor(...)` / `getToolsForDataSource(...)` and the `probe*` functions (they enumerate-then-parse; the topology collectors do the same but write to the graph instead of state).

### Graph-join similarity (5b) — the unwired reader + wire point
- **Unwired reader**: `priorRootCauses` in `packages/knowledge-graph/src/reader.ts` (exported from `index.ts:18`). It joins RootCause → its incidents → `RESOLVED_BY` → Runbook ("we've seen this class, and here's what resolved it"). Today it is called ONLY by the elastic-iac MCP tool `packages/mcp-server-knowledge-graph/src/tools/curated.ts:140` — NOT by the incident-analyzer enrichment path.
- **Wire point**: `packages/agent/src/graph-knowledge.ts` `graphEnrich`. The similar-incident loop is around lines 161–166 (`similarIncidents(...)` then `rootCauseForIncident(...)` per hit), and the return is line 179 (`return { graphContext: buildGraphContext(deps, similar), graphBlastRadius }`). For each similar incident that HAS a root cause, additionally call `priorRootCauses(store, rc.class)` to fetch the runbooks that resolved that cause class, and thread them into `buildGraphContext` (in `reader.ts`) so the aggregator prompt says "prior root cause X, resolved via runbook Y". LINE-CAP the addition (buildGraphContext already caps its rendering — match that discipline so the aggregator prompt doesn't bloat).

### As-of reads (5c)
Add an optional `asOf?: string` (ISO) param to the bi-temporal readers:
- `bindingsForServices` (`reader.ts`) — currently filters `o.tInvalid = ''`. As-of form: `o.tValid <= $asOf AND (o.tInvalid = '' OR o.tInvalid > $asOf)`.
- `blastRadiusForServices` (`reader.ts`) — the `OBSERVED_IN` two-hop `WHERE o1.tInvalid = '' AND o2.tInvalid = ''` gets the same treatment.
- The new `RUNS_ON` reader (if you add one for blast radius) same.
Keep the default (no `asOf`) = "currently valid" (`tInvalid = ''`), so existing callers are unchanged.

---

## The fix (step-by-step, per sub-PR)

**Do 5b first (smallest), then 5c, then 5a (biggest).** Each is its own PR/branch off latest main.

### 5b — graph-join similarity (~1 file + test)
1. In `reader.ts` `buildGraphContext`, extend the similar-incident type/render to carry optional resolving-runbooks.
2. In `graph-knowledge.ts` `graphEnrich`, after `rootCauseForIncident(store, inc.id)` returns a cause, call `priorRootCauses(store, rc.class)` and attach its runbook filenames to that similar-incident entry. Soft-fail (the outer try already handles it).
3. Test in `graph-knowledge.test.ts`: stub `priorRootCauses` result, assert the runbook appears in `graphContext`. (Existing test at ~line 79 stubs the similar-incident + root-cause path — mirror it.)

### 5c — as-of reads (~1 file + test)
1. Add `asOf?: string` to `bindingsForServices` and `blastRadiusForServices`; branch the WHERE clause. Keep the default behavior byte-identical.
2. Real-engine probe (see Verification) + in-memory unit tests: an edge invalidated at T is returned for `asOf < T`, excluded for `asOf >= T`.

### 5a — topology writer cron (multiple files)
1. **Schema**: add `RUNS_ON` (with validity cols) to `MIGRATIONS` + `REL_TYPES`. Probe whether `ALTER TABLE <relTable> ADD` works on lbug 0.14.3 (Q2); decide untimed-existing-edges vs rebuild-migration accordingly.
2. **Writer**: pure `recordTopologyEdges` (or per-kind writers) in `writer.ts` (parameterized MERGE, `tValid=now`; a separate `sweepStaleTopology` that bumps `consecutiveMisses` and sets `tInvalid` after K misses). Export from `index.ts`.
3. **Collectors**: `packages/agent/src/kg-topology.ts` — per-source collectors calling the MCP bridge, mapping live data → parsed edge lists, feeding the writers. Soft-fail per source.
4. **Cron**: `apps/web/src/lib/server/kg-topology-cron.ts` cloned from `iac-reconcile-cron.ts`; register in `agent.ts` after `startIacReconcileCron()`. Flags `KG_TOPOLOGY_CRON_ENABLED` (default OFF), `KG_TOPOLOGY_CRON_SCHEDULE` (default `0 * * * *`). Add both to `.env.example`.
5. **Blast-radius fan-in**: once `RUNS_ON` is populated, extend `blastRadiusForServices` to add shared-`AwsResource` (and, if a `Service→Bucket` edge is added, shared-`Bucket`) fan-in, and drop the "awaits Stage 5" caveat in its comment + `docs/architecture/knowledge-graph.md`.

---

## Verification (copy-paste runnable)

```bash
git fetch origin main && git checkout -b claude/sio-1104-... origin/main && bun install
bun run typecheck && bun run lint
bun test packages/agent/           # 2125 pass on main today
bun test packages/shared/          # 412 pass
CI=true bun test packages/knowledge-graph/   # 81 pass; CI=true SKIPS the real-engine
                                             # integration suite (see gotcha below)
```

**Real-engine probe pattern (CRITICAL for any new Cypher).** lbug is installed locally, so validate every new query against the real binder BEFORE trusting it — the InMemoryGraphStore fake records calls without executing them. Recipe (used repeatedly in Stages 1–4): write a throwaway `packages/knowledge-graph/probe-X.ts` that constructs a `LadybugStore(mkdtempSync(...))`, `await store.init()`, exercises the writer/reader, asserts, then `process.exit(0)` (to skip the teardown segfault — see gotcha). Run `bun run ./probe-X.ts`, then `rm` it. Do this for: rel-table ALTER (Q2), the `RUNS_ON` writer/reader, and any as-of WHERE clause.

Manual end-to-end (topology cron):
```bash
KNOWLEDGE_GRAPH_ENABLED=true KG_TOPOLOGY_CRON_ENABLED=true bun run dev
# trigger a sweep (or wait for the schedule), then read back:
# MATCH (s:Service)-[:DEPENDS_ON]->(d:Service) RETURN s.name, d.name
# MATCH (s:Service)-[:RUNS_ON]->(r:AwsResource) RETURN s.name, r.arn
```

---

## Files to modify (grouped)

| File | Change | Sub-PR |
|---|---|---|
| `packages/knowledge-graph/src/schema.ts` | `RUNS_ON` in MIGRATIONS + REL_TYPES; Q2 ALTER decision | 5a |
| `packages/knowledge-graph/src/writer.ts` | topology writers (MERGE, tValid); stale-sweep | 5a |
| `packages/knowledge-graph/src/reader.ts` | `priorRootCauses` already exists; add `asOf` to bindings/blast-radius; optional RUNS_ON blast fan-in | 5a/5b/5c |
| `packages/knowledge-graph/src/index.ts` | export new writers/readers | 5a |
| `packages/agent/src/kg-topology.ts` (NEW) | live-source collectors | 5a |
| `apps/web/src/lib/server/kg-topology-cron.ts` (NEW) | cron installer | 5a |
| `apps/web/src/lib/server/agent.ts` | register the cron | 5a |
| `packages/agent/src/graph-knowledge.ts` | wire `priorRootCauses` into graphEnrich | 5b |
| `.env.example` | `KG_TOPOLOGY_CRON_*` flags | 5a |
| `docs/architecture/knowledge-graph.md` | topology section; drop the "Bucket/AwsResource awaits Stage 5" caveat | 5a |
| Tests: `knowledge-graph.test.ts`, `graph-knowledge.test.ts` | writer/reader shapes, graphEnrich runbook render, as-of filtering | all |

---

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| `ALTER TABLE <relTable> ADD` unsupported on lbug 0.14.3 (Q2) | Medium | Probe FIRST. Fallback: give only NEW rel tables validity cols; rebuild-migrate the rest (cheap post-Stage-4). |
| Topology cron does heavy multi-estate AWS I/O on a schedule | Medium | Default flag OFF; bound per-source with the `probe*` timeout idiom; soft-fail per source so one slow estate doesn't wall the sweep. |
| Incorrect/incomplete topology is worse than none (Netflix lesson, P6 in the plan) | Medium | Only write edges from a source that IS the system of record (APM/Kong own their topology); mark `discoveredBy: "topology-job"`; K-consecutive-miss invalidation, not immediate delete. |
| lbug teardown segfaults Bun at process exit (SIO-954) | High (local) | The integration suite is SKIPPED in CI via `process.env.CI` guard in `ladybug.integration.test.ts` (added in Stage 1 — that's why CI is green). Local probes must `process.exit(0)` after asserting. |
| Aggregator prompt bloat from `priorRootCauses` runbooks | Low | Line-cap in `buildGraphContext` like the existing similar-incident cap. |
| Correlation-rule regression from touching the engine | Low (5b/5c don't) | Only 5a's blast-radius fan-in touches rule inputs; keep the existing 0.59 degradation cap untouched; ALL pre-existing correlation tests must stay green (the Stage 4 acceptance bar). |

---

## Out of scope (explicitly NOT this ticket)

- Exposing curated `kg_*` READ tools to the incident-analyzer agent — that's the guide's rejected Stage-5-tail idea, tracked SEPARATELY as SIO-1027, and contradicts the documented enrichment-only design (`docs/architecture/knowledge-graph.md` asymmetry table). Do NOT bundle.
- `SERVICE_CHANGED_BY(Service→ConfigChange)` — deferred in Stage 4; only add if an incident-side ConfigChange producer materializes.
- Re-embedding on rebuild (`--re-embed`) — a separate Bedrock-cost decision, not Stage 5.

---

## Related code references (correct patterns to mirror)

- `apps/web/src/lib/server/iac-reconcile-cron.ts` — the cron template (Bun.cron + Node setInterval fallback + re-entrancy + unref).
- `packages/agent/src/resolve-identifiers.ts` `probe*` / `toolFor` / `getToolsForDataSource` — how to call each datasource's MCP tools off the hot path and parse results.
- `packages/knowledge-graph/src/writer.ts` `seed*`/`upsertEntities` — the pure-MERGE, caller-owns-I/O writer convention.
- `packages/knowledge-graph/src/reader.ts` `blastRadiusForServices` — the bi-temporal `tInvalid = ''` filter form (as-of extends this) and the "awaits Stage 5" caveat to remove.
- `packages/agent/src/correlation/rules.ts` `shared-infra-blast-radius` (last rule) — consumes the topology `RUNS_ON` edges once they exist.

## Memory references (relevant prior learnings)

`/Users/Simon.Owusu@Tommy.com/.claude/projects/-Users-Simon-Owusu-Tommy-com-WebstormProjects-devops-incident-analyzer/memory/`:
- `reference_kuzu_vector_index_forbids_set` — vector-index write constraints (relevant if topology ever touches embeddings).
- `reference_lbug_close_segfaults_bun`, `reference_lbug_cypher_and_teardown_gotchas`, `reference_lbug_exclusive_file_lock` — lbug engine gotchas (teardown segfault, exclusive lock, Cypher quirks). The exclusive lock matters: the cron writes through the SAME in-process `getGraphStore()` singleton — never open a second store on the live path.
- `reference_bun_cron_node_fallback` — apps/web runs Node; the cron MUST use the setInterval fallback path.
- `reference_no_module_scope_bun_env_in_agent` — read env flags inside functions with an injectable `env` param (no module-scope `Bun.env`; Vite SSR breaks it).
- `reference_iac_reconcile_*` / `reference_bun_install_rewrites_root_catalog` — cron/reconcile idioms and the `bun install` catalog-rewrite gotcha (check `git diff` after any install).

## Workflow reminders (from CLAUDE.md)

- Branch off main; PR ready-for-review (never draft); commit format `SIO-1104: ...` with a `Co-Authored-By: Claude Fable 5` trailer; PRs get a `🤖 Generated with Claude Code` footer.
- Wait for CodeRabbit on each PR and address findings before merging (Stages 1–4 pattern; CodeRabbit surfaced 8 real bugs across those PRs).
- Split Stage 5 into 5b→5c→5a sub-PRs; keep each independently green.
- Move SIO-1104 In Progress when starting, In Review after merge; do NOT set Done without explicit user approval.
