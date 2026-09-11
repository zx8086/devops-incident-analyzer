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

**RESOLVED 2026-09-11 on the third probe attempt. The model DOES call `search_evidence`, unprompted, three times in one run.** See "Resolution" at the bottom. The rest of this doc is kept because its dead ends are load-bearing: two earlier attempts were void, and the reasons are what the third one had to fix.

Running an eval cannot see the tool (structural, section below). Reading production logs has no target (no deployment, no off-box log path). The targeted probe DID work, once the deployment was pinned and the scenario was reshaped.

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

## Three ways forward (A blocked by infrastructure; B blocked in practice; C is a code change)

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

### Option B: a targeted probe whose answer REQUIRES an elided record. ATTEMPTED 2026-09-11, BLOCKED IN PRACTICE

Attempted and abandoned after one void run. Read this before trying again.

**The probe CLI cannot pin a deployment.** `probeSubAgent(dataSourceId, scenario)` builds state via `buildProbeState`, which sets only `currentDataSource` and the scenario message. `targetDeployments` stays `[]`, so `selectElasticDeployments` returns `[]`, `runSubAgent` takes the non-fan-out path, and the bridge sends no `x-elastic-deployment` header. `ELASTIC_DEFAULT_DEPLOYMENT` is unset, so the server picks its own default, which is not the cluster holding the data. The first run therefore hit `index_not_found_exception` on every query, largest tool result 3,855 bytes, zero truncations. Void, not negative.

The eval datasets show the supported shape: every elastic example carries `uiSelectedElasticDeployments: [LIVE_ANCHORS.elastic.deployment]` (`eu-b2b`) because the UI normally supplies it. A rerun needs a caller that builds the state itself and sets `targetDeployments: ["eu-b2b"]`, then calls `queryDataSource` directly. `buildProbeState`'s own comment sanctions this.

**Four obstacles were hit designing the anchor:**

1. Deployment scope, above. Real, and the one genuinely useful finding.
2. `elasticsearch_search` takes `query`, NOT `queryBody`. The wrong key is silently dropped by Zod `.passthrough()` and the search runs UNFILTERED while looking perfectly normal. This voided an entire round of "deep term at position 120" and rarity findings. Detect it with an impossible-filter control test: `{"match_phrase": {"message": "zzz-cannot-exist-12345"}}` must return 0.
3. Depth is not reproducible. `sort: ["_doc"]` is unstable across a data stream's many backing indices, so "outside the surviving 3 hits" cannot be fixed in advance. `@timestamp` sorting times out on the full alias.
4. `match_phrase` on `message` (type `match_only_text`, no positions stored, 188M docs/index) times out even against one backing index. Cheap alternatives that DO work: a token `match`, or a `range` on `@timestamp`. Note the 2026.09.03 backing index has rolled over and holds nothing recent, so a live anchor needs the current write index.

**The structural problem that outlives all four:** the scenario can invite a broad sweep but cannot compel one. The sub-agent chooses its own tool calls, and the first run went straight to narrow queries. So a null result still cannot distinguish "the model will not use the tool" from "nothing truncated". Until that is solved, this route cannot produce interpretable evidence, which is why it was abandoned rather than retried a fifth time.

Payload sizes ARE confirmed, since they depend only on `size` and not the dropped filter: 150 hits on `eu-b2b` returns 243,113 characters against the 131,072-byte cap, so truncation WOULD fire on a genuine broad sweep.

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


## Resolution, 2026-09-11 (third probe attempt)

The model calls `search_evidence` unprompted. Measured, not inferred.

```
subagent.tool_result_truncated  toolName=elasticsearch_search originalBytes=43676
                                finalBytes=39589 strategy=json-array indexedRows=201
evidence_index.search  scopedTool=elasticsearch_search queryTermCount=6  hitCount=3 indexedRows=201
evidence_index.search  scopedTool=elasticsearch_search queryTermCount=11 hitCount=3 indexedRows=201
evidence_index.search  scopedTool=null                 queryTermCount=20 hitCount=0 indexedRows=201
```

Three calls, 201 indexed rows, zero index failures, run status `success` on `elastic/eu-b2b`. Two scoped searches found hits; a third broader unscoped one did not, which is the model widening its own query and getting an honest miss.

### What is proven, and what is not

PROVEN: **given truncation, the model reaches for recovery.**

NOT proven: how often truncation occurs at the production cap. The run used `SUBAGENT_TOOL_RESULT_CAP_BYTES=40000` because the result was 43,676 bytes, under the 131,072 default, so nothing would have truncated otherwise. That is a legitimate probe parameter to create the condition, and emphatically NOT a production setting: `sub-agent-context-budget.ts:36-40` records a 0.15 regression from tightening caps live.

### The three things that made attempt 3 work

1. **Pin the deployment.** The CLI cannot (see Option B above). A caller must build state itself and set `targetDeployments: ["eu-b2b"]`, then call `queryDataSource` directly.
2. **Aggregate-over-retrieved-evidence, never find-one-needle.** A named needle invites a narrow re-query: small result, no truncation, nothing to recover. That is what made attempt 1 uninterpretable. "List every distinct id across the 150+ records you retrieved" makes every record matter and makes re-querying pointless, so recovery becomes the rational move rather than a detour.
3. **Force the truncation condition via the cap.** Scenario prose cannot dictate `size`; attempt 2 asked for a broad sweep and the sub-agent chose a 109,076-byte fetch, 22 KB under the cap, so nothing truncated.

### Bonus finding, attempt 2

With nothing indexed, the model reported "The search_evidence tool doesn't have the full result indexed" and worked from raw output instead. The deliberate "absence from the index, not absence in the world" wording in the miss message behaved exactly as designed.

### Unrelated defect found along the way

`elasticsearch_scroll_search` failed twice per run with `parsing_exception: unknown query [query]` at `[1:19]`, plus one timeout. Its schema declares `query: z.object({}).passthrough()` (`packages/mcp-server-elastic/src/tools/search/scroll_search.ts:20`) and forwards it at `:129`, so the shape the model sends is being passed through unwrapped into a position Elasticsearch does not accept. Reproduced across two independent runs. Filed separately; not a SIO-1686 concern.