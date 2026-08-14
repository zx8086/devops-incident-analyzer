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
