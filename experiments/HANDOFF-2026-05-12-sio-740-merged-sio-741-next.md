# Handoff — 2026-05-12 — SIO-740 merged (PR #83); SIO-741 next

## Where things stand

- **`main` is at `36b4306`** — SIO-740 merged via PR #83 ("surface AgentCore error.message in SigV4 proxy logs"). Local main is clean, no uncommitted work, no straggling branches.
- **SIO-741 is open in Backlog** — https://linear.app/siobytes/issue/SIO-741/split-mitigation-node-into-parallel-investigatemonitorescalate
- Suggested branch (Linear's auto-name): `simonowusupvh/sio-741-split-mitigation-node-into-parallel`
- **Plan file already written**: `/Users/Simon.Owusu@Tommy.com/.claude/plans/sio-741-parallel-mitigation.md` — read this first; it has the verified facts from the scoping pass and resolved design questions.

## Why we're doing this

In the 2026-05-12 17:46–17:52 CEST trace (request `ef57b351-d31e-4234-914f-34907cd4c6f6`), post-validate latency was 24s. Mitigation alone took 22s in one Bedrock call producing 5 investigate + 4 monitor + 4 escalate + 4 runbook items — four independent sub-tasks bundled into one call. Splitting Step 1 into three parallel branches and reusing the upstream `selectedRunbooks` should cut wall time to ~max(individuals) ≈ 8–10s. Step 2 (action proposal) stays sequential because it depends on Step 1's output as context.

This is **latency + LangSmith observability**, not a correctness fix.

## Design decisions already made (don't re-litigate)

The previous session used `AskUserQuestion` to lock these in before writing the plan:

1. **LangGraph `Send[]` pattern, not `Promise.all`** — each branch shows as a named child run in LangSmith. Mirrors the SIO-681 `enforceCorrelationsRouter` / `enforceCorrelationsAggregate` pair already in the codebase.
2. **`relatedRunbooks` reuses upstream `state.selectedRunbooks`** — the runbook-selector node already produces this list; mitigation re-deriving it via LLM was wasteful. Drop runbooks entirely from the three branch prompts.
3. **Action proposal (Step 2) stays sequential** after the parallel block. It only runs when severity ≥ high and uses Step 1 output as context. Parallelising it would risk quality divergence.

## Critical blocker the new session needs to handle first

The current `mitigationSteps` reducer is **replace**, not merge (`packages/agent/src/state.ts:162-165`). Three Send[] writers would clobber each other.

The plan's solution: add a new transient field `mitigationFragments` with an **append** reducer; the three branches write fragments; a downstream aggregator merges fragments + `selectedRunbooks` into the existing `mitigationSteps` shape (which keeps its single-writer invariant). This preserves the public state field and the SSE payload, so frontend stays untouched.

Don't try to make `mitigationSteps` itself mergeable — every consumer assumes replace semantics on a fresh graph run.

## Files the new session will touch

| File | Change |
|---|---|
| `packages/agent/src/state.ts:162` | Add `mitigationFragments` annotation with append reducer + `MitigationFragment` type |
| `packages/agent/src/llm.ts:59` (ROLE_DEADLINES_MS) | Add `mitigateInvestigate`, `mitigateMonitor`, `mitigateEscalate` keys, default 60_000 each (env: `AGENT_LLM_TIMEOUT_MITIGATE_<KIND>_MS`) |
| `packages/agent/src/mitigation-branches.ts` (new) | Three async branch functions; each calls `invokeWithDeadline`, returns `{ mitigationFragments: [{kind, items}] }` or soft-fails with `failed: true` + `partialFailures` entry |
| `packages/agent/src/mitigation.ts:84` (`proposeMitigation`) | Replace body with `aggregateMitigationFragments`: merge fragments → `mitigationSteps`, set `relatedRunbooks` from `state.selectedRunbooks?.map(r => r.filename)`, then run the existing Step 2 action-proposal LLM call sequentially |
| `packages/agent/src/graph.ts:81-121` | Replace single `proposeMitigation` node with three branch nodes + aggregator join; conditional edges from validate dispatch `Send[]` |
| `packages/agent/src/mitigation-branches.test.ts` (new) | Per-branch success + per-branch timeout tests; mock pattern from `mitigation.deadline.test.ts` |
| `packages/agent/src/aggregate-mitigation.test.ts` (new) | Fragment merge, runbook reuse from `selectedRunbooks`, partial-failure handling, Step 2 conditional dispatch |
| `packages/agent/src/mitigation.deadline.test.ts` | Update for new aggregator shape; existing wall-clock test still relevant |
| One graph-level integration test | Assert the 3 Send branches fire and the join waits for all 3 before aggregator runs |

## How to verify it works

1. `bun run typecheck` — workspace clean
2. `bun run lint` — biome clean (the pre-existing error in `packages/mcp-server-couchbase/src/types/mcp.d.ts` from March commit `8cf6dd0b` is unrelated; ignore)
3. `cd packages/agent && bun test` — all green
4. **Manual smoke (the meaningful test)**: trigger a complex Kafka incident in the running web app, inspect the LangSmith trace — should show three sibling runs under the validate→followUp segment; total wall time should drop from ~22s to ~8–10s; `mitigationSteps` shape in the final state should be identical to today.
5. **Soft-fail smoke**: set `AGENT_LLM_TIMEOUT_MITIGATE_MONITOR_MS=1` in `.env`, restart the agent, run any complex incident. Confirm `partialFailures` contains `proposeMitigation.monitor`, `mitigationSteps.monitor` is `[]`, the other two branches produce content normally.

## Reference patterns (read before coding)

- **SIO-681 Send[]/aggregator pair** — `packages/agent/src/correlation/enforce-node.ts` (router + Send[]) and the matching aggregator. This is the *exact* shape SIO-741 needs.
- **SIO-739 invokeWithDeadline + soft-fail** — `packages/agent/src/llm.ts:80` (env-var → deadline lookup) and `packages/agent/src/mitigation.ts:147` (catch DeadlineExceededError → push to `partialFailures` → return empty). Reuse the same pattern in each branch.
- **Existing mitigation test mock pattern** — `packages/agent/src/mitigation.deadline.test.ts` uses `mock.module("@langchain/aws", ...)` with a counter so each call can have a different behaviour. Extend with one counter per branch.

## CLAUDE.md guardrails (do not skip)

- The Linear issue (SIO-741) already exists. Implementation can start immediately.
- Never commit without explicit "commit + push + PR" from the user.
- Never set Linear issues to "Done" without user approval.
- All work goes through PR review — push to a feature branch, open a PR, don't push to main.

## Quick-start commands for the new session

```bash
# 1. Confirm clean state
git status
git log --oneline -3        # top should be 36b4306 SIO-740

# 2. Create feature branch (or let the user invoke /worktree if they want isolation)
git checkout -b simonowusupvh/sio-741-split-mitigation-node-into-parallel

# 3. Read the plan + this handoff first
cat /Users/Simon.Owusu@Tommy.com/.claude/plans/sio-741-parallel-mitigation.md
cat experiments/HANDOFF-2026-05-12-sio-740-merged-sio-741-next.md

# 4. Read the reference patterns
# packages/agent/src/correlation/enforce-node.ts        — Send[] pattern
# packages/agent/src/mitigation.ts                      — current single-call implementation
# packages/agent/src/mitigation.deadline.test.ts        — test mock pattern
# packages/agent/src/state.ts:162                       — annotation reducers
# packages/agent/src/graph.ts:81-121                    — wiring to replace

# 5. Start with state.ts changes — smallest blast radius, unblocks the rest
```

## Out of scope (do not bundle in)

- Frontend rendering of mitigation categories. UI doesn't show them today; if we want incremental SSE events per branch, that's a separate follow-up against `apps/web/src/routes/api/agent/stream/+server.ts`.
- Firing Step 2 (action proposal) in parallel with Step 1 branches.
- Touching the SIO-740 logging change. That's merged; treat it as background context.
- Diagnosing the underlying `-32010` storm. SIO-740 captures `jsonRpcMessage` on the next occurrence; the actual fan-out fix (L4 semaphore / L3 client-side cap / L1 batching) belongs to whatever follow-up ticket the next storm produces, not here.

## Risks to keep an eye on

1. **LangGraph join semantics** — confirm `addEdge` from N nodes to one downstream node waits for all N. The SIO-681 plumbing already does this, but verify with the new graph-level integration test before declaring done.
2. **Three concurrent Bedrock calls** — same account quota, three slots instead of one. Input/output tokens are roughly comparable (each prompt is ~⅓ size), but the request-count quota triples. Watch for `ThrottlingException` in early prod runs; if it surfaces, add per-branch jittered backoff (not in this ticket's scope, would be a SIO-741 follow-up).
3. **State default reset between runs** — `mitigationFragments` default `[]` must reset for each new graph invocation. LangGraph's default behaviour is per-run isolation, but the graph-level integration test should assert two consecutive runs don't bleed into each other.

## Memory pointers (for the new session's auto-memory layer)

Relevant memory files from the previous session:
- `feedback_handoff_docs_main_branch.md` — handoff doc commits can go straight to main (no PR)
- `feedback_linear_doc_syncs.md` — doc-only commits don't need a new Linear ticket
- `reference_subagent_env_tunables.md` — env-var pattern for per-role deadlines (matches what SIO-741 needs for the three new `AGENT_LLM_TIMEOUT_MITIGATE_*_MS` keys)
- `feedback_never_create_linear_done.md` — SIO-741 already exists in Backlog; don't move it to Done without approval
