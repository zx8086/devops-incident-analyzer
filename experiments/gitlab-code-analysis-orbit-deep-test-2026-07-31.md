# GitLab MCP 37-tool live deep test -- 2026-07-31

Ticket: https://linear.app/siobytes/issue/SIO-1316 (log-parity fix + this test). Defect found: https://linear.app/siobytes/issue/SIO-1318.

- Target: user's dev server `http://localhost:9084/mcp` (HTTP stateless, gitlab.com, booted 2026-07-31 19:43 local, `orbitAvailable: true`). All calls via curl `tools/call` with SSE-stripped parsing; the session's stdio MCP instances were NOT used.
- Incident basis: `pvh-services-styles-v3` production `com.couchbase.client.core.error.UnambiguousTimeoutException` -- KV GetRequest TIMEOUT, `timeoutMs=2500`, bucket `default`, scope `styles`, collection `product2g`, doc `PRODUCT_2027WISPSP_LV04F3853G`, Capella `private-endpoint.mn1uxqblvorb0cle.cloud.couchbase.com:11213`, surfaced by `pvh.services.styles.exception.GlobalExceptionHandler`, 2026-07-30 ~16:40 (Kibana display TZ).
- Scope decisions (user-confirmed): 30 read-only tools tested live; 7 write tools SKIPPED-POLICY (no mutation of pvhcorp projects); results to this report.
- Billed Orbit queries consumed: 7 (estimate was 10-12; cap 20 per rolling 60s never approached).
- Orbit baseline: `/orbit` schema_version 0.1, 32 node types, 8 domains (ci, code_review, container_registry, core, packages, plan, security, source_code); GitLab MCP backend version `19.3.0-pre`.

## Tool inventory (tools/list: 37 = 24 proxy + 6 code-analysis + 7 orbit)

Confirmed all 13 code-analysis/orbit names present in `tools/list` -- they were always registered; the startup log simply never listed them (only counts). Fixed in SIO-1316: `registerCodeAnalysisTools` and `registerOrbitTools` now emit "Code analysis tools registered" / "Orbit tools registered" with name arrays, mirroring "Proxy tools registered". Verified on a throwaway :9284 instance (killed after; port confirmed free).

## Results matrix

Classification per docs/runbooks/mcp-tool-audit-runbook.md.

### Code-analysis (6/6 live PASS)

| Tool | Args (incident-grounded) | Outcome | Class |
|---|---|---|---|
| gitlab_list_merge_requests | project 43242609, merged, updated_after 2026-07-23 | 8 MRs (376-383), all incident-window relevant | PASS |
| gitlab_get_repository_tree | config dir; resources recursive | 6 config classes; 19 resource files incl. `couchbase/stylesIndex.json`, `stylesStiboIndex.json` | PASS |
| gitlab_get_file_content | CouchbaseConfig.java, application.properties (main) | Decoded content; NO timeout override anywhere | PASS |
| gitlab_get_blame | CouchbaseConfig.java | 23 ranges, newest commit 3d808419 (2024-03-05) | PASS |
| gitlab_list_commits | path=CouchbaseConfig.java | 6 commits (2023-09 to 2024-03), path filter works | PASS |
| gitlab_get_commit_diff | sha 3d808419 (short SHA accepted) | 2-file diff | PASS |
| gitlab_get_file_content (error branch) | nonexistent path | `isError` + `_error.kind: "not-found"`, statusCode 404 | PASS |

### Orbit (7 tools; 1 TOOL-BUG)

| Tool | Args | Outcome | Class |
|---|---|---|---|
| gitlab_graph_schema | {} | 28.6KB ontology, 32 nodes/8 domains; FREE | PASS |
| gitlab_recent_deploys | since 2026-07-23, project_path styles | 8 MR nodes + IN_PROJECT edges; exactly matches REST list_merge_requests (two-path control probe) | PASS |
| gitlab_pipeline_failures | since 2026-07-24, project_path styles | 0 aggregation rows -- consistent with all-green pipelines seen via REST | PASS-behavioral |
| gitlab_recent_vulnerabilities | group pvhcorp | 0 rows (Vulnerability entities not populated for the group, despite a scanner-generated GitLab issue existing in the project) | ENV-DATA-EMPTY |
| gitlab_cross_project_callers | fqn StyleController.getStyleByStyleCode | 0 rows -- expected: IMPORTS-join blind to Java REST coupling (SIO-1303 precedent; no fallback on this tool) | PASS-behavioral |
| gitlab_blast_radius | symbol getStyleByStyleCode | row_count 0, no radiusMode, mrByFile {} -- but the identical fallback DSL via raw query returns 4 Definitions. `orbitRows()` reads `result.rows`; live traversal responses use `result.nodes` -> fallback always fires (extra billed query per call) and is always discarded; mrByFile enrichment dead | **TOOL-BUG -> SIO-1318** |
| gitlab_orbit_query_graph | selective Definition token_match; unselective probe | Selective: 4 Definition nodes (the SIO-1303 ground truth). Unselective: local `bad-query` rejection with guidance, unbilled | PASS |

### Proxy reads (17 live)

| Tool | Outcome | Class |
|---|---|---|
| gitlab_get_mcp_server_version | "19.3.0-pre" | PASS |
| gitlab_search (projects) | resolved 43242609 `pvhcorp/b2b/shared-services/pvh.services.styles` (+ sibling `pvh.couchbase.eventing.styles`) | PASS |
| gitlab_search (issues) | 0 hits project+group -- yet issue iid 1 exists; issues search index does not surface scanner-created issues | PASS-behavioral (quirk noted) |
| gitlab_semantic_code_search | "couchbase kv get timeout configuration" -> CouchbaseConfig.java 0.82 top hit | PASS |
| gitlab_search_labels | 0 labels in project | ENV-DATA-EMPTY |
| gitlab_get_merge_request | MR 379 full detail (merge SHA 8ae6c79f) | PASS |
| gitlab_get_merge_request_commits | 2 cherry-pick commits | PASS |
| gitlab_get_merge_request_diffs | 4 files (Product.java, ProductDto.java, OptionResponse.java, CHANGELOG) | PASS |
| gitlab_get_merge_request_pipelines | 2 pipelines, both success | PASS |
| gitlab_get_merge_request_notes | GraphQL envelope, 3 notes | PASS |
| gitlab_get_merge_request_conflicts | `isError: true` + "Merge request does not have conflicts" for the benign no-conflict state | PASS-behavioral (upstream quirk: error-flagged happy path) |
| gitlab_get_pipeline_jobs | 6 jobs of pipeline 2712388222 (setup/build/test/Scan) | PASS |
| gitlab_get_job_log | integration-test job: 418KB log, Couchbase Testcontainers, "Job succeeded" | PASS |
| gitlab_get_issue | iid 1: "Improper Output Neutralization for Logs" (security scanner issue) | PASS |
| gitlab_get_work_item_types | Epic, Incident, Issue, Task, Ticket | PASS |
| gitlab_get_workitem_notes | clean empty envelope (count 0) | PASS |
| gitlab_get_saved_view_work_items | GraphQL id-type validation error (no saved views exist to us) | ENV-LIMITED |
| gitlab_list_wiki_pages | 0 pages | ENV-DATA-EMPTY |

### Writes (7, SKIPPED-POLICY)

gitlab_create_issue, gitlab_create_merge_request, gitlab_create_merge_request_note, gitlab_create_workitem_note, gitlab_link_work_items, gitlab_attach_scan_profile, gitlab_manage_pipeline: registered with well-formed inputSchemas in tools/list; not invoked (would mutate real pvhcorp projects). `throttled` Orbit envelope likewise verified by code inspection only (forcing it burns 15+ billed queries).

## Findings

1. **TOOL-BUG (SIO-1318, High)**: `orbitRows()` traversal-shape mismatch guts `gitlab_blast_radius` -- fallback always fires (wasted billed query per call), its rows are always discarded, `radiusMode` and `mrByFile` are dead. Incident pipeline gets an empty Orbit blast radius on every run. The prior replay's "0-row radius is the tool model" conclusion is corrected by this: the data is in the index; the handler drops it.
2. Upstream quirk: `gitlab_get_merge_request_conflicts` reports `isError: true` for the benign "no conflicts" state -- consumers should not treat that error flag as a failure.
3. Search-index quirk: `gitlab_search scope=issues` does not surface the project's scanner-created issue (iid 1) that `gitlab_get_issue` returns directly.
4. Orbit `Vulnerability` entities are unpopulated for `pvhcorp` even where scanner findings exist as issues -- `gitlab_recent_vulnerabilities` is ENV-DATA-EMPTY for this estate, not broken.

## Incident read-out (what the tools showed for styles-v3)

- `timeoutMs=2500` is the Couchbase SDK default kvTimeout: `CouchbaseConfig.java` (last touched 2024-03) and `application.properties` set NO timeout override. Not a client-config regression.
- Deploy window: MR 379 merged to main 2026-07-28 14:46Z changed the Product model/DTOs (`Product.java`, `ProductDto.java`, `OptionResponse.java`) -- correlates with the failing `PRODUCT_*` KV read path. MRs 376-383 (Jul 23-30) repeatedly modified Couchbase FTS index definitions (`stylesIndex.json`, `stylesStiboIndex.json`; MR 381 removed `default_analyzer`) -- index-definition churn on the same cluster through the incident window; MR 383 hit main 18:17Z on incident day.
- CI is green (all pipelines success; 0 failed MR-event pipelines since Jul 24) -- no deploy failure signal.
- Downstream impact (via the raw-query workaround for SIO-1318): `StyleController.getStyleByStyleCode` -> contract `services/styles/contracts/getStyleByStyleCode.ts` + cross-service consumer `com/pvh/listsapi/rest_client/StylesAPIRestClient.java` (listsapi service).
- Net: GitLab evidence points away from client config and toward cluster-side latency during FTS index churn; next step is Capella-side metrics (capella-agent), outside GitLab scope.

## Which GitLab MCP tools would the incident pipeline use for this incident

All 7 Orbit tools are force-bound on every incident gitlab invocation (`RESOLUTION_TOOLS_BY_DATASOURCE` + skill-promised names) independent of action selection. Binding the full 13-tool code-analysis+orbit surface via actions requires: `code_analysis` + `merge_requests` + `graph_analysis` + `pipelines` + `search` (per `agents/incident-analyzer/tools/gitlab-api.yaml`).

| Investigation question | Tool(s) | Action group |
|---|---|---|
| What shipped recently? | gitlab_list_merge_requests, gitlab_recent_deploys | merge_requests, search |
| Where is the Couchbase/timeout config? | gitlab_get_repository_tree, gitlab_semantic_code_search | code_analysis, search |
| What does it say now? | gitlab_get_file_content | code_analysis |
| Who/when last changed it? | gitlab_get_blame, gitlab_list_commits | code_analysis |
| What exactly changed? | gitlab_get_commit_diff | code_analysis |
| Pipeline health implicated? | gitlab_pipeline_failures, gitlab_get_pipeline_jobs, gitlab_get_job_log | pipelines |
| Which MR is the culprit -- detail/diffs/pipelines/review context? | gitlab_get_merge_request, _commits, _diffs, _pipelines, _notes, _conflicts | merge_requests |
| Downstream impact of the stack-trace symbols? | gitlab_blast_radius (blocked by SIO-1318 today; raw query workaround) | graph_analysis |
| Cross-project callers of the exact fqn? | gitlab_cross_project_callers | graph_analysis |
| Known vulns in play? | gitlab_recent_vulnerabilities | graph_analysis |
| Ad-hoc graph question? | gitlab_orbit_query_graph grounded by gitlab_graph_schema | graph_analysis |
| Is this already tracked / prior art? | gitlab_search (issues), gitlab_get_issue, gitlab_get_work_item_types, gitlab_get_workitem_notes | issues / work items |
| Runbook/docs in the wiki? | gitlab_list_wiki_pages | wikis |

## Cleanup

- User's :9084 server (bun PID 14002): untouched, still listening.
- Throwaway :9284 verification instance: killed by tracked PID; `lsof -nP -iTCP:9284 -sTCP:LISTEN` empty.
- No write/mutating GitLab tool invoked; scratch SSE captures live in the session scratchpad only.
