# Handover: SIO-1372 sub-agent model eval — judge needs a root-cause gate

**Date**: 2026-08-03
**Ticket**: [SIO-1372](https://linear.app/siobytes/issue/SIO-1372) (elastic-iac + 7 sub-agents to claude-opus-5, tracked A/B against SIO-1367's claude-haiku-4-5 baseline)
**Parent epic**: none — a follow-on model-tiering investigation, not part of the original monorepo epics
**Repo state**: branch `claude/agent-model-config-patterns-e5e173`, HEAD `ee67ad9a` ("SIO-1367: address CodeRabbit review on PR #585"), all work below is **uncommitted** in the worktree `.claude/worktrees/handover-review-next-steps-1582db`
**Suggested branch for follow-on work**: continue on `claude/agent-model-config-patterns-e5e173` (already has all the uncommitted changes) or branch off it as `claude/sio1372-judge-rootcause-gate` once the current changes are committed

## TL;DR

We built a new eval harness (real-incident replay, not synthetic queries) and a new holistic 1-10 LLM-judge to compare `claude-haiku-4-5` vs `claude-sonnet-4-6` as the incident-analyzer's 7 sub-agent model. The harness works and produced real, non-flattened signal (unlike an earlier binary judge). **But manually reading one example's full output exposed a real defect in the new judge**: it scored Sonnet 4.6's response 8/10 even though that response never identified the incident's actual root cause (a nightly batch job) — the judge rewarded thoroughness, correlation quality, and "close in spirit" framing, with no check that the named cause was actually correct. Success for the next session: add a root-cause-correctness gate to the judge (a separate field that caps the holistic score when the named cause is wrong), then re-run both A/B legs and see whether the Haiku-vs-Sonnet-4.6 comparison changes. Only after that should SIO-1372's Opus 5 decision lean on `response_quality` numbers at all — right now they're not trustworthy enough to gate a model choice.

## Context — how this came to be

This is a side investigation that grew out of SIO-1367 (swap `elastic-iac` + 7 sub-agents to `claude-haiku-4-5`, merged as PR [#585](https://linear.app/siobytes/issue/SIO-1367)). After that shipped, the user wanted to try the 7 sub-agents on `claude-opus-5` instead (root orchestrator stays `claude-sonnet-5`, untouched) — tracked as SIO-1372. Partway into that work we discovered `claude-opus-5` is currently returning a persistent `ServiceUnavailableException` (503) from Bedrock in `eu-central-1` (confirmed via 3+ retries across ~30 minutes, cross-checked against `claude-haiku-4-5` which probed fine in the same window — not a broader outage). So the Opus 5 A/B itself is **blocked**, and the manifest edits described below are uncommitted, speculative config waiting on Bedrock access.

While that was blocked, we used the same eval harness to re-run the **already-decided** SIO-1367 comparison (`claude-haiku-4-5` vs its predecessor `claude-sonnet-4-6`) as a dry run of the harness itself — and that's where the judge problem surfaced. The user asked to see the raw output side-by-side for one example ("quality is sometimes in the length of the output, can you tabulate the output length"), and reading the actual text revealed the judge's blind spot. This handover is about fixing the judge/eval setup, independent of whichever model SIO-1372 eventually lands on.

## What we built and how the eval works

### 1. Real-incident replay dataset (new this session)

Two dataset files now exist side by side in `packages/agent/src/eval/`:

- [dataset.ts](packages/agent/src/eval/dataset.ts) — the **original synthetic** dataset (5 hand-written hypothetical queries, no `uiSelected*` fields, no `referenceReport`). Unchanged in shape except one addition (see below).
- [incident-replay-dataset.ts](packages/agent/src/eval/incident-replay-dataset.ts) — **new**, 32 entries built from real production Jira tickets (via Agent Memory / Jira fetches earlier in the session), each carrying the exact `uiSelectedDataSources` / `uiSelectedElasticDeployments` / `uiSelectedAwsEstates` the real incident used, so the eval exercises the fixed-target path (`entityExtractor` takes `uiSelected*` as `effectiveTargets` directly — see `entity-extractor.ts:203/234`) instead of letting free entity extraction guess.

Both share the `EvalExample` interface in [dataset.ts:7-31](packages/agent/src/eval/dataset.ts#L7-L31):

```ts
export interface EvalExample {
	inputs: {
		query: string;
		uiSelectedDataSources?: string[];
		uiSelectedElasticDeployments?: string[];
		uiSelectedAwsEstates?: string[];
	};
	outputs: {
		expectedDatasources: string[];
		minConfidence: number;
		qualityRubric: string;
		// SIO-1372: the real, human-curated ticket's own Executive Summary / root-cause text...
		referenceReport?: string;
	};
}
```

`referenceReport` is the field added this session — populated on all 32 `incident-replay-dataset.ts` entries (truncated to Executive-Summary-level text, NOT the full 8-15KB Jira report, per an earlier context-budget call — **this truncation is itself one of the suspects for why the judge missed the root cause, see "What went wrong" below**). Left empty on the 5 synthetic `dataset.ts` entries (no source ticket to compare against).

Two matching sibling entries worth knowing about: `incident-replay-dataset.ts:196-211` (DEVOPS-1386, styles-v3 throughput spike) and `incident-replay-dataset.ts:213-231` (DEVOPS-1387, images-v2 co-spike) — the real root cause for BOTH is the same nightly "Price Indexing V2" Jenkins batch job, but it's only spelled out explicitly in DEVOPS-1387's `referenceReport` text, not DEVOPS-1386's. This is the exact example that exposed the judge gap (details below).

Upload script: [build-incident-replay-dataset.ts](packages/agent/src/eval/build-incident-replay-dataset.ts) writes to `/tmp/incident-replay-eval.json` then shells out to `langsmith dataset upload`. Deletion is manual (`langsmith dataset delete incident-replay-eval` or a direct `DELETE /api/v1/datasets/<id>` REST call) — the dataset has been deleted and re-uploaded 3 times this session as fields were added. **Current live LangSmith dataset id: `42d19b56-7ef0-4d44-b9fc-7096c902b307`** (32 entries, includes `referenceReport`). Two earlier ids (`66ba4127-7395-423b-bd54-e9b76411638d` and one before that) were deleted — don't try to reference them.

### 2. The judge (new this session, replacing an older binary judge)

[evaluators.ts](packages/agent/src/eval/evaluators.ts) has 3 evaluators wired into the harness:

- `datasourcesCovered` ([evaluators.ts:28-41](packages/agent/src/eval/evaluators.ts#L28-L41)) — binary, checks `run.outputs.output.targetDataSources` against `expectedDatasources`. Unchanged this session.
- `confidenceThreshold` ([evaluators.ts:43-52](packages/agent/src/eval/evaluators.ts#L43-L52)) — binary, checks `confidenceCap` against `minConfidence`. Unchanged this session.
- `responseQualityJudge` ([evaluators.ts:78-116](packages/agent/src/eval/evaluators.ts#L78-L116)) — **rewritten this session**, this is the one with the defect.

The old shape (removed) was `GradeSchema { meets_rubric: boolean, reasoning: string }` — a single yes/no over the entire rubric. We found this flattened real quality differences: reading two model configs' actual output for the same incident side by side, one response was visibly more thorough (per-node fatal-query timestamps, a live index-advisor DDL recommendation) than the other, yet both scored identically because each missed exactly one of five rubric clauses (see the comment at [evaluators.ts:10-16](packages/agent/src/eval/evaluators.ts#L10-L16)).

The new shape is `HolisticGradeSchema { score: 1-10, reasoning: string }` ([evaluators.ts:17-26](packages/agent/src/eval/evaluators.ts#L17-L26)), graded by `gpt-4o-mini` against `HOLISTIC_JUDGE_SYSTEM_PROMPT` ([evaluators.ts:68-76](packages/agent/src/eval/evaluators.ts#L68-L76)):

```ts
const HOLISTIC_JUDGE_SYSTEM_PROMPT = [
	"You are an experienced incident-response reviewer grading an AI agent's investigation report against the real, human-curated investigation of the same incident.",
	"You will be given: the real incident's own report..., a rubric..., and the AI agent's response to grade.",
	"Grade holistically, not as a checklist: judge overall investigative quality, correctness of the root cause identified, evidence quality..., and appropriate honesty about gaps/limitations...",
	"A response that reaches the same substantive conclusion as the real report, with strong supporting evidence, should score highly even if it misses a minor rubric clause...",
	"A response that is vague, reaches the wrong conclusion, fabricates unsupported specifics, or omits a major finding the real report considered central should score low.",
	"Score on a 1-10 scale: 9-10 exceptional..., 7-8 solid..., 5-6 mediocre..., 3-4 weak (misses the real root cause or is mostly vague)..., 1-2 poor...",
	'Respond with JSON: {"score": number (1-10), "reasoning": string...}',
].join(" ");
```

The score is normalized from the judge's 1-10 to LangSmith's 0-1 feedback convention at [evaluators.ts:111-115](packages/agent/src/eval/evaluators.ts#L111-L115): `score: (grade.data.score - 1) / 9`.

### 3. The harness script

[run-incident-replay-eval.ts](packages/agent/src/eval/run-incident-replay-eval.ts) — rewritten this session to fix experiment labeling (see "What went wrong" #3 below; not a judge-quality issue, just noted for completeness). Run with:

```bash
bun run eval:incident-replay                                     # sub-agent model from agent.yaml as-is
bun run eval:incident-replay -- --sub-agent-model claude-haiku-4-5  # explicit override, no restart/edit needed
```

The override is applied via `EVAL_SUB_AGENT_MODEL_OVERRIDE`, read at call time inside `resolveRoleModelConfig` (see `applyEvalModelOverride` in [llm.ts](packages/agent/src/llm.ts)). Experiment name is `agent-eval-<git-sha>-subagent-<resolved-model>` — resolved via `loadAgent` + `resolveRoleModelConfig("subAgent", orchestrator, "elastic-agent").modelConfig?.preferred` ([run-incident-replay-eval.ts:48-52](packages/agent/src/eval/run-incident-replay-eval.ts#L48-L52)), never a stale "current"/"reverted" label.

Runs land in LangSmith against dataset `incident-replay-eval`, comparable via Datasets → incident-replay-eval → Compare.

## Two completed A/B runs (dry run of the harness, not the actual SIO-1372 Opus 5 comparison)

| | `claude-haiku-4-5` | `claude-sonnet-4-6` |
|---|---|---|
| Cached raw results | `/tmp/haiku_holistic_results.json` (580KB, 32 runs) | `/tmp/sonnet46_holistic_results.json` (681KB, 32 runs) |
| `datasources_covered` | 100% | 100% |
| `confidence_threshold` | 81.3% | 65.6% |
| `response_quality` (normalized 0-1, holistic 1-10 judge) | 0.618 avg | 0.656 avg |
| Avg response length | 11,246 chars (min 5,874, max 17,606) | 14,312 chars (min 3,948, max 21,555) — ~27% longer |

Diff on `response_quality` (0.656 − 0.618 = 0.038) is not statistically significant at n=32 (diff/SE ≈ 0.79). Individual examples show real per-example variance up to 0.55 on the 0-1 scale in both directions, which is the good news — the holistic judge is producing genuine signal, not a flattened tie like the old binary judge did.

Pooled correlation between response length and `response_quality` score across all 64 data points: **0.073** — essentially none. This directly answers the user's "quality is sometimes in the length of the output" concern from earlier in the session: the judge is not simply rewarding verbosity. That part of the judge redesign is working as intended.

**A full visual writeup of this comparison** (length table for all 32 examples + full side-by-side text for the DEVOPS-1386 example) was published as a Claude Artifact this session: https://claude.ai/code/artifact/38c90729-c775-476a-999f-ffe609d7c8bc — worth reloading for the next session rather than re-deriving, since it already has the exact numbers laid out. It is NOT saved as a file in the repo; if the artifact URL stops resolving, the underlying data can be rebuilt from the two cached JSON files above (`/tmp/length_table.md` also has the raw table if `/tmp` hasn't been cleared).

## What went wrong — the root-cause blind spot

Reading `/tmp/haiku_full_response.md` (14,424 chars) and `/tmp/sonnet46_full_response.md` (15,824 chars) in full for the DEVOPS-1386 example (query at [incident-replay-dataset.ts:198-199](packages/agent/src/eval/incident-replay-dataset.ts#L198-L199)):

- **Real root cause** (per `referenceReport` at [incident-replay-dataset.ts:210](packages/agent/src/eval/incident-replay-dataset.ts#L210), corroborated by the sibling DEVOPS-1387 entry at [incident-replay-dataset.ts:230](packages/agent/src/eval/incident-replay-dataset.ts#L230)): an internally-sourced bulk read workload — specifically the nightly "Price Indexing V2" Jenkins batch job doing a full-catalogue sweep.
- **Haiku 4.5's response** (score 3/10): attributed the spike primarily to an AWS connectivity failure / missing-index defect. Judge's own comment noted this diverges from the real report's conclusion — reasonable low score, though the judge's comment also claims Haiku "fails to validate the statistical anomaly effectively" and "lacks concrete evidence," which isn't quite accurate — Haiku's own report DID surface the unfiltered-Couchbase-query finding, just didn't lead with it as the root cause. Worth noting as a secondary judge-accuracy issue: **the judge's stated reasoning didn't always match what the response actually contained.**
- **Sonnet 4.6's response** (score 8/10): attributed the spike to "bulk automated enumeration" of the endpoint with no rate-limiting. This is closer in *category* to the real cause (correctly identifies automated/bulk internal traffic) but **never named a scheduled batch job or any specific mechanism** — it's a plausible-sounding generic diagnosis that happens to be adjacent to the truth, not a match to it. The judge's own reasoning explicitly praised the "bulk automated enumeration" framing and only flagged a minor gap ("lacks clear identification of the true originating client"). It did not treat "never identified an actual named cause" as disqualifying.

**Root causes of the judge's failure, as best diagnosed this session:**

1. **No hard gate on root-cause correctness.** The scoring bands in `HOLISTIC_JUDGE_SYSTEM_PROMPT` (9-10 / 7-8 / 5-6 / 3-4 / 1-2) mention "misses the real root cause" only in the 3-4 band, as one of several disjunctive conditions ("misses the real root cause OR is mostly vague") — it's advisory, not a required check the judge must perform and report before scoring anything else. A confident, well-organized, wrong-conclusion report can still read as "solid" (7-8) to an LLM grading holistic writing quality, because nothing in the schema forces the judge to first answer "is the named cause actually right" as a gate.
2. **`referenceReport` truncation may be hiding the discriminating fact.** We only stored Executive-Summary-level text (see [dataset.ts:23-29](packages/agent/src/eval/dataset.ts#L23-L29) comment, an earlier context-budget decision), not the full investigation detail. DEVOPS-1386's own summary is somewhat generic ("an internally-sourced bulk read workload (a batch job, data pipeline, or downstream consumer...)") — it doesn't name the Jenkins job itself; only the sibling ticket DEVOPS-1387 does. A judge comparing against a hedged summary has less to catch a "close but not actually right" answer against.
3. **This is structurally the same failure mode as the OLD judge, inverted.** The binary `meets_rubric` judge lost signal by flattening everything to 0/1. This one has signal but no veto — it can be talked into a high score by confident, well-organized wrong answers, same way an LLM grading an essay can be swayed by fluency over correctness.

## The fix (step-by-step)

1. **Add a required root-cause-match field to the judge schema.** In [evaluators.ts:17-26](packages/agent/src/eval/evaluators.ts#L17-L26), extend `HolisticGradeSchema`:
   ```ts
   const HolisticGradeSchema = z.object({
   	score: z.number().nullish().transform(...),
   	rootCauseMatch: z.enum(["correct", "partial", "incorrect", "not_determinable"]).catch("not_determinable"),
   	reasoning: z.union([z.string(), z.number(), z.null()]).optional().transform(...),
   });
   ```
   `not_determinable` covers the 5 synthetic `dataset.ts` examples (no `referenceReport` to check against) and any case where the judge genuinely can't tell.

2. **Instruct the judge to check root cause FIRST, before scoring anything else.** Rewrite `HOLISTIC_JUDGE_SYSTEM_PROMPT` ([evaluators.ts:68-76](packages/agent/src/eval/evaluators.ts#L68-L76)) to require the check as an explicit first step, e.g. insert before the scoring-bands line: `"First, determine whether the AI response's stated root cause matches the real report's root cause: 'correct' (names the same specific mechanism/cause), 'partial' (right general category — e.g. both agree it's automated/internal/bulk traffic — but does not name the specific mechanism the real report identified), or 'incorrect' (names a different or contradictory cause). Only after that, score holistically."`

3. **Enforce the cap in code, not just via prompt instruction.** After parsing the grade in `responseQualityJudge` ([evaluators.ts:101](packages/agent/src/eval/evaluators.ts#L101)), before returning:
   ```ts
   const cappedScore =
   	grade.data.rootCauseMatch === "incorrect" ? Math.min(grade.data.score, 4) :
   	grade.data.rootCauseMatch === "partial" ? Math.min(grade.data.score, 7) :
   	grade.data.score;
   ```
   Don't trust the prompt alone to self-enforce the band — the DEVOPS-1386 Sonnet 4.6 case is direct proof an instructed model can still assign 8/10 despite prose elsewhere in the same prompt saying root cause matters. A code-level cap is the actual gate; the prompt is just steering.

4. **Surface `rootCauseMatch` as its own LangSmith feedback key**, not just buried in the `comment` string, so it can be filtered/sorted independently in the Compare UI:
   ```ts
   // return an array of feedback objects from responseQualityJudge, or add a second evaluator
   { key: "root_cause_accuracy", score: rootCauseMatch === "correct" ? 1 : rootCauseMatch === "partial" ? 0.5 : 0, comment: ... }
   ```
   LangSmith's `evaluate()` accepts an evaluator returning either a single feedback object or an array — check the current `datasourcesCovered`/`confidenceThreshold` pattern for the exact shape langsmith expects; may need `responseQualityJudge` to return `[qualityFeedback, rootCauseFeedback]` instead of a single object, or split into two separate evaluator functions registered in [run-incident-replay-eval.ts:72](packages/agent/src/eval/run-incident-replay-eval.ts#L72)'s `evaluators: [...]` array (cleaner — keeps `responseQualityJudge` as one concern per function, matching the existing pattern where `datasourcesCovered` and `confidenceThreshold` are already separate).

5. **Consider un-truncating `referenceReport` for at least the sibling-ticket cases**, or at minimum re-check whether DEVOPS-1386's own summary should absorb the DEVOPS-1387 corroboration text so the judge has the actual named mechanism to compare against, not just "a batch job, data pipeline, or downstream consumer" hedging. This is a real tradeoff against the original context-budget concern from earlier in the session — worth a quick judgment call with the user rather than silently reverting that decision.

6. **Re-run both A/B legs after the fix** and see whether `response_quality` (and the new `root_cause_accuracy`) actually moves the Haiku-4.5-vs-Sonnet-4.6 comparison. If Sonnet 4.6's score drops materially once root-cause correctness is gated, that's a meaningfully different conclusion than what's currently reported above — and directly relevant input to whichever model SIO-1372 eventually lands on for the sub-agents.

## Verification

```bash
bun run typecheck && bun run lint && bun run test
```

Manual re-run after the judge fix (needs `.env` copied into the worktree temporarily — copy from main repo root, delete immediately after, per this repo's standing `.env` discipline):

```bash
bun run --filter @devops-agent/agent eval:precheck   # needs all 6 MCP servers on :9080-9085
bun run eval:incident-replay -- --sub-agent-model claude-haiku-4-5
bun run eval:incident-replay -- --sub-agent-model claude-sonnet-4-6
```

Pull results directly via LangSmith REST rather than trusting the truncated console dump (pattern used this session — `POST /api/v1/runs/query` with `session:[id], is_root:true, select:[...]` filtered to the relevant experiment's session id). Spot-check at least the DEVOPS-1386 example specifically — it's the known problem case and the fastest way to confirm the gate is actually firing.

## Files to modify

| File | Change |
|---|---|
| [packages/agent/src/eval/evaluators.ts](packages/agent/src/eval/evaluators.ts) | Add `rootCauseMatch` to `HolisticGradeSchema`; update `HOLISTIC_JUDGE_SYSTEM_PROMPT` to require the check first; enforce the score cap in code; surface as a separate LangSmith feedback key |
| [packages/agent/src/eval/run-incident-replay-eval.ts](packages/agent/src/eval/run-incident-replay-eval.ts) | If `responseQualityJudge` is split into two evaluator functions, register both in the `evaluators: [...]` array at line 72 |
| [packages/agent/src/eval/incident-replay-dataset.ts](packages/agent/src/eval/incident-replay-dataset.ts) | Optional: reconsider `referenceReport` truncation depth for DEVOPS-1386 (and any other sibling-ticket pairs) so the named mechanism isn't hedged away |
| No changes needed | `dataset.ts`, `build-incident-replay-dataset.ts`, `llm.ts`, `types.ts` — all correct as-is for this fix |

## Workflow

Branch: continue on `claude/agent-model-config-patterns-e5e173` (already has all the uncommitted eval/judge/manifest changes) or cut a fresh branch off it once those are committed separately from the judge fix — they're logically distinct changes (SIO-1372 model swap vs. eval-judge quality) and probably deserve separate commits/PRs even if done in the same session.

Linear: this handover itself doesn't need a new issue — the judge fix is scoped work under the existing SIO-1372 (the eval setup is explicitly part of that ticket's acceptance criteria, per the "aggregate response_quality pass-count alone is insufficient evidence" caveat already written into it). Update SIO-1372 with a comment linking this handover once the judge fix lands, rather than opening a new ticket.

Suggested commit message template:

```bash
git commit -m "$(cat <<'EOF'
SIO-1372: gate response_quality judge on root-cause correctness

The holistic 1-10 judge introduced this session scored a response 8/10
despite it never naming the incident's actual root cause -- add an
explicit rootCauseMatch check the judge must answer before scoring,
and cap the score in code (not just via prompt instruction) when the
named cause is wrong or only category-adjacent.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

Do NOT set SIO-1372 to Done after this — it's still blocked on the separate `claude-opus-5` Bedrock 503 issue for the actual model swap this ticket is about.

## Risks and edge cases

| Risk | Likelihood | Mitigation |
|---|---|---|
| Code-level cap fights the judge's own score if the judge is internally inconsistent (e.g. says `rootCauseMatch: "correct"` but reasoning text disagrees) | Medium — LLM judges are not perfectly self-consistent | Log a warning (not a hard failure) when `rootCauseMatch` and the score band look mismatched (e.g. `correct` but score < 5), so drift is visible without blocking the run |
| `referenceReport` un-truncation reopens the earlier context-budget concern | Medium | Only widen it for confirmed sibling-ticket cases (few), not all 32 — check with user before a blanket change |
| Splitting `responseQualityJudge` into two evaluators doubles the OpenAI calls per example if not done carefully (e.g. calling the API twice instead of once and returning two feedback objects from the same call) | Low, but costly if missed (32 examples × 2 configs × 2x cost) | Keep ONE OpenAI call, parse both `score` and `rootCauseMatch` from the same JSON response, and either return an array of feedback objects from one function or refactor into two thin functions sharing one cached/memoized call |
| `claude-opus-5` Bedrock 503 resolves before the judge fix lands, tempting a session to run the "real" SIO-1372 A/B on the OLD (uncapped) judge | Medium | Don't run the actual Opus-5-vs-Haiku-4.5 acceptance eval until this judge fix is in — the numbers won't be trustworthy otherwise, per the whole point of this handover |

## Out of scope

- The actual SIO-1372 Opus 5 A/B eval — blocked on the separate Bedrock `ServiceUnavailableException` issue, not part of this handover.
- Committing the currently-uncommitted `lightTierModel` YAML migration, Opus 5 sub-agent manifest swap, or any of the other uncommitted changes in this worktree — no user authorization has been given for that commit yet; this handover is scoped to the eval/judge rework only.
- Redesigning `datasourcesCovered` or `confidenceThreshold` — both are working fine as binary checks and not the subject of this handover.
- General model-tiering / SOD (Segregation of Duties) work discussed earlier in the parent session — a separate, larger initiative, not started.

## Related code references

- [entity-extractor.ts:203](packages/agent/src/entity-extractor.ts) / `:234` — where `uiSelected*` becomes `effectiveTargets`, the reason the incident-replay dataset carries those fields (referenced, not modified, this session).
- [llm.ts](packages/agent/src/llm.ts) — `resolveRoleModelConfig`, `applyEvalModelOverride`, `TOOL_BINDING_ROLES` — all read but not the subject of this handover's fix.
- [llm-json.ts](packages/agent/src/llm-json.ts) — `parseLlmJson`, the tolerant-parse helper `responseQualityJudge` already uses correctly (SIO-1221) — the root-cause-gate fix should keep using this, not add a second raw `JSON.parse`.
- `docs/development/model-upgrade-checklist.md` — the 10-gate process SIO-1372's actual model swap must still satisfy once Bedrock access to `claude-opus-5` is confirmed; gates 6 and 8 are the ones currently blocked.

## Memory references

- `reference_kg_agent_memory_audit_next_session` style entries aren't directly relevant here, but check `MEMORY.md` for any `sio1372`-tagged entry the next session may have added after this handover.
- No existing memory slug specifically covers this judge defect yet — worth writing one (e.g. `reference_holistic_judge_missing_rootcause_gate`) once the fix lands, so future eval-harness work doesn't reintroduce the same blind spot.
