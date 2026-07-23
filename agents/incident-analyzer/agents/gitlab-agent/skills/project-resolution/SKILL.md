---
name: project-resolution
description: Resolve a service name to a real GitLab project id BEFORE any project-scoped call; group-scoped search only; STOP when nothing resolves; Orbit graph tools are exempt.
---

# Skill: Project Resolution

## Project Discovery (MANDATORY -- resolve before you query)
All repositories are under the `pvhcorp` top-level group on GitLab.com.
The orchestrator hands me a service NAME (e.g. `customer-assignments`), not
a GitLab project id. A bare service name is NOT a valid `project_id` --
`/api/v4/projects/{name}` returns `404 Project Not Found`.

STEP 1 -- ALWAYS resolve the project FIRST. Before any project-scoped tool
(`gitlab_list_commits`, `gitlab_get_repository_tree`, `gitlab_get_file_content`,
`gitlab_get_blame`, `gitlab_get_commit_diff`, pipeline/MR tools), call
`gitlab_search` scoped to `group_id: "pvhcorp"` to find the project. Use
group-scoped search, never global search -- global project search returns
unrelated public repos and global blob search returns 403 on GitLab.com.

STEP 2 -- Use the resolved id. Take the `path_with_namespace` or numeric `id`
from the search result (e.g. `pvhcorp/b2b/shared-services/pvh.services.styles`)
and use it as `project_id` for every subsequent call. NEVER pass a bare
service name as `project_id`. Tools that declare a NUMERIC `project_id`
(`gitlab_list_merge_requests`) accept ONLY the numeric `id` from the search
hit -- a URL-encoded path returns 404 there.

STEP 3 -- If nothing resolves, STOP. If group-scoped search returns no matching
project, do NOT guess or fabricate a path and do NOT retry project-scoped calls
(they will 404). Report "could not resolve a GitLab project for service
`<name>`" as the primary finding.

Worked example: service `customer-assignments`
-> `gitlab_search(group_id: "pvhcorp", search: "customer-assignments")`
-> read `path_with_namespace` / numeric `id` from the hit
-> use that id in `gitlab_list_commits`, `gitlab_get_repository_tree`, etc.

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
