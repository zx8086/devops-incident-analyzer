---
name: code-change-correlation
description: Trace a runtime incident to a code change -- merged-MR listing, MR detail chain, pipeline jobs and logs, review notes, blast radius, prior-art check, and how to read structured tool errors.
---

# Skill: Code Change Correlation

## The deploy-vs-runtime chain
This is the primary evidence path linking an incident to a code change. Run it
in order; every id comes from the PREVIOUS call's response, never guessed.

1. `gitlab_list_merge_requests(project_id: <numeric id>, state: "merged", updated_after: <incident window start>, per_page: 100)`
   -- the correlation anchor. `project_id` MUST be numeric (from project
   resolution); the default state is already `merged`. `updated_after` is only
   a lower bound, so filter the response client-side to MRs whose `merged_at`
   falls inside the incident window. The tool returns a SINGLE page (no
   pagination), so always request the maximum `per_page: 100`; if exactly 100
   MRs come back the window may be under-covered -- narrow `updated_after` to
   the incident window and re-issue once, and if still full, state "MR list
   truncated at 100" in the finding instead of assuming completeness.
2. Rank the in-window MRs by merge time and pick AT MOST the 3 closest before
   the incident as candidates. For each candidate:
   `gitlab_get_merge_request` -> `gitlab_get_merge_request_diffs` (what changed)
   and `gitlab_get_merge_request_pipelines` (capture the pipeline id).
3. Pick the STRONGEST candidate from step 2 (changed files overlap the
   incident surface, or its pipeline is failing) and name it explicitly before
   continuing -- everything below runs against that one MR:
   `gitlab_get_merge_request_notes(mr_iid)` -- review discussion often names
   the exact risk that shipped (timeout, rollout, compatibility concerns
   raised pre-merge). Cite at most 2 relevant notes as evidence; an empty or
   purely procedural discussion is reported as nothing, not as a gap. Do this
   even if the pipeline is green -- a passing pipeline does not mean the
   review discussion is uninformative.
4. If the strongest candidate's pipeline is failing (not merely present):
   `gitlab_get_pipeline_jobs(pipeline_id)` -> capture the failing/suspicious
   job ids -> `gitlab_get_job_log(job_id)` for at most 2 jobs. Job logs are
   large and contain ANSI escape codes; extract the failure lines, do not
   quote whole logs. Skip this step outright when the pipeline is green --
   there is nothing to extract.
5. Report the MR iid, merge timestamp (ISO 8601), changed files, and the pipeline
   evidence together -- the orchestrator correlates timing against runtime
   findings from other datasources. If more than 3 in-window MRs exist, say so
   ("N further merged MRs in window not deep-inspected") instead of expanding
   the fan-out.

## Prior-art check (one cheap query -- run it, do not reason about whether to)
The error report almost always carries a distinctive class (an exception
type, a scanner rule name) -- treat that as the default case and run this
check. Only skip it when the incident text truly has no distinctive
error-class token at all (a vague "service is slow" report with no exception
name). When you run it: issue ONE `gitlab_search` with `scope: "issues"`
using ERROR-CLASS vocabulary -- the exception type or its distinctive
tokens, NEVER the incident's service name (issue text rarely contains
service names; a service-name search proves nothing either way, and a
`scope:"projects"` search for the service does NOT satisfy this check).
(`scope: "work_items"` also works and returns the same hits plus extra
WorkItem-only fields -- either scope is fine; `issues` is the narrower,
issue-shaped result.) Jira owns incident history (the atlassian agent
queries it); this check only surfaces scanner/bot-created GitLab issues.
For a hit, fetch detail via `gitlab_get_issue` -- its two required
parameters are `id` (the numeric project id) and `issue_iid` (the hit's
iid). Zero hits is the NORMAL outcome -- move on without retrying synonyms.

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
