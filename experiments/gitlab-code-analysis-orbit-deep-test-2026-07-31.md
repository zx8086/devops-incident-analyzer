# GitLab MCP 37-tool live deep test -- 2026-07-31

Ticket: https://linear.app/siobytes/issue/SIO-1316 (log-parity fix + this test). Defect found AND fixed in this branch: https://linear.app/siobytes/issue/SIO-1318 (orbitRows traversal-shape bug; see Findings).

Counting convention: totals count UNIQUE TOOLS (37 = 24 proxy + 6 code-analysis + 7 orbit; 30 live-tested, 7 skipped). Matrix rows describe the calls made per tool -- several tools were invoked more than once (repeated probes and error branches are labeled in their rows), so invocation count exceeds tool count.

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
| gitlab_blast_radius | symbol getStyleByStyleCode | Initially: row_count 0, no radiusMode, mrByFile {} -- but the identical fallback DSL via raw query returned 4 Definitions. `orbitRows()` read `result.rows`; live traversal responses use `result.nodes` -> fallback always fired (extra billed query per call) and was always discarded; mrByFile enrichment dead. FIXED in this branch and re-proven live on a worktree instance: radiusMode `definition-name-match`, all 4 Definitions, mrByFile stitched (MR 355 -> StyleController.java 2026-03-25, MR 352 -> StylesAPIRestClient.java 2026-05-26, MR 11 -> getStyleByStyleCode.ts contract) | **TOOL-BUG -> SIO-1318, fixed + live-verified** |
| gitlab_orbit_query_graph | selective Definition token_match; unselective probe | Selective: 4 Definition nodes (the SIO-1303 ground truth). Unselective: local `bad-query` rejection with guidance, unbilled | PASS |

### Proxy reads (17 live)

| Tool | Outcome | Class |
|---|---|---|
| gitlab_get_mcp_server_version | "19.3.0-pre" | PASS |
| gitlab_search (projects) | resolved 43242609 `pvhcorp/b2b/shared-services/pvh.services.styles` (+ sibling `pvh.couchbase.eventing.styles`) | PASS |
| gitlab_search (issues) | Initial probes ("couchbase timeout", "style", "timeout") hit 0 -- but a follow-up probe with a term actually present in the issue ("Neutralization") returns iid 1, even without `confidential: true`. The 0-hits were TERM MISMATCHES (the project's only issue is a SAST finding whose text shares no vocabulary with the incident), not an index gap. Initial "quirk" classification RETRACTED | PASS (earlier quirk retracted) |
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

1. **TOOL-BUG, FIXED (SIO-1318, High)**: `orbitRows()` read only the aggregation `result.rows` shape while live Orbit v0.91.x traversal responses carry `result.nodes`/`result.edges` -- the SIO-1303 fallback always fired (wasted billed query per call), its rows were always discarded, and `radiusMode`/`mrByFile` were dead. The regression matches the Orbit 0.86 -> 0.91.1 platform migration of Jul 29-30 (the pre-0.91 traversal shape WAS alias-keyed rows, which is what the code and its fixtures modeled). Fixed two layers in this branch: the tool handler (`packages/mcp-server-gitlab/src/tools/orbit/index.ts` -- dual-shape row detection, nodes-aware `distinctDefFiles`/`firstMrRow`) and the incident-pipeline extractor (`packages/agent/src/correlation/extractors/orbit.ts` -- `rowsFromNodes()` rebuilds alias rows from nodes/edges for blast radius, callers, deploys, and vulnerabilities; without this, ALL traversal-based orbitFindings were empty in incident runs, not just blast radius). Live re-verified end-to-end on a worktree instance: radiusMode + 4 Definitions + mrByFile stitched. Fixtures updated to the live shape (legacy rows shape still covered for back-compat).
2. Upstream quirk: `gitlab_get_merge_request_conflicts` reports `isError: true` for the benign "no conflicts" state -- consumers should not treat that error flag as a failure.
3. RETRACTED: the earlier "issues search index does not surface scanner-created issues" claim was wrong. Follow-up probes show `gitlab_search scope=issues` finds issue iid 1 fine when the search term actually occurs in the issue ("Neutralization"); the original 0-hit probes used incident vocabulary absent from the issue text. Practical caveat that stands: prior-art searches must use error-class vocabulary, and the issue being `confidential: true` did not hide it from this PAT.
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
| Which MR is the culprit -- detail/diffs/pipelines/review context? | gitlab_get_merge_request, gitlab_get_merge_request_commits, gitlab_get_merge_request_diffs, gitlab_get_merge_request_pipelines, gitlab_get_merge_request_notes, gitlab_get_merge_request_conflicts | merge_requests |
| Downstream impact of the stack-trace symbols? | gitlab_blast_radius (SIO-1318 fixed in this branch; was broken at test time) | graph_analysis |
| Cross-project callers of the exact fqn? | gitlab_cross_project_callers | graph_analysis |
| Known vulns in play? | gitlab_recent_vulnerabilities | graph_analysis |
| Ad-hoc graph question? | gitlab_orbit_query_graph grounded by gitlab_graph_schema | graph_analysis |
| Is this already tracked / prior art? | gitlab_search (issues), gitlab_get_issue, gitlab_get_workitem_notes, gitlab_get_saved_view_work_items | issues (gitlab_get_work_item_types is deliberately unmapped: creation-flow metadata) |
| Runbook/docs in the wiki? | gitlab_list_wiki_pages | NONE -- in no action group; unreachable by the agent (see steering audit) |

## Steering audit: does the agent actually ask these investigation questions?

The mapping table above is close to an "ideal runbook" -- so this section compares it against what the gitlab-agent is ACTUALLY steered to do. Sources: `agents/incident-analyzer/agents/gitlab-agent/SOUL.md` (triage priority + never-guess-path rule), its 3 skills (`project-resolution`, `code-search-selection`, `code-change-correlation`), the aggregator-side runbook `agents/incident-analyzer/knowledge/runbooks/code-change-correlation.md`, and `agents/incident-analyzer/tools/gitlab-api.yaml` (action map). Reminder of the SIO-1293 split: the SKILLS drive the sub-agent's in-flight tool calls; the RUNBOOK body reaches the aggregator only.

Verdict: 11 of the 13 investigation questions ARE encoded in current steering, several with stronger discipline than the table (staged 24h -> 90d window widening per SIO-1298/1304, empty-blast-radius mandatory retry, the 3-leg confirmation rule -- code link + shipped deploy + onset-after-deploy -- and escalation criteria). Question-by-question:

| Question | Steered? | Where |
|---|---|---|
| What shipped recently? | YES | SOUL triage 1-2; skill chain step 1; runbook Step 3 (staged window) + Step 4 |
| Where is the config? | YES | SOUL triage 3 + "never guess a file path"; code-search-selection; runbook Per-Project Fallback |
| What does it say now? | YES | runbook fallback (gitlab_get_file_content after discovery) |
| Who/when last changed it? | YES | runbook fallback (gitlab_get_blame, gitlab_list_commits since/until) |
| What exactly changed? | YES | skill step 2 + runbook Step 4.3, which EXPLICITLY says to look for "modified timeouts or connection settings" -- precisely the styles-v3 question |
| Pipeline health? | YES | skill step 3 (jobs -> max 2 job logs); runbook Step 3 (group ranking) |
| Culprit MR chain? | PARTIAL | gitlab_get_merge_request/_diffs/_pipelines steered (skill step 2); _commits/_notes/_conflicts are action-mapped but NO skill/runbook step uses them -- review context (notes) is an unused evidence source |
| Blast radius? | YES | runbook Step 2 + skill blast-radius workflow (retry-once, semantic fallback) -- and SIO-1318 (fixed here) was silently defeating this exact step in production |
| Cross-project callers? | YES | runbook Step 2.3 (fqn from a prior row only) |
| Vulns? | YES | runbook Step 3 (when the error pattern suggests exploitation) |
| Ad-hoc graph? | YES | runbook raw-query reference (grammar constraints + 5-attempt budget) |
| Prior art in GitLab issues? | NO | the `issues` action exists but no skill/runbook step says to search GitLab issues for prior incidents. Defensible: pvhcorp tracks incidents in Jira, and the atlassian-agent owns prior-incident lookup (findLinkedIncidents/getIncidentHistory). Gap is real only for scanner-created GitLab issues (like styles iid 1) |
| Wiki runbooks? | NO -- UNREACHABLE | gitlab_list_wiki_pages is in NO action group, so composeBoundTools never binds it regardless of steering. Low value for this estate (styles wiki live-verified empty); adding it would need both an action mapping and a steering line |

Deliberately unmapped (by design, commented in gitlab-api.yaml): the 6 write tools + gitlab_manage_pipeline (read-only investigator; tickets go through the atlassian create-ticket tool), gitlab_get_mcp_server_version (diagnostic), gitlab_get_work_item_types (creation-flow metadata).

Prior live-replay proof (2026-07-30 audit) already showed the pipeline follows this steering organically: the gitlab sub-agent called gitlab_blast_radius x3 with correct stack-trace anchors, gitlab_graph_schema, gitlab_recent_deploys, gitlab_pipeline_failures plus 24 REST calls on a styles-v3-shaped incident. The steering was working; SIO-1318 was starving it of results.

Actionable residue (not done in this branch): (1) a one-line skill addition steering gitlab_get_merge_request_notes for the strongest culprit MR (review context as evidence); (2) decide whether GitLab-issue prior-art search deserves a steering line given Jira is the tracker; (3) wiki tools stay unmapped unless a wiki-using estate appears; (4) SIO-1302 (mandatory selection of the code-change-correlation runbook) remains open -- selection is still router discretion today.

## Cleanup

- User's :9084 server (bun PID 14002): untouched, still listening.
- Throwaway :9284 verification instance: killed by tracked PID; `lsof -nP -iTCP:9284 -sTCP:LISTEN` empty.
- No write/mutating GitLab tool invoked; scratch SSE captures live in the session scratchpad only.
