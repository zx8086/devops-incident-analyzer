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

## SIO-1322 verification: does SIO-1320's steering actually fire in a live pipeline run?

Ticket: https://linear.app/siobytes/issue/SIO-1322. Verifies https://linear.app/siobytes/issue/SIO-1320 (PR [#556](https://github.com/zx8086/devops-incident-analyzer/pull/556), merged `79b560c9`) against the "actionable residue" item 1 identified above -- a real pipeline run, not code inspection. Repo state: `main` @ `79b560c9`. Fresh :5174 web app (main checkout, `KNOWLEDGE_GRAPH_ENABLED=false LIVE_MEMORY_ENABLED=false AGENT_MEMORY_ENABLED=false`) so agent knowledge (skills/runbooks, cached per-process per [[reference_agent_knowledge_cached_per_process]]) reflects post-merge steering, not the user's possibly-stale :5173. `:9084` gitlab MCP preflighted first (`gitlab_blast_radius` returned `definition-name-match` -- post-`e5d08a3e` code confirmed).

Same incident prompt as the deep test above (styles-v3 Couchbase KV `UnambiguousTimeoutException`), `dataSources: ["gitlab"]`, run twice (fresh threadId each time -- the second run is the one allowed re-run for a soft miss, per the handover's scoring rule). Evidence: SSE `toolsUsed[]` + LangSmith child tool runs (`langsmith run get <id> --full` for arguments) on both trace ids.

| Run | threadId | traceId | responseTime | confidence |
|---|---|---|---|---|
| 1 | `4e3b2302-c4c6-4b03-8fca-9282d23f573d` | `019fb9a4-cc9d-741b-8af3-8782133cd8f7` | 195.0s | 0.45 |
| 2 (re-run) | `f3072e7c-ef83-409c-8de3-b63e7b4b96eb` | `019fb9a9-c6fe-7469-b7d5-536f528b70b5` | 197.3s | 0.45 |

### Pass criteria verdicts

| # | Behavior | Run 1 evidence | Run 2 evidence | Verdict |
|---|---|---|---|---|
| 1 | Review-notes step (SKILL step 4) | `gitlab_get_merge_request_notes`: 0 calls in trace | 0 calls in trace | **FAIL** -- never fires in either run |
| 2 | Prior-art check (SKILL new section) | 4x `gitlab_search`, all `scope:"projects"` (`pvh-services-styles-v3`, `styles`, `pvh.services.styles`) -- zero `scope:"issues"` calls | 4x `gitlab_search`, all `scope:"projects"` (`styles-v3`, `pvh.services.styles`, `styles`) -- zero `scope:"issues"` calls | **FAIL** -- the tool searches only resolve the project itself, never an issues prior-art query |
| 3 | Blast radius through the pipeline (SIO-1318) | `gitlab_blast_radius symbol:"GlobalExceptionHandler"` -- generic class name matching 8+ unrelated services; `radiusMode:"definition-name-match"` present (SIO-1318 plumbing itself works) but `listsapi`/`StylesAPIRestClient`/`StyleController` absent from output and absent from final findings | Same: `symbol:"GlobalExceptionHandler"`, same generic-symbol miss | **FAIL as specified** -- SIO-1318's fix (nodes-shape parsing, `radiusMode` populated) is proven working, but the agent never queries the ground-truth symbol `getStyleByStyleCode`, so the correct blast radius never surfaces |
| 4 | Runbook checklist reaches the aggregator | Server log: `Runbook selection complete ... always_select:"code-change-correlation.md" ... runbooks: 2` (mitigation-merge log) | (not independently re-checked; `always_select` is unconditional) | **PASS** -- `code-change-correlation.md` ships via `always_select` regardless of LLM discretion; file confirmed on disk to contain "Investigation Question Checklist" (`agents/incident-analyzer/knowledge/runbooks/code-change-correlation.md:49`) |

### Analysis

Criteria 1-3 are consistent misses across both the original run and the one allowed re-run -- not LLM noise, a structural gap. Root cause read from the evidence, not asserted:

- **Criterion 1 (notes)**: the SKILL.md step-4 instruction exists (confirmed present in source per the handover's "what changed" section) but the sub-agent's tool-call sequence in both runs stops at `_diffs`/`_pipelines`/`_blame` for the candidate MRs and never reaches `_notes`. Matches the pre-SIO-1320 gap the deep-test steering audit already flagged ("_commits/_notes/_conflicts are action-mapped but no skill/runbook step uses them") -- the new skill language did not change observed sub-agent behavior in this incident shape.
- **Criterion 2 (prior-art)**: the agent DOES call `gitlab_search`, but exclusively `scope:"projects"` to resolve `pvh.services.styles` from the service name -- a different, pre-existing behavior (project resolution, per `project-resolution` skill), not the new conditional issues-scope prior-art check. Zero `scope:"issues"` calls in either trace means the new section's trigger condition ("only when the error class is distinctive") was never judged as met, or the step is not being reached at all.
- **Criterion 3 (blast radius)**: this is a step-order/anchor-selection issue, not a SIO-1318 regression -- SIO-1318's own fix is proven live (`radiusMode:"definition-name-match"` populated in both runs, matching the deep-test's fixed-tool proof above). But the agent anchors blast-radius on `GlobalExceptionHandler` (the exception handler class named in the incident's `surfaced by` line) rather than the actual business-logic entry point `getStyleByStyleCode` used in the deep test's ground truth. `GlobalExceptionHandler` is a common name reused by 8+ unrelated pvhcorp services, so the traversal returns noise instead of the styles-specific `listsapi`/`StylesAPIRestClient` chain.

### Scoring vs. the handover's rule

Handover: "1-3 are the SIO-1320/1318 verdicts... a soft miss earns EXACTLY ONE re-run (fresh threadId) before classifying as a steering defect." One re-run was performed for all three; all three reproduced identically. Per that rule: **criteria 1 and 2 are steering defects** (the SIO-1320 SKILL additions are not organically firing); **criterion 3 is a partial pass** -- the SIO-1318 tool-layer fix is proven correct and live-verified, but the pipeline's symbol-selection step (pre-existing, not part of SIO-1320) prevents it from producing useful output for this incident shape. Criterion 4 passes cleanly (structural guarantee via `always_select`, independent of LLM discretion).

### Recommendation (not actioned in this session -- read-only verification)

SIO-1320's SKILL.md additions are present in the file but did not observably change sub-agent tool-call behavior across 2 runs. Possible next steps for a follow-up ticket: (a) strengthen the step-4 notes instruction from advisory to a more directive trigger tied to a concrete condition (e.g. "after identifying the strongest candidate MR, call notes before writing findings"); (b) same for the prior-art check -- verify the "distinctive error class" trigger condition is being evaluated at all, e.g. by inspecting the sub-agent's reasoning/thinking trace, not just tool calls; (c) the blast-radius anchor-selection gap (criterion 3) is a separate, pre-existing steering question -- worth its own ticket scoped to "which symbol does the agent pick for blast radius" rather than folding it into SIO-1320/1318 scope.

### Cleanup (this section)

- :5174 web app (tracked PID 37327, child bun/node PID 37328): killed after both runs; `lsof -nP -iTCP:5174 -sTCP:LISTEN` empty.
- User's :5173 and :9084: untouched.
- Billed Orbit queries: 1 preflight + 1 blast_radius per run (2 runs) = ~3 total, well under the 20/60s cap.
- No write/mutating GitLab tool invoked.

## SIO-1322 follow-up: root-cause + fix for criteria 1 and 2

Findings 1 and 2 above are real steering defects, not acceptable LLM noise -- 0/2 reproductions each. Investigated root cause and applied targeted fixes in this same worktree/branch (`claude/sio-1322-steering-verification-a4479b`), staying within SIO-1320/1322 scope (did not touch the shared step-3 job-logs pattern, which has the identical bug but is out of scope here).

### Root cause 1: notes-step and job-logs-step were coupled under one ambiguous gate

`SKILL.md` step 3 (job logs) and step 4 (notes) both hung off "for the STRONGEST candidate ... (changed files overlap incident surface, or its pipeline is failing)". In this incident all pipelines were green (`gitlab_pipeline_failures`: 0 rows), so the "pipeline is failing" branch was false, and the model appears to have treated the entire steps-3-and-4 block as conditionally skippable rather than explicitly picking a strongest candidate by the "changed files overlap" branch and continuing into step 4 independently. By contrast, the Blast Radius section (proven reliable across every run, this doc's earlier deep test included) is a flat, unconditional imperative with no upstream judgment call to silently skip.

Fix: split step 3 and step 4 into independent checkpoints. Step 3 (job logs) is now explicitly gated on "pipeline is failing" only and instructed to skip outright otherwise. Step 4 (notes) is now the direct continuation of "pick the strongest candidate" -- unconditional once a candidate is picked, explicitly run "even if the pipeline is green." Same restructuring applied to the runbook's Step 4 item 4 for consistency (aggregator-side checklist, not sub-agent-facing, but should not contradict the skill).

### Root cause 2 (bonus find): `scope: "issues"` is not a valid `gitlab_search` scope value

While investigating criterion 2, direct inspection of the live `gitlab_search` tool schema (`curl .../mcp tools/list`, `:9084`) showed the tool's actual `scope` enum is `projects, blobs, work_items, merge_requests, wiki_blobs, commits, notes, milestones, users` -- there is no `"issues"` value. GitLab issues/tasks/epics/incidents are unified under the `work_items` entity (the runbook's own Orbit section already documented this fact for `gitlab_orbit_query_graph`, just not for `gitlab_search`). `git log -p` confirms `scope issues` was in the SKILL.md text as merged by SIO-1320 (`79b560c9`) -- this is a genuine documentation bug in the merged work, not something introduced by this session's rewrite. The model could never have satisfied the SKILL.md's literal instruction as written.

Fix: replaced `scope issues` with `scope: "work_items"` in both the SKILL.md prior-art section and the runbook checklist line.

### Post-fix replay evidence (3 additional runs, fresh threadId each)

| Run | threadId | `gitlab_get_merge_request_notes` | `gitlab_search scope:"work_items"` |
|---|---|---|---|
| fix1 (notes-restructure only, scope still said `issues`) | `66ca3121-9e55-4313-8ed3-3e20ff5bc794` | NOT called | 1 call used `scope:"work_items"` (model self-corrected against the tool's real schema, ignoring the SKILL.md's invalid `issues` text) -- `search:"UnambiguousTimeoutException styles"` |
| fix2 (both fixes applied) | `0ad8b1d2-af09-4976-a87a-501df074fdd8` | **CALLED** -- `gitlab_get_merge_request_notes(project_id:43242609, merge_request_iid:383)`, correctly the strongest candidate | NOT called (4x `scope:"projects"` only) |
| fix3 (both fixes applied, confirmation run) | `d80b20e2-bff3-4d0e-a3f5-769d6e324012` | **CALLED** again | NOT called (4x `scope:"projects"` only) |

### Final verdict per criterion

| # | Criterion | Pre-fix | Post-fix | Status |
|---|---|---|---|---|
| 1 | Review-notes step | 0/2 runs | **2/2 runs** (fix2, fix3) | **FIXED** -- the step-3/step-4 decoupling resolved it; reproduced twice |
| 2 | Prior-art check | 0/2 runs, and the instruction as written (`scope issues`) could never have succeeded | 0/2 runs with the corrected scope (fix2, fix3); 1 run (fix1) self-corrected to the right scope without the fix present, suggesting the model CAN discover `work_items` from the tool schema but doesn't reliably choose to run this check at all | **SCOPE BUG FIXED, TRIGGER STILL UNRELIABLE** -- the fix removes an impossible-to-satisfy instruction (real bug, worth keeping), but does not reliably make the model run the check. This incident's error class (`UnambiguousTimeoutException`, a Couchbase SDK exception, not a GitLab-specific or scanner-rule pattern) may simply read to the model as low-value to search for in GitLab issues -- a plausible, not confirmed, explanation for why "run it, do not reason about whether to" phrasing did not move the needle further |
| 3 | Blast radius (SIO-1318) | tool-layer proven, wrong symbol anchored | not retested (out of scope -- pre-existing symbol-selection question, not part of this fix) | unchanged: **PARTIAL**, separate ticket recommended |
| 4 | Runbook checklist reaches aggregator | PASS (structural) | unchanged (no code touched this criterion) | **PASS** |

Per the user's explicit guidance during this session: steering should not become a strict/mandatory rule if the underlying behavior would not actually be helpful. Both instructions here remain conditional and cheap as designed (single-MR notes check, single zero-or-low-cost search) -- the fix targeted prompt clarity and a real schema bug, not converting either into an unconditional mandate.

### Recommendation for criterion 2

Criterion 2 is close to acceptable as a known probabilistic-steering limitation given: (a) the check is explicitly optional/cheap by design (zero hits is the normal, expected outcome), (b) one run demonstrated the model is CAPABLE of finding and using `scope:"work_items"` correctly once it decides to run the check, (c) forcing it unconditionally would contradict the "don't make cheap-but-not-always-helpful checks mandatory" principle. If this remains unsatisfying, a follow-up ticket could test whether keying the trigger to a more concrete condition (e.g. "the error type is a checked/named exception class, not a generic timeout/5xx") makes the check fire more reliably -- but that is genuine future work, not part of this fix.

### Verification run for this section

`bun run typecheck` (all packages, 0 errors) and `bun run lint` (16 pre-existing warnings in unrelated `mcp-server-kafka` test files, zero findings in the two edited files) both clean. `packages/gitagent-bridge` test suite (341 tests, includes the `skill-tool-coverage` budget canary): 341 pass, 0 fail -- the rewrite did not add new backticked tool names, so gitlab-agent's 17/17 prompt-name budget is untouched.

### Cleanup (this follow-up)

- :5174 web app across 3 restarts (tracked PIDs 42543/42545, then 43712/43717 after the scope-fix restart): all killed; `lsof -nP -iTCP:5174 -sTCP:LISTEN` empty.
- One process-tracking miss caught and corrected mid-session: a stray `bun run dev` (PID 41322/41325) from an earlier attempt was still listening on :5174 when a new instance was started, causing the new instance to silently fall back to :5175. Found via `ps`, killed by exact PID, verified both :5174 and :5175 free before restarting cleanly.
- User's :5173 and :9084: untouched throughout.
- No write/mutating GitLab tool invoked at any point.
