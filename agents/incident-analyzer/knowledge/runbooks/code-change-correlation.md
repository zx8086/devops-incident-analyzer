---
type: Runbook
title: "Code Change Correlation"
description: "Trace an error or stack trace to the code change that caused it: Orbit blast radius across pvhcorp, group-wide deploy and pipeline ranking, MR diff evidence."
status: stable
tags: [gitlab, orbit, deploys, correlation]
generated:
  by: human:simon
  at: 2026-07-29
tools:
  - gitlab_blast_radius
  - gitlab_cross_project_callers
  - gitlab_recent_deploys
  - gitlab_pipeline_failures
  - gitlab_recent_vulnerabilities
  - gitlab_graph_schema
  - gitlab_orbit_query_graph
  - gitlab_semantic_code_search
  - gitlab_list_merge_requests
  - gitlab_get_merge_request
  - gitlab_get_merge_request_diffs
  - gitlab_get_merge_request_pipelines
  - gitlab_get_merge_request_notes
  - gitlab_get_pipeline_jobs
  - gitlab_get_job_log
  - gitlab_get_issue
  - gitlab_list_commits
  - gitlab_get_commit_diff
  - gitlab_get_file_content
  - gitlab_get_blame
  - gitlab_search
  - gitlab_get_repository_tree
---
# Code Change Correlation

Trace an error or stack trace to the code change that caused it: Orbit blast radius, recent deploys, MR diff evidence. Co-select with a domain runbook whenever logs name code symbols.

## When This Applies

- Stack traces or error messages reference specific classes, methods, or file paths
- Incident timing correlates with a recent deployment or merged MR
- New error patterns appear that were not present before a CI/CD pipeline completed
- A shared library changed and several services degrade together

This runbook complements the domain runbooks (Kafka, Elastic APM, Couchbase, AWS):
they establish WHAT is failing; this one establishes WHICH CHANGE made it fail.
Select it alongside them, not instead of them.

## Investigation Question Checklist

Every code-change finding should be able to answer the questions below; each
maps to a deterministic tool path (SIO-1320, distilled from the 2026-07-31
37-tool live test). Report an unanswered question as a stated gap, not silence.

- What shipped recently? -- `gitlab_list_merge_requests` (project) /
  `gitlab_recent_deploys` (group-wide or project_path-scoped)
- Where does the implicated code/config live? -- `gitlab_semantic_code_search`,
  `gitlab_get_repository_tree` (discovery first; never guess paths)
- What does it say now? -- `gitlab_get_file_content`
- Who/when last changed it? -- `gitlab_get_blame`, `gitlab_list_commits`
- What exactly changed? -- `gitlab_get_commit_diff`, `gitlab_get_merge_request_diffs`
- Did the shipping pipeline succeed? -- `gitlab_get_merge_request_pipelines`,
  `gitlab_get_pipeline_jobs`, `gitlab_get_job_log`
- Are pipelines failing group-wide? -- `gitlab_pipeline_failures`
- What did reviewers flag pre-merge? -- `gitlab_get_merge_request_notes`
  (strongest candidate only; at most 2 cited notes)
- What is downstream of the changed symbol? -- `gitlab_blast_radius`,
  `gitlab_cross_project_callers`
- Known vulnerabilities in play? -- `gitlab_recent_vulnerabilities`
- A graph question the purpose-built tools cannot ask? --
  `gitlab_orbit_query_graph` grounded by `gitlab_graph_schema`
- Prior art in GitLab issues? -- `gitlab_search` with `scope: "issues"` (NOT
  scope projects) using ERROR-CLASS vocabulary, never service names, +
  `gitlab_get_issue` for any hit (its two required parameters are the
  project id and the hit's iid). Run this whenever the incident names a
  distinctive error class; only skip it for a genuinely vague report with
  no exception/rule name. Jira owns incident history, so zero hits is the
  normal outcome

## Step 1: Extract Anchor Symbols

From the error text and Elasticsearch logs, collect anchors in priority order:

1. **Class or module names** (e.g. VariantEventConsumer) -- the BEST anchors:
   these are what other code imports, so they resolve in the Orbit graph.
2. **File paths** from stack frames (e.g. consumer/variant_event_consumer.py).
3. **Method names** (e.g. handleVariantUpsert) -- the WEAKEST anchors: methods
   are rarely imported directly. Use them to choose between candidate
   definitions, not as the first blast-radius argument.

Strip package prefixes and generic suffixes before anchoring: anchor on the
distinctive token, not com.pvh.orders.VariantEventConsumer verbatim.

## Step 2: Orbit Blast Radius (preferred -- deterministic, cross-project)

When GitLab Orbit is enabled this replaces the per-project hunt with a single
graph traversal, and it is the only path that spans repositories.

1. Call `gitlab_blast_radius` with the strongest anchor (class/module name).
   It is group-scoped -- no project resolution needed. Orbit resolves the
   anchor to a Definition node and returns every downstream project and file
   that IMPORTS it across pvhcorp: `importedByProjects` is the deterministic
   set of affected services (not a search guess); `sourceProject` and
   `sourceFile` locate the changed definition; `mrByFile` names the merged MR
   that last touched each defining file.
2. An EMPTY result is a checkpoint, not a conclusion. You MUST retry exactly
   once with a different anchor -- the module or class name if the first try
   was a method, or an alternate class from the stack trace. Only after the
   retry may the finding read "no cross-project importers found for
   <symbol> in the Orbit index" -- NEVER "no code cause" or "nothing depends
   on this" from a single empty call.
3. For "who calls this exact definition across repos", take the fqn from a
   blast-radius definition row and pass it to `gitlab_cross_project_callers`.
   The fqn is matched exactly -- never compose it by hand.
4. Billing: `gitlab_blast_radius` and the other Orbit tools consume GitLab
   Credits. `gitlab_graph_schema` is free -- use it to ground shapes before
   spending credits, and prefer these purpose-built tools over the raw
   `gitlab_orbit_query_graph` escape hatch.

## Step 3: Group-Wide Deploy and Pipeline Context

Run these whenever incident timing suggests deployment causation -- they rank
activity across ALL projects, so they work even before a project is identified:

- `gitlab_recent_deploys` with since = incident window start: which projects
  deployed inside the window, ranked.
- `gitlab_pipeline_failures` with since = incident window start: failing
  pipelines group-wide; a deploy pipeline that failed mid-rollout is a
  first-class root-cause candidate.
- `gitlab_recent_vulnerabilities` for a group-wide security sweep when the
  error pattern suggests exploitation. An empty result is legitimate when the
  scanning index is empty -- report "no vulnerabilities in the index", not a
  tool failure.

**Staged window (SIO-1298, SIO-1304).** Deployments that cause incidents can
land days or weeks before symptoms appear. Start both calls at the incident
window (default 24h). If a call returns 0 rows for that window, a widened
follow-up call is MANDATORY, not optional -- re-run ONCE:

- Owning project resolved (focus block, blob search, or blast radius): pass the
  project_path parameter with that project's full_path and since = 90 days ago.
  Results are newest-first and limit-bounded, so the wide window adds coverage
  for low-velocity teams without adding noise -- and it reveals the team's
  deploy cadence. State that cadence and the gap between the last change and
  the documented incident onset in your findings; treat an old change as a
  root-cause candidate only if its timing aligns with that onset.
- No project resolved: re-run group-scoped with since = 30 days ago and a
  modest limit.

Never report "no correlated deploys or pipeline changes" from the 24h window
alone -- that conclusion requires the widened call to also be empty.

## Step 4: Merge Request Evidence Chain

Once a project is implicated (by blast radius, deploy ranking, or the incident
itself):

1. `gitlab_list_merge_requests` with state merged and the incident window --
   filter client-side to MRs whose merge time falls inside the window.
2. For at most the 3 MRs merged closest before onset: `gitlab_get_merge_request`
   for details and authors, `gitlab_get_merge_request_diffs` for exactly what
   changed, `gitlab_get_merge_request_pipelines` to verify the pipeline that
   shipped it.
3. In the diffs, look for: changed error handling, modified timeouts or
   connection settings, new dependencies or API call patterns, configuration
   and feature-flag changes.
4. For the strongest candidate, `gitlab_get_merge_request_notes` -- run this
   regardless of whether its pipeline passed or failed: review discussion
   often names the exact risk that shipped. Cite at most 2 relevant notes; an
   empty or purely procedural discussion is nothing, not a gap.

## Orbit Raw Query Reference (escape hatch)

`gitlab_orbit_query_graph` is only for questions the purpose-built tools cannot
express. Ground the shape with `gitlab_graph_schema` first. Key constraints:

- GitLab issues, epics, tasks and incidents are all the **WorkItem** entity;
  a query with entity "Issue" is rejected outright.
- Relationship entries take **max_hops** (default 1, max 3). An unset
  **max_hops** answers "direct importers" and silently misses transitive ones.
- Path queries are a different shape: **path_finding** requires a **path**
  sub-object with its own depth cap; an unexpectedly empty path result is
  often an edge-direction mismatch, not absence.
- Prefer **HAS_LATEST_DIFF** over **HAS_DIFF** for "what does this file look
  like now"; **HAS_DIFF** spans every historical revision.
- Merge-request pipelines carry **Pipeline.source = "merge_request_event"**;
  filter on it or parent/child pipelines double-count.
- Budget: at most 5 query attempts per question; changing only limit or
  columns is not progress. On exceeding 5, report the shapes tried and fall
  back to the per-project chain below -- an inflated partial graph answer is
  worse than a stated gap.

## Per-Project Fallback

Use when Orbit is disabled or still indexing, the symbol lives on a
non-default branch, or the code is Terraform/YAML (Orbit indexes the default
branch only and excludes HCL/YAML):

1. `gitlab_semantic_code_search` with the extracted anchors -- finds code by
   meaning, not exact text; focus on scores above 0.75.
2. `gitlab_get_file_content` to read the implicated file; `gitlab_get_blame`
   to identify who last modified the failing lines.
3. `gitlab_list_commits` filtered by since/until around incident onset (and
   by path when known); `gitlab_get_commit_diff` for suspect commits.
4. `gitlab_search` with scope projects to map a service name to its
   repository; `gitlab_get_repository_tree` to navigate unfamiliar layouts.

## Cross-Datasource Correlation (for the final report)

A change is CONFIRMED as root cause only when three things line up: a
code-level link (blast-radius importer, or a diff touching the failing
surface), deployment evidence that the change actually shipped (a deploy from
`gitlab_recent_deploys` or a passed deploy pipeline from
`gitlab_get_merge_request_pipelines`), and error onset AFTER that deploy
timestamp. With any leg missing, report the change as a CANDIDATE correlation,
not a cause.

- Orbit blast radius (shared definition imported by service X) + deploy of the
  defining project + post-deploy Elastic error spike in X = shared-library
  root cause. This is the `orbit-deploy-blast-radius-vs-elastic` rule: when
  all sides are present, state the causal chain deterministically
  (definition -> importing service -> deploy time -> error onset) instead of
  reconstructing it in prose.
- Elasticsearch error onset + a merged MR whose deployment lands inside the
  window = deployment-caused regression; cite the deploy and onset timestamps.
  A commit timestamp alone, with no evidence it shipped, stays a candidate.
- Kafka consumer lag spike + merged MR touching the consumer: candidate until
  the MR's deploy pipeline confirms it shipped before the lag onset.
- Couchbase slow queries + commit touching query code: same rule -- confirm
  the shipping deploy before calling it a query regression.
- Blame author on the failing lines = direct escalation target.
- Report Orbit limitations as stated gaps, not absence of cause: the index
  covers default branches only, excludes Terraform/YAML, and an empty
  blast radius after the mandatory retry means "no importers found in the
  index" -- the per-project chain is the remaining evidence path.

## Escalation Criteria

- Code change clearly caused regression: tag the MR author and reviewers
- Multiple services affected by the same deployment: escalate to the release manager
- Rollback candidate identified: requires human approval before proceeding

## All Tools Used Are Read-Only

gitlab_blast_radius, gitlab_cross_project_callers, gitlab_recent_deploys, gitlab_pipeline_failures, gitlab_recent_vulnerabilities, gitlab_graph_schema, gitlab_orbit_query_graph, gitlab_semantic_code_search, gitlab_list_merge_requests, gitlab_get_merge_request, gitlab_get_merge_request_diffs, gitlab_get_merge_request_pipelines, gitlab_get_merge_request_notes, gitlab_get_pipeline_jobs, gitlab_get_job_log, gitlab_get_issue, gitlab_list_commits, gitlab_get_commit_diff, gitlab_get_file_content, gitlab_get_blame, gitlab_search, gitlab_get_repository_tree
