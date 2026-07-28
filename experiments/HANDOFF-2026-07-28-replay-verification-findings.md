# HANDOFF 2026-07-28 — four defects surfaced by the SIO-1264..1268 verification replay

| | |
|---|---|
| **Date** | 2026-07-28 |
| **Tickets** | [SIO-1270](https://linear.app/siobytes/issue/SIO-1270) judge-abort fail-closed (High) · [SIO-1271](https://linear.app/siobytes/issue/SIO-1271) judge tokens streamed to the UI (High) · [SIO-1272](https://linear.app/siobytes/issue/SIO-1272) AWS absence exit pre-empted (Medium) · [SIO-1273](https://linear.app/siobytes/issue/SIO-1273) missing Confidence line (Medium) |
| **Parent context** | [SIO-1266](https://linear.app/siobytes/issue/SIO-1266), [SIO-1268](https://linear.app/siobytes/issue/SIO-1268) — these were found while verifying their fixes, and are adjacent to but NOT covered by them |
| **Repo state** | `main` at `8688332e`. Five PRs open and awaiting review: [#508](https://github.com/zx8086/devops-incident-analyzer/pull/508) SIO-1264, [#509](https://github.com/zx8086/devops-incident-analyzer/pull/509) SIO-1265, [#510](https://github.com/zx8086/devops-incident-analyzer/pull/510) SIO-1267, [#511](https://github.com/zx8086/devops-incident-analyzer/pull/511) SIO-1266, [#512](https://github.com/zx8086/devops-incident-analyzer/pull/512) SIO-1268 |
| **Source run** | thread `sio1264-1268-replay`, requestId `0e8c9311-84b2-43d4-9e0a-75a7dcd6468c`, runId `eaebc62b-3e90-4b0d-942f-9220fd2bf058`, 2026-07-28T10:06Z, 362s, 43 tools, 4 datasources |
| **Suggested branches** | `claude/absence-judge-deadline-fail-closed`, `claude/sse-suppress-judge-tokens`, `claude/aws-absence-exit-preempted`, `claude/confidence-line-missing` |

---

## TL;DR

All five SIO-1264..1268 fixes were merged into one integration branch and replayed live against
the real estate. **Three verified working end-to-end** (1264, 1265, 1267). The other two did not
fire — for reasons that are themselves defects, all four **pre-existing** and none introduced by
those PRs:

1. **The absence judge times out and fails closed into a wrong caveat.** Its 8s deadline was hit;
   it returned `null`; the regex verdict stood; a correctly-scoped, enumeration-backed confirmed
   negative got tagged *"the labelled datasource returned data matching this claim… treat the
   returned data as ground truth."* The judge had already decided **the opposite**. This is the
   exact class of wrong-reason caveat SIO-1266 exists to remove, arriving by a different route.
2. **The absence judge's raw JSON is streamed to the browser** as `message` events, because it runs
   inside the `aggregate` node and `sse-pump.ts` forwards every LLM token from that node.
3. **SIO-1268's early exit is gated behind a precondition a different guard can pre-empt.** The
   run-wide unproductive backstop stopped `aws_ecs_list_clusters`, which correctly marks enumeration
   incomplete and disables the exit — so the optimisation may rarely trigger in a busy estate.
4. **The report carried no `Confidence:` line at all** (`confidence: 0`, `confidencePreCap: 0`), so
   the cap machinery ran with no number to cap.

Success looks like: the judge either completes or its failure does not manufacture a false caveat;
judge tokens never reach the client; the AWS exit is reachable in a realistic run; and a report
without a confidence line is detected rather than silently scored 0.

---

## Context — how these came to be

The five SIO-1264..1268 fixes were implemented and unit-tested, then verified end-to-end rather than
on tests alone. Because SIO-1264 and SIO-1265 are **MCP-server-side**, a plain web-server replay
would not have exercised them at all — the running `:9080`/`:9082` servers are `main` code. The
replay therefore ran three worktree processes (elastic MCP, couchbase MCP, web) on alternate ports.
See "Reproducing the replay" below; that setup is the main cost of picking this work up.

What the replay proved about the PRs, for reference:

- **SIO-1264 PASS** — live MCP served `latencyMs: 244, latencyNs: 244000000`, no `latency_us`.
  Report quotes 513/318/283/308/313/21 ms; **no value >= 10,000 ms anywhere**. Pre-fix, 513 would
  have printed as "513,000 ms".
- **SIO-1265 PASS** — `elasticsearch_multi_search` ran and emitted **zero** failure headers, i.e. it
  succeeded under the new schema. In the defect run this same tool failed with
  `illegal_argument_exception` and was published as "0 hits".
- **SIO-1267 PASS** — `subagent.loop_guard_stop` now carries `reason`: 2x `duplicate-call`,
  1x `unproductive-streak`. Previously indistinguishable.

The four items below are what the same run exposed that those PRs do **not** address.

---

## Finding 1 — [SIO-1270](https://linear.app/siobytes/issue/SIO-1270) — the absence judge fails closed into an actively wrong caveat (High)

### Evidence from the run

```
"service":"agent:absence-judge", ... "error":"Model invocation was aborted."
absenceJudgeUsed":true
absenceJudgeVetoedCount":0
```

The judge's own verdict was visible in the token stream before the abort:

```json
{"verdicts":[{"index":0,"contradictedByData":false,
  "reason":"The sentence makes a scoped negative claim ... the evidence cannot contradict
            the sentence's claim about service absence ..."}]}
```

`contradictedByData: false` means **veto** — do not flag. The abort discarded it, so the report shipped:

> - **Flagged in "AWS -- eu-oit-prd":** Complete enumeration of all 7 ECS clusters in this estate
>   found no service named `pvh-services-styles-v3` … **not deployed in this estate** (enumeration
>   completed successfully, all pages walked).
>   - *The labelled datasource returned data matching this claim, so the absence is not supported.
>     Treat the returned data as ground truth.*

The claim is a textbook SIO-1242 confirmed negative. The caveat contradicts it and instructs the
operator to trust data that does not exist.

### Where the bodies are buried

`packages/agent/src/absence-judge.ts:155-180` (main) — the deadline and the fail-closed return:

```ts
const result = await invokeWithDeadline(
    llm,
    "absenceJudge",
    [new SystemMessage(JUDGE_PROMPT), new HumanMessage(`Evidence:\n${evidence}\n\nFlagged sentences:\n${numbered}`)],
    config,
);
// ...
} catch (error) {
    // Parity with gaps-judge (CodeRabbit, PR #416): a caller-requested cancellation
    // must propagate -- only judge-local failures (including the 8s role deadline)
    // fail closed to the regex verdict.
    if (config?.signal?.aborted) throw error;
    logger.warn({ error: ... }, "absence judge failed");
    return null;
}
```

`packages/agent/src/llm.ts:189` — `absenceJudge: 8_000`; `:120` —
`absenceJudge: { temperature: 0, maxTokens: 1024 }`; `:302` — it is a
`DEFAULT_LIGHTWEIGHT_ROLES` member, so it runs on `LIGHT_TIER_MODEL` (Haiku).

`packages/agent/src/aggregator.ts:1565-1573` (main) — `null` silently means "keep the regex verdict":

```ts
let absenceJudgeUsed = false;
if (contradicted.length > 0 && isAbsenceJudgeEnabled()) {
    absenceJudgeUsed = true;
    const verdicts = await judgeContradictedAbsenceClaims(absenceDetection.contradictedDetails, results, config);
    if (verdicts !== null) {
        contradicted = absenceDetection.contradictedDetails.filter((_, i) => verdicts[i]).map((c) => c.line);
    }
}
```

### Why fail-closed is the wrong default *here*

Fail-closed was chosen so a judge failure cannot *suppress* a real cap. But the failure mode observed
is the opposite harm: it **asserts a specific, checkable, false statement** about the data. There is a
difference between "we could not verify this claim, so we keep the cap" and "the datasource returned
data matching this claim" — only the second is a fabrication, and only the second is what ships.

### The fix (pick one; 1 is smallest and safest)

1. **Decouple the cap from the caveat text on judge failure.** When `verdicts === null`, keep the cap
   (fail-closed preserved) but emit a *non-asserting* note — e.g. "this absence claim could not be
   automatically verified; the check timed out" — instead of `CONTRADICTED_ABSENCE_NOTE`. Thread a
   `judgeFailed` boolean out of the judge call and into `buildPrematureAbsenceCaveats`. This makes
   the report honest without changing which runs cross the HITL gate.
2. **Raise `absenceJudge` past 8_000 ms** in `ROLE_DEADLINES_MS`. Cheap, but only reduces the
   frequency; the wrong caveat still ships whenever it does fire.
3. **Shrink the judge's output.** `maxTokens: 1024` with verbose per-claim `reason` strings is tight.
   Instruct the prompt to cap `reason` at ~15 words, or drop `reason` from the schema entirely — it is
   only used for logging.

Do **1** regardless. **3** is a good companion. Note **SIO-1266 ([#511](https://github.com/zx8086/devops-incident-analyzer/pull/511))
adds an ERROR block to the evidence digest**; it is budgeted *out of* the existing per-group allowance so
total digest bytes are unchanged, but confirm against a replay that it has not made the 8s deadline
tighter in practice.

---

## Finding 2 — [SIO-1271](https://linear.app/siobytes/issue/SIO-1271) — the absence judge's tokens are streamed to the browser (High)

### Root cause, confirmed

`apps/web/src/lib/server/sse-pump.ts:41` and `:175-184` (main):

```ts
const OUTPUT_NODES = new Set(["aggregate", "responder"]);
// ...
if (event.event === "on_chat_model_stream") {
        const tags: string[] = event.tags ?? [];
        const isOutputNode = tags.some((t: string) => OUTPUT_NODES.has(t));
        const nodeName = event.metadata?.langgraph_node;
        if (isOutputNode || (nodeName && OUTPUT_NODES.has(nodeName))) {
            send({ type: "message", content });
```

The absence judge (and by the same argument the overgeneralized judge, and any other LLM call made
inside `aggregate`) runs with `langgraph_node === "aggregate"`, which is in `OUTPUT_NODES`. **Every
token it produces is forwarded to the client as a user-visible `message` event.**

### Impact

In the replay the assembled `message` stream ends mid-word and then contains the judge's raw JSON:

```
... at 2026-07-28T09:55:35Z-09:55:41Z, all returning HT```json
{ "verdicts": [ { "index": 0, "contradictedByData": false, "reason": "The sentence makes ...
```

In the browser a user sees judge JSON appear in the chat. It is later superseded by the
`message_final` event (which carries the correct, complete report), so the end state is right and
this has probably been dismissed as flicker.

**This also has a trap for anyone verifying the agent by curl**: concatenating `type:"message"`
chunks does **not** give you the answer. Use the single `type:"message_final"` event. This cost real
time during the SIO-1264..1268 verification and initially looked like a corrupted report.

### The fix

Filter on something narrower than the node name. Options, best first:

1. Tag the report-producing LLM call explicitly (e.g. `tags: ["final-answer"]`) and match only that,
   rather than matching the whole `aggregate` node.
2. Exclude known judge/utility roles by run name — the LLM calls already pass a `role`
   (`absenceJudge`, `gapsJudge`, `classifier`, …) through `invokeWithDeadline`; surface it as a tag
   and skip those.

Add a test that a judge-role token never produces a `type:"message"` event.

---

## Finding 3 — [SIO-1272](https://linear.app/siobytes/issue/SIO-1272) — SIO-1268's absence exit is pre-empted by the run-wide backstop (Medium)

### Evidence

```
"event":"subagent.loop_guard_stop","deploymentId":"estate:eu-oit-prd",
"toolName":"aws_ecs_list_clusters","iteration":16,"unproductiveSearches":0,"reason":"unproductive-streak"
```

Only **2** `aws_ecs_list_clusters` calls were made in that estate, so this cannot be the per-tool cap
(`MAX_UNPRODUCTIVE_PER_TOOL = 3`). It is the **run-wide** backstop,
`MAX_UNPRODUCTIVE_PER_RUN = 8` (`packages/agent/src/sub-agent-loop-guard.ts:24-25`), tripped by
*other* tools' unproductive results and then applied to an ECS list call.

### Why that disables the exit — correctly

PR [#512](https://github.com/zx8086/devops-incident-analyzer/pull/512) marks a guard-stopped ECS list
as `awsEcs.failed = true`, because a stopped list means that page/cluster was never walked and
enumeration is therefore unprovable. That is the intended safety behaviour — a partial enumeration
must never early-exit. So the exit did not fire, and the estate still ran to iteration 47.

The model reached the right conclusion unaided ("not deployed in this estate … all pages walked"),
which is worth noting: it also means the model *claimed* complete enumeration while the guard had
stopped one of its list calls.

### The tension to resolve

This is the same class of problem PR #482 already fixed once for the CloudWatch poll: a run-wide
counter that other tools raise being applied to a tool that cannot raise it. Options:

1. Add the two ECS list tools to `GENERIC_GUARD_EXEMPT_TOOLS`, mirroring the PR #482 reasoning —
   they cannot meaningfully spam (bounded by cluster count) and blocking them strands enumeration.
   **Check first** whether they can contribute to `totalUnproductive`; if they can, exempt them from
   *contributing* as well as from *being blocked*, or the exemption is incoherent.
2. Make the run-wide backstop per-*category* rather than global.
3. Accept it and treat SIO-1268 as best-effort.

Option 1 is most consistent with existing precedent. **Do not** "fix" the empty-ECS-list productive
classification as part of this — see `reference_sio1266_1268_absence_and_ecs_ledger`; it is
load-bearing, and making empty lists unproductive would cap enumeration at 3 clusters and disable the
exit permanently.

---

## Finding 4 — [SIO-1273](https://linear.app/siobytes/issue/SIO-1273) — the report carried no Confidence line, and scored 0 (Medium)

### Evidence

`done` event: `confidence: 0`, `confidencePreCap: 0`, `capReasons: ["premature-absence"]`,
`lowConfidence: false`. The 13,495-char report contains **no** line matching `confidence` at all.

So the cap machinery ran (`capMode: hard`, one reason) against a score of 0. Note the incoherence:
`confidence: 0` with `lowConfidence: false`.

### Where to look

`packages/agent/src/aggregator.ts:333-350` (main):

```ts
const STRICT_CONFIDENCE_RE = /^\s*[*_>\-\s]*\**\s*confidence(?:\s+score)?\s*:?\**\s*([0-1](?:\.\d+)?)/im;
const LOOSE_CONFIDENCE_RE  = /confidence[^0-9]{0,20}([0-9]+(?:\.[0-9]+)?)/i;
export function extractConfidenceScore(answer: string): number {
    const strict = answer.match(STRICT_CONFIDENCE_RE);
    // ...
    const loose = answer.match(LOOSE_CONFIDENCE_RE);
```

Both regexes are fine; the model simply never emitted the line. The defect is that a **missing**
confidence line is indistinguishable from a **stated** confidence of 0.

### The fix

1. Return `null` from `extractConfidenceScore` (or a discriminated `{found:false}`) rather than `0`,
   and have callers treat "absent" as its own state — surface it as a report-quality problem instead
   of a score.
2. Find out why the line was dropped. Worth checking whether the aggregator prompt still mandates it
   and whether a long report is truncating the tail before it is written.
3. `lowConfidence: false` alongside `confidence: 0` should be impossible; whichever branch computes
   it needs to agree.

---

## Reproducing the replay

This is the expensive part; budget for it. The user's `:5173` and MCP servers run **main** and must
not be touched. MCP-side changes require worktree MCP servers on alternate ports.

```bash
cd <WORKTREE>
cp <MAIN_CHECKOUT>/.env .env
# sed-REPLACE, never append -- first occurrence of a key wins, and the ROOT .env
# beats apps/web/.env (reference_worktree_web_server_replay_env)
sed -i '' \
 -e 's#^ELASTIC_MCP_URL=.*#ELASTIC_MCP_URL=http://localhost:9180#' \
 -e 's#^COUCHBASE_MCP_URL=.*#COUCHBASE_MCP_URL=http://localhost:9182#' \
 -e 's#^LIVE_MEMORY_ENABLED=.*#LIVE_MEMORY_ENABLED=false#' \
 -e 's#^AGENT_MEMORY_ENABLED=.*#AGENT_MEMORY_ENABLED=false#' .env
echo "KNOWLEDGE_GRAPH_MCP_PORT=9187" >> .env   # this key is absent, so append IS correct
cp .env apps/web/.env

# three tracked processes
(cd packages/mcp-server-elastic   && MCP_TRANSPORT=http MCP_PORT=9180 bun --env-file=../../.env src/index.ts &)
(cd packages/mcp-server-couchbase && MCP_TRANSPORT=http MCP_PORT=9182 bun --env-file=../../.env src/index.ts &)
(cd apps/web && bun run dev -- --port 5174 &)
```

Confirm the MCP servers are serving *your* code before trusting the run — `tools/list` on `:9180`
should show `searches.items.properties = [index, query]`, and `capella_get_cluster_health` on `:9182`
should return `latencyMs`/`latencyNs` with no `latency_us`.

Drive it:

```bash
curl -sS -N -X POST http://localhost:5174/api/agent/stream -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Investigate pvh-services-styles-v3: we are seeing CHANNEL_CLOSED_WHILE_IN_FLIGHT errors ..."}],
       "threadId":"replay","dataSources":["couchbase","elastic","gitlab","aws"],
       "uiAwsEstates":["eu-shared-services-prd","eu-oit-prd"]}' --max-time 1500 -o replay.sse
```

**Read `type:"message_final"`, not the concatenation of `type:"message"`** — see Finding 2.

Teardown is non-negotiable: kill all three by tracked PID, then prove
`lsof -nP -iTCP:9180 -sTCP:LISTEN` (and 9182, 5174, 9187) is empty, and
`rm .env apps/web/.env && rm -rf apps/web/.data`.

---

## Files to modify

| File | Change | Finding |
|---|---|---|
| `packages/agent/src/absence-judge.ts` | Signal judge failure to the caller; trim `reason` verbosity | 1 |
| `packages/agent/src/aggregator.ts` | Non-asserting caveat when the judge failed; keep the cap | 1 |
| `packages/agent/src/llm.ts` | Possibly raise `ROLE_DEADLINES_MS.absenceJudge` from 8_000 | 1 |
| `apps/web/src/lib/server/sse-pump.ts` | Narrow the `OUTPUT_NODES` filter so judge tokens are not streamed | 2 |
| `packages/agent/src/sub-agent-loop-guard.ts` | Reconcile the run-wide backstop with ECS enumeration | 3 |
| `packages/agent/src/aggregator.ts` | `extractConfidenceScore` must distinguish absent from 0 | 4 |

---

## Verification

```bash
cd <REPO>
bun run typecheck && bun run lint && bun run test
bun run --filter '@devops-agent/agent' test
bun run --filter '@devops-agent/web' test
```

Targeted assertions to add:

- **1**: a judge returning `null` produces a caveat that does **not** contain "returned data matching
  this claim", while `capReasons` still contains `premature-absence`.
- **2**: an `on_chat_model_stream` event carrying a judge role/tag produces no `type:"message"` event.
- **3**: an ECS list call is not blocked by `totalUnproductive` raised by other tools.
- **4**: `extractConfidenceScore` on an answer with no confidence line is distinguishable from one
  stating `Confidence: 0`.

---

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Changing the judge-failure caveat alters which runs cross the HITL gate | **Low if done as proposed** | Keep the cap and `capReasons` identical; change only the note text. Assert the cap value is unchanged. |
| Narrowing the SSE filter accidentally suppresses the real answer | **High impact** | The final answer also arrives via `message_final`; test both paths, and check the frontend does not rely solely on `message` chunks for rendering. |
| Exempting ECS lists from the run-wide backstop removes a termination guarantee | Medium | Bounded by cluster count, but confirm they cannot contribute to `totalUnproductive` either — an exemption from being blocked but not from contributing is incoherent (PR #482 precedent). |
| Raising the judge deadline slows every turn | Medium | It is a light-tier call; measure before/after. Prefer shrinking the output first. |

---

## Out of scope

- The five open PRs (#508-#512). These findings are adjacent; none of them blocks a merge, and all
  four defects predate those PRs.
- `extractClaimEntities` returning ISO-timestamp fragments on timeline table rows — already spun off
  separately (SIO-1269 / [#507](https://github.com/zx8086/devops-incident-analyzer/pull/507)), and it
  overlaps #511 in `aggregator.ts`.
- The "model claimed complete enumeration while a list call was guard-stopped" wording issue in
  Finding 3 — a prompt-honesty question, not the mechanism.
- Re-litigating fail-closed as a general policy. It is right for the cap; only the caveat *text* is
  wrong.

---

## Related code references (already correct — use as patterns)

- `packages/agent/src/llm.ts:159-205` — `ROLE_DEADLINES_MS` and `getRoleDeadlineMs`; the per-role
  deadline seam any Finding-1 change should use rather than a bespoke timer.
- `packages/agent/src/llm.ts:302` — `DEFAULT_LIGHTWEIGHT_ROLES`; why the judge runs on the light tier
  (SIO-1262's `LIGHT_TIER_MODEL` split). Do not re-couple it to the specialist model.
- `packages/agent/src/sub-agent-loop-guard.ts:41-57` — `GENERIC_GUARD_EXEMPT_TOOLS` and the PR #482
  reasoning; the exact precedent Finding 3 should follow.
- `packages/agent/src/aggregator.ts:1017-1028` (main) — the SIO-1242 comment explaining why caveats
  are *recorded* rather than spliced into the claim line. Any new note must respect it.

---

## Memory references

`reference_worktree_web_server_replay_env` (the replay recipe, incl. the append-vs-sed env gotcha),
`reference_agent_stream_curl_endpoint`, `reference_sio1266_1268_absence_and_ecs_ledger` (why empty ECS
lists must stay productive), `reference_confidence_two_class_policy_sio1194_1195` (0.59 is the HARD
cap), `reference_absence_judge_premature_absence_veto`, `reference_couchbase_latency_us_is_actually_nanoseconds`,
`feedback_always_kill_own_background_processes_safely`, `feedback_repo_is_public_sanitize_before_commit`,
`feedback_validate_every_claim_against_source`.
