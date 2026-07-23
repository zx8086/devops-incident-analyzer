---
name: code-search-selection
description: Pick the right code-search tool -- Orbit graph for structural/cross-project questions, semantic search for fuzzy meaning; fallback procedure when Orbit errors.
---

# Skill: Code Search Selection

## Semantic Code Search Technique
Semantic search finds code by meaning, not just exact text. When the
orchestrator provides error context from logs, extract search anchors:
- Exception class names: `NullPointerException`, `TimeoutException`
- Method names from stack traces: `fetchOpenWindows`, `processEvent`
- Endpoint patterns: `/api/v1/delivery-dates`
- Domain concepts: "delivery date calculation", "consumer retry logic"

Use these as `semantic_query` in `gitlab_semantic_code_search`. Results
are scored 0-1. Focus on scores above 0.75. When results point to
exception handlers or error handlers, follow up with `get_file_content`
and `get_blame` to identify who last modified the code and whether a
recent change introduced the fault.

Always cross-reference semantic search findings with `list_commits`
filtered to the incident time window. If a recently changed file
matches a high-scoring search result, that is strong evidence of a
deployment-caused regression.

A "no embeddings / indexing in progress" result is a routine state, not a
failure: first-time indexing takes 10-20 minutes per project. Follow the
embedded guidance (browse via `gitlab_get_repository_tree` +
`gitlab_get_file_content`) and note the fallback in the finding.

## Code Search: Structural (Orbit) vs Semantic -- pick the right tool
Orbit and semantic search are COMPLEMENTARY -- use both in one investigation,
not one instead of the other. Orbit is NOT a blanket replacement for semantic
search.

| Need | Use | Not |
|------|-----|-----|
| Where is this stack-trace symbol DEFINED? (exact project/file/line) | `gitlab_blast_radius` FIRST (`gitlab_cross_project_callers` only with an exact fqn taken from a prior blast-radius def row -- its `eq` match fails on hand-composed names) | semantic (ranked guess) |
| WHO IMPORTS/CALLS this function across repos? / blast radius | Orbit graph tools (`IMPORTS` traversal) | semantic (single-project, can't traverse) |
| Find code that SEMANTICALLY RESEMBLES this error/behaviour | `gitlab_semantic_code_search` (Duo embeddings) | Orbit (structural, no fuzzy match) |
| Symbol on a NON-DEFAULT branch, or Terraform/YAML | `gitlab_semantic_code_search` + REST reads | Orbit (default-branch source only; no HCL/YAML) |

Orbit answers structural, cross-project code questions (where defined, who
imports, blast radius) deterministically and group-wide; semantic search answers
fuzzy "code that looks like X" within a project.

## Orbit Availability
When a graph tool returns an ERROR or guidance result, act on the structured
`_error.kind` per the ONE policy defined in the `code-change-correlation` skill
("Reading structured tool errors"): `bad-query` gets exactly one corrected
retry, `throttled` stops ALL further graph calls this turn, and every other
kind (`no-index`, network, server, auth) goes straight to the fallback. The
fallback is always `gitlab_semantic_code_search` + `gitlab_list_commits` for
the same question -- and SAY SO in the finding (state which fallback you used
and why). In every case, do NOT fabricate cross-project import edges from an
unavailable graph. Orbit indexes the DEFAULT BRANCH only and excludes
Terraform/YAML, so IaC-change questions stay on the REST / commit path
regardless.
