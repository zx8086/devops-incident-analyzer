---
name: search-memory
description: Recall prior decisions, change outcomes, and pipeline results from durable cross-session memory. Use it when a question needs "what happened before" and the knowledge graph's structured tools don't cover the shape of the question. Never mutates memory.
inputs:
  question: { type: string, required: true }   # the operator question, e.g. "what was the outcome of the eu-b2b 9.4.2 upgrade?"
outputs:
  answer: { type: string }
---

# Search durable memory

`search_memory` recalls facts this agent wrote in *any* past session: prior decisions, change outcomes, versions, and pipeline results. It is a fuzzy, semantic recall over free text — the opposite of the knowledge graph's structured, always-correct joins. Use it when the question is about *what happened or was decided*, not about *repo structure or change history*, which belong to `kg_*` (see `query-knowledge-graph`).

## When to call it

Call `search_memory` when the question needs prior context that isn't derivable from the current turn or the live cluster:

| Question shape | Example |
|---|---|
| Outcome of a past change | "What was the outcome of the eu-b2b 9.4.2 upgrade?" |
| A prior decision and its reasoning | "Why did we downsize the us-cld warm tier last time?" |
| Status of an in-flight operation | "How's the ap-cld fleet upgrade going?" (also proactively recalled at session bootstrap, R5 in `docs/architecture/agent-memory.md`) |
| Whether something was already tried | "Did we already attempt to fix the .alerts unmanaged-index issue?" |

Do **not** call it for:
- Repo structure, blast radius, or change history — those are `kg_*` tool questions (RULES.md rule 7). The knowledge graph is the deterministic system of record; memory is a fuzzy supplement, not a substitute.
- Live cluster state (versions, health, topology) — read those directly from Elastic Cloud, per RULES.md rule 1.
- Anything answerable from the current conversation — don't recall what you already know this turn.

## How to call it well

`search_memory` takes a free-text `query` plus optional `deployment` / `stack` / `kind` filters. Two things matter for getting a useful result:

1. **Always pass a specific `query`.** This tool is semantic-mode by design (unlike the knowledge graph's `kg_run_cypher`, which prefers deterministic filters) — the query text is what ranks the right memories to the top. A vague query ("upgrades") competes with everything the agent has ever recorded; a specific one ("eu-b2b 9.4.2 upgrade outcome") ranks the right block near the top.
2. **Pair the query with a filter when you know the deployment/stack.** The service applies the `deployment`/`stack`/`kind` filter *after* ranking the top candidates by relevance to `query` (SIO-998 — see `docs/architecture/agent-memory.md` "Retrieval: TWO modes"). The tool already widens its candidate window to 25 hits specifically to give a filter room to work, but a filter still can't rescue a result if the `query` text itself doesn't rank the right memory into that window. Make the query as specific as the filter, don't rely on the filter alone to narrow a vague query.

`kind` values seen in practice: `iac-change` (a proposed or reconciled config change), `fleet-upgrade-dispatched` / `fleet-upgrade-terminal` (version rollouts), `key-decision` (a recorded reasoning step), `skill` (a proposed-but-unpromoted learned skill).

## Worked examples

Recall a past change's outcome, scoped to a deployment:
```
search_memory({ query: "9.4.2 upgrade outcome", deployment: "eu-b2b", kind: "iac-change" })
```

Recall why a decision was made, no deployment known yet:
```
search_memory({ query: "why downsize warm tier to 8GB" })
```

Check an in-flight fleet upgrade (also see the proactive R5 bootstrap recall — this is the manual fallback if that didn't surface it):
```
search_memory({ query: "us-cld fleet upgrade status", kind: "fleet-upgrade-dispatched" })
```

## Notes

- Returns "No matching memory found (or durable memory is not enabled for this agent)" on zero hits or when the agent-memory backend isn't active — treat an empty result as "nothing recorded" or "memory unavailable," not as proof something never happened, the same caution `query-knowledge-graph` gives for an empty graph result.
- This skill is read-only. It never writes, promotes, or deletes a memory.
- See `docs/architecture/agent-memory.md` (Reads table, row R7) for the full mechanism and how this differs from the agent's own automatic (code-driven) recalls.
