# Grounded Gaps + Confidence Cap + IAM Drift Reconciliation

**Date:** 2026-06-23
**Status:** Approved (brainstorming)
**Trigger:** BindPlane incident report (2026-06-23, eu-shared-services-prd) printed a fabricated IAM gap and an unverified `Confidence: 0.62`.

## Problem

A unified incident report claimed ECS collector logs were inaccessible because
`logs:DescribeLogGroups` and `logs:StartQuery` are "not permitted for `DevOpsAgentReadOnly`".

This was **verified false against the live AWS account** (356994971776):

- Live policy `DevOpsAgentReadOnlyPolicy` default version **v6** grants
  `logs:DescribeLogGroups` (statement `LogsListUnscoped`, `Resource: *`) and
  `logs:StartQuery` (statement `LogsReadLimitedByName`, on `/aws/*,/ecs/*,/app/*,/platform/*,/prod/*`).
- The report's target log group `/ecs/fargate/open-telemetry-prd-log-group` **matches** `/ecs/*`.
- `RoleLastUsed = 2026-05-18` — 35 days **before** the 2026-06-23 incident. The role was
  never assumed near the incident, so the agent did not call the logs tools and receive an
  `AccessDenied`. The LLM invented the IAM reason.

Two systemic weaknesses let this through:

1. **Gaps are ungrounded LLM free-text.** The aggregator never cross-checks a gap's claimed
   cause against the observed `state.dataSourceResults[].toolErrors[]`. A permission-denial
   claim with zero corresponding `auth` tool errors is accepted verbatim.
2. **The confidence cap counts bullets, not truth.** The SIO-709 cap fires on `>= 2` Gaps
   bullets. It is blunt (fires on many *real* gaps) and — empirically, against this report's
   text — did **not** cap the 0.62 despite 3 bullets, so a fabricated blocker printed a
   passing score.

Separately, the committed IAM policy file has drifted from live (harmless but untruthful):
the policy name and the logs-statement structure differ.

## Goals

1. A Gaps bullet asserting a permission/IAM denial must be **grounded** in an observed
   `toolError{category:"auth"}`; if not, rewrite it to an honest "not retrieved" statement.
2. An ungrounded blocker claim **caps confidence** to 0.59 (below the 0.6 HITL gate), so a
   fabricated blocker can never print a passing score.
3. The repo IAM policy file + setup script + error-advice strings match the **live** deployed
   role (no production IAM mutation).

Non-goal: raising confidence numerically. "Improve confidence" here means making the printed
number **trustworthy** — ungrounded high scores get capped; honest grounded scores stand.

## Design

Three independent units, each separately testable.

### Unit 1 — Gap-grounding guard (`packages/agent/src/aggregator.ts`)

New pure helper (no LLM, fully unit-testable):

```ts
// Phrases that assert a permission/IAM denial as the cause of a gap.
const PERMISSION_DENIAL_RE =
  /\b(not permitted|access denied|accessdenied|forbidden|iam permission|permission (?:gap|denied|missing)|lacks? permission|logs:[A-Za-z]+)\b/i;

export function detectUngroundedBlockers(
  answer: string,
  results: DataSourceResult[],
): { ungrounded: string[] } {
  const authErrorObserved = results.some((r) =>
    (r.toolErrors ?? []).some((e) => e.category === "auth"),
  );
  if (authErrorObserved) return { ungrounded: [] }; // a real denial happened; trust the prose
  // Walk the "## Gaps" section bullets; any bullet matching PERMISSION_DENIAL_RE is ungrounded.
  // (reuse the GAPS_HEADING_RE / TOP_LEVEL_BULLET_RE / ANY_HEADING_RE walk from extractGapsBulletCount)
  ...
  return { ungrounded };
}
```

Grounding key rationale: a real `logs:DescribeLogGroups` AccessDenied flows
MCP `_error.kind=iam-permission-missing` -> tool output text -> `sub-agent.ts` regex
(`/access denied/i`, `/forbidden/i`) -> `toolErrors[{category:"auth"}]`. If a gap claims a
denial but **no** `auth` error exists in any sub-agent's results, the claim is fabricated.

Rewrite behavior (chosen): replace each ungrounded permission-blocker bullet's false cause
with a neutral truth, e.g.:

> ECS collector application logs (`/ecs/fargate/...`) were not retrieved during this
> investigation. No permission error was observed, so the access state is unconfirmed.

Implemented as `rewriteUngroundedBlockers(answer, ungrounded): string` — replaces only the
flagged bullet lines, leaving the rest of the report intact.

### Unit 2 — Confidence cap on ungrounded blockers (`packages/agent/src/aggregator.ts`)

Wire Unit 1 into the existing cap path:

```ts
const { ungrounded } = detectUngroundedBlockers(answer, results);
const anyCapTriggered =
  degradedSubAgents.length > 0 || gapsCapTriggered || ungrounded.length > 0;
```

- Cap value unchanged: `TOOL_ERROR_CONFIDENCE_CAP = 0.59`.
- When `ungrounded.length > 0`, first rewrite the prose (Unit 1), then `rewriteConfidenceInAnswer`
  (SIO-860) syncs the printed `Confidence:` line to 0.59.
- Add a `logger.warn` mirroring the existing two cap warnings (include the ungrounded bullets).

### Unit 3 — IAM policy reconciliation (repo only, no prod change)

Align `scripts/agentcore/policies/devops-agent-readonly-policy.json` to live v6:

- Split logs into two statements (matching live):
  - `LogsListUnscoped`: `logs:DescribeLogGroups`, `logs:DescribeLogStreams` on `Resource: *`.
  - `LogsReadLimitedByName`: `logs:GetLogEvents`, `FilterLogEvents`, `StartQuery`,
    `GetQueryResults`, `StopQuery` on the name-scoped ARNs.
- Keep `/bedrock/*` in the repo name-scope list (harmless future-proofing; live lacks it —
  documented as an intentional repo-ahead-of-live addition).
- **Policy name:** revert the rename. Set the policy name back to `DevOpsAgentReadOnlyPolicy`
  in `scripts/agentcore/setup-aws-readonly-role.sh` and in the advice string at
  `packages/mcp-server-aws/src/tools/wrap.ts:82`. This matches the deployed role (zero prod
  change) and undoes the SIO-858 rename intent (which was never applied to prod).

## Testing

- **Unit 1/2** (`packages/agent/src/__tests__/aggregator-grounding.test.ts`, bun):
  - Fixture = the real 2026-06-23 report tail (3 Gaps bullets incl. the IAM claim), `results`
    with **no** `auth` toolError -> `detectUngroundedBlockers` flags the IAM bullet; aggregator
    caps to 0.59; printed line rewritten; IAM bullet rewritten to "not retrieved".
  - Grounded variant: same report, but `results` includes one `toolError{category:"auth"}` ->
    **not** flagged, not capped by this rule, prose untouched.
  - Non-permission gaps (SQL query failures, missing CloudWatch metrics) are never flagged.
- **Unit 3:** re-read live `get-policy-version v6`; confirm the repo JSON statements match
  (modulo the documented `/bedrock/*` addition). `bun run typecheck && bun run lint && bun run test`.

## Verification

```bash
bun run typecheck && bun run lint
bun run --filter @devops-agent/agent test
# manual: re-run detectUngroundedBlockers against /tmp report tail -> ungrounded=[IAM bullet]
```

## Out of scope

- Re-running the incident live against AWS (role is reachable; deferred).
- Reworking the SIO-709 Gaps bullet-count cap (kept as-is alongside the new grounding cap).
- Any production IAM mutation (rename, re-attach, statement change on the live role).

## References

- Live verification: `aws iam get-policy-version --version-id v6` on
  `arn:aws:iam::356994971776:policy/DevOpsAgentReadOnlyPolicy`.
- Memory: `reference_aws_logs_iam_gap_hallucination`, `reference_aws_report_gap_taxonomy`
  (SIO-855), `reference_findings_cards_are_unscoped_dumps` (SIO-773),
  `reference_confidence_prose_vs_gate` (SIO-860).
- Code: `aggregator.ts:342-419` (cap), `aggregator.ts:246-269` (Gaps parser),
  `sub-agent.ts:67-113` (auth classification), `wrap.ts:23-94` (mapAwsError),
  `devops-agent-readonly-policy.json:107-127` (logs statement).
```
