# Handover: SIO-1836 Jev epic, session of 2026-09-21

- **Date**: 2026-09-21
- **Epic**: [SIO-1836](https://linear.app/siobytes/project/devops-incident-analyzer-02f717a4b59a) Jev (TypeSafe System One) integration
- **Repo state at handover**: `main` at `6206a2b3`; branch `simonowusupvh/sio-1864-keywords-zero-coverage` at `933630af` (PR #878, awaiting a Greptile re-review after a P1 fix)
- **Suggested branch for next work**: `simonowusupvh/sio-1864-eval-verification` off merged main

## TL;DR

Five PRs shipped, all Greptile-clean, all verified by live probe rather than CI alone.
The Jev action selector and Atlassian rerank are both live and measured: **82% of
actions dropped at p50 ~300 ms for ~$0.002 a run**, and the rerank fired in production
for the first time. The eval baseline is **`expected_tools_fired` 0.931** with five
evaluators at 1.000. Nothing is blocked. The one task genuinely worth doing next is
re-running the eval to confirm PRs #877 and #878 did not regress that 0.931.

## What shipped (all merged unless noted)

| PR | Ticket | What |
|---|---|---|
| [#874](https://github.com/zx8086/devops-incident-analyzer/pull/874) | SIO-1861 | Rerank threshold calibrated on real Jira tickets; value unchanged at 1.0, now evidenced |
| [#875](https://github.com/zx8086/devops-incident-analyzer/pull/875) | SIO-1862 | Selector scores order the tool-budget cut; + Greptile P1 (keyword tier stays above score tier) |
| [#876](https://github.com/zx8086/devops-incident-analyzer/pull/876) | SIO-1863 | Widen the search window when retrieval is empty; + Greptile P1 (do not widen on a partial failure) |
| [#877](https://github.com/zx8086/devops-incident-analyzer/pull/877) | SIO-1864 | Selector uses `action_descriptions`, which already existed and were ignored |
| [#878](https://github.com/zx8086/devops-incident-analyzer/pull/878) | SIO-1864 | `action_keywords` 20/72 -> 72/72; + Greptile P1 (`sql++` could never match) — **OPEN, re-review pending** |

## Measurements to carry forward

**Eval baseline** (experiment `mcp-tool-eval-eff6623f`, 25 examples, selector ON):

| evaluator | mean |
|---|---|
| expected_tools_fired | **0.931** |
| datasources_covered / confidence_threshold / tool_arg_validity / tool_name_validity / tool_data_utilization | 1.000 |
| tool_response_health | 0.917 |
| tool_efficiency | 0.337 |

**Seam behaviour** (`data/decision-metrics.sqlite`, 70 rows, zero failures):

- `action-selector`: 69 applied, p50 ~300 ms, 82% of actions dropped, ~$0.002/run
- `atlassian-rerank`: 1 applied, 647 ms, 12 in / 2 dropped, **rank correlation 0.673**
  (well below 1.0, so Jev genuinely reorders rather than echoing the deterministic pass)

## Tasks for the next session

### 1. Re-run `mcp-tool-eval` and compare against 0.931 (RECOMMENDED)

The acceptance criterion on SIO-1864. ~70 minutes, unattended.

```bash
cd packages/agent && timeout 7200 bun --env-file=/Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer/.env \
  run src/eval/run-mcp-tool-eval.ts > /tmp/eval.log 2>&1; echo "EXIT=$?" >> /tmp/eval.log
```

Then fetch scores — **root runs only**, or it enumerates ~3500 children and times out:

```ts
for await (const r of c.listRuns({ projectId: SESSION, isRoot: true })) ids.push(r.id);
// then listFeedback({ runIds }) in chunks of ~25
```

Gotchas that cost this session hours, all now in memory:
- The dataset is **25 examples, not 28** — the source-file count lies; read it from LangSmith.
- Scores exist **only after the whole run completes**; a killed run leaves thousands of traces and zero feedback.
- `scripts/decision-metrics-report.ts --since` parses **local** time; pass a full ISO string with `Z`.
- Caveat on interpretation: this measures #877 and #878 **combined**, not either alone.

### 2. Finish merging PR #878

Greptile re-review was running at handover. If clean, merge. If it finds more, the P1 pattern
holds: verify with a live repro before applying.

### 3. Optional, lower value

- **SIO-1840 tier flip** (`AGENT_LLM_TIER_ENTITY_EXTRACTOR=light`): parked by the user.
  My recommendation is still *don't* — the extractor scored 25/25 on datasource recall, and
  light tier means **bare Haiku with no fallback chain** (`llm.ts:360-367`), an availability
  regression for a component that is not broken.
- **Thirteen Tier-2 epic items** (SIO-1841 through SIO-1853), all Low or Medium.

## Decisions needing the user, not a session

- **SIO-1861 and SIO-1863 both show Done** via merge automation while each has a documented
  gap. SIO-1861's fixtures I recommended *dropping* (the tests inject scores and never call
  the API, so committed envelopes would be inert input **and** would put real ticket text in
  a public repo); its four live-replay checks were never run, though the flag-ON case is now
  covered by production evidence. Per the standing rule I did not change either status.

## Where the bodies are buried

- `packages/agent/src/sub-agent.ts` — `buildSelectableActions` (descriptions + keywords),
  `orderByDeclaration` (three tiers: keyword > score > declaration rank)
- `packages/gitagent-bridge/src/tool-mapping.ts` — `matchActionsByKeywords` builds
  `\b<kw>\b`, which is why `sql++` was dead and why singular keywords miss plurals
- `packages/mcp-server-atlassian/src/tools/custom/find-linked-incidents.ts` —
  `WIDENED_WINDOW_DAYS = 120`, retry only when `issues.length === 0 && warnings.length === 0`
- `agents/incident-analyzer/tools/*.yaml` — 72/72 actions now carry keywords
- `data/decision-metrics.sqlite` — the per-decision table; `DECISION_METRICS_DB_PATH` is set
  in the **main checkout's** `.env` (gitignored, not in worktrees)

## Lessons this session paid for (all saved to memory)

1. **`action_descriptions` already existed and the selector ignored it.** Check what the
   repo already declares before writing 52 new things. Measured: `fatal_requests` went from
   outside the top four to the top pick at 0.88.
2. **"Cannot reproduce" is evidence about the harness first.** Omitting `skillToolNames`
   from a replay hid SIO-1862 across four configurations. Reproduce a *number* the log
   reports (`requested: 30`), not the symptom.
3. **Read the call site before filing "X is not handled."** Four times this session the
   guard already existed.
4. **A generic single word is a trap.** `styles` retrieved 10 merchandising tickets the
   reranker dropped 10/10; a bare `scope` would match every report header.
5. **Jev is not always better.** It *loses* to the entity extractor on datasource choice at
   every threshold, because the extractor's imprecision is deliberate correlation policy.

## Verification

```bash
bun run yaml:check
cd packages/agent && bun run typecheck && bun run test        # 4970 pass
cd packages/gitagent-bridge && bun run test                    # 457 pass
bun run scripts/decision-metrics-report.ts --since 2026-09-21T09:50:00.000Z
```

## Memory references

`reference_mcp_tool_eval_scores_and_gotchas`, `reference_jev_action_selector_live_behaviour`,
`reference_jev_loses_to_the_entity_extractor`, `reference_findlinkedincidents_window_not_name`,
`reference_typesafe_outage_fallback_verified`, `reference_jev_seam_conventions`,
`feedback_read_the_mechanism_before_calling_it_missing`,
`feedback_replay_must_pass_every_production_argument`,
`feedback_assert_the_reason_not_just_the_outcome`
