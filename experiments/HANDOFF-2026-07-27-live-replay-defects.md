# HANDOFF — Defects surfaced by the 2026-07-27 17:29 live replay

- **Date**: 2026-07-27
- **Parent to file under**: [SIO-1241](https://linear.app/siobytes/issue/SIO-1241) — Report-quality defects (all five original children now In Review or merged)
- **Repo state**: `main` @ `79e0db0a`, plus [PR #497](https://github.com/zx8086/devops-incident-analyzer/pull/497) (SIO-1242) open
- **Suggested branches**: one per ticket below, e.g. `claude/sio-12XX-truncation-synthesis`

## TL;DR

The SIO-1241 fixes were validated by a live replay against `pvh-services-styles-v3`
(run `cbada913-d22f-4618-826b-0c4c38fd8956`, request `62a6af93-3977-4c56-9e8e-36a521e08d69`).
**Two of the four merged fixes are confirmed working in production.** The replay then exposed a
different, larger class of defect: **the pipeline loses evidence it has already paid for.** GitLab
gathered 15 successful tool results and reported 44 characters. Kafka made **zero** tool calls and
deferred to the user. Five of seven findings cards extracted `rawCount: 0`. The report's own Root
Cause section says it plainly: *"No tool output in this session directly reproduced or confirmed the
mechanism."* Confidence 0.45.

Success is: a truncated sub-agent reports what it found, and a sub-agent never asks permission
instead of querying.

## The run

| Field | Value |
|---|---|
| Request-Id | `62a6af93-3977-4c56-9e8e-36a521e08d69` |
| Thread | `47fd5d5e-e1a6-496c-9c2b-620edf7d299f` |
| Run | `cbada913-d22f-4618-826b-0c4c38fd8956` |
| Query | Investigate `pvh-services-styles-v3` — Couchbase `RequestCanceledException` (`CHANNEL_CLOSED_WHILE_IN_FLIGHT`) |
| Elastic deployment | `eu-b2b` |
| AWS estates | `eu-shared-services-prd`, `eu-oit-prd` |
| Duration | 218.3s, 45 tools |
| Confidence | **0.45** — the aggregator's own score, **not** a cap (no `capReasons` logged) |

## What the replay PROVED (do not re-litigate)

**SIO-1245 works.** One clean line replaced the contradictory pair:
```
merged multi-deployment tool outputs before extraction {dataSourceId:"aws",
  deployments:["estate:eu-shared-services-prd","estate:eu-oit-prd"], mergedRows:2, toolOutputs:37}
AWSFindingsCard rawCount:60 filteredCount:57 filterMode:"scoped"
```
No `unscoped-fallback`. Exactly the defect fixed.

**SIO-1246 works.** `subagent.loop_guard_stop` fired for `aws_ecs_list_clusters` — a **non-bespoke**
tool. That was structurally impossible before the fix.

**SIO-1243 / SIO-1244 remain unexercised.** No `CREATE INDEX` was emitted; `findLinkedIncidents`
returned zero issues (`droppedAll: false`), so the provenance path never ran. Neither is disproven.

## Defect 1 — a truncated sub-agent throws away everything it found (HIGH)

**This is the one that broke this report.**

```
Sub-agent completed (truncated at recursion limit; partial results)
  {"dataSourceId":"gitlab","duration":33977,"messageCount":30,
   "responseLength":44,"recoveredFromIndex":28,"toolErrorCount":0,"truncated":true}
```

`toolErrorCount: 0` — **GitLab did not fail.** It succeeded 15 times: `gitlab_semantic_code_search`
(23,305 bytes), two `gitlab_get_repository_tree`, three `gitlab_get_file_content`, 78 commits across
two `gitlab_list_commits`, plus `gitlab_recent_deploys` and `gitlab_pipeline_failures`. It then
reported **44 characters**, and the aggregator saw `dataLength: 152`.

Both AWS estates did the same: `responseLength: 208` and `64`.

### Where the body is buried

`packages/agent/src/sub-agent.ts:1549-1570` — the salvage recovers **the last message that happens
to carry text**, it does not synthesise:

```ts
// SIO-1029: a truncated run that still gathered tool data is partial-success, not error --
// salvage what the sub-agent observed rather than blanking the datasource.
const outcome = buildSubAgentOutcome({
    recovered, allToolsFailed, truncated: truncated === true, ...
});
const data = outcome.data;
```

`recovered.index = 28` of 29 — a stray mid-loop sentence. The tool data itself is **not lost**: it is
persisted in `toolOutputs` and reaches `extractFindings`. What is missing is the prose summary,
because the budget ran out before the model got a turn to write one.

### The fix

Reserve the final turn for synthesis rather than letting tool calls consume the whole budget — so
truncation degrades gracefully instead of catastrophically. Alternative (weaker): on
`truncated === true`, spend one extra LLM call on "summarise what you have from these tool results".

Recursion limits live in `RECURSION_LIMIT_BY_DATASOURCE` (`sub-agent.ts:228-256`), env-overridable
via `SUBAGENT_RECURSION_LIMIT_<DATASOURCE>`. Note LangGraph counts **super-steps** and a ReAct cycle
is two, so `limit ≈ 2 × maxLlmTurns + 1` — gitlab's 24 buys ~11 LLM turns.

## Defect 2 — the Kafka sub-agent asked permission instead of querying (HIGH)

```
Sub-agent completed {"dataSourceId":"kafka","duration":6938,"messageCount":2,
  "responseLength":1921,"toolErrorCount":0,"allToolsFailed":false}
```

`messageCount: 2` is system + one AI reply — **zero tool calls**, in 6.9 seconds, from a belt of 25
bound tools. The report records what it did instead:

> The sub-agent determined the error signature originates from a direct Couchbase query path, not
> Kafka message flow, and did not execute lag/DLQ/consumer-group tool calls in this session. **It
> offered to check Couchbase sink-connector consumer groups and DLQ topics but deferred pending
> direction.**

A sub-agent has no user to defer to — the offer goes nowhere and the evidence is simply never
gathered. Start at `agents/incident-analyzer/agents/kafka-agent/SOUL.md`: it needs an explicit rule
that there is no interactive human in the loop, and that "not relevant" must be evidenced by at
least one query, not asserted a priori.

Worth checking whether other sub-agents share the phrasing — this is a prompt-shape bug, not a
kafka-specific one.

## Defect 3 — `isUnproductiveResult` misses short "no results" strings (MEDIUM)

`gitlab_search` was called **seven** times (iterations 1, 2, 6, 11, 12, 18, 20). Four returned short
**strings** rather than arrays — 78, 72, 90 and 114 bytes — almost certainly "no results"/guidance
messages.

`packages/agent/src/sub-agent-loop-guard.ts:311` only counts: empty string, `EMPTY_SEARCH_RE`
(elastic's `Total results: 0`), empty aggregations, empty arrays, `hitsLen 0`. **A 78-byte "nothing
found" string is therefore classified PRODUCTIVE**, so `MAX_UNPRODUCTIVE_PER_TOOL = 3` never tripped.
Combined with the streak reset on the genuine hit at iteration 5, the counter never got near the cap.

Fix candidate: treat a short string with no structured payload as unproductive, or let a tool declare
its own empty-shape. Be careful — the guard now actually enforces (SIO-1246), so a loosened predicate
stops real calls. Add the test before the change.

## Defect 4 — gitlab re-resolves the project before every scoped tool (MEDIUM)

`project-resolution/SKILL.md` STEP 1 mandates `gitlab_search` before **any** tool taking a
`project_id`. Every new project-scoped tool triggers another resolve — 7 of 21 calls in this run.

This is the SIO-1238 amplification flagged in the [SIO-1246 PR](https://github.com/zx8086/devops-incident-analyzer/pull/492)
and it is now observed live. Options: cache the resolved `project_id` for the turn, or scope STEP 1
to "once per distinct project". **Do not** simply revert SIO-1238 — its categorical rule fixed a real
404-on-bare-service-name failure.

**Budget constraint:** gitlab-agent sits at 16 prompt-promised tool names against a 17 budget
(`MAX_TOOLS_PER_AGENT 25 − MIN_ACTION_TOOLS 8`). Naming any new tool breaks
`skill-tool-coverage.test.ts`. Verify with:
`for f in SOUL.md skills/*/SKILL.md; do ...; done | grep -oE '\bgitlab_[a-z_]+' | sort -u | wc -l`

## Defect 5 — `aws_ecs_list_tasks` is prompted but not bound (MEDIUM)

```
toolErrors:[{"toolName":"aws_ecs_list_tasks","category":"not-found",
  "message":"Error: Tool \"aws_ecs_list_tasks\" not found.\n Please fix your mistakes."}]
```

Classic action-group gap (memory: `reference_subagent_missing_tool_is_action_group_gap`). It cost the
run its ECS task-count and security-group verification — the exact evidence needed to confirm or rule
out the DEVOPS-1353 security-group hypothesis.

**This also explains the `raw_output_count_mismatch` warning** — investigated and **not** a
regression:
```
subagent.raw_output_count_mismatch {rawOutputCount:18, toolMessageCount:19}
```
A hallucinated tool name never reaches the `instrumentTools` proxy, so LangGraph emits a ToolMessage
with no paired raw output. Arithmetic matches exactly (one not-found error on that estate). Short-
circuits and thrown errors **are** captured (`sub-agent-instrumentation.ts:206` and `:228`), so
SIO-1246/SIO-1248 are not implicated. Fix the tool binding and the warning goes away.

## Lower-priority observations

- `resolveIdentifiers probe failed; omitting this datasource {"dataSourceId":"elastic","error":"probe timed out after 8000ms"}`
- `aws_logs_start_query` on `eu-oit-prd` returned `MalformedQueryException` — window outside retention. The SIO-1141 re-anchor advice exists; check whether it fired.
- `OrbitFindingsCard` logged `droppedAll: true` (rawCount 1 → 0) — the only card that actually over-scoped this run.
- Five of seven cards extracted `rawCount: 0` despite a 129KB elastic search result. Worth confirming the extractors match what `logs-apm.error` actually returns; this may be a fixture-vs-reality drift (memory: `feedback_extractor_fixtures_must_mirror_real_mcp`).

## Verification

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer
bun run typecheck && bun run lint && bun run test
bun run --filter '@devops-agent/agent' test
bun run --filter '@devops-agent/gitagent-bridge' test   # tool-budget canary (Defect 4)
bun run yaml:check                                       # agent definitions (Defect 2)
```

Live replay — **mandatory**, these are all output-shape defects:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN   # the user's server runs MAIN code; do not kill it
# Start a SECOND server from the worktree on :5174 — see reference_worktree_web_server_replay_env:
cp MAIN/.env .env && cp .env apps/web/.env
printf '\nKNOWLEDGE_GRAPH_MCP_PORT=9187\nLIVE_MEMORY_ENABLED=false\nAGENT_MEMORY_ENABLED=false\n' >> .env
cd apps/web && bun run dev -- --port 5174     # TRACK THE PID
```

Expected after fixes: gitlab `responseLength` in the thousands; kafka `messageCount > 2`; no
`aws_ecs_list_tasks` not-found; no `raw_output_count_mismatch`.

**Cleanup is non-negotiable:** kill the tracked :5174 PID, `rm .env apps/web/.env && rm -rf apps/web/.data`,
then prove `lsof -nP -iTCP:5174 -sTCP:LISTEN` returns nothing. Leave :5173 alone.

## Files to modify

| File | Defect | Change |
|---|---|---|
| `packages/agent/src/sub-agent.ts` | 1 | Reserve the final turn for synthesis; salvage must summarise, not grab last text |
| `agents/incident-analyzer/agents/kafka-agent/SOUL.md` | 2 | No interactive human; "not relevant" needs one query as evidence |
| `packages/agent/src/sub-agent-loop-guard.ts` | 3 | `isUnproductiveResult`: short unstructured string counts as unproductive |
| `agents/incident-analyzer/agents/gitlab-agent/skills/project-resolution/SKILL.md` | 4 | Resolve once per project per turn |
| `packages/agent/src/sub-agent.ts` (aws action map) | 5 | Bind `aws_ecs_list_tasks` or stop naming it |

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Reserving a synthesis turn reduces the tool budget and truncates *more* runs | Medium | Reserve one turn only; measure `truncated` rate before/after on the replay |
| Loosening `isUnproductiveResult` stops legitimate calls — the guard now really enforces | **High** | Write the test first; keep `GENERIC_GUARD_EXEMPT_TOOLS` intact (CodeRabbit, PR #482) |
| Caching project resolution reintroduces the SIO-1238 404-on-bare-name failure | Medium | Cache the RESOLVED id, never skip the first resolve |
| Naming a new gitlab tool breaks the 17-name budget canary | Medium | Count `gitlab_*` names before and after; `skill-tool-coverage.test.ts` must stay green |
| "Fixing" `raw_output_count_mismatch` in the instrumentation | Medium | Don't — the cause is an unbound tool name; fix the binding (Defect 5) |

## Out of scope

- The five original SIO-1241 children — all merged or in review; SIO-1242 is [PR #497](https://github.com/zx8086/devops-incident-analyzer/pull/497).
- The run's **analysis**, which was honest. It correctly refused to assert a root cause and listed every gap. Confidence 0.45 was self-assessed, not capped. Fix the evidence gathering, not the reasoning.
- `konnect` MCP being down — intentional.

## Related code references (already correct)

- `packages/agent/src/sub-agent-instrumentation.ts:202-232` — short-circuit and throw paths both capture `rawOutputs`; the mismatch is NOT here
- `packages/agent/src/sub-agent-loop-guard.ts:365-375` — the generic guard, now genuinely reachable (SIO-1246)
- `packages/agent/src/extract-findings.ts` — multi-deployment merge (SIO-1245), confirmed working live

## Memory references

`reference_subagent_missing_tool_is_action_group_gap`, `reference_gitlab_search_first_and_elastic_loop_guard`,
`reference_subagent_tool_budget_calibration`, `reference_worktree_web_server_replay_env`,
`feedback_extractor_fixtures_must_mirror_real_mcp`, `reference_aws_logs_expired_was_wrong_window_not_retention`,
`reference_pr_merge_no_branch_protection_and_worktree_gh_quirk`
