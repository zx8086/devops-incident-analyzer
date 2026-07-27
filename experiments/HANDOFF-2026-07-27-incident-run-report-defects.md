# HANDOFF — Report-quality defects from the 2026-07-27 prana-order-service run

- **Date**: 2026-07-27
- **Parent**: [SIO-1241](https://linear.app/siobytes/issue/SIO-1241) — Report-quality defects surfaced by the 2026-07-27 prana-order-service run
- **Children**: [SIO-1242](https://linear.app/siobytes/issue/SIO-1242) (High), [SIO-1243](https://linear.app/siobytes/issue/SIO-1243) (High), [SIO-1244](https://linear.app/siobytes/issue/SIO-1244) (Medium), [SIO-1245](https://linear.app/siobytes/issue/SIO-1245) (Medium), [SIO-1246](https://linear.app/siobytes/issue/SIO-1246) (Medium)
- **Repo state**: `main` @ `e00ca80b` (after `bce24833` SIO-1238, `40ff83d0` + `e00ca80b` SIO-905 handover corrections)
- **Suggested branches**: one per child, e.g. `claude/sio-1242-absence-rewrite-leak`

## TL;DR

A full incident run completed cleanly — 6 datasources, 54 tools, 245s, zero sub-agent failures, every datasource `Success` in the UI — and still produced a degraded report. Five defects, none of them crashes. Two (SIO-1242, SIO-1243) actively damage trust: one leaks an internal `[CORRECTION: …]` string into the rendered report *and* hard-caps confidence on a correct finding, the other hands an operator a `CREATE INDEX` that will not execute. Three are silent coverage losses where the analysis is right but the supporting card or sub-agent output is not. **Success is: the same replay produces a report with no internal strings, valid DDL, an Atlassian card, relevant AWS alarms, and a gitlab result that is either substantive or an honest "could not locate".**

## The run

| Field | Value |
|---|---|
| Request-Id | `43796e9f-611f-43f0-9809-14ccbc0e6d3c` |
| Thread | `137298f3-9c71-4d0f-9010-7a1f678688f7` |
| Run | `dcc94a9d-b789-4352-88ef-99dd8db177fc` |
| Query | Investigate `prana-order-service` — season fetch timeout, company code CK |
| Elastic deployment | `eu-b2b` |
| AWS estates | `eu-oit-prd`, `eu-shared-services-prd` |
| Duration | 245.6s (aggregation alone 131.8s; aggregator emitted 13,323 output tokens) |
| Confidence | **0.59**, hard-capped from **0.72**, `capReasons: ["premature-absence"]` |

Reproduce with the same prompt, the same 6 datasources, `eu-b2b`, and both AWS estates selected. The MCP servers must be up — konnect (`:9083`) was down during this run and is intentionally disabled, so its absence is not a factor.

## Context — how this came to be

The user ran an end-to-end investigation to sanity-check the system and reported "everything seems to work". The pipeline *did* work. Reading the rendered report and the run log against each other is what surfaced these. **That is the technique worth repeating**: the completion panel showed six green ticks while a card was empty, another card showed April alarms, and a debug string sat in a table cell.

## Where the bodies are buried

### 1. The correction string — `packages/agent/src/aggregator.ts:899`

```ts
" [CORRECTION: this datasource's sub-agent returned matching data this turn, so it is NOT absent -- the earlier phrasing was a synthesis error; treat the returned data as ground truth.]";
```

Appended by `rewritePrematureAbsence` (`:903`) to the flagged line. In this run the flagged line was a **markdown table row**, so the string rendered inside the Correlated Timeline's Severity cell. The Findings section still carried the original claim, so the report asserts both.

Detection is `detectPrematureAbsence` (`:851-879`); branch (A) flags "an absence line about a datasource that returned data". The judge wiring is `:1409-1434`.

### 2. What the eu-shared-services-prd sub-agent actually returned

```
aws_ecs_list_services      -> bytes: 313, 539, 221, 454, 2195   (service lists came back)
aws_logs_describe_log_groups -> bytes: 135 (x4)                  (empty {"logGroups":[]})
```

Data was returned; **no data matching the absence claim** was. That distinction is the bug in SIO-1242 Bug B.

### 3. The judge ran and kept the wrong one

```
judge verdicts {"verdicts":[{"index":0,"keep":false},{"index":1,"keep":true}]}
Confidence cap decision {"capMode":"hard","capReasons":["premature-absence"],
  "appliedCap":0.59,"originalScore":0.72,"cappedScore":0.59}
Confidence below threshold, flagging for user review {"confidenceScore":0.59,"threshold":0.6}
```

It correctly vetoed one of two regex hits, so the judge works — it was under-informed on this one.

### 4. Card scoping, two failure modes in one run

```
warn: findings card scoped to empty {"tag":"AtlassianFindingsCard","rawCount":10,"filteredCount":0,"droppedAll":true}
info: findings extracted            {"tag":"AWSFindingsCard","rawCount":25,"filteredCount":3,"filterMode":"scoped"}
info: findings card fell back to unscoped top-N {"tag":"AWSFindingsCard","rawCount":35,"fallbackCount":5,"filterMode":"unscoped-fallback"}
```

Atlassian dropped to zero. AWS scoped **successfully to 3** and was then **overwritten by 5 unscoped** ones. Note the differing `rawCount` (25 vs 35) — the two AWS estates are extracted separately, so the fallback may be evaluating a different result set than the one that scoped. Confirm that ordering first.

### 5. gitlab exhausted its budget

```
Sub-agent completed (truncated at recursion limit; partial results)
  {"dataSourceId":"gitlab","duration":51935,"messageCount":39,
   "responseLength":49,"recoveredFromIndex":36,"truncated":true,"toolErrorCount":3}
```

`responseLength: 49`; aggregator `dataLength: 157` vs 4,649–10,639 for every other datasource.

Eight empty results (`bytes: 2`): `gitlab_search` at iterations 1, 17, 20, 25 (**4 > MAX_UNPRODUCTIVE_PER_TOOL = 3**), `gitlab_list_merge_requests` at 4, `gitlab_list_commits` at 8, 15, 23 — **total 8 = MAX_UNPRODUCTIVE_PER_RUN**.

## Two things I got wrong — do not repeat them

**I initially suspected SIO-1232's loop guard was never implemented**, because `GUARDED_TOOLS` still contains only `elasticsearch_search` and `aws_logs_start_query`. That reading is wrong. SIO-1232 **repurposed** the set to mean "tools with *bespoke* rules"; `sub-agent-loop-guard.ts:368` uses `if (!GUARDED_TOOLS.has(toolName))` as the *entry* to the generic path. Read the comment at `:16-19` before concluding anything about that constant.

**I initially attributed SIO-905's fix to "the elastic-iac team"** and praised their "better diagnosis". It was fixed by this same operator 31 minutes after the ticket was filed. Check `git log`/`gitlab_search` for authorship before narrating who did what.

## The confounder to keep in mind

`bce24833` (SIO-1238 — trimmed `project-resolution/SKILL.md` STEP 1 from five named example tools to a categorical rule) merged **04:06 UTC**; the server started **05:45 UTC**. That change **was live** in this run, and it touches the gitlab agent implicated in SIO-1246.

Evidence says it is not the cause: `gitlab_get_file_content` **succeeded five times** (iterations 3, 9, 10, 12, 22), and the three failures are `404 File Not Found` / `404 invalid revision or path`, **not** `404 Project Not Found`. Resolution worked; path discovery did not. But it cannot be fully excluded without an A/B — if you touch SIO-1246, consider replaying once with STEP 1 reverted.

## Verification

```bash
cd /Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer
bun run typecheck && bun run lint && bun run test
bun run --filter '@devops-agent/agent' test
```

Live replay — the only way to confirm any of these, since all five are output-shape defects invisible to unit tests:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN   # reuse the running server; do not start a second
curl -N -X POST http://localhost:5173/api/agent/stream \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Investigate the \"prana-order-service\" service for the error: Couldn'"'"'t fetch seasons by company code: CK and season types: [DIVISIONAL, OUTLET]"}],
       "dataSources":["elastic","kafka","couchbase","gitlab","aws","atlassian"],
       "targetDeployments":["eu-b2b"],
       "awsTargetEstates":["eu-oit-prd","eu-shared-services-prd"]}' \
  | grep -E 'CORRECTION|findings card|premature-absence|responseLength'
```

Expected after fixes: no `CORRECTION` match, no `scoped to empty` for Atlassian, no `unscoped-fallback` for AWS, no `premature-absence` cap, gitlab `responseLength` in the thousands.

## Files to modify

| File | Ticket | Change |
|---|---|---|
| `packages/agent/src/aggregator.ts` | SIO-1242 | `detectPrematureAbsence` contradiction test; keep the correction out of table rows |
| `packages/agent/src/mitigation-branches.ts` | SIO-1243 | Deterministic dedupe of emitted DDL index keys |
| `packages/agent/src/correlation/focus-match.ts` | SIO-1244 | Provenance-aware focus match for ticket-shaped findings |
| `packages/agent/src/extract-findings.ts` | SIO-1244, SIO-1245 | Fallback must not overwrite a non-empty scoped set; multi-estate card semantics |
| `packages/agent/src/sub-agent-loop-guard.ts` | SIO-1246 | Establish classification vs enforcement gap |
| `agents/incident-analyzer/agents/gitlab-agent/skills/code-search-selection/SKILL.md` | SIO-1246 | Steer to semantic search before path guessing |

## Workflow

Branch off `main` before the first commit. One branch + PR per child ticket — they touch different files and have different risk profiles; do not bundle. Commit `SIO-12XX: message` via HEREDOC ending with the `Co-Authored-By` trailer. PRs ready-for-review, never draft. Wait for the SHA-scoped CodeRabbit check before merging. Linear: In Progress → In Review → Done **only with explicit user approval**.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Loosening the absence check re-admits the hallucinated-absence class SIO-1085/1013 exist to stop | High | Tighten the *contradiction* predicate only; leave the over-generalisation branch alone. Keep the judge. |
| Disabling focus scoping to fix SIO-1244 regresses SIO-1030 | High | Scoping stays; change what counts as in-focus, not whether scoping runs |
| Fixing the AWS fallback hides genuinely empty cards | Medium | Fallback still fires when scoped is empty — only the overwrite is removed |
| Hard-stopping the loop guard strands the CloudWatch Insights poll | Medium | `GENERIC_GUARD_EXEMPT_TOOLS` already exempts `aws_logs_get_query_results` + `aws_logs_describe_log_groups`; preserve it (CodeRabbit caught this on PR #482) |
| Unit tests pass while the report stays broken | High | All five are output-shape defects — a live replay is mandatory, not optional |

## Out of scope

- The run's **analysis**, which was sound. The proximate cause (180,000ms client timeout, dual-confirmed in Elasticsearch APM and eu-oit-prd CloudWatch) is correct, and the two competing underlying hypotheses are honestly labelled unconfirmed. Fix the plumbing, not the reasoning.
- `MAX_TOOLS_PER_AGENT` calibration — [SIO-1240](https://linear.app/siobytes/issue/SIO-1240).
- aws-agent RULES.md oversubscription — [SIO-1239](https://linear.app/siobytes/issue/SIO-1239).
- konnect MCP being down (`:9083`) — intentional.

## Related code references (already correct)

- `packages/agent/src/sub-agent-loop-guard.ts:16-19` — the `GUARDED_TOOLS` comment that explains the repurposing
- `packages/agent/src/sub-agent-loop-guard.ts` `GENERIC_GUARD_EXEMPT_TOOLS` — the AWS poll exemption and why it exists
- `packages/agent/src/correlation/rules.ts` `infra-service-degraded-needs-synthetic-cross-check` — a `fetchDirective` that carries a procedure to the agent owning the tool (SIO-1237); the pattern to copy if any of these fixes need cross-agent instruction

## Memory references

`reference_absence_judge_premature_absence_veto`, `reference_confidence_two_class_policy_sio1194_1195`, `reference_findings_cards_are_unscoped_dumps`, `reference_focus_match_empty_collapse`, `reference_atlassian_find_linked_incidents_shape`, `reference_aws_cloudwatch_describe_alarms_shape`, `reference_capella_suggest_optimizations_invalid_include_ddl`, `reference_gitlab_search_first_and_elastic_loop_guard`, `reference_subagent_tool_budget_calibration`, `reference_worktree_web_server_replay_env`
