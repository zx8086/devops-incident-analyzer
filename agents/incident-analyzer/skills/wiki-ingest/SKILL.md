# Skill: Wiki Ingest

## Purpose
Compile a raw source (a runbook, a systems-map doc, or a finished investigation
report) into a cross-referenced wiki page under `memory/wiki/pages/`, and update
the catalog and log. Inspired by Karpathy's LLM Wiki pattern.

## Procedure
1. Choose a stable slug for the topic (kebab-case, e.g. `kafka-consumer-lag`).
2. Write a compiled page body: concise prose that distills the source(s), with
   `[[wiki-links]]` to related pages.
3. Set frontmatter: `sources` (the raw `knowledge/...` paths it was compiled
   from), `related` (other page slugs), and `updated` (ISO timestamp).
4. Add or update the page's one-line entry in `memory/wiki/index.md`.
5. Append a dated line to `memory/wiki/log.md`.

## Output
A file-diff proposal (page + index + log), never a direct write. The proposal is
staged on a branch and opened as a PR for human review (see the memory-pr flow).
Never commit secrets; the proposal is scanned before the PR opens.
