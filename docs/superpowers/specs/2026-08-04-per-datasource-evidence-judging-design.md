# Per-datasource evidence judging for the incident-replay eval

Date: 2026-08-04
Origin: [SIO-1374](https://linear.app/siobytes/issue/SIO-1374/per-datasource-evidence-judging-for-the-incident-replay-eval), a follow-on from [SIO-1372](https://linear.app/siobytes/issue/SIO-1372) (judge root-cause gate, PR [#590](https://github.com/zx8086/devops-incident-analyzer/pull/590)).

## Problem

A manual 4-example audit of the SIO-1372 gated judge (artifact: `https://claude.ai/code/artifact/c05d74e7-1d04-4b3c-b375-f041fda2f30e`) found 7/8 verdicts fully justified, but exposed a structural measurement gap: the A/B varies only the 7 sub-agent models, while the final report is always written by the same root Sonnet 5 aggregator. A single holistic score over the aggregate report partly measures the constant (aggregator prose) rather than the variable (sub-agent evidence quality) -- a weak sub-agent finding can be dressed up by a strong aggregator, and a strong finding can be buried by a weak one.

The audit also found one systematic judge miscall class (example #8, DEVOPS-1386, Sonnet leg): live replays investigate CURRENT systems, so an agent can truthfully observe recurrence-window facts (co-occurring chronic symptoms) that the frozen `referenceReport`'s era does not contain. The judge read those as fabrication and dropped `partial` to `incorrect`.

## Goals

Make the eval measure what the model decision needs: per-datasource evidence quality, judged against the real ticket, isolating sub-agent output from aggregator prose.

## Non-goal: section-by-section grading

Timeline / Findings / Root Cause / Gaps is pipeline-enforced structure -- the aggregator emits it the same way regardless of which sub-agent model produced the underlying evidence. Grading it separately would re-measure formatting (constant across every run) rather than investigation quality (the actual variable), repeating the same mistake this ticket exists to fix. The two components of that idea worth keeping -- gaps honesty (does the report admit what actually failed, e.g. the AWS tool outages) and a fabrication check -- are not a separate graded section; they fold into the per-datasource `datasourceVerdicts` as extra fields, because both are properties of evidence quality per datasource, not of section presence.

## Design

### 1. Per-datasource evidence verdicts (same single judge call, do first -- no added OpenAI cost)

Extend `HolisticGradeSchema` in `packages/agent/src/eval/evaluators.ts:17` with:

```ts
datasourceVerdicts: z.record(
  z.string(),
  z.object({
    verdict: z.enum(["found", "partial", "missed"]),
    gapsHonest: z.boolean(),   // did the report admit what actually failed for this datasource, if anything did
    fabricated: z.boolean(),  // did the report assert a specific finding for this datasource that the reference doesn't support
  })
).optional(),
```

`.optional()` and per-key `.catch()`-tolerant the same way `rootCauseMatch` is: a judge that omits or mangles this map degrades gracefully (see Error handling below) rather than failing the whole example, consistent with the file's existing tolerance philosophy (`evaluators.ts:7-8`).

For each datasource in the example's `expectedDatasources`, the judge determines whether the response surfaced the evidence `referenceFindings[datasource]` says that source showed (elastic -> the deadlock exception chain, kafka -> the DLQ headers, aws -> the CPU saturation, etc.).

`judgeFeedback` (`evaluators.ts:67`) is extended to emit one additional LangSmith feedback key per datasource present in `datasourceVerdicts`: `evidence_<datasource>`, score `found=1 / partial=0.5 / missed=0`, comment includes the gaps-honesty and fabrication flags. This is purely additive -- `response_quality` and `root_cause_accuracy` emission and the `applyRootCauseCap` / `squareVerdictWithReference` gate logic are unchanged.

**Prerequisite dataset work**: `referenceReport` in `EvalExample.outputs` (`dataset.ts:18-23`) is Executive-Summary-only today. Add a structured field to the same `outputs` shape:

```ts
referenceFindings?: { [datasource: string]: string };
```

Backfilled per entry from the real tickets' "Findings by Datasource" sections, across the ~32 entries in `packages/agent/src/eval/incident-replay-dataset.ts`. This revisits the earlier truncation trade-off from SIO-1372 (full ticket text was judged too long to pass whole) -- scope the backfill per-datasource-fact-level (the specific finding text for that one datasource), not full ticket text. This is the largest chunk of work in the ticket: reading each of the ~32 source tickets and extracting the per-datasource finding paragraph.

### 2. Judge each sub-agent's own report (the measurement SIO-1372's model decision actually needs)

`packages/agent/src/eval/run-function.ts` already surfaces `firstAttempts` (`run-function.ts:76`) from `finalState.dataSourceResults`. `DataSourceResult` (`packages/shared/src/agent-state.ts:447`) has no plain-text report field -- only opaque `toolOutputs[].rawJson` and typed per-datasource `*Findings` objects (`kafkaFindings`, `elasticFindings`, `awsFindings`, etc.). Per the resolved design decision, the "sub-agent report" graded here is the serialized structured `*Findings` object for that datasource, not raw tool output and not a new free-text field upstream (that would be a materially larger change to the graph/sub-agent prompts, out of scope for an eval-harness ticket).

Add a small helper (co-located with `run-function.ts`, following the existing keyed-lookup pattern already used in `absence-judge.ts:135`) that walks `finalState.dataSourceResults` and produces:

```ts
subagentReports: { [dataSourceId: string]: string }  // JSON.stringify(the datasource's *Findings object)
```

exposed on `runAgent`'s returned `output`, alongside the existing `response`, `targetDataSources`, `confidenceCap`, `firstAttempts`.

A new judge function (`evaluators.ts`) grades each sub-agent's serialized findings against `referenceFindings[datasource]`, batched as one OpenAI call per example (all sub-reports in one prompt) to keep cost trivial on `gpt-4o-mini` (~$1-2 per 32-example leg). Emits `subagent_accuracy_<datasource>` LangSmith feedback keys, isolating the variable under test (sub-agent model) from the constant (aggregator).

### 3. Era-drift prompt fix (one line, land together with 1)

Add to `HOLISTIC_JUDGE_SYSTEM_PROMPT` (`evaluators.ts:128`): the response may describe a live recurrence window with additional co-occurring symptoms not present in the reference report's era; classify such observations as "outside the reference window", NOT as fabrication. The root-cause verdict is still judged on mechanism category + naming as usual -- this only changes how era-specific extra detail is read, not the correctness bar.

## Error handling

Consistent with the file's existing tolerance philosophy: a missing or malformed `datasourceVerdicts` map does not fail the example. If the map is absent or every entry fails to parse, no `evidence_<datasource>` feedback keys are emitted for that run (same omission pattern as `root_cause_accuracy` under `not_determinable`, `evaluators.ts:77`) -- the run still gets its `response_quality` and `root_cause_accuracy` scores. A per-key `.catch()` means one bad datasource entry inside an otherwise-valid map degrades only that key, not the whole map. The sub-agent judge follows the same pattern: a datasource with no corresponding `referenceFindings` entry (not every example has findings backfilled for every expected datasource in one release) is skipped for that key rather than scored 0, so incomplete backfill degrades coverage, not scores.

## Testing

All new pure mapping logic (feedback-key construction, verdict-to-score mapping, the sub-agent report serialization helper) gets unit tests following `evaluators.test.ts` patterns -- no network calls, judge-response fixtures constructed inline the way `rootCauseMatch` cases are today.

## Steps

1. Backfill `referenceFindings` per entry from the source tickets (largest chunk of work).
2. Extend judge schema + prompt: `datasourceVerdicts` (verdict + gapsHonest + fabricated), era-drift line. Keep the SIO-1372 cap and `squareVerdictWithReference` semantics intact; cap/verdict logic stays in code, not prompt.
3. Surface `subagentReports` in `run-function.ts` output; add the sub-agent judge (one batched call per example).
4. Unit tests for all new pure mapping logic (no network).
5. Delete + re-upload the LangSmith dataset (no upsert; current id `6d433c9e-fbd0-4040-8be7-06de64dd383c` becomes stale -- record the new id in the Linear ticket).
6. Re-run both A/B legs (haiku-4-5, sonnet-4-6) with the extended judge; spot-check DEVOPS-1386 (#8) to confirm the era-drift fix reclassifies the Sonnet-leg miscall; compare per-datasource keys across legs.

## Acceptance criteria

- Each eval run emits per-datasource evidence feedback keys (`evidence_<datasource>`) plus per-sub-agent accuracy keys (`subagent_accuracy_<datasource>`), visible and filterable in LangSmith Compare.
- The #8-class era-drift miscall no longer grades truthful recurrence-window observations as fabrication (verified on the DEVOPS-1386 example).
- Root-cause gate behavior from SIO-1372 (`rootCauseMatch` + code-level cap via `applyRootCauseCap` / `squareVerdictWithReference`) is unchanged and its existing tests still pass unmodified.
- `bun run typecheck && bun run lint && bun run test` clean; judge-logic tests run without network.

## References

- Predecessor: SIO-1372 (judge root-cause gate), PR #590, branch `claude/sio1372-judge-rootcause-gate-55233d`
- Audit artifact: `https://claude.ai/code/artifact/c05d74e7-1d04-4b3c-b375-f041fda2f30e`
- Handover that started the judge rework: `experiments/HANDOFF-2026-08-03-SIO-1372-eval-judge-rework.md`
- Gated A/B baseline to compare against: haiku quality 0.646 / accuracy 0.656 vs sonnet-4-6 0.715 / 0.750 (n=32, dataset `6d433c9e-fbd0-4040-8be7-06de64dd383c`)
- Memory: `reference_holistic_judge_missing_rootcause_gate`
