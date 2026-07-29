# HANDOFF 2026-07-29 — SIO-1270..1273 shipped, two verified live, two gaps remain

| | |
|---|---|
| **Date** | 2026-07-29 |
| **Tickets** | [SIO-1270](https://linear.app/siobytes/issue/SIO-1270) · [SIO-1271](https://linear.app/siobytes/issue/SIO-1271) · [SIO-1272](https://linear.app/siobytes/issue/SIO-1272) · [SIO-1273](https://linear.app/siobytes/issue/SIO-1273) |
| **Parent** | `experiments/HANDOFF-2026-07-28-replay-verification-findings.md` — the write-up that identified all four |
| **Repo state** | `main` at `e1aa644a`; all four PRs merged ([#513](https://github.com/zx8086/devops-incident-analyzer/pull/513), [#514](https://github.com/zx8086/devops-incident-analyzer/pull/514), [#515](https://github.com/zx8086/devops-incident-analyzer/pull/515), [#516](https://github.com/zx8086/devops-incident-analyzer/pull/516)). **`1e961acf` (SIO-1277, [#518](https://github.com/zx8086/devops-incident-analyzer/pull/518)) landed between the four merges and this document** — see "Correction: how #518 actually interacts". |
| **Linear** | SIO-1270 + SIO-1271 **Done**; SIO-1272 + SIO-1273 moved back to **In Review** (2026-07-29) because their live gaps are open. See "Linear status — resolved" below. |
| **Amended** | 2026-07-29, post-merge. Five source corrections applied; original content otherwise preserved verbatim. |
| **Suggested branch** | `claude/sio-1272-1273-live-verification` for the remaining gaps |

---

## TL;DR

All four defects from the 2026-07-28 handover are fixed and on `main`, each **CodeRabbit-reviewed before merge** — the gap that let the previous wave ship unreviewed.

Two are verified end-to-end against live infrastructure. **Two are not**, and that is the only work left:

- **SIO-1270 VERIFIED** — forced the judge timeout deliberately; the report now carries a non-asserting caveat with an unchanged cap.
- **SIO-1271 VERIFIED** — twice, including on a run where the judge ran and failed. No judge JSON reaches the browser.
- **SIO-1272 NOT VERIFIED** — needs a busy estate that spends the run-wide backstop *during* an ECS enumeration. Neither replay hit it.
- **SIO-1273 PARTIAL** — happy path confirmed (`Confidence: 0.78` parsed). The absent-line branch never ran, and **the original "why was the line dropped?" question is still unanswered**.

Success for the next session: close the two gaps, or consciously accept them as test-covered-only.

**Read "Correction: how #518 actually interacts" before replaying anything.** SIO-1277 landed after these four merged and changed what the absence judge sees. It does not conflict with any of them, but it changes how a fresh timeout should be interpreted — which bears directly on Gap C.

---

## What shipped

```
66f8f78d SIO-1273: an absent confidence line is not a confidence of zero (#516)
6cdc76f2 SIO-1272: stop the run-wide backstop from destroying the ECS absence exit (#515)
41a0a504 SIO-1271: stop streaming judge JSON to the browser (#514)
4f1d8bed SIO-1270: stop a failed absence judge from manufacturing a false caveat (#513)
```

Per-ticket detail lives in the Linear comments (added 2026-07-29) — they carry the full rationale, the deliberate non-choices, and the verification evidence. This document covers what a fresh session needs that the tickets do not.

---

## Three places the 2026-07-28 handover was WRONG

These matter because a future reader may trust that document. All three were verified against source, not argued.

### 1. SIO-1272's prescribed fix regresses SIO-1268

The handover's Option 1 says to add the ECS list tools to `GENERIC_GUARD_EXEMPT_TOOLS`. **Do not.** That set is checked FIRST in `shouldShortCircuit` and returns `false` unconditionally:

```ts
// packages/agent/src/sub-agent-loop-guard.ts, generic branch
if (GENERIC_GUARD_EXEMPT_TOOLS.has(toolName)) return false;   // <-- returns before the next line
if (AWS_ABSENCE_BLOCKED_TOOLS.has(toolName) && awsEcsAbsenceProven(state)) return true;  // SIO-1268
```

So it would also bypass the SIO-1268 absence block and silently disable the early exit. **Proven empirically**: applying that change turns `"a proven absence STILL blocks an ECS list call"` red. That test exists so the mistake cannot be made quietly.

The shipped fix is a separate `RUN_BACKSTOP_EXEMPT_TOOLS` checked *after* the absence block and the duplicate check.

### 2. `aggregator.test.ts:1211` must be PRESERVED, not updated

The handover implies SIO-1273 changes it. It pins a **SIO-1194** property — a degenerate annotated line can never leak the pre-cap number — and `0` is the correct answer *for the wrapper*. Changing it would retire a safety property from a different ticket. New coverage is additive, on `findConfidenceScore`.

### 3. SIO-1271 needed no live probe

The handover treats role-tag propagation as an open risk requiring verification. It is provable from the pinned `@langchain/core`: `base.cjs:141-142` → `chat_models.cjs:97/157/257` → `event_stream.cjs:93,132-133`. Reading the dependency turned a gamble into a fail-safe design.

---

## Two things the handover MISSED

**SIO-1272's pre-emption is self-amplifying.** A backstop stop on an ECS list latches `awsEcs.failed`, and `awsEcsAbsenceProven` returns `false` forever once set. The exit is not delayed — it is **permanently destroyed** for that estate, and the agent keeps hunting, raising `totalUnproductive` further.

*Amended 2026-07-29:* there are **five** independent one-way latch sites, not one. Nothing anywhere resets `failed`:

| Site | Trigger |
|---|---|
| `sub-agent-loop-guard.ts:612` | `awsErrorKind(content) !== null` |
| `sub-agent-loop-guard.ts:617` | unparseable result |
| `sub-agent-loop-guard.ts:621` | `"_truncated" in obj` |
| `sub-agent-loop-guard.ts:647` | `list_services` page with no attributable `cluster` arg |
| `sub-agent-instrumentation.ts:219` | guard-stop path — the one SIO-1272 exists to avoid |

Read site `sub-agent-loop-guard.ts:665-667` (`if (!e.enabled || e.failed || e.matched) return false;`) is permanent for that estate's `LoopGuardState`.

**This matters for Gap A.** Four latches *other than* the SIO-1272 one can still destroy the exit. So a Gap A repro that fails to see `subagent.aws_service_absent_early_exit` does **not** by itself indicate the SIO-1272 fix is wrong — check *which* latch fired before concluding anything.

**`topic-shift/+server.ts:89`** carries the same `finalAnswer !== responseContent` guard as `stream/+server.ts:227`, so SIO-1271's behaviour change affects both paths.

---

## Correction: how #518 actually interacts

*Added 2026-07-29, after `1e961acf` (SIO-1277, #518) landed.*

The session that wrote this document described #518 as "letting the absence judge see discovery, which plausibly affects **how often the judge produces a verdict at all**, and therefore how often SIO-1270's path is reachable."

**The first half is right; the causal link is not.** `judgeContradictedAbsenceClaims` (`absence-judge.ts:201`) is never gated on digest content:

- returns `[]` early **only** when `claims.length === 0` (`:206`)
- returns `null` **only** on LLM error, timeout, or malformed response (`:231-238`, and `mapVerdicts` `:244-283`)
- an empty digest renders the placeholder `"(no data returned by this datasource this turn)"` (`:154`) and **the judge still runs**, just against nothing refutable

So adding `elasticsearch_multi_search` to `TYPED_FINDING_TOOLS` (`sub-agent-instrumentation.ts:74`) changes **verdict quality**, not verdict frequency. The judge now sees contradicting evidence it was previously blind to; it does not run more or less often.

### The real second-order path runs the *opposite* way

Two effects are genuine, and both follow from the digest being bigger, not from any gate:

1. **More input tokens against a fixed deadline.** `ROLE_DEADLINES_MS.absenceJudge` is 8 s (`llm.ts:189`) regardless of digest size, so timeout-to-`null` becomes marginally **more** likely — which makes SIO-1270's non-asserting-caveat path **more** reachable, not less.
2. **Harder truncation of everything else.** `DIGEST_PER_DATASOURCE_CAP_BYTES` (8192, `absence-judge.ts:99`) is divided per deployment at `:160` (`perGroupBudget`), and that budget is now shared with the extra msearch entries — so on a multi-deployment datasource, other entries truncate harder. Each individual entry is separately capped at `DIGEST_PER_ENTRY_CAP_BYTES` (2048, `:98`).

### Why this matters for Gap C

Gap C asks whether PR #511's ERROR block made the 8 s deadline tighter in practice. **#518 is now a live candidate cause for any natural timeout observed from here on.**

Without this note, the next session would read a fresh timeout as *"the deadline was always too tight"* when the honest reading may be *"the digest got bigger on 2026-07-29"*. Distinguish them before acting: compare digest size, not just the timeout's presence. This strengthens the existing instruction not to raise `ROLE_DEADLINES_MS.absenceJudge` — there is now a second explanation to rule out first.

---

## Live verification — what was actually run

Both replays ran on merged `main` `66f8f78d` via a worktree web server on `:5174`. **No worktree MCP servers were needed** — unlike the SIO-1264/1265 verification, all four fixes are agent/web-side, so the user's running `:9080`/`:9082` on `main` are correct.

### Run 1 — natural replay

Thread `sio1270-1273-replay`, runId `13bba57c-d339-487c-811b-2db1c6d0c826`. 4 datasources, 180 tool calls, ~5 min.

- **SIO-1271 PASS** — `verdicts` and `contradictedByData` both absent from the concatenated `message` stream.
- **SIO-1273 happy path** — `confidence: 0.78`, line present, parsed correctly, diagnostic did not fire.
- **SIO-1270 not exercised** — no absence claim arose, so the judge never ran (`judge verdicts`: 0 occurrences). **The conclusion is right; the method is not — see below.**
- **SIO-1272 not exercised** — backstop never armed during enumeration.

> **Amended 2026-07-29 — do not reuse that grep as-is.** `"judge verdicts"` is emitted at `absence-judge.ts:281`, inside `mapVerdicts`, i.e. **only on the success path**. Every `null` return — LLM error, timeout, malformed JSON, verdict-count mismatch, duplicate index — logs a *different* message and never reaches it.
>
> The Run 1 conclusion still holds, but for a different reason than stated: no absence claim arose, so `claims.length === 0` returned `[]` at `:206` **before any LLM call**. Zero occurrences of `"judge verdicts"` proves the judge never reached a usable verdict — **not** that it never ran.
>
> That distinction is exactly the SIO-1270 scenario (judge ran, then failed), so the naive grep would give a false negative on the very case this ticket is about. A future session must also check `"absence judge failed"` (`:236`) and `"absence judge response unusable"` (`:259`).

### Run 2 — deliberate fault injection (SIO-1270)

Thread `sio1270-forced-timeout`, runId `e71cf40f-336d-4926-a8c8-9d01129bf751`, requestId `784ec649-e487-4fd5-bbaf-92292f0710fd`.

**No source edit was needed.** `getRoleDeadlineMs` already has a per-role env override:

```ts
// packages/agent/src/llm.ts — the seam
const envKey = `AGENT_LLM_TIMEOUT_${roleToEnvSegment(role)}_MS`;
```

So `AGENT_LLM_TIMEOUT_ABSENCE_JUDGE_MS=1` forces a 1 ms deadline the judge cannot meet, with the source tree pristine throughout. **Use this seam for any future role-deadline fault injection** — never edit `ROLE_DEADLINES_MS` locally.

Result:

```
error: "LLM call for role 'absenceJudge' exceeded deadline of 1ms"
absenceJudgeFailed: true, absenceJudgeUsed: true
cap: 0.59, originalScore: 0.74, cappedScore: 0.59
capReasons: ["premature-absence"], lowConfidence: true
```

| Assertion | Result |
|---|---|
| `"returned data matching this claim"` | 0 occurrences |
| `"Treat the returned data as ground truth"` | 0 occurrences |
| `"did not complete this turn"` | 2 (both flagged claims) |
| Cap value / reasons | unchanged |
| Log message | non-asserting variant fired; asserting one did not |
| Claim lines | unmutated (SIO-1242 invariant intact) |

---

## The remaining work

### Gap A — SIO-1272 has never run live

**What is needed:** an incident across several datasources where gitlab/elastic calls return empties (raising `totalUnproductive` toward `MAX_UNPRODUCTIVE_PER_RUN = 8`) *while* an ECS enumeration is still in flight, against an estate with enough clusters that the enumeration has not finished.

**Confirm:** `runState.loopGuard.awsEcs.failed` stays `false`, no `subagent.loop_guard_stop` with `reason: "unproductive-streak"` on `aws_ecs_list_clusters`/`aws_ecs_list_services`, and `subagent.aws_service_absent_early_exit` fires.

`eu-oit-prd` has 7 clusters / 21 services (observed in run 2), so it is a plausible target. The difficulty is arranging enough *unproductive* non-AWS calls in the same turn.

### Gap B — SIO-1273's absent-line branch, and the unanswered root cause

The branch is hard to force by design: it needs the **model** to omit a line the prompt mandates. Do not fake it.

The diagnostic shipped in #516 is the instrument. When a report next omits the line, `logger.warn` records:

| Field | Reads as |
|---|---|
| `stopReason` | `max_tokens` proves truncation outright |
| `outputTokens` vs resolved `maxTokens` | at the ceiling ⇒ truncation |
| `answerTail` (last 200 chars) | mid-sentence ⇒ truncation; clean ⇒ omission |
| `mentionsConfidence` | `false` on a long report ⇒ model omission |
| `answerChars` | *(amended — was missing from this table)* total length; corroborates `outputTokens` |

All five are logged at `aggregator.ts:1660-1664`. Exact grep string (`:1666`):

```
Report omitted the required Confidence line -- score defaulted to 0 (SIO-1273)
```

**Truncation and omission need opposite fixes** (raise `maxTokens`/hoist the line earlier vs strengthen the prompt), which is why #516 deliberately ships no repair. The first hit answers the question.

### Gap C — the SIO-1270 deadline question, still open

The original ticket asks whether PR #511's ERROR block made the 8 s deadline tighter in practice. **Run 2 says nothing about this** — it used a 1 ms deadline. Needs a natural-timeout observation. Until then, do not raise `ROLE_DEADLINES_MS.absenceJudge`: once a timeout is harmless (which it now is), raising it is a pure latency cost that would also mask the signal.

---

## Linear status — resolved

All four auto-flipped to **Done** when their merged PR links attached (`reference_linear_pr_link_auto_transitions_to_done`) — not a deliberate call.

**Resolved 2026-07-29 on the user's instruction:**

| Ticket | Status | Why |
|---|---|---|
| SIO-1270 | **Done** | Verified live (forced timeout) |
| SIO-1271 | **Done** | Verified live, twice |
| SIO-1272 | **In Review** | Acceptance criterion 2 unmet — no live run reached the fixed path |
| SIO-1273 | **In Review** | Acceptance criterion 2 unmet live, and fix item 2 (*why* the line dropped) still unanswered |

Each reopened ticket carries a comment naming its closing condition. **Do not move them to Done without the user's approval** — and note the trap: re-attaching a merged PR link can auto-flip them again.

Rationale, so the alternatives are not re-litigated: leaving them Done and relying on the ticket comments would put the caveat only where someone is already reading carefully — and status fields get trusted precisely when nobody has time to read comments. Splitting the unverified halves into follow-ups would create two issues whose only content is "the thing the original said it did."

---

## Files changed (all merged)

| File | Change | Ticket |
|---|---|---|
| `packages/agent/src/aggregator.ts` | non-asserting notes + `judgeFailed` options param; conditional cap log; `findConfidenceScore`; missing-line caveat + diagnostic | 1270, 1273 |
| `packages/agent/src/absence-judge.ts` | `reason` optional in both schemas; brevity instruction in both prompts | 1270 |
| `packages/agent/src/llm.ts` | `tags: ["role:<role>"]` + `metadata: { role }` in `buildChatModel` | 1271 |
| `apps/web/src/lib/server/sse-pump.ts` | `OUTPUT_ROLES` / `NON_STREAMING_ROLES`; role-first filter with subtractive fallback | 1271 |

*Amended on the `sse-pump.ts` row:* "subtractive fallback" understates the design. When a role **is** present the decision is **purely additive** — `OUTPUT_ROLES.has(role)` (`:197`) — so any role not on that list is silent by default. `NON_STREAMING_ROLES` is consulted **only** on the no-role fallback (`:198-207`), per its own comment at `:53-54`. Consequence worth knowing: **a future judge role leaks nothing even if nobody remembers to add it to `NON_STREAMING_ROLES`.**
| `packages/agent/src/sub-agent-loop-guard.ts` | `RUN_BACKSTOP_EXEMPT_TOOLS` + guard reorder | 1272 |
| `packages/agent/src/confidence-gate.ts`, `validator.ts` | drop the `> 0` clause (one bug, two places) | 1273 |

New test files: `packages/agent/src/llm.role-tagging.test.ts`.

---

## Verification

```bash
bun run typecheck && bun run lint && bun run test
```

Green on merged `main` — 18/18 packages, lint exit 0. **Run the whole repo suite, not just the touched package**: the CI miss on #511 was exactly that, a new cap-reason code breaking the exact-set assertion in `packages/shared/src/__tests__/confidence.test.ts` while `packages/agent` stayed green. This wave deliberately adds no cap-reason code, so that test should stay untouched — if it goes red, one crept in.

Every fix was confirmed to **go red when reverted** (SIO-1270: 2 failures; SIO-1271: 4; SIO-1272: 2; SIO-1273: 5 across three layers). A passing test that never binds proves nothing.

### Replay recipe

Per `reference_worktree_web_server_replay_env` — `sed`-REPLACE, never append (first key wins, and the ROOT `.env` beats `apps/web/.env`):

```bash
cd <WORKTREE>
cp <MAIN_CHECKOUT>/.env .env
sed -i '' \
 -e 's#^LIVE_MEMORY_ENABLED=.*#LIVE_MEMORY_ENABLED=false#' \
 -e 's#^AGENT_MEMORY_ENABLED=.*#AGENT_MEMORY_ENABLED=false#' .env
echo "KNOWLEDGE_GRAPH_MCP_PORT=9187" >> .env   # absent by default, so append IS correct
cp .env apps/web/.env
(cd apps/web && bun run dev -- --port 5174 &)   # TRACK THE PID
```

Read `type:"message_final"`, **not** the concatenation of `type:"message"`.

Teardown is non-negotiable: kill by tracked PID, then prove `lsof -nP -iTCP:5174 -sTCP:LISTEN` (and 9187) is empty, and `rm .env apps/web/.env && rm -rf apps/web/.data`. **Never touch port 5173** — that is the user's own dev server.

---

## Out of scope

- Re-litigating fail-closed as a policy. It is right for the cap; only the caveat text was wrong, and that is fixed.
- Raising `ROLE_DEADLINES_MS.absenceJudge` — see Gap C.
- The pre-existing `noUnusedFunctionParameters` warning on `reserveSignature`; present on `main` before this wave.
- Building a repair for the missing confidence line before the diagnostic reports back (Gap B).

---

## Related code references (correct — use as patterns)

- `packages/agent/src/llm.ts` — `getRoleDeadlineMs`, the env seam used for fault injection; and `buildChatModel`'s SIO-1226 comment, the precedent for attaching at the model instance.
- `packages/agent/src/sub-agent-loop-guard.ts` — the PR #482 comment on `GENERIC_GUARD_EXEMPT_TOOLS`; the exact precedent SIO-1272 follows, and the trap it must not fall into.
- `packages/agent/src/aggregator.ts` — the SIO-1242 comment on why caveats are *recorded* rather than spliced into the claim line. Any new note must respect it.
- `packages/agent/src/aggregator-grounding-integration.test.ts` — `_setAggregatorLoggerForTesting` is the seam for asserting on log messages; do not spy on the module logger.

## Memory references

`reference_worktree_web_server_replay_env`, `reference_agent_stream_curl_endpoint`,
`reference_sio1266_1268_absence_and_ecs_ledger` (why empty ECS lists must stay productive),
`reference_confidence_two_class_policy_sio1194_1195`, `reference_absence_judge_premature_absence_veto`,
`reference_linear_pr_link_auto_transitions_to_done`, `reference_pr_merge_no_branch_protection_and_worktree_gh_quirk`,
`feedback_always_kill_own_background_processes_safely`, `feedback_repo_is_public_sanitize_before_commit`,
`feedback_validate_every_claim_against_source`, `reference_bun_test_isolate_kills_mock_module_pollution`.
