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
| [#659](https://github.com/zx8086/devops-incident-analyzer/pull/659) | 2026-08-14 | 5 | 4 / 0 | 1 / 3 | Elastic boot resilience; Greptile drove a fail-closed security redesign; detail below |
| [#660](https://github.com/zx8086/devops-incident-analyzer/pull/660) | 2026-08-14 | 3 | 1 / 0 | 2 / 1 | Auth-probe classification; CodeRabbit caught the Major leak, Greptile caught the dup-id edge; detail below |

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

## PR #659 detail (Elastic single-deployment boot resilience)

Five rounds. The PR started as a one-file resilience fix (skip+warn instead of crash-all) and grew, driven almost entirely by Greptile findings, into a fail-closed routing redesign.

**Findings, by bot:**

- CodeRabbit: caught the **connection-pool leak on a failed probe** (Major, real — `buildDeploymentClient` rethrew without `client.close()`), and later the **`DeploymentConfigError` dropped non-Error causes** (Minor, real). Missed the three routing findings below.
- Greptile: raised **Issue 3 config-error-tolerated-as-transient** (real; a bad `caCert` was swallowed), then escalated **Issue 1 (default re-point silently retargets implicit writes)** and **Issue 2 (explicit unavailable deployment falls through to default)** into a fail-closed **security** framing with T-Rex repros. All three verified real and fixed (fail-closed routing at the registry + tool layer). Greptile then caught a **regression the fix introduced** — the guard wrongly rejected valid `x-elastic-deployment` header selections — which was also fixed.

**Behavioral notes worth remembering:**

- Greptile's status check repeatedly would **not register on a whitespace-only commit** — two `@greptile review` re-triggers produced no check over ~14 min. Resolved by folding the format fix into the reviewed commit and force-pushing (fresh SHA), which it then reviewed.
- CI `Lint` had a **pre-existing** failure in `packages/mcp-server-kafka/tests/services/schema-registry-service.test.ts` (`fetchCall![0]`) unrelated to this PR; not a blocker.

**Takeaway:** Greptile was the stronger reviewer here — it found the higher-severity design/security issues AND the self-inflicted regression from a fix, all with executable proofs. CodeRabbit's two real findings were legitimate but lower-severity, and it skipped "similar" files on incremental rounds.

## PR #660 detail (SIO-1467, classify 401/403 probe failures as fatal)

Three rounds.

**Round 1:**

- CodeRabbit: **CHANGES_REQUESTED** with two real findings — (a) Major: `connectDeployments` rethrew a fatal error without closing pools of deployments already connected in that pass (client leak on fatal rethrow); (b) Minor: `any` casts + biome-ignores in the `ResponseError` test fixture. Both confirmed and fixed (`04783971`).
- Greptile: did not register a check on the initial head this round (registered from round 2 onward).

**Round 2 (fix commit `04783971`):**

- Greptile: Confidence 4/5 with a **NEW real finding CodeRabbit missed** — the fatal-unwind loop iterated the `clients` Map, so a **duplicate deployment id** in `ELASTIC_DEPLOYMENTS` (which overwrites its Map entry) left the shadowed client's pool open. Verified against `listDeploymentIds()` (splits on comma, no dedupe) and fixed by tracking opened clients in a flat list (`3f93a88a`). T-Rex proof drove the real resolver path.
- CodeRabbit: re-approved after the fix push.

**Round 3 (fix commit `3f93a88a`):**

- Greptile: clean, Confidence Score 5/5, footer SHA matched head.
- CodeRabbit: approval carried over.

**Latency:** both bots reported within ~1-2 min of each push; on this PR Greptile again did not post a check on the very first head but registered reliably on subsequent pushes.

**Takeaway:** roughly even, with an edge to Greptile again on completeness. CodeRabbit caught the primary Major leak on round 1 (Greptile's first check hadn't landed yet); Greptile then caught the duplicate-id leak that CodeRabbit missed after its own fix approval. Both findings were resource-leak hygiene in the same helper — CodeRabbit found the common case, Greptile found the config-edge case.
