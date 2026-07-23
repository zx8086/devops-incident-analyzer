---
name: code-change-correlation
description: Trace a runtime incident to a code change -- merged-MR listing, MR detail chain, pipeline jobs and logs, blast radius, and how to read structured tool errors.
---

# Skill: Code Change Correlation

## The deploy-vs-runtime chain
This is the primary evidence path linking an incident to a code change. Run it
in order; every id comes from the PREVIOUS call's response, never guessed.

1. `gitlab_list_merge_requests(project_id: <numeric id>, state: "merged", updated_after: <incident window start>, per_page: 20)`
   -- the correlation anchor. `project_id` MUST be numeric (from project
   resolution); the default state is already `merged`. `updated_after` is only
   a lower bound, so filter the response client-side to MRs whose `merged_at`
   falls inside the incident window.
2. Rank the in-window MRs by merge time and pick AT MOST the 3 closest before
   the incident as candidates. For each candidate:
   `gitlab_get_merge_request` -> `gitlab_get_merge_request_diffs` (what changed)
   and `gitlab_get_merge_request_pipelines` (capture the pipeline id).
3. For the STRONGEST candidate only (changed files overlap the incident
   surface, or its pipeline is failing): `gitlab_get_pipeline_jobs(pipeline_id)`
   -> capture the failing/suspicious job ids -> `gitlab_get_job_log(job_id)` for
   at most 2 jobs. Job logs are large and contain ANSI escape codes; extract the
   failure lines, do not quote whole logs.
4. Report the MR iid, merge timestamp (ISO 8601), changed files, and the pipeline
   evidence together -- the orchestrator correlates timing against runtime
   findings from other datasources. If more than 3 in-window MRs exist, say so
   ("N further merged MRs in window not deep-inspected") instead of expanding
   the fan-out.

## Blast radius workflow
When the incident implicates a symbol or a changed shared file:

1. `gitlab_blast_radius(symbol: "<function/class/module name>")` -- group-wide
   importers of matching definitions, plus `mrByFile` metadata (the merged MR
   that last touched each defining file) when available.
2. An EMPTY result is a checkpoint, not a conclusion. Retry ONCE with a
   different anchor (a symbol likelier to appear in import paths -- the module
   name rather than a method name). If still empty, say "no cross-project
   importers found for <symbol> in the Orbit index" and fall back to
   `gitlab_semantic_code_search` -- NEVER conclude "nothing depends on this"
   from a single empty call.
3. For an exact known definition, prefer `gitlab_cross_project_callers(fqn:
   "<fqn from a blast-radius def row>")` -- the fqn must be exact (`eq` match),
   so take it from a prior result, do not compose it by hand.
4. `gitlab_recent_deploys(since: <window>)` and `gitlab_pipeline_failures(since:
   <window>)` rank group-wide activity when no specific project is implicated.
   Empty `gitlab_recent_vulnerabilities` is LEGITIMATE when the group's security
   scanning index is empty -- report "no vulnerabilities in the index", not a
   tool failure.

## Reading structured tool errors
GitLab tool failures carry guidance prose followed by a JSON envelope
`{"_error": {"kind", "category", "advice", ...}}`. This is the ONE error
policy for every GitLab tool (the `code-search-selection` skill's Orbit
fallback defers to it). Act on the kind:

- `no-index` (Orbit unavailable, embeddings not ready): a routine environment
  state. Follow the embedded fallback guidance; do NOT count it as a tool
  failure or retry the same call.
- `bad-query`: the query itself was rejected (unselective, grammar). Fix the
  query per the advice and retry the corrected form AT MOST ONCE; if it is
  rejected again, use the fallback path instead. NEVER retry unchanged.
- `throttled`: the billed-query budget for the current window is exhausted.
  Stop issuing graph calls this turn and work with the evidence already
  gathered (use the REST/semantic fallback for anything still unanswered).
- `not-found` / `auth-denied` with a statusCode: a real upstream answer about
  THIS target; do not retry blindly -- re-check project resolution first.
