# HANDOFF: Orbit blast-radius program (5 tickets, sequenced)

## Header

- **Date**: 2026-07-30
- **Tickets** (execute in this order; each has a full spec in Linear -- this doc adds the session-derived facts a fresh session cannot get from the tickets alone):
  1. [SIO-1303](https://linear.app/siobytes/issue/SIO-1303/gitlab-blast-radius-definition-name-match-fallback-when-the-imports) -- gitlab_blast_radius definition name-match fallback
  2. [SIO-1305](https://linear.app/siobytes/issue/SIO-1305/fuse-kg-depends-on-runtime-radius-with-orbit-code-radius-into-a) -- fuse KG DEPENDS_ON runtime radius with Orbit code radius
  3. [SIO-1302](https://linear.app/siobytes/issue/SIO-1302/make-code-change-correlation-runbook-selection-mandatory-deterministic) -- mandatory always-select for the code-change-correlation runbook
  4. [SIO-1299](https://linear.app/siobytes/issue/SIO-1299/orbit-deploy-needs-blast-radius-re-fan-carries-no-fetchdirective-re) -- fetchDirective for the orbit-deploy-needs-blast-radius re-fan
  5. [SIO-1300](https://linear.app/siobytes/issue/SIO-1300/orbit-tool-outputs-are-not-in-typed-finding-tools-64kb-persist-cap) -- Orbit outputs into TYPED_FINDING_TOOLS
- **Parent context**: [SIO-1295](https://linear.app/siobytes/issue/SIO-1295/gitlab-mcp-orbit-gate-rejects-migrating-status-and-boot-frozen) (merged, PR #539) and the 2026-07-30 Orbit steering audit + two live replays. [SIO-1297](https://linear.app/siobytes/issue/SIO-1297) (aggregation grammar) is already merged (`b1ba209f`).
- **Repo state at handoff**: `main` @ `318fa2c1` (SIO-1304). One ticket per branch; Linear's suggested branch names are fine (e.g. `simonowusupvh/sio-1303-...`).
- **Policy decision (Simon, 2026-07-30, binding for all five)**: all incidents are software incidents -- the query always concerns a running service, i.e. code. Code-change investigation and blast-radius identification must be deterministic and explicit, never LLM-router discretion. 1303+1305 together are what make "there is always an identifiable blast radius" literally true.

## TL;DR

The Orbit availability gate is fixed (SIO-1295) and live-proven; a 4-layer audit plus two full-pipeline live replays (one synthetic, one with a real styles-v3-service Couchbase-timeout log) proved the skills DO drive the 7 Orbit tools and anchor extraction from a real stack trace is correct. What remains is that the radius ANSWER is unreliable: the IMPORTS-edge model is structurally blind to Java same-package and cross-service REST coupling (SIO-1303), the KG's already-ingested APM service map is not wired into the downstream-impact answer (SIO-1305), the code-change runbook is selected at router discretion (SIO-1302), the blast-radius recovery re-fan is untargeted (SIO-1299), and big Orbit payloads silently truncate at 64KB before the rules see them (SIO-1300). Success = a styles-v3-service-style incident deterministically names its impacted consumers (e.g. lists-api) with two-source confirmation.

## Context -- how these tickets came to be

SIO-1295 (this session, merged as `ac3c3b48`, PR [#539](https://github.com/zx8086/devops-incident-analyzer/pull/539)) fixed two availability-gate defects (accept `system.status "migrating"` when both required indexers are ready; re-check availability on every handler call while boot-unavailable, arming flag deleted). Verifying it live against gitlab.com Orbit v0.91.1 (which was mid-schema-migration all day, status fluctuating boot-to-boot) surfaced the aggregation-grammar defect (fixed as SIO-1297) and prompted a full steering audit + two live replays. Replay 2 used a REAL log entry (styles-v3-service, `com.couchbase.client.core.error.UnambiguousTimeoutException` on kv get to bucket `default` scope `styles` collection `article`, Reactor checkpoint `pvh.services.styles.controller.StyleController#getStyleByStyleCode(String, boolean)`): the agent anchored blast radius on exactly `StyleController`, `getStyleByStyleCode`, `GlobalExceptionHandler`, `pvh.services.styles` -- all 0 rows -- and its report admitted "downstream callers ... could not be enumerated from GitLab code-import analysis alone". Ground-truth probes then proved the radius IS in the graph but invisible to the IMPORTS join (see next section).

## Where the bodies are buried (live-verified facts + file:line)

**The IMPORTS join and its blindness** -- `packages/mcp-server-gitlab/src/tools/orbit/dsl.ts:94` (`buildBlastRadiusQuery`):

```ts
nodes: [
  { id: "def", entity: "Definition", columns: [...], filters: { name: { token_match: symbol } } },
  { id: "sym", entity: "ImportedSymbol", columns: [...], filters: { import_path: { any_tokens: symbol } } },
],
relationships: [{ type: "IMPORTS", from: "sym", to: "def" }],
```

Live-proven 2026-07-30 against gitlab.com Orbit v0.91.1:
- `getStyleByStyleCode` blast radius = 0 rows, BUT a Definition-only probe finds it in 4 places: the stack-trace method itself (`src/main/java/pvh/services/styles/controller/StyleController.java`, Method), a cross-service consumer (`src/main/java/com/pvh/listsapi/rest_client/StylesAPIRestClient.java`, Method), `services/styles/contracts/getStyleByStyleCode.ts` (Module), and a spec file. The radius exists as name co-occurrence; REST/same-package coupling produces no IMPORTS edges.
- `AdyenNotificationsDao` -- Definition exists (Class, `WebSphereCommerceServerExtensionsLogic/src/com/pvh/commerce/rest/adyen/dao/AdyenNotificationsDao.java`), 0 importers (Java same-package `new`, no import statement).
- Contrast `logger` -> `frontend/lib/bricks/utils/src/js/logger.js` (JS Module) returns real IMPORTS rows. The join works only where import statements exist.

**The live-validated fallback query** (SIO-1303 step 1 -- this exact shape compiled and returned the rows above):

```json
{ "query_type": "traversal",
  "nodes": [{ "id": "def", "entity": "Definition",
    "columns": ["name", "fqn", "file_path", "definition_type"],
    "filters": { "name": { "token_match": "<symbol>" } } }],
  "limit": 10 }
```

- Handler integration point: `runBlastRadius` in `packages/mcp-server-gitlab/src/tools/orbit/index.ts` (~:213) -- it already does a second-stage bounded enrichment (mrByFile) with `tryConsumeBudget()` per extra billed call; the fallback follows the same pattern (fire only when the edge query returns 0 rows, budget-guarded).
- Response shape gotcha: traversal responses carry `result.nodes[]` + `result.edges[]` (typed `Definition` / `ImportedSymbol` entries with flat properties) plus `row_count`; `result.pagination.truncated` exists. The tool's `orbitRows()` helper reads `result.rows` -- name-match fallback rows arrive under `result.nodes`, so tag the payload distinctly (`radiusMode: "definition-name-match"`) rather than faking rows.
- Grammar (if writing any new aggregation queries): SIO-1297-verified -- `group_by` entries are `"<node>.<prop>"` strings or `{key, as}` objects; `aggregations` are function-as-key `{count: "<node-id>", as: "<alias>"}`; rows come back as flat scalars keyed by alias. `/orbit/schema` (free) carries ONLY the ontology, no query grammar -- grammar drift is only discoverable via a billed probe's `compile_error` text.

**The KG substrate (SIO-1305 -- already built, only the fusion is missing)**:
- Sweep: `packages/agent/src/kg-topology.ts` -- "elastic APM service_destination metrics -> DEPENDS_ON(Service->Service)" (line ~6, exit-span ingestion ~:207), lifecycle-managed, P6 discipline (guessed topology is worse than none). Cron: `apps/web/src/lib/server/kg-topology-cron.ts`, gated `KG_TOPOLOGY_CRON_ENABLED` + `KNOWLEDGE_GRAPH_ENABLED` -- **both `true` in the dev `.env`**.
- Edge model: `packages/knowledge-graph/src/schema.ts` ~:135-179 -- `TopologyEdgeKindSchema = ["depends-on", "routes-to", "consumes-from", "runs-on"]`, `depends-on -> DEPENDS_ON(Service.name -> Service.name)`, with `TOPOLOGY_DISCOVERED_BY` provenance. `PRODUCES_TO` deliberately absent (no system of record).
- Incident-time read: `packages/agent/src/graph-knowledge.ts:144-159` -- `graphEnrich` calls `priorRelationshipsForServices(store, services)` (both-direction currently-valid DEPENDS_ON; `packages/knowledge-graph/src/reader.ts` top) AND `blastRadiusForServices` (SIO-1103 shared-infra radius feeding the synchronous `shared-infra-blast-radius` rule).
- What is missing: none of that reaches the report's downstream-impact answer as a deterministic enumeration, no cross-validation against Orbit code radius, and no code-derived DEPENDS_ON writes.

**Runbook selection (SIO-1302)** -- `packages/agent/src/runbook-selector.ts`: stage-1 deterministic narrowing :400-422 (trigger-less runbooks always survive -- `code-change-correlation.md` is deliberately trigger-less per SIO-1293), stage-2 LLM router :169-188 picks 0-3 (cap :225). Live replay 2 evidence: router picked ONLY `high-error-rate.md`, reasoning "aligns with investigating error rate spikes via APM", skipping the code-change runbook despite the prompt explicitly asking "did a recent code change cause this?". Runbook bodies inject into the AGGREGATOR prompt only (`buildAggregatorMessages` -> `filterAgentRunbooks`, `packages/agent/src/aggregator.ts:116-158`); sub-agent tool-driving comes from the always-injected skills (proven: 4 blast calls fired anyway).

**Re-fan targeting (SIO-1299)** -- `packages/agent/src/correlation/rules.ts:684` (`orbit-deploy-needs-blast-radius`) sets `requestBlastRadius: true` in triggerContext (:707) but has NO `fetchDirective`; only the confluent-5xx rule (:329) and log-gap rule (:991) have one (copy their pattern). `enforce-node.ts:106-125` sends `correlationFetchDirective: undefined` -> the re-fanned gitlab-agent re-runs the original prompt untargeted (SIO-1237 class).

**Persist truncation (SIO-1300)** -- `packages/agent/src/sub-agent-instrumentation.ts:48-78` `TYPED_FINDING_TOOLS`: gitlab's only entry is `gitlab_list_merge_requests`; none of the 6 Orbit output tools is present, so `buildPersistedToolOutput` (`sub-agent.ts:491-520`) caps persisted rawJson at 65536 bytes and `extractors/orbit.ts:22-29` parses a truncated world silently. Measured: 23KB blast payload at limit 50; tool default limit is 200, max 1000. Mind the SIO-1248 in-flight vs persist cap decoupling (persist-side only). SIO-1277's comment block in that file is the rationale template.

## The fix, step-by-step (per ticket)

Each Linear ticket carries the full fix direction and acceptance criteria -- follow them. Sequencing rationale:

1. **SIO-1303 first**: adds the name-match fallback rows (tagged `radiusMode`) + extractor mode flag + one calibration sentence in `agents/incident-analyzer/agents/gitlab-agent/skills/code-search-selection/SKILL.md`. Everything later consumes these rows. TDD against `dsl.test.ts` + `orbit-tools.test.ts` (stub-server harness at the top of `orbit-tools.test.ts` is the pattern; `makeCtx`/`register` helpers).
2. **SIO-1305 second**: fusion. Render DEPENDS_ON callers (direction-aware) + cross-validate with 1303's name-match rows; write `orbit-name-match` DEPENDS_ON edges with own provenance through the existing sweep edge model. Repo->Service mapping via `RESOLVES_TO(Alias->Service)`; skip unmappable, never guess.
3. **SIO-1302 third**: always-select mechanism for `code-change-correlation.md` (frontmatter flag or `index.yaml` list), appended post-router, deduped, outside the 3-cap; severity-fallback path unions it too.
4. **SIO-1299 fourth**: fetchDirective for the re-fan, rendering deploy MR + symbol candidates + services (by now 1303/1305 give it better material to name).
5. **SIO-1300 fifth**: add the 6 Orbit output tools to TYPED_FINDING_TOOLS (`gitlab_graph_schema` stays out), with a >64KB persistence test.

## Verification

Minimum per ticket:

```bash
bun run typecheck && bun run lint && bun run test
```

(scope `bun test packages/mcp-server-gitlab` / `packages/agent` / `packages/knowledge-graph` while iterating; 16 pre-existing lint warnings live in OTHER packages -- nothing new in yours).

**Live Orbit probe recipe** (credit-free status/schema; each `/orbit/query` bills one GitLab credit -- budget ~5 per investigation):

```bash
bun --env-file=/Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer/.env run <scratchpad-script>.ts
```

Script imports `OrbitRestClient` (and DSL builders) from the worktree source by absolute path; `instanceUrl: "https://gitlab.com"`, paths `/api/v4/orbit/{query,schema,status}`, token `ORBIT_PERSONAL_ACCESS_TOKEN || GITLAB_PERSONAL_ACCESS_TOKEN` from env. Never print the token. Expected: `getStyleByStyleCode` name-sweep returns the 4 definitions listed above (post-1303, the TOOL must return them).

**Full-pipeline live replay recipe** (proves steering end-to-end; ~4 min, Bedrock + a few credits):

1. Fresh worktree needs `bun install` (no workspace symlinks) -- check `git status` after (bun install can rewrite root catalog pins; restore if so).
2. `cp MAIN/.env WORKTREE/.env`. If another session holds :9084, run your own gitlab MCP with `MCP_PORT=9184` and `sed` the worktree `.env` `GITLAB_MCP_URL=http://localhost:9184`.
3. Start: `cd packages/mcp-server-gitlab && MCP_PORT=9184 bun --env-file=../../.env src/index.ts` (background, track PID), then `bun run --filter @devops-agent/web dev` from worktree root -- vite auto-increments ports (5173->5174->5175...); parse "Local:" from its output, don't assume.
4. Replay: build the body with `jq -n --rawfile msg prompt.txt '{messages:[{role:"user",content:$msg}],dataSources:["gitlab"]}'` and `curl -N -X POST http://localhost:<port>/api/agent/stream --data @body.json`. The real styles-v3-service prompt text is in SIO-1303/1305; tool-call ledger = grep the MCP server log for "Tool call started:"; runbook picks = grep the web log for "Runbook selection complete".
5. **KG caveat (bit us twice)**: a worktree web app boots an EMPTY KG store (`apps/web/.data` absent) -- KG-derived radius will never show in a worktree replay. For SIO-1305 tests, seed DEPENDS_ON edges (or run against the cron-fed main-env store). `kg_run_cypher` via the KG MCP (:9087, in-process when the web app runs) is the credit-free inspection path.
6. **KILL every server you started** (tracked PID, then `lsof -nP -iTCP:<port> -sTCP:LISTEN` must return nothing). Other sessions' listeners on 9084/5173 are NOT yours.

## Files to modify (by ticket)

| Ticket | Files |
|---|---|
| SIO-1303 | `packages/mcp-server-gitlab/src/tools/orbit/index.ts` (runBlastRadius fallback), `dsl.ts` (+sweep builder), `dsl.test.ts`, `orbit-tools.test.ts`; `packages/agent/src/correlation/extractors/orbit.ts` (+ its test); `agents/incident-analyzer/agents/gitlab-agent/skills/code-search-selection/SKILL.md` |
| SIO-1305 | `packages/agent/src/graph-knowledge.ts`, `packages/agent/src/kg-topology.ts` (or a sibling writer), `packages/knowledge-graph/src/{schema,writer,reader}.ts`, `packages/agent/src/aggregator.ts` or a correlation rule, tests in both packages |
| SIO-1302 | `packages/agent/src/runbook-selector.ts` (+test), `agents/incident-analyzer/knowledge/index.yaml` or runbook frontmatter, `packages/agent/src/prompt-context.ts` if frontmatter parsing changes |
| SIO-1299 | `packages/agent/src/correlation/rules.ts` (+rules-orbit.test.ts), possibly `enforce-node.ts` tests |
| SIO-1300 | `packages/agent/src/sub-agent-instrumentation.ts`, truncation/persistence test suite |

## Workflow

Branch off `main` (fetch first; check open PRs -- parallel sessions were active on 2026-07-30 and dup-work has happened before). Linear: In Progress at start -> In Review at PR -> Done ONLY with Simon's explicit approval (note: a merged-PR attachment can auto-flip Done). Commits `SIO-XXXX: message`; PRs ready-for-review, never draft; CodeRabbit lifecycle is SHA-scoped (see CLAUDE.md recipe) -- triage every finding before merge. The repo is PUBLIC: sanitize (no tokens, no internal hostnames beyond what the codebase already contains).

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Orbit grammar drift (SIO-1123/1151/1297 family) breaks the new sweep query | Medium | Live-probe the exact DSL before locking tests; the compile_error text names expected shapes |
| Name-match false positives (common tokens like `logger` match many defs) | Medium | Keep fallback rows mode-tagged + prose-labeled; cap limit; never feed untagged into edge-radius consumers |
| KG lbug quirks: `close()` segfaults Bun, CREATE DDL must repeat ALTER defaults, coalesce-DEFAULT gotcha, exclusive file lock (in-proc with web app) | High if touched carelessly | Follow existing writer patterns in `packages/knowledge-graph/src/writer.ts`; never open the main `.data` store while a web app holds it |
| Always-select runbook inflates every aggregator prompt | Low | Measure byte delta (runbook body is a few KB); note in PR |
| `bun test` mock pollution across files | Medium | Own mocks in beforeEach; `--isolate` if cross-file poisoning appears |
| Orbit availability during live probes | Low (post-SIO-1295) | Status "migrating" with ready indexers = available; handlers self-heal per call |

## Out of scope

- Konnect route-level radius; network-map card changes (SIO-1204 renders already); true runtime-traffic radius beyond APM-derived DEPENDS_ON.
- SIO-1296/1298/1304 window/escalation work (other sessions, already merged).
- Any Orbit MCP availability work (SIO-1295 shipped; SIO-1297 shipped).

## Related code references (known-good patterns)

- `packages/mcp-server-gitlab/src/tools/orbit/index.ts:213` -- runBlastRadius two-stage billed pattern with budget guard (template for the 1303 fallback).
- `packages/agent/src/correlation/rules.ts:329` and `:991` -- the two existing fetchDirective implementations (template for 1299).
- `packages/agent/src/kg-topology.ts` -- provenance-tagged sweep writes + P6 skip-never-guess (template for 1305's code-derived edges).
- `packages/mcp-server-gitlab/src/tools/orbit/orbit-tools.test.ts` -- stub-server handler-test harness (`makeCtx`/`register`).
- `packages/agent/src/sub-agent-instrumentation.ts:65-74` -- SIO-1277 rationale comment style for TYPED_FINDING_TOOLS additions.

## Memory references

`reference_orbit_steering_audit_and_replay` (audit verdict, gap->ticket map, policy, replay proof), `reference_orbit_aggregation_grammar_v0911` (verified grammar), `reference_sio1295_orbit_gate_migrating_and_recheck`, `reference_sio1293_runbook_selection_levers`, `reference_sio1237_crossdatasource_procedure_home`, `reference_worktree_web_server_replay_env`, `reference_sio1248_inflight_vs_persist_cap_decoupling`, `reference_subagent_tool_budget_calibration`, `reference_kg_wal_replay_segfault_and_cwd_store_location`, `reference_lbug_close_segfaults_bun`, `feedback_fetch_before_starting_ticketed_work`, `feedback_always_kill_own_background_processes_safely`.
