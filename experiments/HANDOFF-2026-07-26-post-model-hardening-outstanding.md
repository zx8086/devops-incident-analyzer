# HANDOFF — outstanding items after the SIO-1221..1226 model-hardening series

- **Date:** 2026-07-26
- **Repo state:** `main` @ `856ed127` ("SIO-1221..1226: harden the model-swap blast radius (#477)")
- **Merged this session:** PR [#477](https://github.com/zx8086/devops-incident-analyzer/pull/477) — squash `856ed127`
- **Open from this session:** PR [#478](https://github.com/zx8086/devops-incident-analyzer/pull/478) (SIO-1227), branch `claude/sio-1227-empty-findings` @ `0ec1a611`
- **Tickets closed:** [SIO-1221](https://linear.app/siobytes/issue/SIO-1221), [SIO-1222](https://linear.app/siobytes/issue/SIO-1222), [SIO-1223](https://linear.app/siobytes/issue/SIO-1223), [SIO-1224](https://linear.app/siobytes/issue/SIO-1224), [SIO-1225](https://linear.app/siobytes/issue/SIO-1225), [SIO-1226](https://linear.app/siobytes/issue/SIO-1226) — all **Done**
- **Tickets open:** [SIO-1227](https://linear.app/siobytes/issue/SIO-1227) (In Review), [SIO-1228](https://linear.app/siobytes/issue/SIO-1228) (Backlog)

## TL;DR

The SIO-1213 Sonnet 5 / Opus 4.8 bump caused six production failures in one day. PR #477 closed the remaining failure classes and added a pre-merge conformance gate. Running that gate's acceptance eval then surfaced two **pre-existing** bugs on `main` (SIO-1227, SIO-1228) which between them explain most of a `datasources_covered` regression. Four things are outstanding: one unrun verification gate, one open PR, one unstarted ticket, and one non-repo bash issue. Each section below is independently actionable — read only the section you are picking up.

## Item 1 — Gate 9: exercise elastic-iac end-to-end on Opus 4.8 (NOT DONE)

**Why it matters.** SIO-1213 moved `agents/elastic-iac/agent.yaml` to `preferred: claude-opus-4-8`, `fallback: claude-sonnet-5`. **Both** entries are new-generation, so the fallback preserves every capability assumption that broke. The graph has never been driven end-to-end on that chain. SIO-1224's probe only exercises single calls; it cannot tell you whether the 30-node pipeline works.

This is gate 9 of `docs/development/model-upgrade-checklist.md`. Gates 1-8 are done (gate 8's result is in Item 1b below).

**What to run.** The elastic-iac graph has no token stream — it appends its answer as an AIMessage and the SSE handler reads terminal state via `getLastAssistantText`. So it must be driven through the web app, not a script.

```bash
# .env must exist at the repo root; a worktree needs its own copy:
#   cp /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer/.env .
lsof -nP -iTCP:5173 -sTCP:LISTEN          # confirm nothing is already bound
bun run --filter @devops-agent/web dev
```

Then drive two turns:

1. **A read-only `info` request** — e.g. "what version is eu-b2b running?" Exercises `iacClassifier` (16-token budget on Opus 4.8 — verified fine by probe) → `iacReader` (raised to 8192 in SIO-1225).
2. **A `gitops` request through to plan-review** — e.g. a small ILM or tier change. Exercises `iacPlanner` (raised 2048 → 8192) and `draftChange`.

**What to watch for**, each tied to a shipped fix:

| Symptom | Would mean |
|---|---|
| `[object Object]` anywhere in the answer | a message-content read escaped SIO-1222's chokepoint |
| "Which cluster and what change should I make?" on a clearly-specified request | `parseIntentJson` rejected the planner's JSON (SIO-1221 sanitizer) |
| Answer cut off mid-sentence | a `maxTokens` still below the model's floor (SIO-1225) |
| `warn: dropped every content block` | a reasoning-only response reached a caller (SIO-1222 instrumentation) |
| `LLM token usage` lines absent | SIO-1226 telemetry not firing on this graph |

**Kill the dev server when done** and prove the port is free: `lsof -nP -iTCP:5173 -sTCP:LISTEN` must return nothing.

### Item 1b — gate 8 result, for context

Gate 8 (`bun run eval:agent`) **was** run: experiment `agent-eval-094b203a-f754dcd6`, 5/5 queries.

| evaluator | baseline 2026-05-10 (Sonnet 4.6) | this run | verdict |
|---|---|---|---|
| `confidence_threshold` | 1.00 | 1.00 | unchanged |
| `datasources_covered` | 1.00 | **0.40** | regressed |
| `response_quality` | 0.00 | 0.00 | unchanged — **not** a regression |

`response_quality: 0.00` scored 0.00 pre-bump too. The judge itself was verified working (its feedback comments are real per-clause rubric analyses), so the SIO-1221 change to `eval/evaluators.ts` did not break it. Strict rubrics, long-standing, separate concern.

`datasources_covered` 1.00 → 0.40 has **at least three** contributors: SIO-1227, SIO-1228, and konnect being intentionally disabled in this environment. Do not attribute it to one cause. The baseline is also 2.5 months and ~80 tickets old, so it is not a clean A/B.

Two blockers had to be fixed before gate 8 could run at all (both in #477): the eval precheck probed a kafka port the app does not use (`:9081` rather than the `:3000` SigV4 proxy) and hard-failed on intentionally-disabled konnect; and `eval:precheck` / `eval:run` / `eval:upload-dataset` never loaded the root `.env`.

## Item 2 — PR #478 / SIO-1227: sub-agent returns success with no findings (OPEN)

**Status:** implemented, CodeRabbit round 1 addressed, awaiting its re-review of `0ec1a611`. Branch `claude/sio-1227-empty-findings`.

**The bug** (`packages/agent/src/sub-agent.ts`, pre-fix):

```ts
const baseData = lastResponse ? extractTextFromContent(lastResponse.content)
                              : "No response from sub-agent";
status: allToolsFailed ? "error" : "success"
```

The ternary tested whether a message **existed**, not whether it produced text, so the fallback could never fire and `baseData` became `""`. `status` never inspected `data`. Alignment counts statuses, not content, so it logged `successes: 2, errors: 0` and neither retried nor capped confidence.

Two ways the final message carries no text, both measured in the eval:

| shape | evidence |
|---|---|
| Sonnet 5 ends the loop with a **reasoning-only** message | elastic, 6 msgs, not truncated, 0 tool errors, `responseLength: 0` |
| Recursion-limit salvage — last message is mid-loop (documented in SIO-1029) | gitlab, 40 and 44 msgs, `truncated: true`, `responseLength: 0` |

**The fix on the branch:** `lastTextualResponse(messages)` walks backwards for the most recent **assistant** message with text (tool messages excluded — their content is raw tool output that would reach the aggregator as unlabelled JSON; the human turn excluded so an empty run cannot echo the query back). Decision extracted into pure `buildSubAgentOutcome()` so the invariant "never `success` with no findings" is unit-testable — `queryDataSource` cannot be tested directly without mocking `createReactAgent`, the MCP tool layer and `prompt-context`, the last of which causes cross-file mock pollution in this package.

**To finish:** wait for CodeRabbit on `0ec1a611`, triage any findings, then merge. `main` has no branch protection, so CI and CodeRabbit are advisory — but the project rule is never to merge with a CodeRabbit report pending. Use `gh pr merge 478 --squash` **without** `--delete-branch` (the local checkout step fails in a worktree; the remote merge still succeeds).

## Item 3 — SIO-1228: skills promise tools the action filter may not bind (NOT STARTED)

Filed this session with full evidence. Two gitlab runs burned 108s and 159s and hit their recursion limit on:

```
Error: Tool "gitlab_get_file_content" not found. Please fix your mistakes.
```

**Both obvious explanations are wrong** — verified: the tool **is** registered (`packages/mcp-server-gitlab/src/tools/code-analysis/get-file-content.ts:17`) and **is** in the action map (`agents/incident-analyzer/tools/gitlab-api.yaml:105`, group `code_analysis`).

The real mechanism: gitlab-mcp exposes 36 tools and action-driven selection binds a subset (observed 7, 13, 13, 21 in one run), but the sub-agent's skills name that tool **unconditionally** and skill prose is always in the system prompt:

- `agents/incident-analyzer/agents/gitlab-agent/skills/code-search-selection/SKILL.md:30`
- `agents/incident-analyzer/agents/gitlab-agent/skills/project-resolution/SKILL.md:15`

So on a turn without `code_analysis` selected, the model follows its instructions, calls an unbound tool, and loops. The error is classified `category: "unknown"` → `isRetryable` defaults true → alignment may re-dispatch the same doomed configuration.

Four options are on the ticket. Option 3 (bind the union of tools named in active skills) is the structural fix and mirrors the chokepoint pattern from #477: make the two sources of truth unable to diverge rather than reconciling by hand. Option 4 (classify `Tool "X" not found` as non-retryable) is a cheap mitigation that stops the 40-iteration burn without fixing the mismatch.

Reference: `docs/development/action-tool-maps.md`.

## Item 4 — agent-memory graph traversal still needs bash 4+ (SEPARATE REPO)

Not this repo: `/Users/Simon.Owusu@Tommy.com/WebstormProjects/agent-memory`.

A Stop hook (`bridge log --action session-end --quiet`) was failing every session end with:

```
lib/graph.sh: line 378: conditional binary operator expected
```

**Cause:** `[[ -v "arr[key]" ]]` needs bash 4.3+; `#!/usr/bin/env bash` resolves to macOS system bash **3.2.57**. It fails at *parse* time, and `bridge:19` does `source lib/graph.sh`, so an unrelated feature killed every code path — including session-end logging, which never calls graph traversal.

**Fixed (3 lines, uncommitted in that repo):** the three `-v` tests became `-n "${…:-}"` / `-z "${…:-}"`. Behaviour-preserving under bash 4+ (`_visited[…]=1` is never empty; `expected[…]="$f"` is a file path), and the file now parses under 3.2. Hook verified: `Logged [--action]: session-end`, exit 0.

**Still outstanding:** graph traversal cannot *run* under 3.2 — `local -A` (4 uses) is bash 4.0+. If you use the graph/entity commands, `brew install bash` and point the shebangs at it. My fix only stopped that limitation from breaking everything else.

Revert if unwanted: `git -C ~/WebstormProjects/agent-memory checkout lib/graph.sh`

## Repo hygiene noticed in passing (no action taken)

- **SIO ticket-number collision.** PR [#476](https://github.com/zx8086/devops-incident-analyzer/pull/476) "SIO-1221: bump Biome to 2.5.5" is OPEN on branch `simonowusupvh/sio-1221-bump-biome` and is **attached to the SIO-1221 issue**, which is actually the parseLlmJson chokepoint. I marked SIO-1221 Done because *its* work merged in #477; the Biome PR is unrelated work sharing the number. Worth re-numbering or detaching.
- The **primary checkout** (`~/WebstormProjects/devops-incident-analyzer`) is on `simonowusupvh/sio-1221-bump-biome` @ `811dea77`, not `main`, with two untracked `.data.*` recovery directories.

## Verification for any of the above

```bash
bun run typecheck && bun run lint && bun run test
```

Green at `main` @ `856ed127` plus #478: agent **2876** pass / 0 fail, gitagent-bridge **234** / 0, web **266** / 0, typecheck clean across 18 packages, lint clean.

For a model change, the full gate is `docs/development/model-upgrade-checklist.md`:

```bash
bun run model:probe -- <model> --agent <agent> --report   # ~$0.50-2.00, 3-5 min per model
bun run eval:agent                                        # ~$0.50-1.50, gate 8
```

## Out of scope — do not fold into the above

- `subAgent` model fallback. The plan assumed reusing `createLlmWithTools`' bind-both-then-wrap shape; it does **not** transfer — `createReactAgent` calls `bindTools()` internally and `RunnableWithFallbacks` has none. Needs a manual ReAct loop or a budget-gated application-level retry, and live verification. Its original motivator (SIO-1214's temperature misconfiguration) is now caught at PR time by SIO-1223's divergence oracle. Analysis is on SIO-1225.
- `response_quality: 0.00`. Long-standing, pre-dates the bump, judge verified working. Its own investigation if wanted.
- Implementing the `sqlite` checkpointer (`packages/checkpointer/src/index.ts:12` throws). Relevant only because it would be the first real message-serialization boundary.
- Re-running the model probes purely to refresh `observedLatencyMs`. Those figures now exclude the streaming call (fixed after the reports were generated); they are advisory and the shape/floor findings are unaffected.

## Memory references

- `reference_sio1213_model_facts_measured.md` — measured per-model facts; why subAgent has no fallback
- `reference_probe_production_path_not_raw_sdk.md` — **read before probing a model**; the raw CLI hides reasoning blocks and gave a wrong conclusion in this session
- `reference_pr_merge_no_branch_protection_and_worktree_gh_quirk.md` — merge mechanics, worktree `gh pr merge` quirk
- `reference_konnect_mcp_intentionally_disabled.md` — konnect down is expected, do not "fix"
- `reference_session_kafka_mcp_cannot_reach_msk.md` — why kafka's real path is `:3000`, not `:9081`
- `reference_subagent_missing_tool_is_action_group_gap.md` — related to SIO-1228, but that instance is the inverse
- `reference_worktree_web_server_replay_env.md` — a worktree needs its own `.env` copy
- `feedback_validate_every_claim_against_source.md` — the operating discipline for this whole thread
