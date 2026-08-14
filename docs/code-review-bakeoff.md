# Code Review Bake-off: Greptile vs CodeRabbit

Both review bots run on every PR of this repo **deliberately** (since 2026-08-14) to gather evidence for choosing one going forward. Do not suspend either app while this evaluation runs. This ledger accumulates the per-PR head-to-head results; append a row (and a detail section when there were findings) for every merged PR.

## Ground rules

- The `Greptile Review` status check remains the only merge gate. CodeRabbit registers no status check here, but its `CHANGES_REQUESTED` review flips `reviewDecision` and holds the PR until it re-approves.
- Triage every finding from BOTH bots: verify with a live repro before fixing, fix or explicitly decline with a reason.
- Record honestly, including "both missed X" when a bug is found later by other means. Misses discovered post-merge are the most valuable signal.

## Scoring dimensions

| Dimension | What to record |
|---|---|
| Real findings | Bugs that survived verification (repro confirmed), per bot |
| False positives | Findings that did not survive verification, per bot |
| Severity calibration | Did the assigned severity match the actual impact? |
| Evidence quality | Executable proof (Greptile T-Rex artifacts) vs prose reasoning |
| Incremental rounds | Did the bot re-examine code changed by fix pushes, or skip it? |
| Latency | Trigger-to-report time per round |
| Noise | Volume of non-actionable commentary a human must read past |

## Running tally

| PR | Date | Rounds | Greptile: real / missed | CodeRabbit: real / missed | Notes |
|---|---|---|---|---|---|
| [#658](https://github.com/zx8086/devops-incident-analyzer/pull/658) | 2026-08-14 | 3 | 2 / 0 | 1 / 1 | First dual-review PR; detail below |
| [#661](https://github.com/zx8086/devops-incident-analyzer/pull/661) | 2026-08-14 | 2 | 1 / 0 (round 2 only) | 5 / 0 | Greptile skipped round 1 (credits); detail below |

## PR #661 detail (Vite module-runner timer leaks + IaC message sanitization)

**Greptile round 1: no review.** On PR open, every trigger (auto on push, explicit `@greptile review`) returned only "reached the 50-credit limit for trial accounts. To continue receiving code reviews, upgrade your plan," and the `Greptile Review` status check never registered -- so CodeRabbit had round 1 to itself. On the round-2 fix push the check registered and completed normally (credits apparently refreshed or the limit applied per-trigger), reviewing commit `ee4552b5` at Confidence Score 4/5 with ONE actionable finding:

- Real: "Removed schedules retain active slots" -- an armed slot whose id disappears from the schedule map entirely (YAML deleted, renamed, or skipped as malformed) is never visited by the registration loop, so `stopSlot` never runs and the dead graph's timer keeps firing. The residual sibling of CodeRabbit's round-1 Major (which covered ids present-but-gated, not absent). Verified with a failing unit test before fixing; registerSchedules now reaps every slot id absent from the input map.

Head-to-head on the slot-ownership hole: CodeRabbit caught the gated-id variant in round 1; Greptile caught the absent-id variant in round 2 after CodeRabbit had approved that same commit. Each bot found a real coverage gap the other missed on this PR.

**CodeRabbit: 2 actionable + 3 nitpicks, all verified real, 0 false positives.**

- Major (real): gated schedule ids escaped the new slot ownership -- `schedules.ts` DELETED precondition-gated ids from the map, so they never reached the scheduler's disabled-path `stopSlot`, and a slot armed by a previous module graph would keep sweeping in a dead graph after the backend went away. Exactly the failure class the PR set out to fix, in a path the PR itself added. Fixed by gating via `enabled: false` copies instead of deletion.
- Minor (real): the new not-connected regression test restored its bridge mock inline, so a failing assertion would leak `getConnectedServers() => []` into later tests. Fixed with try/finally.
- Nitpicks (all real, all applied): warn-log the sweeping-skip path (a never-settling sweep would silence a schedule with no signal); poll instead of a fixed 100ms sleep in the once-mode test; assert the exact "Completed in 13.2s" separator (the loose "13.2s" assertion also passed for the "Completedin" regression this PR fixed).

**Severity calibration:** the Major rating was correct -- it was a genuine coverage gap in the PR's own fix. Notably, CodeRabbit's analysis chain ran repo scripts (sed/rg/python static checks) to verify the mock-restore gap before asserting it, evidence quality approaching Greptile's T-Rex style.

**Latency:** CodeRabbit posted its full review ~3 minutes after PR open.

## PR #658 detail (SIO-1466, ELASTIC_DEPLOYMENTS fallback)

Three commits: initial change, case-normalization fix, blank-query fix.

**Round 1 (initial commit `2d027076`):**

- Greptile: P1 "case-insensitive matching fails for mixed-case queries" in `matchDeploymentName`. Verified via T-Rex executable repro artifacts (before/after outputs). Confirmed locally with `bun -e` before fixing. Real.
- CodeRabbit: same finding, rated "Minor / Quick win", posted as a `CHANGES_REQUESTED` review with one inline comment. Real, but under-rated: a mixed-case deployment reference would have blocked operator actions, so P1 was the better calibration.

**Round 2 (fix commit `82b339ed`):**

- Greptile: NEW P1 "empty deployment query selects the sole fallback deployment" (`n.includes("")` is true for every name, so a blank query with a single `ELASTIC_DEPLOYMENTS` entry silently resolved to a deployment the user never named, and the drift/fleet flows would trigger previews for it). Its T-Rex harness mocked only the MCP boundary and drove the real resolver, drift, and fleet-preview paths. Confirmed locally with `bun -e`. Real.
- CodeRabbit: `APPROVED`; skipped both files as "similar to previous changes". Missed the round-2 bug entirely.

**Round 3 (fix commit `6385d423`):**

- Greptile: clean, Confidence Score 5/5, footer SHA matched head.
- CodeRabbit: approval carried over.

**Latency:** both bots reported within roughly a minute of each push on this small diff.

**Takeaways so far (n=1, do not over-generalize):**

- Both caught the surface bug; only Greptile caught the bug introduced by the fix, because its incremental rounds re-examine changed code while CodeRabbit's incremental review skipped "similar" files.
- Greptile's executable proofs (T-Rex) made verification near-instant; CodeRabbit's walkthrough/summary/sequence-diagram layer is reviewer-friendly context but found nothing extra.
- Severity calibration favored Greptile on this PR (P1 vs "Minor" for the same operator-blocking bug).
