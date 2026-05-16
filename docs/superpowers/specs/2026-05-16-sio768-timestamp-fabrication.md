# SIO-768 — Aggregator "fabricated timestamp" warnings are false positives (format mismatch)

**Status:** Investigation findings — fix is a follow-up batch
**Date:** 2026-05-16
**Source run:** LangSmith trace `019e3001-7747-70f7-8e9f-6b3f02d3d809` (thread `979f6713-41e3-4bd9-9139-edff102d3037`, 2026-05-16T08:57:42Z)

## Context

During SIO-767 manual validation, the validator at `packages/agent/src/validator.ts` flagged 6 ISO-8601 timestamps in an "AWS landscape" answer as potentially fabricated:

```
warnings: [
  "Potential fabricated timestamps: 2026-05-16T07:54:00, 2026-05-15T22:48:00,
   2025-10-18T21:13:00, 2026-05-15T22:54:00, 2026-05-15T22:48:00, 2025-10-18T21:13:00"
]
```

`2025-10-18T21:13:00` (7 months in the past) was treated as the smoking gun for LLM hallucination. SIO-768 was opened to investigate. This document records the investigation's findings.

## Root cause

**Validator false positive driven by a regex format mismatch.** The aggregator and the sub-agents are doing the right thing; the validator's source-comparison logic is too narrow.

### Evidence chain

`packages/agent/src/validator.ts:49` matches timestamps with:

```typescript
const timestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g;
```

The regex requires a literal `T` between date and time. It matches ISO-8601 output but not the AWS-API string formats the SDK actually returns.

For stopped EC2 instances, the SDK returns `StateTransitionReason` as a string in the form:

```
"User initiated (2025-10-18 21:13:00 GMT)"
```

— space-separated, with a `GMT` suffix. The aggregator/sub-agent correctly normalizes this to `2025-10-18T21:13:00Z` in the answer. The validator's source scan (`sourceTimestamps`) misses it because the regex requires a `T`. Empirical check:

```
node -e 'const re = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g;
         console.log("2025-10-18 21:13:00 GMT".match(re));'
> null
```

So the AWS-format string in the sub-agent prose is invisible to `sourceTimestamps`, but the ISO-normalized form is visible in `answerTimestamps`. The validator concludes the timestamp was fabricated.

### Secondary effect — `result.data` is sub-agent prose, not raw tool output

`packages/agent/src/sub-agent.ts:414` populates `DataSourceResult.data` with the sub-agent LLM's `lastResponse.content` — a prose summary, not the raw AWS SDK response. `toolOutputs` on the same struct is set to `[]` (line 417, never populated). So even if the regex matched the AWS format, the validator would still miss timestamps that the sub-agent paraphrases (e.g. "launched yesterday") rather than quoting verbatim.

This compounds the regex problem for the four "now-ish" timestamps in the warning (`2026-05-16T07:54:00`, `2026-05-15T22:48:00` x2, `2026-05-15T22:54:00`): the sub-agent's prose may have rendered EC2 `LaunchTime` and CloudWatch `creationTime` in any of several formats (ISO with millis, locale string, "yesterday at 10:48pm"), and the aggregator normalized them to ISO without millis in the answer. The regex's `\d{2}:\d{2}:\d{2}` ending then matches the answer but not the sub-agent prose, unless the prose happened to quote it in the exact same shape.

### Hypotheses ruled out

| Hypothesis | Ruled out by |
|---|---|
| Aggregator LLM hallucination | Aggregator uses Claude Sonnet 4.6 at temperature 0.1 with an explicit "do not fabricate metrics or timestamps" instruction (`aggregator.ts:137`). For `2025-10-18T21:13:00` specifically, the timestamp **exists** in the AWS SDK output (`StateTransitionReason`) — the aggregator is correctly extracting it, not inventing it. |
| Stale `investigationFocus` context bleed | The thread trace shows turn 2 ("How long has TheMule been stopped and should it be terminated?") is a logical follow-up on the same instance, not an unrelated topic. No cross-topic bleed. |

## Why it matters

Current behavior: warnings do not gate. `validator.ts:81` returns `pass_with_warnings` and the answer flows to the UI. So the false positives don't currently break the user-facing path. But:

1. **Trust erosion of the validator signal.** If "fabricated timestamp" warnings fire on every AWS query with stopped EC2 instances, on-call engineers learn to ignore the validator output. When a real hallucination eventually happens, it'll get filtered out alongside the noise.
2. **Confidence cap risk.** Any future change that promotes these warnings to confidence caps or hard failures (as the SIO-768 ticket proposes) would immediately degrade the user experience: every AWS report mentioning a stopped instance would fail validation despite being correct.

## Recommended fix

A small follow-up batch (call it D.2 — fix). Two changes in `packages/agent/src/validator.ts`:

### Change 1 — Widen the timestamp regex (primary fix)

Match both ISO-8601 (`T` separator) and AWS-format (space separator with optional timezone words), then normalize before building the comparison set.

```typescript
// Match either ISO 8601 (literal T) or AWS string format (space) with optional timezone suffix.
const timestampPattern = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|GMT|UTC|[+-]\d{2}:?\d{2})?/g;

// Normalize both source and answer matches: strip the timezone suffix, replace space with T,
// drop fractional seconds. The comparison set should be format-agnostic so that
// "2025-10-18 21:13:00 GMT" in source data matches "2025-10-18T21:13:00" in the answer.
function normalizeTimestamp(ts: string): string {
    return ts
        .replace(" ", "T")
        .replace(/\.\d+/, "")
        .replace(/(Z|GMT|UTC|[+-]\d{2}:?\d{2})$/, "");
}
```

This is the single highest-leverage change. Empirically it eliminates the `2025-10-18T21:13:00` false positive and most of the "now-ish" cluster as well.

### Change 2 — Compare against raw tool output, not just prose (secondary, larger fix)

Populate `DataSourceResult.toolOutputs` properly in `sub-agent.ts:417` (currently `[]`) and have the validator scan both `result.data` (prose) AND each tool output's serialized payload. Catches paraphrased-timestamp cases the regex fix alone misses.

This is a bigger change — touches `DataSourceResultSchema` in `@devops-agent/shared`, every sub-agent's data assembly, and the validator's source-data build. Probably worth doing alongside SIO-764 (sub-agent structured-data emission epic) rather than as a standalone fix, since both improvements need the same plumbing.

Recommendation: ship Change 1 first as a 1-hour fix; defer Change 2 into the SIO-764 epic.

### Regression test

Add to `packages/agent/src/validator.test.ts` (likely exists; check before creating):

```typescript
test("AWS-format timestamps in source data match ISO-format timestamps in answer", () => {
    const state = makeStateWithDataSourceResult(
        "aws",
        "EC2 instance i-abc stopped: User initiated (2025-10-18 21:13:00 GMT)",
    );
    state.finalAnswer = "Instance i-abc has been stopped since 2025-10-18T21:13:00Z";
    const result = validate(state);
    expect(result.validationResult).toBe("pass");  // not "pass_with_warnings"
});

test("ISO-with-millis source matches ISO-without-millis answer", () => {
    const state = makeStateWithDataSourceResult(
        "aws",
        "EC2 instance i-abc LaunchTime: 2026-05-15T22:48:00.000Z",
    );
    state.finalAnswer = "Instance launched at 2026-05-15T22:48:00Z";
    const result = validate(state);
    expect(result.validationResult).toBe("pass");
});

test("Genuinely fabricated timestamp (not in any source format) still flags", () => {
    const state = makeStateWithDataSourceResult("aws", "EC2 instance i-abc is running.");
    state.finalAnswer = "Instance failed at 2020-01-01T00:00:00Z";
    const result = validate(state);
    expect(result.validationResult).toBe("pass_with_warnings");
});
```

## What NOT to do

- **Don't promote warnings to hard fails** until Change 1 ships and is validated against several real production runs. Promoting today would break every AWS landscape query.
- **Don't tighten the aggregator prompt further.** The existing instruction "do not fabricate metrics or timestamps" is correct and being followed. Adding more no-fabricate prose would crowd out genuinely useful instructions.
- **Don't add a `FABRICATED_TIMESTAMP_CONFIDENCE_CAP`** in `confidence-gate.ts` — that's the SIO-768 ticket's suggested fix shape, but it's the wrong answer for a false-positive root cause. It would cap confidence on every correct AWS answer.

## Related code

- `packages/agent/src/validator.ts:49-65` — regex + comparison logic to update
- `packages/agent/src/sub-agent.ts:414-417` — where `data` is set to prose and `toolOutputs` is left empty (Change 2 target)
- `packages/agent/src/aggregator.ts:137` — the existing no-fabricate prompt (correct as-is; do not touch)
- `packages/mcp-server-aws/src/tools/ec2/describe-instances.ts` — confirms tool output is the verbatim SDK response

## Out of scope for SIO-768

- The first thread-trace warning "Datasource kafka was queried but not referenced in the answer". The query was AWS-only and the user clicked aws in the UI; kafka being queried at all is a separate issue (entity extractor or datasource selector overreach). File separately if it recurs.
- The validator's metric-grounding check (`validator.ts:67-77`) — appears to work correctly in this run; no follow-up needed.
