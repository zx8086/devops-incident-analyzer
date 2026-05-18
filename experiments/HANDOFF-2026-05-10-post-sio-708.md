# Handoff -- post SIO-708 -- Elastic search timeout fix shipped, trust trio next

**Date:** 2026-05-10
**Branch on disk at handoff:** `main` at `ef2b321`
**Working tree:** clean (experiments/ now gitignored per `06ab1c0`)
**Linear status:** SIO-708 **Done** (PR #62 merged 2026-05-10T19:19:18Z)

---

## What this handoff is

Continuation of `HANDOFF-2026-05-10-post-sio-710.md`. That handoff recommended SIO-708 as the next pickup. It shipped this session as PR #62 with the `searchRequestOptions` helper, schema-cap lift, and LLM-facing narrowing guidance. The remaining trust trio (SIO-709 / SIO-711 / SIO-712) is the natural next bundle -- same aggregator surface, same styles-v3 fixture for all three.

The previous handoff is still useful context for SIO-701's IAM blocker and for what *did* close out (SIO-702 is now Done, not "in review" -- update that mental model).

---

## What shipped this session

| PR | Commit | Ticket | What |
|----|--------|--------|------|
| [#62](https://github.com/zx8086/devops-incident-analyzer/pull/62) | `ef2b321` | SIO-708 | `getSearchRequestOptions()` helper (mirrors SIO-690 discovery-options pattern). Per-call `requestTimeout: 60_000` / `maxRetries: 0` on `esClient.search`. `ELASTIC_SEARCH_REQUEST_TIMEOUT_MS` / `ELASTIC_SEARCH_MAX_RETRIES` env tunables. Shared elastic client schema cap lifted 60s -> 120s. Cloud schema unchanged. LLM-facing narrowing guidance in MCP tool description + `agents/incident-analyzer/tools/elastic-logs.yaml` action_descriptions.search. 6 new unit tests in `searchRequestOptions.test.ts`. |
| -- | `06ab1c0` | doc-infra | `experiments/` added to `.gitignore` (closing the gap the previous handoff falsely claimed was already there). Direct-to-main commit. |

Done in Linear. Test counts at session end: agent 275/275, gitagent-bridge 147/147, elastic 135 pass / 2 pre-existing fail (`doc-accuracy.test.ts` import error, `new-configuration-sections.test.ts` LANGSMITH env namespacing -- neither touched by this PR), helper 6/6, workspace typecheck clean across all 12 packages.

The only surprise vs the previous handoff: **the styles-v3 LangSmith trace ID in SIO-708 (`83323f5b-8b69-45d0-bc14-a049b473723c`) was the `request_id` in `custom_metadata`, not the actual `trace_id`.** The real trace ID is `019e12a4-fdc8-73c9-bdf7-8c7f1b39764b`. Both `langsmith trace get` and `langsmith run get` 404 on the request_id; you have to list traces in the time window to find the actual trace_id. The SIO-708 ticket description now records the correct trace_id alongside the request_id.

---

## What's still open

### Theme 1 -- the trust trio (medium impact, harder validation)

| ID | Priority | Title | Status |
|----|----------|-------|--------|
| [SIO-709](https://linear.app/siobytes/issue/SIO-709) | Medium | Aggregator confidence (0.71) too high when critical metrics couldn't be re-verified live | Backlog |
| [SIO-711](https://linear.app/siobytes/issue/SIO-711) | Medium | Aggregator volunteered "not fabricated" -- meta-signal of LLM uncertainty | Backlog |
| [SIO-712](https://linear.app/siobytes/issue/SIO-712) | Medium | GitLab-vs-Couchbase deployment-vs-runtime contradiction recognised in prose but didn't fire a correlation rule | Backlog |

**Bundle. Recommended next pickup as a single PR / single session.**

All three share:
- **Same surface**: `packages/agent/` -- specifically the aggregate node, the report-generation prompt, and the confidence-cap logic. Not Elastic-side.
- **Same fixture**: the styles-v3 transcript (LangSmith trace `019e12a4-fdc8-73c9-bdf7-8c7f1b39764b`). Pull it with `langsmith trace export /tmp/styles-v3 --trace-ids 019e12a4-fdc8-73c9-bdf7-8c7f1b39764b --project devops-incident-analyzer --full` and walk the `aggregate*` runs to get the actual report text the LLM produced.
- **Same shape of fix**: extend the existing aggregator confidence-cap mechanism with new degraded-rule cases (rather than building net-new infrastructure).

**Key correction vs the previous handoff:** SIO-707 already shipped (`PR #56`) the deterministic `confidenceCap: 0.6` when sub-agent `toolErrorRate > 25%`. So:
- SIO-709 is **not "add the cap from scratch"** -- it's "**lower the threshold to 15%** plus add Gaps-section parsing and cross-source contradictions." Read SIO-707's PR before touching this to avoid duplicating the existing cap path.
- The relevant file is whatever PR #56 added the 25% cap in (likely `packages/agent/src/aggregator.ts` or a sibling). Start by reading SIO-707's diff.

#### Per-ticket entry points

- **SIO-709**: AC #1 wants `toolErrorCount / messageCount > 15%` -> cap at 0.6. AC #2 wants Gaps-section parser. AC #3 wants cross-datasource discrepancy detection (overlaps with SIO-712). Regression-test by running the styles-v3 transcript through and asserting confidence drops below the 0.6 HITL threshold.
- **SIO-711**: AC #1 is a system-prompt change ("forbid self-defensive phrases like 'not fabricated', 'I am not hallucinating'"). AC #2 wants a regression test against the exact styles-v3 phrasing. The relevant prompt lives in the aggregator system message -- find the existing anti-hallucination rules and append to them.
- **SIO-712**: New correlation rule class -- **deployment-vs-runtime contradiction**. Extends the SIO-681 `enforceCorrelationsAggregate` framework (existing rules: kafka-significant-lag with elastic-agent finding, etc.). Add a 4th rule pattern: GitLab finding asserts "fix deployed/merged" with timestamp T, AND a datastore finding shows the buggy signature with timestamp > T -> cap at 0.6 + banner.

#### Why bundle

The cap mechanism, the test fixture, and the surface (aggregator) are all shared. Three separate PRs would touch the same files, fight for the same regression-test slot, and need 3x the review effort. One PR with three logical chunks lands cleaner.

### Theme 2 -- cross-account IAM (still blocked)

| ID | Priority | Title | Status |
|----|----------|-------|--------|
| [SIO-701](https://linear.app/siobytes/issue/SIO-701) | High | Apply full-coverage IAM policy to `kafka-mcp-agentcore-role-dev` | Blocked |

Unchanged from previous handoff. Policy JSON staged at `/tmp/kafka-mcp-full-policy.json` (may have rotated; rebuild from the JSON in the Linear description if needed). Runbook at `experiments/SIO-701-iam-policy-runbook.md`. Needs IAM-write credentials in AWS account `352896877281`.

**Indirect effect of SIO-708 shipping:** `ELASTIC_SEARCH_REQUEST_TIMEOUT_MS` is now the per-call knob for elasticsearch_search. If a future live probe (post-SIO-701) shows similar timeouts against `eu-b2b`, lift to 90-120s rather than back to the client-level schema cap.

### Theme 3 -- already closed since the previous handoff

| ID | Title | Status |
|----|-------|--------|
| [SIO-702](https://linear.app/siobytes/issue/SIO-702) | GitLab OAuth refresh-token rotation race | **Done** (PR #55) |
| [SIO-707](https://linear.app/siobytes/issue/SIO-707) | Sub-agent per-failure tool error visibility + 25% confidence cap | **Done** (PR #56) |

Both were "open" in the prior handoff. They're not anymore. Stop tracking.

---

## Recommended pickup order for the next session

1. **Trust trio bundle** ([SIO-709](https://linear.app/siobytes/issue/SIO-709) + [SIO-711](https://linear.app/siobytes/issue/SIO-711) + [SIO-712](https://linear.app/siobytes/issue/SIO-712)). One PR. Shared aggregator surface + shared styles-v3 fixture. Read PR #56's diff first to see where the existing 25% confidence cap lives.
2. **[SIO-701](https://linear.app/siobytes/issue/SIO-701)** -- whenever cross-account access materialises. Live MSK probe also validates the SIO-710 fix end-to-end.

---

## What's worth knowing about SIO-708 (for the next session)

- **Identify-by-trace-id-vs-request-id.** The Linear ticket gave `83323f5b-...` which is the LangGraph `request_id` in `custom_metadata`, not the LangSmith `trace_id`. The actual trace is `019e12a4-fdc8-73c9-bdf7-8c7f1b39764b`. If you `langsmith trace get <request_id>` you'll get `run_count: 0` and assume the trace aged out -- it didn't. The fix: list traces by time window (`--since 2026-05-10T16:00:00Z`) and match by metadata.request_id.
- **Smoking-gun pattern.** All 4 failures hit 30,295-30,301ms exactly (within 6ms of each other), and they were in `Promise.all (index 0..3)` -- one ReAct iteration fanned out 4 parallel heavy aggs and they all hit the **client's 30s `requestTimeout` ceiling** together. Same query shapes issued sequentially in later iterations completed in 5.6-6.5s. **Contention, not infeasibility.** That's why the fix is per-call timeout + LLM-side fan-out guidance, not query rewrite.
- **The successful retry data is gold.** When the SIO-708 trace is replayed:
  - Failed `couchbase_ops,total_couchbase_spans,total_doc_id_fetches,unique_doc_ids` agg on 7d: 30,299ms -> Retry: 5,634ms success.
  - Failed `latency_percentiles,transaction_latency` on 7d: 30,300ms -> Retry: 5,636ms success.
  - That's strong evidence the cluster *can* serve these; the parallel-fan-out was the trigger.
- **SDK options API.** `esClient.search(params, opts)` -- `opts` is `TransportRequestOptions` (from `@elastic/transport`), and it accepts `requestTimeout?: number | string | null` plus `maxRetries?: number`. The existing call site only passed `{ opaqueId }`. SIO-708 added the timeout + retries fields. Pattern is verified typesafe (no `any` casts).
- **Schema cap deliberately asymmetric.** Lifted the elastic client `requestTimeout` cap (line 61) 60s -> 120s. Did NOT lift the cloud client cap (line 143). The cloud client (`cloudClient.ts`) has its own `AbortController`-based timeout for the org-scoped /api/v1 endpoint and isn't on the SIO-708 path.
- **Action YAML's `action_descriptions.search` now uses folded scalar form** (`>-`). The previous prose was a flat string; new content is long enough that yamllint warned about line length. Folded form keeps content readable and silences the warning. If you add more guidance in the trust trio, mirror the folded form.

---

## Don'ts (carry-forward + new)

- **Don't change `MCP_OAUTH_HEADLESS=true`.** Production posture.
- **Don't push directly to main for code changes.** Code goes through PR review. (Doc-infra commits like `chore:` to `.gitignore` are an explicit carve-out per `feedback_handoff_docs_main_branch`.)
- **Don't apply SIO-701 from the user's usual shell** -- wrong AWS account.
- **Don't bundle the trust trio with other tickets.** All three share the aggregator surface; mixing in unrelated work makes the PR untestable as a unit.
- **(SIO-710 carry-forward) Don't reintroduce a `Promise.race` outer timer in `withAdmin`.** Library `timeout` is the only timeout we want; the regression-guard test exists for a reason.
- **(NEW from SIO-708) Don't widen `ELASTIC_SEARCH_REQUEST_TIMEOUT_MS` beyond ~120s.** Values above that hold the ReAct loop hostage on a single tool call. If the agent is still timing out, the right move is to narrow the query (which the new MCP tool description and action YAML now guide the LLM toward) rather than keep raising the ceiling.
- **(NEW from SIO-708) Don't assume the Linear ticket's run ID is a `trace_id`.** Always cross-check by listing traces in the time window first.

---

## Useful pointers for the next session

- **First skills to invoke:** `superpowers:using-superpowers` (always), then `superpowers:brainstorming` for the trust trio (design-led: prompt engineering + new correlation rule shape).
- **First file to read for the trust trio:** PR #56 (SIO-707) diff. That's where the existing 25% `toolErrorRate` confidence cap lives. SIO-709's AC #1 is "lower threshold to 15%" -- you need to find the existing code first.
- **First file to read for SIO-712:** `packages/agent/src/correlations/` (or wherever SIO-681's `enforceCorrelationsAggregate` lives). The new deployment-vs-runtime rule extends the existing rule list, doesn't replace it.
- **Pulling the styles-v3 trace:**
  ```bash
  export LANGSMITH_API_KEY=$(grep "^LANGSMITH_API_KEY=" .env | cut -d= -f2-)
  mkdir -p /tmp/styles-v3
  langsmith trace export /tmp/styles-v3 --trace-ids 019e12a4-fdc8-73c9-bdf7-8c7f1b39764b --project devops-incident-analyzer --full
  # Then: jq -c 'select(.name | test("aggregat"; "i"))' /tmp/styles-v3/*.jsonl  for the aggregator runs.
  ```
- **Verification before claiming done:** every ticket runs `bun run typecheck`, `bun run lint`, and the touched-package tests. Capture actual output -- never claim "tests pass" without it.
- **Pre-existing test failures on main:** ~34, all unrelated -- Konnect/Couchbase live-service integration tests, PII redactor source scans, structured-logging source scans, mcp-server-elastic `doc-accuracy.test.ts` import error + `new-configuration-sections.test.ts` LANGSMITH namespacing assertion, and mcp-server-elastic tests/integration crashes on missing `ES_URL`. Don't be alarmed.

---

## Cross-references

- [PR #62](https://github.com/zx8086/devops-incident-analyzer/pull/62) -- SIO-708 (this session)
- Commit `06ab1c0` (this session) -- `experiments/` gitignore fix
- [HANDOFF-2026-05-10-post-sio-710.md](HANDOFF-2026-05-10-post-sio-710.md) -- previous handoff; still useful for SIO-701's IAM details and the trust trio's original rationale
- [HANDOFF-2026-05-10-post-log-hygiene.md](HANDOFF-2026-05-10-post-log-hygiene.md) -- handoff two-back; original styles-v3 fallout summary
- [SIO-701-iam-policy-runbook.md](SIO-701-iam-policy-runbook.md) -- runbook for the cross-account IAM apply

---

*Handoff produced 2026-05-10 by Claude Opus 4.7 (1M context). One ticket shipped this session (SIO-708 via PR #62) plus a one-line `.gitignore` fix. Three remain from the styles-v3 fallout (SIO-709/711/712 trust trio, recommended as one bundle next session) plus SIO-701 still blocked on cross-account IAM. SIO-702 and SIO-707 have closed since the previous handoff -- drop them from your mental open-tickets list.*
