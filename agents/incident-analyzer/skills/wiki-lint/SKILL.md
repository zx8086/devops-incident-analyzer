---
name: wiki-lint
description: Validate the integrity of the compiled wiki -- dead links, orphan pages, missing frontmatter, stale sources, and missing source files -- so it does not drift from its raw sources or accumulate broken cross-references. Runs in CI (wiki:lint) and during session teardown to keep the wiki trustworthy for wiki-query to consume.
---

# Skill: Wiki Lint

## Purpose
Validate the integrity of the compiled wiki so it does not drift from its raw
sources or accumulate broken cross-references.

## Checks
1. Dead links: every `[[slug]]` must resolve to an existing page under
   `memory/wiki/pages/`.
2. Orphans: every page must be listed in `memory/wiki/index.md`.
3. Missing frontmatter: every page must have a frontmatter block with `sources`
   and `updated`.
4. Stale sources: if a declared source file's mtime is newer than the page's
   `updated` timestamp, the page is stale and should be re-ingested.
5. Missing sources: every declared source path must exist.

## Output
A report listing each issue by kind, page, and detail. Runs in CI via the
`wiki:lint` script and during session teardown. A clean wiki reports zero issues.
