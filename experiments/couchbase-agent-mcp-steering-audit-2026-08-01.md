# Couchbase MCP Steering Audit (2026-08-01)

Datasource-agnostic audit of `packages/mcp-server-couchbase` and the capella-agent's
steering, run per `docs/runbooks/mcp-steering-audit-runbook.md` and
`docs/runbooks/mcp-tool-audit-runbook.md`, following the elastic-agent audit
(SIO-1326/1327/1328, PR #559) and the aws-agent audit (SIO-1329/1330/1331, PR #560)
in this project. Couchbase's architecture is NOT a copy of AWS/elastic's -- see
"Architecture differences" below before comparing findings 1:1.

## Architecture differences from elastic/AWS (confirmed before auditing)

- capella-agent has `SOUL.md` (207 lines) but no `RULES.md` -- procedural steering
  lives in three skill files: `agents/incident-analyzer/agents/capella-agent/skills/
  {fatal-request-investigation,no-index-diagnosis,slow-query-triage}/SKILL.md`. All
  four files were read end-to-end.
- Couchbase is a **single cluster**, not a multi-target fan-out like elastic's N
  deployments or AWS's N estates. There is no per-deployment/per-estate
  `Promise.allSettled` racing a shared timeout in the live-incident query path.
- `capella_run_sql_plus_plus_query` is **synchronous** (SQL++ over the SDK), not an
  async start/poll/get-results lifecycle like CloudWatch Logs Insights -- there is no
  `status` field to poll, so the Class 3 check needed a different shape than AWS's.

## Phase 0: Scope and ground truth

- Read all four steering files: `SOUL.md`, `fatal-request-investigation/SKILL.md`,
  `no-index-diagnosis/SKILL.md`, `slow-query-triage/SKILL.md`.
- Read `packages/agent/src/resolve-identifiers.ts` (`probeCouchbase`),
  `packages/mcp-server-couchbase/src/lib/runSqlPlusPlusQuery.ts`,
  `packages/mcp-server-couchbase/src/tools/runSqlPlusPlusQuery.ts`,
  `packages/mcp-server-couchbase/src/lib/classifyCouchbaseError.ts`,
  `packages/mcp-server-couchbase/src/tools/getClusterHealth.ts`, and the
  `getMostExpensiveQueries.ts` / `analysisQueries.ts` window-default constants.
- Baseline: `bun run --filter '@devops-agent/gitagent-bridge' test` -- 341 pass, 0
  fail, before touching anything.
- Confirmed live cluster reachability via the session's direct `mcp-server-couchbase`
  MCP tools (`capella_ping` -> "Server and database are healthy").

## Phase 1: Ground-truth incident

Pulled a real incident directly from the live cluster (not invented): five fatal
N1QL requests (`capella_get_fatal_requests`), error code 1080 (timeout), all against
`default.styles.article`, timing out at ~74.5s, e.g.:

```sql
SELECT COUNT(*) AS total, SUM(CASE WHEN identifier IS NOT NULL THEN 1 ELSE 0 END) AS with_identifier
FROM article WHERE fmsSeasonCode IS NOT NULL LIMIT 1
```

Independently verified root cause via `capella_explain_sql_plus_plus_query` (called
directly, not through the agent) before any replay: the plan is `IndexScan3
(adv_fmsSeasonCode_articleNo) -> Fetch -> ...aggregate`, with an optimizer cardinality
estimate of 4,134,954 rows. `adv_fmsSeasonCode_articleNo` covers only
`(fmsSeasonCode, articleNo)` -- it does NOT cover the `identifier` field the
projection needs, forcing a full-document KV fetch for every matched row. This is a
**non-covering index** case, not a "no index available" (N1QL code 4000) case --
a meaningfully different failure to diagnose correctly, which made it a strong
steering test.

## Phase 2/3: Fresh-process replay + evidence

Fresh dev server on `:5174` (`KNOWLEDGE_GRAPH_ENABLED=false`, `.env` copied from
main per the worktree-replay recipe), replayed against the exact fatal statement.

**Result: PASS.** `toolsUsed` included, in order: `capella_get_scopes_and_collections`,
`capella_get_system_indexes`, `capella_get_buckets`, `capella_get_fatal_requests`,
`capella_get_system_vitals`, `capella_get_cluster_health`, `capella_get_detailed_indexes`,
`capella_explain_sql_plus_plus_query`, `capella_get_index_advisor_recommendations`,
`capella_get_completed_requests`, `capella_get_non_covering_index_queries`,
`capella_get_low_selectivity_queries`, `capella_get_indexes_to_drop`,
`capella_get_system_nodes`.

The mandatory EXPLAIN + Index Advisor pass (SOUL.md "Query optimization") fired on
the exact fatal statement. The final report's root cause matched my independently-
verified ground truth exactly: "non-covering secondary index forcing full-document
fetches ... does not cover `identifier` field used in query projection." It correctly
used `capella_explain_sql_plus_plus_query` (read-only) instead of re-running the
literal fatal statement against production. DDL was routed to "Escalate (requires
human approval)," never proposed for execution. The "Gaps" section honestly flagged
that the exact incident-window row count was an estimate, not a directly observed
value -- matching SOUL.md's "no fabrication" standard. Confidence 0.78.

This is a genuine PASS, not a gap -- the capella-agent's steering (SOUL.md +
fatal-request-investigation + slow-query-triage's EXPLAIN/Advisor mandate) drove
correct behavior on a real, previously-undiagnosed production incident.

## Findings by class

### Class 1 -- timeout races across a fan-out (adapted): FOUND, FIXED (SIO-1332)

`probeCouchbase()` in `packages/agent/src/resolve-identifiers.ts` runs a
**heterogeneous** 3-call fan-out (`capella_get_scopes_and_collections`,
`capella_get_system_indexes`, `capella_get_buckets`) via `Promise.allSettled`, with
no per-branch timeout of its own -- and was dispatched via `safeProbe()`, which wraps
the WHOLE call in one OUTER `withTimeout`. This is the exact SIO-1326 shape (an outer
timeout racing an inner `Promise.allSettled`), just 3 fixed heterogeneous branches
instead of N homogeneous per-target branches. A slow `indexes`/`buckets` branch could
discard an already-resolved `scopes` branch.

A second instance of the identical gap existed in the SIO-1107 second hop (the
bounded per-bucket `capella_get_scopes_and_collections(bucket_name)` loop) -- its own
comment assumed it "shares the node's existing probe budget," true only while the
outer `safeProbe` wrap existed.

grep across `packages/mcp-server-couchbase/src/**/*.ts` for other
`Promise.allSettled`/`withTimeout` combinations found exactly one more:
`suggestQueryOptimizations.ts`'s `runLiveOptimizationAnalysis` (ADVISOR + EXPLAIN in
parallel) -- but it has **no outer timeout at all**, and branches on each settled
result independently rather than discarding the whole thing on one failure. Not a
Class 1 bug.

**Fix**: switched `probeCouchbase` from `safeProbe` to `catchOnlyProbe` (the SIO-1326
pattern), and added `withTimeout(..., probeTimeoutMs())` to each of the three
first-hop branches individually plus the second-hop per-bucket loop -- `catchOnlyProbe`
requires the callee to own its per-branch timeout bound, which `probeCouchbase` did
not have before this fix.

**Verification**: regression test added (`resolve-identifiers.test.ts`), confirmed
failing against pre-fix code (`result.resolvedIdentifiers?.couchbase` was `undefined`
even though scopes had resolved), passing post-fix. Full `agent` package suite: 3508
pass, 0 fail. Live smoke-tested against the real cluster via a fresh replay --
`resolveIdentifiers produced candidates {"resolved":["couchbase"]}` logged cleanly.

### Class 2 -- steering field/unit/window accuracy: NO DEFECTS FOUND

- `reference_couchbase_latency_us_is_actually_nanoseconds`'s bug is already fully
  fixed in `getClusterHealth.ts` (via `withLatencyMs()`, which drops the misleading
  `latency_us` field entirely and the tool description explicitly says "Do not
  rescale them"). SOUL.md and all three SKILL.md files never reference `latency_us`
  anywhere -- no steering-side false claim to find.
- `slow-query-triage/SKILL.md`'s "defaults: 8-week window, limit 50" claim for
  `capella_get_most_expensive_queries` matches `getMostExpensiveQueries.ts`'s own
  tool description string and `DEFAULT_ANALYSIS_LIMIT` exactly -- verified against
  source, not just internal consistency.
- `fatal-request-investigation/SKILL.md`'s error-code classification table
  (3000-3999 parsing / 4000-4999 planning / 1080 timeout / 5000+ execution) matches
  `classifyCouchbaseError.ts`'s actual `instanceof` + `first_error_code` mapping
  precisely (4000 -> `no-index`, other 4xxx -> `bad-query`, 3xxx -> `bad-query`).
- `no-index-diagnosis/SKILL.md`'s guidance was live-verified against the real
  cluster's `capella_explain_sql_plus_plus_query` output during the Phase 1/3
  ground-truth work (not merely read) -- the "index scan followed by Fetch = 
  non-covering" and "no usable index = code 4000, not missing data" distinctions the
  skill draws both matched the live EXPLAIN plan's own `[WARNING]`/`[INFO]`
  annotations exactly.

No partial-enum-list doc-quality issues found in the audited files either.

### Class 3 -- silent partial-success swallowing (adapted): FOUND, FIXED (SIO-1333)

`packages/mcp-server-couchbase/src/tools/runSqlPlusPlusQuery.ts`'s `runQuery()`
success path never read `result.meta.warnings`. The Couchbase SDK's
`QueryMetaData.warnings: QueryWarning[]` (verified against `querytypes.d.ts`) is
populated whenever N1QL emits an advisory condition on an otherwise-successful query.

**Scope note**: before assuming this was a 1:1 analogue of the elastic `_shards.failed`
bug (SIO-1328), researched Couchbase's own official docs. Verdict: N1QL warnings are
**purely advisory/plan-quality signals** -- unlike ES's shard-failure case, a
Couchbase query with warnings still returns a complete, correct row set. There is no
documented N1QL "partial scatter-gather timeout as warning" mode; a genuine partial-
execution condition is modeled as a hard error/non-success status, never a warning on
a success response. This ruled out converting warnings into a hard error (SIO-1328's
fix shape) as wrong for Couchbase -- the correct fix surfaces the warning as a visible
annotation on the still-successful response instead.

**Fix**: `runQuery()`'s success path now reads `result.meta.warnings` and prepends a
`"Query succeeded with N warning(s): [code] message; ..."` line when non-empty.
`isError` stays `false`.

**Verification (TDD)**: two regression tests added
(`runSqlPlusPlusQuery.test.ts`) -- one asserting warnings surface, one asserting the
normal (no-warning) happy path is unaffected. Confirmed the warnings test failing
against pre-fix code (`Expected to contain: "sequential scan" / Received: "[...]"`) 
before applying the fix. Full `mcp-server-couchbase` package suite: 198 pass, 0 fail.
Live smoke-tested against the real cluster (`capella_run_sql_plus_plus_query` on
`styles.article`) -- output unchanged on a no-warning query, confirming no happy-path
regression.

## Verification summary (both fixes)

- `bun run typecheck` (repo-wide, all packages): clean.
- `bun run lint` (repo-wide): clean on all touched files; 8 pre-existing warnings in
  unrelated kafka test files (`noNonNullAssertion`), none in files this audit changed.
- `bun run test` (repo-wide): agent 3508 pass/0 fail, web 278 pass/0 fail,
  mcp-server-couchbase 198 pass/0 fail (includes the 2 new regression tests).
- Both fixes live-smoke-tested against the real Couchbase Capella cluster via a
  fresh-process replay on `:5174`, killed and port-verified free afterward
  (`lsof -nP -iTCP:5174 -sTCP:LISTEN` returns nothing).

## Disposition

| Finding | Class | Status | Ticket |
|---|---|---|---|
| `probeCouchbase` outer-timeout-races-inner-allSettled | 1 (adapted) | FIXED, live-verified | [SIO-1332](https://linear.app/siobytes/issue/SIO-1332) |
| Steering field/unit/window accuracy | 2 | No defects found (PASS) | -- |
| `meta.warnings` never read on success | 3 (adapted) | FIXED, live-verified | [SIO-1333](https://linear.app/siobytes/issue/SIO-1333) |

Both tickets are in Linear status **In Review** (not Done) pending user approval, per
this repo's workflow rules.
