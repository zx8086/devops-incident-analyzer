# Successful elastic-iac Prompts

A catalog of real user prompts that produced a successfully **applied** elastic-iac merge request — concrete examples of "what to ask to get a working change." Sourced from the knowledge graph's `Prompt` -> `ConfigChange` -> `MergeRequest` chain (SIO-1202), filtered to `ConfigChange.outcome = 'applied'`.

## How this is populated

This doc is generated from the live knowledge graph, not hand-written. Call the curated MCP tool against a running elastic-iac deployment that has `KNOWLEDGE_GRAPH_ENABLED=true` and real turn history:

```text
kg_successful_prompts { "limit": 50 }
```

Reached at `http://127.0.0.1:9087/mcp` (in-process on the web app — see [knowledge-graph.md](../architecture/knowledge-graph.md#the-in-process-mcp-server-port-9087-sio-967)), or via the elastic-iac agent's tool belt directly. The tool returns rows shaped `{prompt, summary, workflow, mrUrl, createdAt}`; render each as one entry below, newest first.

**Known gap (SIO-1203): `kg_successful_prompts` only sees changes applied from 2026-07-09 onward.** The `Prompt` node was introduced in SIO-1038 (merged 2026-07-09); the knowledge graph itself was activated for elastic-iac earlier, in SIO-954 (merged 2026-06-19), which recorded `ConfigChange`/`MergeRequest` but never a prompt. Any change applied between those two dates is real and still in the graph, but has no `Prompt` to join — `kg_successful_prompts`' strict join silently excludes it. For a complete historical count (including those undated-prompt rows), call `kg_applied_changes` instead:

```text
kg_applied_changes { "limit": 50 }
```

It returns the same shape, but renders `(no prompt recorded -- predates SIO-1038)` in place of the prompt for changes from that gap window, so they're still counted and dated even without the verbatim ask.

This repository's own worktrees have no local `.data/knowledge-graph` and no `lbug` install, so there is nothing to query from a dev sandbox — this catalog can only be populated from a real deployment that has actually run elastic-iac turns to completion (an MR opened, merged, and its pipeline applied).

## Entries

_None recorded yet. Run the query above against a live environment and populate this section — one entry per row:_

```markdown
### <createdAt> — <workflow>

**Prompt:**
> <prompt, verbatim>

**Result:** <summary> ([MR](<mrUrl>))
```

## Cross-check (optional)

Agent Memory's reconciliation sweep (`iac/reconcile.ts`) independently tracks the same outcomes as `kind:iac-change` facts with `lifecycle: applied`, keyed by `config_change_id`. If a `config_change_id` shows `lifecycle: applied` there but is missing from this catalog, the knowledge-graph write for that turn likely soft-failed — the change is still real and can be added here manually from the Agent Memory fact's `change_summary` annotation, without the verbatim prompt (Agent Memory does not store the raw prompt unless `LIVE_MEMORY_RAW_PROMPTS_ENABLED` was set for that turn). See [agent-memory.md](../architecture/agent-memory.md#what-we-save-and-to-which-block-type).
