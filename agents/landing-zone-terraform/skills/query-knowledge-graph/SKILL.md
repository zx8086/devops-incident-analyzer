---
name: query-knowledge-graph
description: Use when answering PVH Landing Zone questions about repository history, Terraform module consumers, account-managing roots, merge-request delivery outcomes, or governing standards and ADRs.
inputs:
  question: { type: string, required: true }
outputs:
  graph_evidence: { type: array }
---

# Query the Landing Zone knowledge graph

The graph is a deterministic, rebuildable projection of imported GitLab and governance evidence. Use it for relationships and history, then revalidate material conclusions against current GitLab or the authoritative ADR source.

## Curated tools

| Question | Tool |
|---|---|
| What changed in a repository, and what happened? | `kg_lz_repository_history {repository, limit?}` |
| Which Terraform roots consume a local module? | `kg_lz_module_consumers {moduleId}` |
| Which roots explicitly manage AWS accounts? | `kg_lz_account_roots {repository?}` |
| What change, pipeline, and plan belong to an MR? | `kg_lz_mr_outcome {mrUrl}` |
| Which standards and ADRs govern a repository? | `kg_lz_repository_standards {repository}` |

Prefer these parameterized readers. Use `kg_run_cypher` only when the requested relationship is not covered.
Repository paths are mutable locators. Importers key GitLab groups and projects by their immutable GitLab IDs,
merge requests by `<project-id>:<iid>`, and Terraform roots/modules by `<project-id>:<terraform-path>`.
Use IDs returned by graph or GitLab evidence; never reconstruct an ID from a repository name.

## Interpretation

- An empty result means no matching imported graph fact was found. It does not prove the object or event never existed.
- State that the graph may be incomplete and verify against live GitLab before concluding absence.
- A merged MR is not an applied change. Report `applied` only when the recorded delivery pipeline or verified live state supports it.
- Keep graph evidence separate from Agent Memory. Memory explains prior experience; it cannot override this graph or live evidence.
- Treat open MRs, pipelines, and plans as time-sensitive. Refresh them before reporting current status.

## Physical schema for ad-hoc reads

Ladybug relationship tables are endpoint-typed. Use the exact Landing Zone edges:

```text
(GitLabGroup)-[:CONTAINS]->(Repository)
(Repository)-[:REPOSITORY_CONTAINS_ROOT]->(TerraformRoot)
(TerraformRoot)-[:ROOT_USES_MODULE]->(TerraformModule)
(TerraformModule)-[:MODULE_USES_SHARED_MODULE]->(SharedModule)
(ConfigChange)-[:CHANGE_TARGETS_REPOSITORY]->(Repository)
(ConfigChange)-[:CHANGE_TARGETS_ROOT]->(TerraformRoot)
(ConfigChange)-[:PROPOSED_IN]->(MergeRequest)-[:RAN]->(Pipeline)
(Pipeline)-[:PRODUCED]->(TerraformPlan)
(Repository)-[:GOVERNED_BY]->(Standard)-[:IMPLEMENTS]->(ADR)
```

Do not substitute the Elastic IaC `TARGETS` or `USES_MODULE` tables; those have different endpoint types. Bind all values through `$params`; never interpolate user text into Cypher.

## Example

For “Did account creation change, and was it applied?” call `kg_lz_repository_history` with the full GitLab repository path. Use `kg_lz_mr_outcome` for the relevant MR, then verify its current pipeline and default-branch state in GitLab. If history is empty, report the import limitation and perform the live GitLab check rather than answering “never changed.”

## Common mistakes

| Mistake | Correction |
|---|---|
| Querying by short repository name | Use the full GitLab path. |
| Treating no rows as non-existence | Report incomplete graph coverage and verify live. |
| Treating merge as apply | Require pipeline or live-state evidence. |
| Guessing generic edge names | Use the endpoint-specific physical schema above. |
