---
name: project-resolution
description: Resolve a service name to a real GitLab project id BEFORE any project-scoped call; honour the focus-block id, otherwise group-scoped search ONCE per project; STOP when nothing resolves; Orbit graph tools are exempt.
---

# Skill: Project Resolution

## Project Discovery (MANDATORY -- resolve before you query)
All repositories are under the `pvhcorp` top-level group on GitLab.com.
The orchestrator hands me a service NAME (e.g. `customer-assignments`), not
a GitLab project id. A bare service name is NOT a valid `project_id` --
`/api/v4/projects/{name}` returns `404 Project Not Found`.

STEP 0 -- Check the investigation focus block FIRST. When the per-turn focus
block above carries a line of the form
`- GitLab numeric project_id: <id> (<path>)`, the supervisor already resolved
that service: STEP 1 is SATISFIED for that project. Use that id directly and do
NOT issue a resolution search for it. The line is absent whenever the
supervisor's probe was skipped or failed -- that probe is best effort, so treat
its absence as normal and fall through to STEP 1.

STEP 1 -- Resolve any project the focus block did not give you, ONCE. The rule
stays categorical: no tool that takes a `project_id` argument may be called with
an unresolved project -- the single exception is the Orbit graph tools listed at
the bottom of this skill. A bare service name is not a valid `project_id`. To
resolve, call `gitlab_search` scoped to `group_id: "pvhcorp"`. Check the tool's
own schema for a `project_id` parameter rather than matching against a remembered
list; the tools bound on any given turn vary, and a tool absent from an example
list still needs resolution. Use group-scoped search, never global search --
global project search returns unrelated public repos and global blob search
returns 403 on GitLab.com.

Resolve ONCE PER DISTINCT PROJECT, not once per call. A project id is stable for
the whole turn: the moment you hold one -- from STEP 0 or from a STEP 1 search --
reuse it for EVERY later call against that project without searching again. Only
search again when you need a project you have not resolved yet. Re-resolving a
project you already hold is a wasted call, and a few of them exhaust the search
tool's call budget for the turn, which costs you the ability to resolve a
DIFFERENT project later.

STEP 2 -- Use the resolved id. Take the `path_with_namespace` or numeric `id`
from the focus block or the search result (e.g.
`pvhcorp/b2b/shared-services/pvh.services.styles`) and use it as `project_id` for
every subsequent call against that project. NEVER pass a bare
service name as `project_id`. Tools that declare a NUMERIC `project_id`
(`gitlab_list_merge_requests`) accept ONLY the numeric `id` from the search
hit -- a URL-encoded path returns 404 there.

STEP 3 -- If nothing resolves, STOP. If group-scoped search RAN and returned no
matching project, do NOT guess or fabricate a path and do NOT retry
project-scoped calls (they will 404). Report "could not resolve a GitLab project
for service `<name>`" as the primary finding.

That applies only to a search that actually ran. If the search was refused before
it executed -- the result says the tool has returned nothing useful several times
and must not be called again -- that is a call-budget outcome, not evidence about
the project. Report it as "GitLab project resolution was not attempted for
`<name>`: the search tool was short-circuited after repeated empty results", and
never as "the project does not exist". Reuse any id you already hold from STEP 0
or an earlier STEP 1 rather than treating the turn as unresolved.

Worked example: service `customer-assignments`
-> focus block has `- GitLab numeric project_id: 4471 (pvhcorp/b2b/customer-assignments)`
   -> use 4471 directly; no search
-> focus block has no such line
   -> `gitlab_search(group_id: "pvhcorp", search: "customer-assignments")` ONCE
   -> read `path_with_namespace` / numeric `id` from the hit
-> then use that id in `gitlab_list_commits`, `gitlab_get_repository_tree`, etc.
   for the rest of the turn, without searching again

EXCEPTION -- Orbit graph tools skip STEP 1. The graph tools
(`gitlab_blast_radius`, `gitlab_cross_project_callers`, `gitlab_recent_deploys`,
`gitlab_pipeline_failures`, `gitlab_recent_vulnerabilities`, `gitlab_graph_schema`,
`gitlab_orbit_query_graph`) are group-scoped against `pvhcorp` and take a
symbol/file/definition or group directly -- they do NOT need project resolution.
PREFER them for cross-project questions: "who calls X across repos", "blast
radius of this change", "which shared library breaks these services",
"rank recent deploys / pipeline failures group-wide". Call `gitlab_graph_schema`
(free) first when you need to ground a graph query. Note: Orbit `query_graph`
calls consume GitLab Credits, so use the purpose-built tools over the raw
`gitlab_orbit_query_graph` escape hatch unless the wrappers cannot express the
question.
