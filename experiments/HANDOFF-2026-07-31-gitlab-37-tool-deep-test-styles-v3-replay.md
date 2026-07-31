# HANDOFF 2026-07-31: replay the GitLab MCP 37-tool deep test (styles-v3 Couchbase timeout incident)

- Date: 2026-07-31
- Tickets (both Done, shipped in PR #555, merged 2026-07-31T18:47Z as `e5d08a3e`):
  - https://linear.app/siobytes/issue/SIO-1316 (log-parity + the original 37-tool live deep test)
  - https://linear.app/siobytes/issue/SIO-1318 (Orbit >= 0.91 traversal-shape fix, tool handler + agent extractor)
- Repo state: `main` @ `e5d08a3e` (merge of `claude/code-analysis-orbit-test-ac921d`)
- Branch for the replay: none needed -- the replay is read-only. Create a fresh `claude/` worktree branch only if new defects need fixing.
- Prior results + full matrix: `experiments/gitlab-code-analysis-orbit-deep-test-2026-07-31.md` (committed with the PR)

## TL;DR

Re-run the full 37-tool GitLab MCP deep test (24 proxy + 6 code-analysis + 7 Orbit) against the running :9084 dev server, using the styles-v3 production Couchbase timeout as the incident basis. The 2026-07-31 run classified all 37 tools (30 live PASS-family, 7 writes SKIPPED-POLICY) and found + fixed SIO-1318. Success for a replay: every expected outcome below reproduces, and `gitlab_blast_radius` now returns `radiusMode: "definition-name-match"` with 4 Definitions and a populated `mrByFile` (it returned empty before the fix).

## The incident (verbatim basis)

```
@timestamp     Jul 30, 2026 @ 16:40:04.086
service.name   pvh-services-styles-v3   (production)
message        styles-v3-service exception: com.couchbase.client.core.error.UnambiguousTimeoutException:
               GetRequest, Reason: TIMEOUT {"cancelled":true,"completed":true,"idempotent":true,
               "lastDispatchedTo":"private-endpoint.mn1uxqblvorb0cle.cloud.couchbase.com:11213",
               "requestType":"GetRequest","retried":0,
               "service":{"bucket":"default","collection":"product2g","documentId":"PRODUCT_2027WISPSP_LV04F3853G",
               "scope":"styles","type":"kv","vbucket":495},"timeoutMs":2500,"timings":{"totalMicros":2531694}}
error.exception.type  com.couchbase.client.core.error.UnambiguousTimeoutException
service.framework.name  pvh.services.styles.exception.GlobalExceptionHandler
```

Key derived facts (all live-verified 2026-07-31): `timeoutMs=2500` is the Couchbase SDK DEFAULT kvTimeout -- the service sets no timeout override anywhere; GitLab repo is `pvhcorp/b2b/shared-services/pvh.services.styles`, numeric project id **43242609** (sibling `pvh.couchbase.eventing.styles` = 44466651); Elastic APM name mapping is styles-v3 -> pvh-services-styles-v3.

## Preconditions

1. Root `.env` present (GITLAB_PERSONAL_ACCESS_TOKEN with read_api; ORBIT_ENABLED defaults true).
2. Start (or RESTART, if it predates `e5d08a3e`) the GitLab MCP dev server:
   ```
   cd packages/mcp-server-gitlab && bun run dev
   ```
   Boot log must now show THREE name-listing registration lines (this is the SIO-1316 fix): `Proxy tools registered` (24 names), `Code analysis tools registered` (6 names), `Orbit tools registered` (7 names), then `GitLab MCP server created {proxyTools:24, codeAnalysisTools:6, orbitTools:7, total:37}` and `Orbit status probed {orbitAvailable:true}`.
3. CRITICAL: a Claude session's `mcp__mcp-server-gitlab__*` tools are app-spawned STDIO instances, NOT :9084. To test :9084, curl it directly (stateless streamable HTTP, SSE-framed):
   ```
   curl -sS -X POST http://localhost:9084/mcp -H "Content-Type: application/json" \
     -H "Accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}'
   ```
   Strip SSE framing before parsing: `grep '^data:' | sed 's/^data: //'` -- never pipe curl straight into jq.

## Replay procedure and expected outcomes (2026-07-31 baseline)

Orbit budget: 20 billed queries per rolling 60s (`ORBIT_MAX_QUERIES_PER_RUN`). The whole replay costs ~7-12 billed queries. `gitlab_graph_schema` and `/orbit/status` are free.

Phase 0 -- enumeration + baseline (free):
- `tools/list` -> exactly 37 tools; all 13 code-analysis/orbit names present. Capture proxy tools' inputSchemas here (proxy tools are remote-defined; never guess arg names).
- `gitlab_get_mcp_server_version {}` -> was `19.3.0-pre`.
- `gitlab_graph_schema {}` -> ~28KB ontology; was schema_version 0.1, 32 node types, 8 domains.

Phase 1 -- discovery (proxy reads):
- `gitlab_search {scope:"projects", search:"pvh.services.styles", group_id:"pvhcorp"}` -> id 43242609.
- `gitlab_semantic_code_search {id:"43242609", q:"couchbase kv get timeout configuration", limit:5}` -> top hit `src/main/java/pvh/services/styles/config/CouchbaseConfig.java` (~0.82).
- `gitlab_search_labels {full_path:"pvhcorp/b2b/shared-services/pvh.services.styles", is_project:true}` -> 0 labels (ENV-DATA-EMPTY).

Phase 2 -- code-analysis, investigation order:
- `gitlab_list_merge_requests {project_id:43242609 (numeric int!), state:"merged", updated_after:"2026-07-23T00:00:00Z", per_page:20}` -> was 8 MRs (iids 376-383; 379 = last main merge before onset, "Adding compartments"; 380/381/383 modify `stylesIndex.json`/`stylesStiboIndex.json`).
- `gitlab_get_repository_tree {project_id:"43242609", path:"src/main/java/pvh/services/styles/config"}` -> 6 files; and `{path:"src/main/resources", recursive:true}` -> 19 entries incl. `couchbase/stylesIndex.json`.
- `gitlab_get_file_content` on `CouchbaseConfig.java` and `src/main/resources/application.properties` (ref main) -> NO timeout/2500 anywhere (SDK default confirmed). Response is a JSON file object with decoded `content`.
- `gitlab_get_blame` on CouchbaseConfig.java -> 23 ranges, newest commit `3d808419` (2024-03-05).
- `gitlab_list_commits {path:<same file>, per_page:10}` -> 6 commits (2023-09..2024-03).
- `gitlab_get_commit_diff {sha:"3d808419"}` (short SHA accepted) -> 2-file diff.
- Error branch: `gitlab_get_file_content` on `does/not/exist/NoSuchFile.java` -> `isError` + `{"_error":{"kind":"not-found","statusCode":404}}`.

Phase 2b -- MR 379 deep-dive (proxy reads): `gitlab_get_merge_request {id:"43242609", merge_request_iid:379}` (merge SHA 8ae6c79f, release/AMS-Support-team -> main, 2026-07-28T14:46Z), `_commits` (2 cherry-picks), `_diffs` (Product.java, ProductDto.java, OptionResponse.java, CHANGELOG -- overlaps the failing PRODUCT_* read path), `_pipelines` (2712388222 + 2712377388, both success), `_notes` (GraphQL envelope, 3 notes), `_conflicts` (QUIRK: `isError:true` with "Merge request does not have conflicts" -- benign), `gitlab_get_pipeline_jobs {pipeline_id:2712388222}` (6 jobs, all success), `gitlab_get_job_log {job_id:<integration-test>}` (~418KB, Couchbase Testcontainers, "Job succeeded").

Phase 2c -- issues/work items/wiki: `gitlab_search {scope:"issues"}` finds things ONLY with vocabulary present in the issue text -- "Neutralization" hits, "couchbase timeout" does not (the project's only issue is SAST finding iid 1, `confidential:true`, still visible to this PAT). `gitlab_get_issue {issue_iid:1}` -> "Improper Output Neutralization for Logs". `gitlab_get_work_item_types` -> Epic/Incident/Issue/Task/Ticket. `gitlab_get_workitem_notes {work_item_iid:1}` -> empty envelope count 0. `gitlab_get_saved_view_work_items` -> ENV-LIMITED (needs a real `WorkItemsSavedViewsSavedViewID`). `gitlab_list_wiki_pages` -> 0 pages.

Phase 3 -- Orbit billed singles (4 queries):
- `gitlab_recent_deploys {since:"2026-07-23T00:00:00Z", project_path:"pvhcorp/b2b/shared-services/pvh.services.styles", limit:50}` -> nodes/edges envelope, row_count 8, same 8 MRs as REST (control probe).
- `gitlab_pipeline_failures {since:..., project_path:...}` -> aggregation envelope (rows/columns), row_count 0 (clean CI -- consistent, not a bug).
- `gitlab_recent_vulnerabilities {group_path:"pvhcorp"}` -> 0 rows (Vulnerability entities unpopulated for pvhcorp -- ENV-DATA-EMPTY).
- `gitlab_cross_project_callers {fqn:"pvh.services.styles.controller.StyleController.getStyleByStyleCode"}` -> 0 rows EXPECTED (IMPORTS blind to Java REST coupling; no fallback on this tool).

Phase 4 -- blast radius (THE SIO-1318 regression check, 2-5 billed):
- `gitlab_blast_radius {symbol:"getStyleByStyleCode", limit:50}` -> MUST now return `radiusMode:"definition-name-match"`, 4 Definition nodes (`StyleController.java`, `com/pvh/listsapi/rest_client/StylesAPIRestClient.java`, `services/styles/contracts/getStyleByStyleCode.ts`, `tests/styles/getStyleByStyleCode.spec.ts`) and `mrByFile` stitched (was: MR 355 -> StyleController.java 2026-03-25, MR 352 -> StylesAPIRestClient.java 2026-05-26, MR 11 -> the TS contract). Empty payload or missing radiusMode = REGRESSION of SIO-1318 (or the server predates `e5d08a3e` -- check boot log first).

Phase 5 -- raw DSL: unselective probe (`nodes` without `filters`) -> local `bad-query` rejection, UNBILLED; selective probe `{"query_type":"traversal","nodes":[{"id":"d","entity":"Definition","columns":["fqn","file_path","name"],"filters":{"name":{"token_match":"GlobalExceptionHandler"}}}],"limit":20}` -> rows incl. `pvh.services.styles.exception.GlobalExceptionHandler`. Max 5 attempts per question; ground shapes in the Phase 0 schema.

Phase 6 -- writes: SKIPPED-POLICY (create_issue, create_merge_request, create_merge_request_note, create_workitem_note, link_work_items, attach_scan_profile, manage_pipeline) -- never invoke against pvhcorp; schema presence via tools/list only.

## Verification (run before claiming anything)

```bash
bun run typecheck && bun run lint && bun run --filter '@devops-agent/mcp-server-gitlab' test
```
Expected: clean, 115+ tests pass (incl. the "SIO-1318 traversal nodes/edges" describe blocks). Extractor: `cd packages/agent && bun test src/correlation/extractors/orbit.test.ts` -> 16 pass. Manual probes: the tools/list curl (37) and the Phase 4 blast_radius call.

## Incident read-out from the 2026-07-31 run (for comparison)

Not a client-config regression (no timeout override; config untouched since 2024-03). Deploy window is busy: MR 379 (Jul 28 -> main) changed Product model/DTOs on the failing PRODUCT_* read path; MRs 376-383 churned the Couchbase FTS index definitions (381 removed `default_analyzer`); CI fully green. Downstream impact: `getStyleByStyleCode` -> `listsapi` `StylesAPIRestClient` + TS contract. Net: points at Capella cluster-side latency during index churn -> next hop is capella-agent metrics, outside GitLab scope.

## Gotchas

- Session stdio MCP instances run the code loaded at spawn -- a restarted :9084 does NOT refresh them, and they don't test :9084. Curl only.
- `gitlab_list_merge_requests` requires NUMERIC project_id (int); the other 5 code-analysis tools take numeric-as-string; URL-encoded paths 404.
- blast_radius can consume up to 5 budget units in one call (primary + fallback + up to 3 mrByFile enrich); isolate it from the other billed calls.
- Orbit availability self-heals per-call (SIO-1295) -- a `no-index` right after a healthy boot deserves one retry, not a bug report.
- The `--hot` dev server on main hot-reloads source on git pull, but bun --hot does not re-resolve node_modules; restart after dependency changes.
- Expected-empty results are classifications, not failures: labels 0, wiki 0, vulnerabilities 0, pipeline_failures 0, cross_project_callers 0.

## Out of scope (known residue, do NOT fold into a replay)

- Steering gaps from the audit (report section "Steering audit"): `gitlab_get_merge_request_notes` steered nowhere; GitLab-issue prior-art unsteered (Jira owns incident history); `gitlab_list_wiki_pages` in NO action group (unreachable by the agent).
- SIO-1302 (mandatory selection of the code-change-correlation runbook) still open; SIO-1300 (Orbit tools not in TYPED_FINDING_TOOLS, 65536-byte persist cap) still open.
- PR #555's stale `reviewDecision: CHANGES_REQUESTED` is round-1's verdict with all comments fixed/resolved; the PR is merged.

## Memory references

`reference_sio1318_orbitrows_traversal_shape_bug`, `reference_session_gitlab_mcp_is_stdio_not_9084`, `reference_orbit_aggregation_grammar_v0911`, `reference_orbit_steering_audit_and_replay`, `reference_sio1295_orbit_gate_migrating_and_recheck`, `reference_gitlab_internal_vs_public` (numeric-id rule), `reference_gh_api_jq_no_arg_flag` (CodeRabbit SHA check).
