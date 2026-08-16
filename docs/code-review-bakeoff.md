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
| [#661](https://github.com/zx8086/devops-incident-analyzer/pull/661) | 2026-08-14 | 6 | 4 / 0 (rounds 2-6) | 2 / 0 (+3 valid nitpicks) | Greptile skipped round 1 (credits); detail below |
| [#662](https://github.com/zx8086/devops-incident-analyzer/pull/662) | 2026-08-15 | 2 | 3 / 0 | 3 / 0 (2 duplicate) | Renovate on-demand MR tools; near-total overlap; detail below |

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

## PR #661 detail (Vite module-runner timer leaks + IaC message sanitization)

**Greptile round 1: no review.** On PR open, every trigger (auto on push, explicit `@greptile review`) returned only "reached the 50-credit limit for trial accounts. To continue receiving code reviews, upgrade your plan," and the `Greptile Review` status check never registered -- so CodeRabbit had round 1 to itself. From the round-2 fix push onward the check registered and completed normally (credits apparently refreshed or the limit applied per-trigger).

**CodeRabbit round 1: 2 actionable + 3 nitpicks, all verified real, 0 false positives.**

- Major (real): gated schedule ids escaped the new slot ownership -- `schedules.ts` DELETED precondition-gated ids from the map, so they never reached the scheduler's disabled-path `stopSlot`, and a slot armed by a previous module graph would keep sweeping in a dead graph after the backend went away. Exactly the failure class the PR set out to fix, in a path the PR itself added. Fixed by gating via `enabled: false` copies instead of deletion.
- Minor (real): the new not-connected regression test restored its bridge mock inline, so a failing assertion would leak `getConnectedServers() => []` into later tests. Fixed with try/finally.
- Nitpicks (all real, all applied): warn-log the sweeping-skip path; poll instead of a fixed 100ms sleep in the once-mode test; assert the exact "Completed in 13.2s" separator (the loose "13.2s" assertion also passed for the "Completedin" regression this PR fixed).

**Greptile rounds 2-5 (Confidence Score 4/5 each round): three real findings, each a residual variant of the same slot-ownership class, each found AFTER CodeRabbit had approved the same commit.**

- Round 2 (`ee4552b5`): "Removed schedules retain active slots" -- an id absent from the schedule map entirely (YAML deleted/renamed/malformed) is never visited by the registration loop, so the dead graph's timer keeps firing. Fixed with an absent-id reaper.
- Round 3 (`da0f3704`): P1 "Rejected schedule retains old timeout" -- re-registering a once-mode schedule with an invalid or past `runAt` early-returned before slot handling, leaving the old timeout armed with the dead graph's closure. Fixed by stopping the slot in both validation paths.
- Round 5 (`df95b2fb`): registration failure branches (workflow missing, wrong step shape, no handler bound, prompt unwired, cron arming throw) skipped slot cleanup, so a present-but-unresolvable id kept its dead-graph timer. Fixed with a single `if (!run) stopSlot(id)` chokepoint plus `stopSlot` in the arming catch.
- Round 6 (`d626ca12`): the CALLER-level bypass -- `startSchedules`'s zero-schedules early return and its load-failure catch both skipped `registerSchedules` entirely, so emptying or invalidating the whole schedule set left every previous-graph timer running. Fixed by running an empty-set registration pass (the reaper) on both paths. CodeRabbit also flagged (Minor, valid) that this ledger's own tally counted its 3 nitpicks as "real findings" against the scoring definition -- corrected to 2 actionable (+3 valid nitpicks).

All three reproduced with failing unit tests before fixing. Note round 5's report arrived with the status check at `COMPLETED SUCCESS` while the summary prose said "not yet safe to merge" -- the check conclusion alone under-reported; reading the comment body was what surfaced the finding.

**Severity calibration:** CodeRabbit's Major and Greptile's P1s were all correctly rated. CodeRabbit's analysis chain ran repo scripts (sed/rg/python static checks) to verify the mock-restore gap before asserting it -- evidence quality approaching Greptile's T-Rex style.

**Head-to-head:** CodeRabbit caught the gated-id variant in round 1; Greptile caught the absent-id, rejected-runAt, and failure-branch variants in rounds 2-5. Each bot found real coverage gaps the other missed. CodeRabbit approved after round 2 and did not re-flag the later variants; Greptile's incremental rounds kept re-examining the fix code (same pattern as #658/#659).

**Infra note:** GitHub Actions dropped the `pull_request` events for three consecutive heads on this PR (two pushes, one close/reopen) -- no CI runs were created at all while both review webhooks fired normally. An empty commit finally re-fired CI. Worth remembering when a "green gate, no CI" state appears: check `gh run list` per SHA before trusting the rollup.

## PR #662 detail (SIO-1470, Renovate on-demand MR trigger tools)

Two rounds on a single-file feature addition (`gitlab.ts` + tests + classification + snapshot). Unusually high overlap between the two bots -- both found the same three root issues in round 1, independently.

**Round 1 (initial commit `5e0846da`):**

- Greptile: Confidence Score 4/5, 3 findings, all real. P1 "Dashboard updates lose concurrent changes" (the GET-then-PUT on the Dependency Dashboard issue has a reachable lost-update race against a concurrent Renovate regeneration). P2 "Schedule matching is ambiguous" (`descriptionContains` had no `.min(1)`, so an empty/whitespace filter matches and plays every schedule via `.includes("")`). P2 "Schedule lookup ignores later pages" (unpaginated GET only reads GitLab's default first page).
- CodeRabbit: `CHANGES_REQUESTED`, 3 actionable comments -- functionally the same three findings (concurrency race Major, empty-filter Major, plus one Greptile missed: **null/undefined schedule-array entries crash `findPipelineScheduleId`** via an unguarded destructure). Did not independently surface the pagination issue (folded into its own concurrency/matching framing).
- Both bots cited real GitLab API behavior to support the concurrency finding; CodeRabbit's review included a live web-search citation confirming GitLab's Issues API has no ETag/If-Match conditional-update support, which shaped the fix (documented as best-effort rather than built as false-atomic).

**Triage (all verified before fixing, no false positives):**

- Null-entry crash: live-repro'd with `bun -e` before touching code -- confirmed `TypeError: Cannot destructure property 'id' from null or undefined value`. Fixed by skipping non-object entries; added 2 regression tests.
- Empty-filter ambiguity: confirmed by reading the schema (bare `z.string()`, no `.min`). Fixed with `.trim().min(1, ...)`.
- Pagination: confirmed by reading the unpaginated `glJson` call. Fixed with `per_page=100` (GitLab's max).
- Concurrency race: confirmed as real and unfixable server-side (no conditional-update support), but the fix was **documentation, not locking** -- the original code comment overstated the protection a plain GET-then-PUT provides; narrowed to "best-effort, re-run on suspected loss" per the originating handover's own low-frequency/low-consequence assessment of this race, rather than building client-side coordination disproportionate to the risk.

**Round 2 (fix commit `fd402eb4`):**

- Greptile: `COMPLETED SUCCESS`, footer confirmed it reviewed `fd402eb4`.
- CodeRabbit: re-approved (`reviewDecision: APPROVED`) after the fix push.

**Latency:** both bots reported within roughly a minute of the PR open; round 2 landed within a couple of minutes of the fix push.

**Takeaway:** the strongest overlap observed in this series so far -- 2 of 3 root issues were found by both bots independently, with only the null-entry crash unique to CodeRabbit and only the pagination gap unique to Greptile (arguably the two lowest-severity items). Neither bot suggested the concurrency fix actually applied (narrowing the claim rather than adding locking); that call required checking GitLab's actual API capabilities, which CodeRabbit's cited research made easy to verify but did not itself recommend.

## PR #664 detail (refactor, break kong-api <-> portal-api import cycle)

The smallest diff in the series so far: 3 files, +17/-10, no ticket. A pure refactor extracting `API_REGIONS` into `api/constants.ts` to break one of four circular dependencies fallow reported. Both bots approved on round 1 with zero findings.

**Round 1 (initial commit `abe60a23`), the only round:**

- Greptile: `COMPLETED SUCCESS`, Confidence Score **5/5**, zero actionable defects, zero inline comments. Footer SHA matched head. Its summary independently restated the intent ("eliminating the runtime import cycle ... without changing region values or client behavior") and rendered a mermaid flowchart confirming the resulting one-way shape (`kong-api -> constants`, `kong-api -> portal-api`, `portal-api -> constants`).
- CodeRabbit: `APPROVED`, zero inline comments, no findings write-up beyond its in-progress placeholder.

**Head-to-head: a tie at zero findings.** Nothing to triage on either side, so this round exercises the bots' false-positive rate rather than their recall -- both correctly declined to invent work on a mechanical, behavior-preserving change. Greptile's report was the more substantive of the two: it explicitly enumerated four things it had checked and cleared (no stale internal import, no public re-export left behind, no emitted-declaration issue, no package-entry compatibility break). That third and fourth check are the ones with teeth on an extract-to-leaf-module refactor.

**Notable near-miss, caught pre-push rather than by either bot:** the first local iteration re-exported `API_REGIONS` from `kong-api.ts` for backward compatibility. A repo-wide grep showed no importer of that path, and fallow's unused-export count rose 263 -> 264, so the re-export was removed before the commit. Had it shipped, Greptile's "no public re-export remains" check is precisely where it would have surfaced -- suggesting the check is real and not boilerplate, but also that a static-analysis pass before pushing catches this class earlier and cheaper than a review round.

**Latency: the outlier of the series.** Greptile's check sat at `IN_PROGRESS` for roughly 20+ minutes on a 3-file diff, against the ~1-2 min reported on every prior PR in this ledger (#658 through #662). It did complete cleanly on its own with no re-trigger, so this was slowness, not the #661 dropped-event failure mode. CodeRabbit posted its in-progress placeholder within about a minute but its approval landed in the same late window. No re-trigger was issued -- per the lifecycle rules, a trigger comment while the check is already `IN_PROGRESS` is redundant.

**Takeaway:** on a trivial, mechanically-verifiable diff both bots behave correctly and identically, and the differentiator collapses to report quality (Greptile) and latency (neither, this round). Consistent with the series pattern that Greptile's value shows up in incremental re-examination of non-trivial fix code; there was none here to examine. One data point against reading too much into any single small-PR round.

## PR #669 detail (SIO-1474, Renovate display-name-to-slug resolution)

Small, single-concern fix: 3 files, +199/-2 on round 1 (new `resolveIntegrationSlug` node + graph wiring + 8 tests), +16 on the round-2 fix commit (one added test, no production code change). The two bots diverged this round -- Greptile clean on round 1, CodeRabbit found a real gap Greptile missed.

**Round 1 (initial commit `9955031f`):**

- Greptile: `COMPLETED SUCCESS`, Confidence Score **5/5**, zero findings. Its summary correctly restated the node's soft-fail contract ("preserves the extracted target on every soft-failure path, replaces the complete target on a confirmed title match") and rendered an accurate flowchart of the new graph edge placement.
- CodeRabbit: `CHANGES_REQUESTED`, one inline Minor finding ("Add a malformed-response regression test") -- Kibana returning a 2xx with a valid-JSON-but-wrong-shape body (a bare `null`) had no direct test. It supplied a ready-to-apply test as a committable suggestion.

**Triage (verified before fixing, not applied on the bot's authority alone):** live-repro'd via `bun -e` whether `body.items` actually throws on a bare-`null` body -- confirmed `TypeError: null is not an object (evaluating 'body.items')`. Then checked whether that throw escapes the function: it does not -- the whole `res.json()`/parse block sits inside the node's own `try/catch`, so the throw is caught and the function still soft-fails to `{}`, matching the spec's never-blocks contract. So the underlying *behavior* was already correct; only test coverage was missing. Added CodeRabbit's suggested test verbatim (commit `dba681f3`) rather than defensively rewriting the parsing logic, since the code path was already safe.

**Round 2 (fix commit `dba681f3`):**

- Greptile: `COMPLETED SUCCESS`, footer confirmed it reviewed `dba681f3` (the fix commit) -- re-ran clean on the addition-only diff.
- CodeRabbit: re-approved (`reviewDecision: APPROVED`) after the fix push; the inline thread auto-resolved (`isResolved: true` via GraphQL, no manual `resolveReviewThread` needed) without a distinguishable resolution event in the API response, consistent with the #652 pattern noted in this repo's lifecycle rules.

**Latency:** both bots' round 1 completed within a few minutes of PR open (comparable to the #658-#662 baseline, not the #664 20-minute outlier); round 2 landed within about 2-3 minutes of the fix push.

**Takeaway:** the first round in this series where Greptile reported a clean 5/5 on a genuine, real (if Minor) gap that CodeRabbit caught -- a coverage gap in a soft-fail/never-throws contract, exactly the kind of "does this test suite prove the safety property it claims" finding that benefits from an independent second reviewer. Verifying before fixing mattered here: the finding's suggested framing ("must preserve the target... on invalid shape") could be read as implying a live correctness bug, but the actual gap was narrower (missing coverage of an already-caught exception) -- worth distinguishing in the fix commit message and PR reply rather than accepting the more alarming framing at face value.
