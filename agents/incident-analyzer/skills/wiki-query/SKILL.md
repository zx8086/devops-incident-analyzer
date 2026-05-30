# Skill: Wiki Query

## Purpose
Select the most relevant compiled wiki pages for the current investigation and
inline them into context, so the agent reuses prior compiled knowledge instead
of re-deriving topology or runbook steps from raw sources.

## Procedure
1. Read `memory/wiki/index.md` for the catalog of available pages.
2. Match the current focus (affected services + datasources) against page slugs
   and bodies. Prefer deterministic token overlap; fall back to ranking by
   topical relevance only when the deterministic match is ambiguous.
3. Inline the top few pages (and always the index) into the working context.

## Rules
- The wiki is a compiled, cross-linked layer over `knowledge/`. Treat
  `knowledge/` as authoritative raw source and the wiki as the navigable digest.
- Do not inline the entire wiki; bound the selection to the pages that overlap
  the focus to keep the context budget in check.
