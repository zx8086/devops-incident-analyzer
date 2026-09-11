# HANDOFF 2026-09-11: SIO-1686 search_evidence adoption follow-up

- Date: 2026-09-11
- Ticket: https://linear.app/siobytes/issue/SIO-1686 (deliberately reopened to In Progress; NOT done)
- Children, all Done: https://linear.app/siobytes/issue/SIO-1687, https://linear.app/siobytes/issue/SIO-1688, https://linear.app/siobytes/issue/SIO-1689
- Merged PR: https://github.com/zx8086/devops-incident-analyzer/pull/724, squashed to `main` as `e2afabe9`
- Repo state when this was written: branch `claude/context-mode-gitagent-hooks-3fb1c3` at `2e0e3e3b`, `origin/main` at `e2afabe9`
- Spec: `docs/superpowers/specs/2026-09-10-context-mode-concepts-feasibility.md` (sections 11 and 12 carry the phase 3 findings and the A/B)
- Suggested branch for any follow-up code: `sio-1686-search-evidence-adoption` off `origin/main`

## TL;DR

The SIO-1688 evidence index is merged and default ON. It is PROVEN to index full tool output before truncation and to return elided records on demand. What is NOT proven is whether the model ever chooses to call `search_evidence`. In the one live A/B it never did, because that scenario was answerable from data that survived truncation.

The epic stays open until a turn is observed where the model called `search_evidence` and got a hit.

Read the next TWO sections before planning any work. Both obvious moves are blocked. Running an eval cannot see the tool (structural). Reading production logs has no target (there is no production deployment and no off-box log path). Corrected 2026-09-11 after checking; the first version of this doc recommended the log route and was wrong.

## The eval question, settled: no existing eval can detect this

Asked directly during the session: would running one of the existing eval sets identify whether `search_evidence` fires? No. It cannot, by construction, and "unlikely" would understate that.

Every tool-aware evaluator grades `run.outputs.output.toolTrajectory`. That projection is built in exactly one place:

```ts
// packages/agent/src/eval/run-function.ts:245
const toolTrajectory = buildToolTrajectory(finalState.dataSourceResults ?? []);
```

and `tool-trajectory.ts:8` states its source: "Source is DataSourceResult.toolErrors[]/toolOutputs[]".

`search_evidence` never enters either. It is bound to the loop AFTER instrumentation wraps the datasource tools:

```ts
// packages/agent/src/sub-agent.ts:1612
const loopTools = evidenceIndex
    ? [...instrumentedTools, buildSearchEvidenceTool(evidenceIndex)]
    : instrumentedTools;
```

`instrumentTools` is what pushes into `ctx.rawOutputs`, and `toolOutputs[]` is derived from `rawOutputs` (`sub-agent.ts:1765`). An unwrapped tool produces no MCP result, so it lands in neither. Therefore `search_evidence` is invisible to `tool_arg_validity`, `tool_name_validity`, `expected_tools_fired`, `tool_efficiency` and every other trajectory key.

Consequence: running `eval:incident-replay` or `eval:mcp-tool` to answer this would spend Bedrock and judge budget and return a confident silence that looks like "it never fired" but actually means "the instrument cannot see it". Do not do it for this purpose.

## Three ways forward (A is blocked; B is the live one)

### Option A: read production logs. BLOCKED, do not attempt today

Checked 2026-09-11. There is nothing to query. Three independent findings:

1. **The logger has no network sink.** `createMcpLogger` (`packages/shared/src/logger.ts:244,265,279`) builds pino over `pino.destination({ dest: fd })`, file descriptor 1 or 2. No OTLP log exporter, no CloudWatch transport. `packages/observability/src/otel.ts` re-exports tracing only, with no `LoggerProvider`. Logs reach a process's stdout/stderr and stop.
2. **No runtime runs `apps/web`.** AgentCore has exactly two runtimes, `kafka_mcp_server` (READY, updated 2026-04-07) and `aws_mcp_server` (READY, updated 2026-05-15). `evidence_index.search` is emitted by `apps/web`, which is not deployed. This is consistent with `docs/runbooks/mcp-agentcore-image-deployment.md:157`, which contrasts those two containers against `apps/web` precisely because the web app is not one of them.
3. **No log group could hold it.** Six log groups exist in eu-central-1; the only two candidates belong to those same MCP servers and both report 0 stored bytes.

The instrumentation itself is correct and worth keeping:

```
event=evidence_index.search
fields: scopedTool, queryTermCount, hitCount, indexedRows
```

Emitted in `packages/agent/src/evidence-index.ts` (search method). Paired with `subagent.tool_result_truncated`'s `indexedRows`, it gives the adoption ratio (turns where recovery was POSSIBLE vs turns where the model reached for it) the moment a queryable destination exists.

**This option unblocks only when BOTH hold:** `apps/web` is deployed somewhere, and its stdout is shipped to a store someone can query. Neither is true today, and neither is in scope for this follow-up. Until then, use Option B.

### Option B: a targeted probe whose answer REQUIRES an elided record. THE ONLY ROUTE THAT WORKS TODAY

The 2026-09-11 A/B failed to settle this because the scenario ("top error signatures") was answerable from aggregation buckets that survived truncation. The model was never forced to look further.

A valid probe needs a question whose answer lives only in a truncated tail. Sketch:

```bash
PROBE_DATASOURCE=elastic \
PROBE_SCENARIO="Find the single document mentioning <a rare term known to sit deep in a large result set> and quote its _id" \
bun --env-file=/Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer/.env \
  run src/eval/single-agent-probe-cli.ts
```

Run from `packages/agent`. Note the explicit `--env-file` path: the package script uses `--env-file=../../.env`, which resolves inside a worktree where no `.env` exists, and the symptom is a LangSmith 401 or missing MCP URLs rather than a clear error.

Picking the rare term is the hard part and must be done against live data first, or the probe proves nothing again.

### Option C: if adoption is genuinely zero, fix the WORDING

The pointer the model sees is at `packages/agent/src/sub-agent-instrumentation.ts:513`:

```
[Truncated for context: {N} bytes cut to {M}. The full result is searchable: call
search_evidence with a query and tool="{toolName}" to retrieve any part of it,
including what was cut.]
```

And the tool description at `packages/agent/src/evidence-index.ts:334` begins "Search the FULL text of tool results already returned in this run...".

If the event never fires on turns that DID truncate, the lever is this text, not the machinery.

**Explicitly NOT the lever: tightening truncation to force search traffic.** `packages/agent/src/sub-agent-context-budget.ts:36-40` records a deliberately harsh 60,000-byte run that elided a live search result mid-investigation, flailed on follow-ups, hit the recursion limit and scored 0.15. Do not repeat that experiment.

## Where the bodies are buried

- `packages/agent/src/evidence-index.ts`: the store, the chunker, `sanitizeQuery`, and `buildSearchEvidenceTool`. Per-run, in-memory, closed in `sub-agent.ts`'s existing `finally`.
- `packages/agent/src/sub-agent-instrumentation.ts:341`: indexing happens at tool-result time, deliberately NOT at the SIO-1248 persist site, because that site runs only after the loop finishes and could never serve an in-loop search.
- `packages/agent/src/sub-agent-instrumentation.ts:513`: the pointer, appended only when `indexedRows > 0` so it can never name a search that returns nothing.
- `packages/agent/src/sub-agent.ts:1612`: where the tool is bound, and the reason it is invisible to the eval trajectory.

## Measured facts from the 2026-09-11 A/B (do not re-derive)

Tier-2 single-agent probe, elastic, same scenario both legs, live MCP and Bedrock. Both legs completed `success`, no recursion limit, no loop-guard stop, no salvage.

| Leg | Tool | Original | Kept for model | Lost | Rows indexed |
|---|---|---|---|---|---|
| off | elasticsearch_search | 719,000 | 139 | 99.98% | 0 |
| on | elasticsearch_multi_search | 465,563 | 419 | 99.91% | 127 |
| on | elasticsearch_multi_search | 236,190 | 1,485 | 99.37% | 68 |

The headline is the scale of pre-existing loss this exposed, not the feature. A 719 KB result reaching the model as 139 bytes was already happening and was already unrecoverable; the index is what makes the remainder reachable.

Zero `evidence_index_failed` events. Nothing indexed for results that fit. Kill switch verified (off leg indexed nothing).

## Verification for any follow-up change

```bash
bun run typecheck && bun run lint
```

```bash
cd packages/agent && bun test
```

```bash
cd apps/web && bun run test
```

```bash
cd packages/gitagent-bridge && bun test
```

That last one matters: it was skipped during the original session and CI caught a persona-export pin failure as a result. `bun run test` at the repo root exits 139 (documented Bun runner crash) even when every package passes, so read per-package results rather than the root exit code.

Expected: agent shows ~24 pre-existing failures confined to `src/iac/*` from cross-file mock pollution; running those seven files in isolation drops it to 2. That is the baseline, not a regression. Prove any "pre-existing" claim by diffing against a clean checkout rather than asserting it.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Someone runs an eval to answer this and reads the silence as a negative | High, it is the obvious move | This doc's section 2; the trajectory cannot see the tool |
| Someone tightens truncation to force search traffic | Medium | The 0.15 regression is recorded at `sub-agent-context-budget.ts:36-40` |
| Probe scenario is again answerable without recovery | High if rushed | Pick the rare term against live data BEFORE writing the scenario |
| Adoption looks zero because no turn truncated at all | Medium | Check the `indexedRows > 0` denominator first |
| Someone hunts for production logs that cannot exist | High, the first version of this doc recommended it | Option A above; the logger writes to a file descriptor and `apps/web` is not deployed |

## Out of scope

- Extending `buildToolTrajectory` to cover non-MCP loop tools. It would make this eval-gradeable, but it changes a projection with a documented privacy invariant (`tool-trajectory.ts`: never args, never rawJson) and affects every existing fixture. Worth its own ticket if wanted, not a side effect of this follow-up.
- The heavier `eval:incident-replay` harness for a quality-delta claim. Not a prerequisite for what merged.
- Web app runtime in AgentCore prod (Bun vs Node), which would decide whether the evidence store needs the dual-driver path from `tool-call-metrics.ts:184-267`. PARTLY ANSWERED 2026-09-11: `apps/web` is not deployed to AgentCore at all (only the two MCP server runtimes are), so the question is moot until it is deployed, and the `bun:sqlite` path is the only one exercised today.
- Deploying `apps/web` and shipping its logs to a queryable store. That is what would unblock Option A, and it is a real piece of infrastructure work, not a side effect of this follow-up.
- Phase 3 items 5, 6 and 8. Retired on evidence; see spec section 11.

## Memory references

- `reference_sio1688_search_evidence_adoption_unproven`: this gap and its exit criterion
- `project_context_mode_feasibility_sio1686`: the decisions, phases and do-not-do list
- `feedback_prove_already_solved_by_code_comparison`: prove claims by comparison, never assertion
- `reference_sio1248_inflight_vs_persist_cap_decoupling`: why truncation must not be tightened
- `reference_eval_scripts_env_file_breaks_in_worktree`: the `--env-file` worktree trap
- `feedback_lint_changed_files_and_baseline_diff`: proving "pre-existing" properly
