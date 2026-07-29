---
type: Runbook
title: "Code Change Correlation"
description: "Correlate an incident window with recent GitLab deploys and merge requests."
status: stable
tags: [gitlab, deploys, correlation]
generated:
  by: human:simon
  at: 2026-07-29
triggers:
  metrics:
    - deploy
    - release
    - stack_trace
    - commit
    - mr
  match: any
---
# Code Change Correlation

## Symptoms
- Incident timing correlates with a recent deployment
- Stack traces or error messages reference specific classes, methods, or file paths
- New error patterns appear that were not present before a recent merge
- Performance degradation after a CI/CD pipeline completed

## Preferred: Orbit blast-radius traversal (deterministic, cross-project)

When GitLab Orbit is enabled, the whole call chain below becomes a single
deterministic graph traversal instead of an 8-step per-project hunt. Prefer it
for the "which shared change broke which services" question -- it is the only
path that spans repositories.

1. Extract anchor symbols from the Elasticsearch logs (exception classes, method
   names) exactly as in step 1 below.
2. Call `gitlab_blast_radius(symbol: "<anchor>")` -- group-scoped, no project
   resolution needed. Orbit resolves the anchor to a `Definition` node and
   returns every downstream project/file that `IMPORTS` it across `pvhcorp`.
3. Read the result: `importedByProjects` is the deterministic set of affected
   services (not a `gitlab_search` guess). `sourceProject`/`sourceFile` is where
   the changed definition lives.
4. For group-wide deploy/failure context, use `gitlab_recent_deploys` and
   `gitlab_pipeline_failures` (both take a `since` timestamp) -- ranked across
   all projects.
5. Only drop to the per-project steps below when Orbit is disabled/indexing, the
   symbol is on a non-default branch, or the code is Terraform/YAML (Orbit
   indexes the default branch only and excludes HCL/YAML).

The rules engine consumes these findings automatically: a blast-radius result
plus a post-merge Elastic error spike in a downstream service fires
`orbit-deploy-blast-radius-vs-elastic`, grounding the root cause deterministically
rather than relying on the aggregator LLM to reconstruct it in prose.

For "who calls this definition across repos" use `gitlab_cross_project_callers`,
and for a group-wide security sweep use `gitlab_recent_vulnerabilities`.

Note: `gitlab_blast_radius` and the other billed Orbit tools consume GitLab
Credits. Call `gitlab_graph_schema` (free) first if you need to ground a raw
query; prefer the purpose-built tools over the raw `gitlab_orbit_query_graph`
escape hatch.

## Orbit raw query reference (gitlab_orbit_query_graph)

Only for questions the purpose-built tools above cannot express. Ground the
shape with `gitlab_graph_schema` (free) before spending credits on a raw query.

**Entities.** GitLab issues, epics, tasks and incidents are all the **WorkItem**
entity. There is no **Issue** node -- a query with entity "Issue" is rejected
outright, so a hunt for a linked incident or epic queries **WorkItem**.

**Traversal depth.** Relationship entries take **max_hops** (and optionally
**min_hops**): default 1, maximum 3. A one-hop default means an unset
**max_hops** answers "direct importers" and silently misses transitive ones --
set it explicitly when the question is "everything downstream".

**Path queries.** These are a different shape: **path_finding** requires a
**path** sub-object carrying **path.max_depth** (max 3). **max_hops** does not
apply to a path query. When the endpoints use filters, add **path.rel_types**
to bound fan-out; path queries follow edges only in their schema direction, so
an unexpectedly empty result is often a direction mismatch rather than absence.

**Diff edges.** Prefer **HAS_LATEST_DIFF** over **HAS_DIFF** when the question
is "what does this file look like now" -- **HAS_DIFF** spans every historical
revision and undercounts long-lived files when combined with a limit.

**Pipeline source.** Merge-request pipelines carry
**Pipeline.source = "merge_request_event"**. Parent/child pipeline structures
mean a naive count double-counts; filter on source when attributing a failure
to an MR.

**Iteration budget.** At most 5 query attempts per question. Changing only
**limit** or **columns** is not progress; changing the entity, a relationship
type or a filter is. HTTP 400 validation errors count. On exceeding 5, report
the shapes tried and what each failed on, then fall back to
`gitlab_semantic_code_search` + `gitlab_list_commits` -- an inflated partial
graph answer is worse than a stated gap.

## Investigation Steps (per-project fallback)

### 1. Extract Search Anchors from Logs
Before querying GitLab, extract searchable symbols from Elasticsearch logs and error messages:
- Exception class names (e.g. `NullPointerException`, `TimeoutException`)
- Method names from stack traces (e.g. `fetchOpenWindows`, `processDeliveryDates`)
- Endpoint or route paths (e.g. `/api/v1/delivery-dates`)
- Kafka topic names or Couchbase query references from error context

### 2. Semantic Code Search for Root Cause
Use `gitlab_semantic_code_search` with extracted symbols to find relevant source code by meaning, not just exact text. This finds code even when log messages don't match function names exactly.

Examples:
- Log shows `SettlementWindowRepository.fetchOpenWindows timeout` -> search "settlement window fetch open windows timeout"
- Log shows `DeliveryDateConsumer failed to process event` -> search "delivery date consumer event processing"
- Log shows `connection refused on port 5432` -> search "database connection configuration"

Semantic search returns scored results. Focus on scores above 0.75.

### 3. Trace the Call Chain
When semantic search identifies an exception handler or error handler:
- Use `gitlab_get_file_content` to read the full source file
- Use `gitlab_get_blame` to identify who last modified the relevant lines
- Look for callers of the failing method by searching for method name references

### 4. Identify Recent Code Changes
Use `gitlab_list_commits` filtered to the deployment time window (from Elasticsearch log timestamps):
- Filter by `since` and `until` matching the incident onset
- Filter by `path` if you know the affected file from step 2

### 5. Examine the Deployment Merge Request
If recent commits point to a merge request:
- Use `gitlab_get_merge_request` to get the MR details, description, and approvers
- Use `gitlab_get_merge_request_diffs` to see exactly what code changed
- Use `gitlab_get_merge_request_pipelines` to verify the CI/CD pipeline passed

### 6. Check Commit Diffs for Suspect Changes
Use `gitlab_get_commit_diff` for commits that touch files identified in steps 2-4. Look for:
- Changed error handling (removed try/catch, changed exception types)
- Modified timeouts or connection settings
- New dependencies or API call patterns
- Configuration changes (environment variables, feature flags)

### 7. Identify the Affected Project
If the incident references a service name but not a GitLab project, use `gitlab_search` with scope `projects` to find the matching repository. Search by service name, namespace, or keyword.

### 8. Browse Repository Structure
Use `gitlab_get_repository_tree` to understand the project layout when navigating unfamiliar codebases. This helps locate configuration files, test directories, and related modules.

## Cross-Datasource Correlation
- Elasticsearch error timestamp + GitLab commit timestamp = deployment-caused regression
- Orbit blast radius (shared definition imported by service X) + post-merge Elastic error spike in X = shared-library root cause (fires `orbit-deploy-blast-radius-vs-elastic`)
- Kafka consumer lag spike + GitLab MR merged = consumer code change caused processing failure
- Couchbase slow queries + GitLab commit touching query code = query regression
- Kong gateway 5xx + GitLab pipeline deployment = upstream service deployment failure
- Error class in logs + GitLab blame shows recent author = direct author for escalation

## Escalation Criteria
- Code change clearly caused regression: tag MR author and reviewers
- Multiple services affected by same deployment: escalate to release manager
- Rollback candidate identified: requires human approval before proceeding

## All Tools Used Are Read-Only
gitlab_semantic_code_search, gitlab_get_file_content, gitlab_get_blame, gitlab_list_commits, gitlab_get_commit_diff, gitlab_get_merge_request, gitlab_get_merge_request_diffs, gitlab_get_merge_request_pipelines, gitlab_get_repository_tree, gitlab_search, gitlab_graph_schema, gitlab_blast_radius, gitlab_cross_project_callers, gitlab_recent_deploys, gitlab_pipeline_failures, gitlab_recent_vulnerabilities, gitlab_orbit_query_graph
