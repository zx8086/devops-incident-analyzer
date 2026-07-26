# HANDOFF — SIO-1217/1218/1219/1220: streaming, normalizer, and aggregation-budget fixes on PR #475

- **Date:** 2026-07-26
- **Tickets:**
  - [SIO-1217](https://linear.app/siobytes/issue/SIO-1217) — `[object Object]` streaming garbage — **fix merged into this branch, previously merged separately per prior session** (see note below)
  - [SIO-1218](https://linear.app/siobytes/issue/SIO-1218) — Streaming delta chunks garble mid-word (newline spliced into words) — fix on this branch, not yet live-verified after last push
  - [SIO-1219](https://linear.app/siobytes/issue/SIO-1219) — Sonnet 5 normalizer emits unescaped control chars in JSON, crashing runbook selection — fix on this branch, **live-verified working**
  - [SIO-1220](https://linear.app/siobytes/issue/SIO-1220) — `aggregate()` has no deadline awareness, can be hard-aborted mid-LLM-call producing zero answer — fix on this branch, **unit-tested only, NOT live-verified**
- **Parent epic:** none (all four surfaced during live smoke-testing of the SIO-1213 Sonnet 5 model bump)
- **Repo state:** branch `simonowusupvh/sio-1217-fix-object-object-streaming`, HEAD `c9c1afd85fa218ba655f9ff455f4bfde63fbbcab`, PR [#475](https://github.com/zx8086/devops-incident-analyzer/pull/475) (OPEN, `reviewDecision: APPROVED`, all CI checks green, `mergeable: MERGEABLE`).
- **Suggested branch for follow-up:** continue directly on `simonowusupvh/sio-1217-fix-object-object-streaming` — do not open a new branch unless the user explicitly asks for PR #475 to be split.

## TL;DR — what's done / what's next / gotchas hit so far

Four real bugs, all discovered from ONE extended live smoke-testing session (submitting the same `prana-order-service` timeout incident query against the user's local dev server, repeatedly, after the SIO-1213 Sonnet 5 model bump landed). Each was root-caused with actual evidence (log timestamps, `bun -e` repros, git blame) before any fix — the user pushed back hard, twice, on shortcuts (mocked-only verification, and mis-attributing SIO-1219 as "pre-existing" when it was actually caused by this session's own model bump). That discipline is the operating mode for this whole thread; keep it up.

**What's done and pushed (`c9c1afd8`):**
1. `extractTextFromContent()` / `extractStreamDeltaText()` split (SIO-1217/1218) — array-shaped Bedrock content blocks no longer produce `[object Object]`, and streaming deltas concatenate with no separator instead of `\n` (which spliced newlines mid-word).
2. `sanitizeJsonControlChars()` in `normalizer.ts` (SIO-1219) — escapes raw control chars inside JSON string literals before `JSON.parse`, fixing Sonnet 5's tendency to echo multi-line user input unescaped into JSON fields.
3. `hasAggregationBudget()` + `buildDegradedAggregateFallback()` (SIO-1220) — `aggregate()` now checks remaining graph-wide time budget before its LLM call and falls back to a deterministic summary (low fixed confidence, always flags for review) instead of letting the shared `AbortSignal` kill it mid-generation with zero output.

**What's NOT done — this is where the next session picks up:**
1. **CodeRabbit has not reviewed the latest two commits.** Its last review was against `265b8ad9` (SIO-1218). Commits `2e204b44` (SIO-1219) and `c9c1afd8` (SIO-1220) are unreviewed. Follow the CodeRabbit Review Lifecycle in the root `CLAUDE.md` (deterministic SHA-scoped check) before merging.
2. **SIO-1218 (mid-word newline fix) has not been re-verified live** since it was pushed — the live smoke test that ran afterward hit the SIO-1219 crash before any streamed text with multi-block chunks could be visually inspected end-to-end for absence of garbling.
3. **SIO-1220 (aggregation budget fallback) has NEVER been live-verified.** It is unit-tested only (mocked `Date.now()`/injected `GRAPH_DEADLINE_KEY`, not a real timeout). Reproducing a real trigger means deliberately running a ~15-minute investigation to exhaustion — expensive, and the user has explicitly flagged live-run cost as a concern this session. Decide with the user whether to (a) live-verify before merge, (b) merge with this explicitly flagged as an accepted risk, or (c) find a cheaper way to force the budget-tight code path (e.g. temporarily set `GRAPH_DEADLINE_KEY` via an env override to something small and hand-drive a real query — needs a code seam that doesn't exist yet, see "Out of scope").
4. **PR #475 has not been merged.** Per this repo's standing rule, merging requires (a) CodeRabbit fully clear on the latest commit, AND (b) the user's own live-verification for anything the session's discipline calls for — which for this PR now includes SIO-1220 at minimum, arguably SIO-1218 too.

## Context — how this came to be

This started as a routine "check PR #475 for CodeRabbit findings" follow-up on the SIO-1213 (Sonnet 5 model bump) → SIO-1214 (temperature) → SIO-1216 (reasoningContent crash) → SIO-1217 (`[object Object]`) chain from earlier in the same day's work. The user ran a live smoke test on their own dev server after each fix (a hard-won discipline after the temperature and reasoningContent bugs were both merged on unit tests alone and then broke in production). That live-testing loop is what surfaced SIO-1218, SIO-1219, and SIO-1220 — none of them were found by code review or unit tests; all three were found by literally watching the chat UI and the server log while a real query ran against real Bedrock/MCP infrastructure.

Two explicit course-corrections from the user mid-session, both important for how to operate going forward:
- **"can we stop mocking, i think we have it in claude.md, the mocks are not real-life as the errors are not surfaced with the mock tests"** — after I proposed writing more LLM-response-mocking tests for the SIO-1219 fix. Response: stopped mocking LLM behavior entirely for that fix; the only test added exercises `sanitizeJsonControlChars` as a pure string function against the literal byte pattern from the real error log.
- **"but you have run ui changes and check before here"** — after I said I couldn't verify a fix live. Correct: the Claude Browser MCP tools (`mcp__Claude_Browser__*`) were available and had been used earlier in the session; I hadn't reached for them for that particular check. Used them from that point on to actually drive the dev server UI and read real server logs.

## Where the bodies are buried

### SIO-1217/1218 — `packages/agent/src/message-utils.ts`
```typescript
function isTextBlock(block: unknown): block is MessageContentText {
	return textBlockSchema.safeParse(block).success;
}

export function extractTextFromContent(content: unknown): string {
	// joins array blocks with "\n" -- correct for a COMPLETE message's distinct
	// logical blocks (aggregator's final answer, prior assistant messages)
	...
}

export function extractStreamDeltaText(content: unknown): string {
	// joins array blocks with "" -- correct for a STREAMING DELTA chunk's
	// contiguous text fragments (sse-pump.ts's on_chat_model_stream handler)
	...
}
```
`apps/web/src/lib/server/sse-pump.ts:176` calls `extractStreamDeltaText`, NOT `extractTextFromContent`, for the `on_chat_model_stream` handler. Every other call site (`aggregator.ts:146,1210`, `iac/nodes.ts` ×9, `responder.ts`, `normalizer.ts`, `mitigation-branches.ts`, `mitigation.ts`, `entity-extractor.ts`, `runbook-selector.ts`, `validator.ts`, `sub-agent.ts`) still uses `extractTextFromContent` — that's correct and must stay that way; they're all complete-message call sites.

### SIO-1219 — `packages/agent/src/normalizer.ts`
```typescript
export function sanitizeJsonControlChars(text: string): string {
	// char-by-char, tracks quote state + backslash-escapes, escapes raw \n/\r/\t
	// found INSIDE a string literal before JSON.parse sees it
}
...
const parsed = NormalizationSchema.parse(JSON.parse(sanitizeJsonControlChars(jsonMatch[0])));
```
Root cause chain (verified via two separate real-log traces, not guessed):
1. SIO-1213 bumped `incident-analyzer/agent.yaml` preferred model `claude-sonnet-4-6` → `claude-sonnet-5`.
2. `normalizer.ts`'s `createLlm("normalizer")` picks up that model.
3. Given a multi-line pasted incident query, Sonnet 5 echoes raw text verbatim into a JSON string value without escaping embedded control chars — Sonnet 4.6 apparently didn't do this with the identical prompt.
4. `JSON.parse` correctly rejects the malformed JSON.
5. `normalizeIncident`'s own try/catch already failed safe (`return {}`), but the missing `severity` then hit `runbook-selector.ts:214-222`'s **intentional** `enterFallback` "refusing to guess" throw two nodes later. That throw is correct and untouched by this fix — see `packages/agent/src/runbook-selector.ts:208-236`.

### SIO-1220 — `packages/agent/src/graph-budget.ts` + `packages/agent/src/aggregator.ts`
```typescript
// graph-budget.ts
const AGGREGATION_MIN_RUNWAY_MS_DEFAULT = 30_000;
export function hasAggregationBudget(deadlineAt, now = Date.now(), env = process.env): boolean { ... }

// aggregator.ts, top of aggregate()
const deadlineAt = getGraphDeadlineAt(config);
if (!hasAggregationBudget(deadlineAt)) {
	return buildDegradedAggregateFallback(results, skillsApplied);
}
```
Exact real-trace timeline that motivated this (all timestamps from one live run, thread `30e55538-df31-4c2f-96a9-b404a4f2124f`, run `622097c5-99e7-46c0-b5d1-c3ee962c2751`):
- `12:36:23` run start → deadline = `12:36:23 + 900s` = `12:51:23` (`DEFAULT_GRAPH_TIMEOUT_S=900` in `apps/web/src/lib/server/agent.ts:155`)
- `12:36:45` GitLab first attempt starts, uncapped at 360s (ample budget at dispatch time)
- `12:42:45` GitLab first attempt fails (`duration: 360035`ms — burned its full timeout)
- `12:42:45` alignment retry dispatched — `capSubAgentTimeoutMs()` recalculated affordability as 398s (398s > 360s base), so still uncapped at 360s
- `12:48:45` retry also fails (`duration: 360027`ms)
- `12:48:45` only ~158s remain before `12:51:23` deadline; `aggregate()` starts its LLM call anyway (no deadline awareness existed before this fix)
- `12:51:24` `TimeoutError: The operation was aborted due to timeout` — the aggregation call needed 159s+ and was hard-killed, producing **zero output** for a 15-minute investigation

`capSubAgentTimeoutMs`/`hasRetryBudget` (both in `graph-budget.ts`) were verified working exactly as designed — this is NOT a bug in that mechanism. The gap was narrowly that `aggregate()` (`llm.ts:110`, `ROLE_DEADLINES_MS.aggregator = 0`) is deliberately exempt from the per-role deadline and has no other safety net.

## The fix — step by step (for reference; already implemented and pushed)

All four fixes are already implemented on `c9c1afd8`. Nothing further to implement unless CodeRabbit's next review or live verification surfaces something. If a `git reset`/rebase ever loses this work, reconstruct from these SHAs on `simonowusupvh/sio-1217-fix-object-object-streaming`:
- `1771683b` — SIO-1217 first pass
- `3f34dc9a` — SIO-1217 remaining `String(.content)` sites + hardened `extractTextFromContent`
- `d9d87f61` — SIO-1217 never-fall-through-to-`String()` fix (CodeRabbit round 2)
- `883c8e7a` — SIO-1217 Zod `safeParse` for text-block validation (CodeRabbit nitpick)
- `265b8ad9` — SIO-1218 `extractStreamDeltaText` split
- `2e204b44` — SIO-1219 `sanitizeJsonControlChars`
- `c9c1afd8` — SIO-1220 `hasAggregationBudget` + `buildDegradedAggregateFallback`

## Verification

```bash
# From repo root
bun run typecheck && bun run lint && bun run test
```
Last run (this session, HEAD `c9c1afd8`): typecheck clean across all 18 packages, lint clean (10 pre-existing unrelated warnings only), full test suite green — `packages/agent`: 2799 pass / 64 skip / 0 fail across 165 files; `apps/web`: 266 pass / 0 fail across 32 files.

**Manual/live probes still needed (see "What's NOT done" above):**
```bash
# 1. Re-check CodeRabbit's review state for the latest SHA (deterministic check per CLAUDE.md)
LATEST_SHA=$(gh pr view 475 --repo zx8086/devops-incident-analyzer --json commits --jq '.commits[-1].oid')
gh api "repos/zx8086/devops-incident-analyzer/pulls/475/reviews" \
  --jq ".[] | select(.user.login==\"coderabbitai[bot]\" and .commit_id==\"$LATEST_SHA\")"
# Empty result = still pending for c9c1afd8/2e204b44. If empty, corroborate with
# gh pr view 475 --json reviewDecision,mergeable,statusCheckRollup before concluding "clear"
# (see CLAUDE.md's "CodeRabbit Review Lifecycle" section for the full decision tree).

# 2. Live smoke test (dev server must be running with this branch's code):
#    Submit the same query used throughout this session:
#    Investigate the "prana-order-service" service for the error and error exception message below :-
#    "Couldn't fetch seasons by company code: CK and season types: [DIVISIONAL, OUTLET]"
#    "I/O error on GET request for ""https://gateway.prd.shared-services.eu.pvh.cloud/v3/seasons/CK/seasons"":
#    Timeout deadline: 180000 MILLISECONDS, actual: 180000 MILLISECONDS"
#    Watch for: (a) no RunbookSelectionFallbackError [SIO-1219 already confirmed fixed],
#    (b) no "[object Object]" anywhere in the streamed bubble [SIO-1217, confirmed],
#    (c) no mid-word newlines in the streamed text [SIO-1218, NOT yet re-confirmed after last push],
#    (d) a complete final report (SIO-1220 can only be confirmed by triggering the slow-GitLab
#        scenario again, which is the expensive part -- discuss cost/approach with the user first).
```

## Files to modify (already done — reference only)

| File | Package | Change |
|---|---|---|
| `packages/agent/src/message-utils.ts` | agent | `extractStreamDeltaText()` added alongside `extractTextFromContent()`; Zod-based `isTextBlock` |
| `packages/agent/src/message-utils.test.ts` | agent | Tests for both extraction functions |
| `packages/agent/src/index.ts` | agent | Export `extractStreamDeltaText` |
| `apps/web/src/lib/server/sse-pump.ts` | web | Use `extractStreamDeltaText` instead of `extractTextFromContent` for streamed chunks |
| `apps/web/src/routes/api/agent/stream/server.test.ts` | web | Mock updated with both extraction functions; new same-chunk multi-block E2E test |
| `packages/agent/src/normalizer.ts` | agent | `sanitizeJsonControlChars()` added and wired before `JSON.parse` |
| `packages/agent/src/normalizer-sanitize.test.ts` | agent | New file, 6 tests for the sanitizer |
| `packages/agent/src/graph-budget.ts` | agent | `hasAggregationBudget()` + `getAggregationMinRunwayMs()` added |
| `packages/agent/src/graph-budget.test.ts` | agent | Tests for the new functions |
| `packages/agent/src/aggregator.ts` | agent | `buildDegradedAggregateFallback()` added; `aggregate()` checks budget before LLM call |
| `packages/agent/src/aggregator.test.ts` | agent | Tests for the fallback builder + integration tests for the budget-check branch |
| `CLAUDE.md` (root) | — | New "CodeRabbit Review Lifecycle" section documenting the deterministic SHA-scoped completion check (added mid-session after repeated inefficient polling) |

## Workflow

- Branch: already on `simonowusupvh/sio-1217-fix-object-object-streaming`, do not branch off main again for this work.
- Linear: SIO-1217/1218/1219/1220 are all currently **Backlog** status — none moved to In Progress/In Review/Done. Do not set any to Done without explicit user approval per the global rule.
- Commit message pattern used throughout: `SIO-XXXX: <summary>` body explaining root cause + fix, `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` footer.
- Next CodeRabbit round: if new findings appear, follow the same verify-with-`bun -e`-before-fixing discipline used for every prior round on this PR (comment_id=3652123185 is a good example of the pattern: verified the exact byte behavior before touching code).
- Merge: only after (a) CodeRabbit clears the latest SHA, (b) the user has live-verified SIO-1218 and SIO-1220 (or explicitly accepts the residual risk on SIO-1220), per the "NEVER merge with a CodeRabbit report pending" + live-smoke-test discipline established this session.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| SIO-1220's fallback path has a bug that only surfaces under real timeout conditions (not exercised by mocked-`Date.now()` unit tests) | Medium | Live-verify before merge, or accept as a known gap and monitor `logger.warn("Insufficient graph budget for aggregation...")` in prod logs post-merge |
| `AGGREGATION_MIN_RUNWAY_MS_DEFAULT=30_000` (30s) might be too small for the deterministic fallback + downstream nodes (`extractFindings`/`checkConfidence`/`validate`/mitigation) to actually complete before the hard deadline | Low-medium | Not measured with a real trace; the 30s figure was reasoned from "no LLM call needed" but downstream nodes still run. Watch first few prod occurrences, tune via `AGGREGATION_MIN_RUNWAY_MS` env if the fallback path itself still gets aborted |
| Other in-flight, unrelated files show as modified in `git status` (`classifier.ts`, `correlation/*.ts`, `record-bindings.ts`, `supervisor-router.test.ts`, kafka/aws/couchbase test files, `CLAUDE.md`, `biome.json`, `bun.lock`, `package.json`, `apps/web/src/lib/stores/agent.svelte.ts`, `apps/web/src/routes/+layout.svelte`) | N/A — pre-existing | These predate this session (present in the very first `git status` at session start) and were never touched here. Do NOT assume they're part of this PR's diff; check `git diff main...HEAD -- <file>` per-file before including/excluding anything in a future commit |
| CodeRabbit review for `c9c1afd8` may surface findings requiring another fix→push→re-review cycle | Expected | Standard flow; see root `CLAUDE.md`'s CodeRabbit Review Lifecycle section |

## Out of scope (do not fold into this PR without discussing first)

- Any further model-behavior differences between Sonnet 4.6 and Sonnet 5 beyond the two already found (temperature rejection [SIO-1214], JSON control-char escaping [SIO-1219]) — if a new one surfaces, treat it as its own ticket.
- A code seam to deliberately force `aggregate()`'s budget-tight path for cheap live verification (e.g. an env var to shrink `GRAPH_DEADLINE_KEY` mid-run, or a way to inject an artificial sub-agent delay) does not exist yet. If the user wants to live-verify SIO-1220 cheaply, this would need to be designed first — don't build it silently as a side effect of verification.
- Tuning `GRAPH_BUDGET_RESERVE_MS_DEFAULT` (120s) or `DEFAULT_GRAPH_TIMEOUT_S` (900s) — deliberately left untouched this session; SIO-1220's fix is an independent second safety net, not a replacement for those constants. Revisit only if the live trace shows the 30s `AGGREGATION_MIN_RUNWAY_MS_DEFAULT` is also insufficient.
- The pre-existing modified files listed in the Risks table — unrelated to this work, do not touch without separately understanding what they are.

## Related code references

- `packages/agent/src/runbook-selector.ts:208-236` — `enterFallback()`, the reference pattern for a safe non-LLM fallback that SIO-1220's `buildDegradedAggregateFallback()` follows. Do not weaken its "refusing to guess" throw when severity is missing — that was explicitly discussed and rejected as a fix shape for SIO-1219.
- `packages/agent/src/graph-budget.ts:38-65` — `getGraphDeadlineAt`, `hasRetryBudget`, `capSubAgentTimeoutMs` — the pre-existing budget-accounting primitives SIO-1220 extends (not replaces).
- `packages/agent/src/llm.ts:106-137` — `ROLE_DEADLINES_MS`, including the deliberate `aggregator: 0` opt-out and its comment explaining why.
- `packages/agent/src/sub-agent.ts:960-964` — the ONE call site that actually applies `capSubAgentTimeoutMs`; confirms the mechanism is correctly wired at the sub-agent layer (ruled out as the bug's location).
- `apps/web/src/lib/server/agent.ts:150-165,390-410` — `getGraphTimeoutMs()` and where `GRAPH_DEADLINE_KEY`/the shared `AbortSignal` are set once per run.

## Memory references

- `reference_sio1204_network_map_feature.md` and other network/AWS memory files are unrelated to this thread — do not conflate.
- No pre-existing memory file covers this specific SIO-1213 Sonnet-5-model-bump-side-effects investigation; consider writing one (`project_sio1213_sonnet5_side_effects.md` or similar) if this pattern (new model version → new failure mode → live-smoke-test-driven fix) recurs on a future model bump, since it happened three times in one day here (temperature, reasoningContent, normalizer JSON).
- `feedback_validate_every_claim_against_source.md` (existing memory) is directly relevant — this whole session was a live demonstration of that principle after two direct user corrections (stop mocking; use the browser tool you already have).
