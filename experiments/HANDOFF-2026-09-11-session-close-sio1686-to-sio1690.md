# HANDOFF 2026-09-11: session close, SIO-1686 done, pick up SIO-1690

- Date: 2026-09-11
- Closed this session: https://linear.app/siobytes/issue/SIO-1686 (Done), children https://linear.app/siobytes/issue/SIO-1687, https://linear.app/siobytes/issue/SIO-1688, https://linear.app/siobytes/issue/SIO-1689 (all Done)
- **Next work item: https://linear.app/siobytes/issue/SIO-1690** (Backlog, filed this session)
- Repo state: branch `claude/context-mode-gitagent-hooks-3fb1c3` at `2e0e3e3b`, `origin/main` at `1e95d1f5`
- Merged PR: https://github.com/zx8086/devops-incident-analyzer/pull/724, squashed as `e2afabe9`
- Specs: `docs/superpowers/specs/2026-09-10-context-mode-concepts-feasibility.md`, detail handover `experiments/HANDOFF-2026-09-11-SIO-1686-search-evidence-adoption.md`
- Suggested branch for SIO-1690: `sio-1690-scroll-search-query-param` off `origin/main`

## TL;DR

SIO-1686 is finished. The context-mode feasibility study shipped, phases 1 and 2 shipped code, phase 3 shipped findings that retired its own items, and the one open question (does the model actually call `search_evidence`) was answered YES with a live probe.

Next session picks up SIO-1690, a defect found incidentally: `elasticsearch_scroll_search` rejects its own `query` parameter. Everything needed to start cold is in the section below.

## What shipped (all merged, all verified)

| Ticket | Outcome |
|---|---|
| SIO-1686 | Feasibility study: 12-row head-to-head against context-mode |
| SIO-1687 | Fleet reply discipline, evidence TOC, tool-failure breadcrumbs |
| SIO-1688 | Per-run FTS5 evidence index + `search_evidence` tool |
| SIO-1689 | No code: Pi 0.84.4 preconditions retired items 5, 6, 8 |

Plus six metadata-only log events, verified not to leak tool payloads, spoke prose, or search query text.

Verification at merge: agent 4488 pass (24 pre-existing iac failures, proven pre-existing by A/B against pristine sources), apps/web 399 pass 0 fail, pi-coms 326 pass 0 fail, gitagent-bridge 442 pass 0 fail, typecheck and lint clean.

## The headline finding

A 719,000-byte Elasticsearch result was reaching the model as **139 bytes**, a 99.98% loss, permanently unrecoverable for the rest of the run. That was pre-existing behaviour, invisible until the new instrumentation exposed it. The evidence index makes those bytes recoverable.

Then, on the third probe attempt, the model used it unprompted:

```
subagent.tool_result_truncated  originalBytes=43676 finalBytes=39589 indexedRows=201
evidence_index.search  scopedTool=elasticsearch_search queryTermCount=6  hitCount=3
evidence_index.search  scopedTool=elasticsearch_search queryTermCount=11 hitCount=3
evidence_index.search  scopedTool=null                 queryTermCount=20 hitCount=0
```

PROVEN: given truncation, the model reaches for recovery. NOT proven: how often truncation occurs at the production cap (the run used `SUBAGENT_TOOL_RESULT_CAP_BYTES=40000` to create the condition; that is a probe parameter, never a production setting).

## NEXT: SIO-1690, elasticsearch_scroll_search rejects its own `query`

Everything below is what a cold session needs.

**Symptom.** Reproduced in two independent live sub-agent runs against `eu-b2b`:

```
MCP error -32603: [elasticsearch_scroll_search] parsing_exception
  Caused by: named_object_not_found_exception: [1:19] unknown field [query]
  Root causes: parsing_exception: unknown query [query]
```

Classified `bad-query`, twice per run. One additional call timed out.

**Why it looks real.** The schema DOES declare the parameter:

- `packages/mcp-server-elastic/src/tools/search/scroll_search.ts:20` declares `query: z.object({}).passthrough()`
- `:129` forwards it as `query: params.query as unknown as estypes.QueryDslQueryContainer`

So the name is right, but Elasticsearch rejects the body at character 19 saying `query` is unknown *in the position it arrived*. That is the signature of a double-wrap (`{query: {query: {...}}}`), or a bare clause passed where a wrapped one is expected, or the reverse.

**The comparison that should crack it.** The sibling `elasticsearch_search` (`packages/mcp-server-elastic/src/tools/core/search.ts:32`) takes `query` the same way and works correctly. Diff the two call paths; whatever differs is the bug.

**Repro.** Any elastic sub-agent scenario asking for a large result set, e.g. "retrieve at least 150 documents in one search" against `logs-apm.app.prices_api_v2_service-default` on `eu-b2b`. The model reaches for scroll first and fails.

**Impact.** Investigations still complete because the sub-agent falls back to plain `elasticsearch_search`. The cost is wasted iterations plus a misleading `bad-query` attribution against the model when the tool is at fault. Large-result-set pagination is effectively unavailable.

## Traps this session hit (do not rediscover these)

1. **`elasticsearch_search` takes `query`, NOT `queryBody`.** Zod `.passthrough()` silently drops the wrong key and the search runs UNFILTERED while looking completely normal. This voided a full round of findings before it was caught. Detect with an impossible-filter control test: `{"match_phrase": {"message": "zzz-cannot-exist-12345"}}` must return 0. Memory: `reference_elastic_search_param_is_query_not_querybody`.
2. **The probe CLI cannot pin a deployment.** `probeSubAgent` to `buildProbeState` leaves `targetDeployments` empty, so no `x-elastic-deployment` header is sent and the server falls back to a cluster without the data. Write a caller that sets `targetDeployments: ["eu-b2b"]` and calls `queryDataSource` directly.
3. **`match_phrase` on `message` times out** (`match_only_text`, no positions, 188M docs/index). Cheap alternatives that work: a token `match`, or a `range` on `@timestamp`.
4. **`message` has no `.keyword` sub-field**, so terms aggregations and `term` filters on `message.keyword` silently return nothing.
5. **Root `bun run test` exits 139** (documented Bun runner crash) even when every package passes. Read per-package results, not the root exit code.
6. **`packages/gitagent-bridge` must be in the test sweep.** It holds the persona-export pin; skipping it let a CI failure through this session.

## Process notes worth carrying

- Three times this session I attributed my own malformed input to a broken tool before reading its schema. The `queryBody` bug was the costliest. Read the Zod schema first.
- A probe that produces no signal is VOID, not negative. Two runs were misreadable as "the model does not use the tool" when the truth was "the mechanism never got the chance to fire". State the precondition before running, then check it before interpreting.
- Handover docs commit directly to main. This session pushed four docs commits that way; each touched exactly one file.

## Memory references

- `project_context_mode_feasibility_sio1686` (decisions, do-not-do list)
- `reference_sio1688_search_evidence_adoption_unproven` (now RESOLVED; the three fixes that made the probe work)
- `reference_elastic_search_param_is_query_not_querybody` (the `query` trap, directly relevant to SIO-1690)
- `feedback_never_blame_working_code_for_probe_failures`
- `reference_sio1248_inflight_vs_persist_cap_decoupling` (why truncation must never be tightened)
