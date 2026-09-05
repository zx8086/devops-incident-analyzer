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
| [#670](https://github.com/zx8086/devops-incident-analyzer/pull/670) | 2026-08-16 | 2 | 1 / 0 | 1 / 0 (+1 declined-then-withdrawn) | Cwd-aware OAuth seed command; non-overlapping recall, CodeRabbit withdrew its Zod finding after an adversarial repro; detail below |
| [#671](https://github.com/zx8086/devops-incident-analyzer/pull/671) | 2026-08-16 | 3 | 2 / 0 | 1 / 0 (duplicate of round-1 Greptile) | Renovate follow-up guard + history; round 1 both bots caught the same bug, round 2 Greptile caught a fix-introduced regression alone; detail below |
| [#673](https://github.com/zx8086/devops-incident-analyzer/pull/673) | 2026-08-16 | 3 | 2 / 0 | 3 / 0 (1 duplicate) | gitlabFetch timeout + probe classification; first convergence (both caught the caller-cancellation mislabel), CodeRabbit's readPositiveIntEnv pointer beat the hand-rolled fix; detail below |
| [#674](https://github.com/zx8086/devops-incident-analyzer/pull/674) | 2026-08-16 | 1 | 0 / 0 (1 declined) | 0 / 0 | Renovate stage-tracker wiring + per-policy agent counts; Greptile 4/5 with one convention finding declined as a false premise, CodeRabbit clean; detail below |
| [#679](https://github.com/zx8086/devops-incident-analyzer/pull/679) | 2026-08-30 | 4 | 5 / 0 | 0 / 0 (never reviewed) | Live graph triage panel (SIO-1572); Greptile alone drove 3 rounds of real UI-state fixes incl. a parallel-Send store bug; CodeRabbit posted no review at all; detail below |
| [#680](https://github.com/zx8086/devops-incident-analyzer/pull/680) | 2026-08-31 | 0 | n/a (SKIPPED, docs-only) | n/a (no review) | Combined DevOpsAgentReadOnly IAM reference doc; Greptile logged both triggers as terminal SKIPPED so the status check never registered, CodeRabbit silent; merged on green CI; detail below |
| [#681](https://github.com/zx8086/devops-incident-analyzer/pull/681) | 2026-09-01 | 0 | n/a (SKIPPED, docs-only) | n/a (no review) | Periodic AWS self-check strategy doc; auto-trigger logged as terminal SKIPPED (MCP-confirmed before any long wait, per the #680 lesson), CodeRabbit silent through a 30-min watch; merged on green CI; detail below |
| [#683](https://github.com/zx8086/devops-incident-analyzer/pull/683) | 2026-09-05 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1640 agent-toolkit-for-aws content port (7 files incl. wrap.ts + 2 tests); auto-trigger logged terminal SKIPPED within ~100 ms, CodeRabbit silent (5th straight); first CODE PR merged on a skip, on green CI + MCP-confirmed SKIPPED + explicit per-PR user instruction; detail below |

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

## PR #670 detail (SIO-1476, cwd-aware OAuth seed command)

Small diagnostics fix across two rounds: 8 files (+105/-11) on round 1, 4 files (+16/-5) on the round-2 fix commit. Both bots found real defects the author missed, and they found *different* ones -- the strongest head-to-head case in this ledger so far for keeping both.

**Origin:** an operator hit `OAuth refresh chain expired ... run 'bun run oauth:seed:atlassian' to re-seed`, followed that instruction, and got `error: Script not found`. The seeder is exposed as `oauth:seed:<ns>` at the workspace root but as a bare `oauth:seed` inside each package, and the error is thrown from a process usually started in the package directory. Round 1 added `seedCommandFor(namespace, cwd)` and applied it to the throwing paths.

**Round 1 (initial commit `834a43e2`):**

- Greptile: `COMPLETED SUCCESS`, Confidence Score **4/5**, one **P1** inline finding -- "Startup remediation bypasses resolver". Three remediation strings still hardcoded the root-only name: `bootstrap-lifecycle.ts:147` (the fatal interactive-auth path) plus the `seedCommand` literals at `mcp-server-atlassian/src/index.ts:52` and `mcp-server-gitlab/src/index.ts:55`, which `warnIfOAuthNotSeeded` interpolates at `boot-warn.ts:65`. Its flowchart correctly showed the two-path split (resolver vs hardcoded) converging on "Script not found from package cwd".
- CodeRabbit: `CHANGES_REQUESTED`, two inline findings -- one Minor (test leaked one temp dir per `mkdtempSync` call, no cleanup) and one Major (validate the parsed `package.json` with Zod, citing the repo's "Zod for all runtime validation" rule).

**Triage (all three verified before acting):**

- *Greptile P1 -- valid, fixed.* Confirmed all three sites by grep, then confirmed the fix live from each package directory (both now yield `bun run oauth:seed`). This was a genuine author miss: round 1 fixed the error-throwing paths but not the startup paths, which are the ones most likely to actually be read. Notably `bootstrap-lifecycle.ts:147` is the precise line that emitted the original report, so the PR would have shipped without fixing its own motivating case.
- *CodeRabbit Minor -- valid, fixed.* Tracked each `manifestDir` result and `rmSync`'d in `afterEach`. Verified by purging `$TMPDIR/seed-cmd-*`, re-running, and confirming 0 leftover directories rather than assuming.
- *CodeRabbit Major (Zod) -- declined, with evidence.* `readScripts` already performs exactly the checks the proposed schema would express (`typeof scripts !== "object" || scripts === null`, plus a per-key `typeof === "string"` at each call site) inside a `try/catch` that returns `null` on any failure. Adversarially tested 10 hostile manifests -- `scripts` as array/string/null, values as number/object, manifest as array/bare-string/`null`, a `__proto__` pollution attempt, truncated JSON: **10/10 fell back safely, 0 threw.** Declined in-thread with that repro and an explicit invitation to supply a counterexample.

**Round 2 (fix commit `e607f4c6`):**

- Greptile: `COMPLETED SUCCESS`, **5/5**, footer SHA confirmed `e607f4c6`, "The PR appears safe to merge" and explicitly noted the previously reported bypass is now addressed in all three locations.
- CodeRabbit: re-approved (`APPROVED` @ 15:47:11, after `CHANGES_REQUESTED` @ 15:40:16). Both its threads auto-resolved. On the Zod thread it replied: *"I cannot identify an input that causes an incorrect command or an exception. I withdraw this finding."* Greptile's thread did not auto-resolve and needed an explicit `resolveReviewThread` mutation -- a divergence from the #652/#669 pattern where threads self-resolved on the fix push.

**Latency:** round 1 both bots within ~1-2 min of PR open. Round 2 Greptile took noticeably longer (multiple 25s poll cycles) but completed cleanly with no re-trigger.

**Takeaways:**

1. *Non-overlapping recall.* Greptile found the P1 correctness/completeness gap; CodeRabbit found the test hygiene issue. Neither found the other's. On a diff this small that is a strong argument against dropping either bot on the basis of "the other would have caught it".
2. *Verify-before-apply earned its keep, again.* The Zod finding was rule-shaped and superficially plausible -- an auto-applying loop would have added a dependency to the shared OAuth error path to re-express checks that already held. The 10-case adversarial repro both justified the decline and persuaded the bot to withdraw. This is the second ledger entry (after #669) where the bot's *framing* was more alarming than the underlying reality.
3. *Severity calibration.* Greptile's P1 was correctly rated -- it defeated the PR's own purpose on the most-read path. CodeRabbit's "Major" for the Zod suggestion was overrated for what was, by its own eventual admission, a style preference over already-correct code; its "Minor" for the temp-dir leak was rated about right.
4. *A clean status check is not a clean review.* Round 1 reported `Greptile Review: COMPLETED SUCCESS` while carrying an unresolved P1. Gating on the check alone would have merged the bug. The check means "the review ran", not "the review found nothing" -- read the comment body and the confidence score.

## PR #671 detail (SIO-1475, Renovate follow-up guard + deployment-wide trigger history)

A 7-commit branch (6 SDD implementation tasks + 1 final-whole-branch-review fix wave already landed before either bot ran), 51KB diff across 9 files. Both bots independently found the SAME real bug on round 1 -- the first true head-to-head DUPLICATE catch in this series (prior rounds each had one bot catch something the other missed; this round both caught the identical defect, in the identical function, with proposed fixes differing only in mechanism).

**Round 1 (initial commit `ad5a8e3a`, i.e. after the branch's own internal fix wave):**

- Greptile: `COMMENTED` (not approved), Confidence Score **4/5**, ONE finding: `watchRenovateMr`'s MR-found success return cleared `renovateInFlightMarker` in the same object that set `renovateMrUrl` -- but `teardownIac` (the node's only graph successor, same turn) needed that field as a fallback source for the durable `renovate-trigger` memory fact whenever the turn-scoped `renovateMarker`/`renovateTarget` were already null (exactly the `renovate-status-check` follow-up's own state shape). Net effect: the fact was written with placeholder text ("an outdated dependency"/"an Elastic deployment") and no `deployment`/`marker` annotations on precisely the turn a real MR was just found -- silently undermining this same branch's own new deployment-wide recall feature. Greptile flagged this as blocking ("should not merge until...").
- CodeRabbit: `CHANGES_REQUESTED`, one inline Major finding -- **the identical bug**, same file, same line (`nodes.ts:985`), same root cause description, with a concrete suggested diff: clear `renovateInFlightMarker` inside `teardownIac`'s short-circuit instead (`return state.renovateMrUrl ? { renovateInFlightMarker: null } : {};`) rather than in `watchRenovateMr`.

**Triage (live-repro'd before fixing, not applied on either bot's authority alone):** ran `bun -e` calling the real `buildRenovateFactDecision`/`buildRenovateFactAnnotations` against the exact state shape `teardownIac` would see post-clear (`renovateTarget: null, renovateMarker: null, renovateInFlightMarker: null, renovateMrUrl: "<real-url>"`) -- confirmed the fact genuinely resolved to the placeholder strings with zero annotations, exactly as both bots described. Chose a different fix mechanism than CodeRabbit's suggested diff: rather than making `teardownIac` responsible for remembering to clear a field it doesn't otherwise own/read, removed the premature clear from `watchRenovateMr` entirely -- reasoning at the time was that `TURN_START_RESET` would null the field at the start of the next turn regardless. **This reasoning was wrong** (see Round 2 below): `TURN_START_RESET` does not clear this field at all -- it is deliberately excluded from that reset object, and this fix's premise was never actually re-verified against `TURN_START_RESET`'s real contents before shipping. Both bots' proposed fixes and the one shipped converge on the same round-1 *effect* (the fact is written correctly on the MR-found turn); they differed on *where* the field gets cleared -- and that difference turned out to matter, since the chosen mechanism left the field permanently uncleared (round 2 below).

**Fix push after round 1 (commit `2aab4f46`):** two new regression tests added -- one asserting `watchRenovateMr`'s success return no longer includes `renovateInFlightMarker` in its partial-update object at all, and one true end-to-end test chaining the real `watchRenovateMr` output directly into the real `teardownIac` (matching the graph's actual unconditional edge), asserting the durable fact records the real deployment/marker values and explicitly asserting the placeholder strings are absent. 130/130 tests pass, 0 typecheck/lint errors.

**Notable: neither this branch's own per-task reviews (7 tasks) nor its final whole-branch review (an independent Opus pass, which itself caught 2 separate real cross-task-interaction bugs in the same `teardownIac` function) caught this round-1 defect.** The final-review's own fix wave -- which broadened `teardownIac`'s three `renovate-integration-update` gates to also match `renovate-status-check` -- is what CREATED the conditions where this bug became reachable via the new intent (before that fix, a `renovate-status-check` turn never reached the durable-fact-write gate at all, so the placeholder-write path, while dormant, wasn't yet exercised by any live code path). Both external bots caught what a same-session Opus whole-branch review, working from the same diff, missed -- a genuine data point for running external review even after a rigorous internal review pass, not a substitute for one.

**Round 2 (fix commit `2aab4f46`):** CodeRabbit re-approved (`reviewDecision: APPROVED`) on the fix push. Greptile, however, caught a NEW real bug that the round-1 fix itself introduced -- Confidence Score still **4/5**, one finding: the round-1 fix removed the premature `renovateInFlightMarker: null` clear from `watchRenovateMr`'s success return, but added no replacement clear anywhere. Since the field is deliberately excluded from `TURN_START_RESET` (the mechanism that would otherwise have caught this), a resolved trigger's marker now persisted on the thread **indefinitely** -- not just through `teardownIac` as the round-1 fix intended, but forever, silently able to hijack any later, wholly unrelated message that happened to match the "check again"-style phrasing guard.

**Triage (live-repro'd again before fixing):** ran a second `bun -e` repro, this time calling `classifyIacIntent` directly with a stale-but-still-set `renovateInFlightMarker` and an unrelated query ("any update on the eu-b2b cluster health?") -- confirmed it was misclassified as `renovate-status-check`. Fixed by moving the clear to exactly where CodeRabbit's ORIGINAL round-1 suggested diff had proposed it all along (`teardownIac`'s renovate short-circuit, conditional on `state.renovateMrUrl`) -- the round-1 fix's chosen mechanism (never clear, rely on `TURN_START_RESET`) turned out to be wrong because `TURN_START_RESET` genuinely never reaches this field, a fact confirmed but not fully reasoned through during round-1 triage. Extended the existing teardown tests (exact-return-shape assertion for the MR-found case, a companion untouched-field assertion for the no-MR-yet case) and the end-to-end chained test (added a final assertion that the merged post-teardown state has `renovateInFlightMarker: null`). 131/131 tests pass in the target file; the pre-existing 14-test cross-file `mock.module` pollution class (confirmed via `git stash` to predate this entire PR, present on the already-pushed base commit) is unrelated and untouched.

**Round 3 (fix commit `a6348316`):** Greptile `COMPLETED SUCCESS`, Confidence Score **5/5**, zero findings, footer SHA confirmed matching HEAD exactly. CodeRabbit's `reviewDecision` stayed `APPROVED` (it had already cleared after round 1's fix and posted no new inline comments on rounds 2-3's pushes). Clean on both bots.

**Notable, round 2:** this is the first round in the series where a bot's OWN round-1 finding indirectly caused a round-2 finding -- not because the fix was wrong in effect (the durable fact IS now written correctly), but because the chosen fix *mechanism* (removing a clear rather than relocating it) had a side effect neither the implementer nor CodeRabbit's alternative suggestion would have had. CodeRabbit's original suggested diff, if applied verbatim in round 1, would have avoided this second round entirely -- a caution against substituting a differently-reasoned fix for a bot's concretely-proposed one without re-verifying the substitute's OWN correctness as rigorously as the original finding was verified.

**Takeaway:** the first true duplicate-catch round in this series -- both bots independently found the identical single bug, in the identical location, with the identical root-cause diagnosis, differing only in proposed fix mechanism. This is a strong signal for this specific defect class (a field cleared one node too early, silently degrading a downstream consumer's derived data quality rather than throwing) being a genuinely well-covered blind spot for automated review generally, not a quirk of one tool's heuristics. It's also a caution against declaring "final review passed" as a true final gate -- this branch had 8 internal review passes (7 task-level + 1 whole-branch) before either external bot ran, and the defect still reached PR review live.

## PR #672 detail (SIO-1477, AgentCore credential validation)

Three review rounds on a diagnostics fix: 4 files (+283/-5) round 1, (+121/-1) round 2, (+70/-2) round 3. The strongest round in this ledger for the both-bots case -- **five findings, four valid, and the two bots' valid findings did not overlap at all.** Greptile found two successive correctness gaps in the author's own logic; CodeRabbit found a crash the author introduced while fixing them.

**Origin:** an expired AWS credential broke the kafka and aws proxies, but the readiness probe reported `credentials: "ok"` while `agentcoreUpstream` read `"unreachable"` -- sending the operator after a network fault when the real cause was auth. The probe only awaited `getCredentials()`, a presence check: an expired/revoked/wrong-account key still resolves cleanly, and a credentials-file profile carries no local `Expiration` to inspect (live-confirmed: `Expiration: (none)` even right after a successful refresh).

**Round 1 (`e712c702`):** signed `sts:GetCallerIdentity` validation, 401/403 classified as auth rather than unreachable, `componentErrors` surfaced in the degraded warn.

- Greptile: **4/5**, one **P1** -- "Wrong-account identity passes validation". A *valid* key from a different account returns HTTP 200, so the new check still passed it and blame stayed on `agentcoreUpstream`. This directly contradicted the PR description, which claimed the change caught wrong-account keys.
- CodeRabbit: `CHANGES_REQUESTED`, two findings -- one Major (non-string `errors` values make `value.slice()` throw inside the poll loop) and one Minor (`res.text()` buffers the body before `slice(0, 200)`).

**Triage, all verified before acting:**

- *Greptile P1 -- valid, fixed.* Proven empirically rather than accepted: signed the previously-configured key (the one commented out in `.env`) against real STS and got `HTTP 200 | account 356994971776` while the runtime lives in `399987695868`. Wrong-account is this repo's documented historical AgentCore failure mode, so it is the case most worth catching. Fixed by parsing the account from the runtime ARN and comparing identities.
- *CodeRabbit Major -- valid, fixed.* Reproduced first (`TypeError: v.slice is not a function`), and confirmed the premise: `mcp-bridge.ts:589` is `(await r.json().catch(() => ({}))) as ReadinessSnapshot`, an unvalidated cast. A non-string would have thrown inside the poll loop and dropped every remaining server's result for that cycle -- a resilience bug inside a resilience fix. Fixed with `String(value)`.
- *CodeRabbit Minor -- declined.* Both paths read only AWS-generated error bodies (small, bounded, not attacker-controlled) behind a 20s timeout over HTTPS to a fixed endpoint. Manual `ReadableStream` handling in two error paths plus a synthetic streaming test, to defend against a body AWS does not send, is a net loss in clarity for code whose job is to make failures easier to diagnose. Declined in-thread with an explicit invitation to supply a realistic counterexample.

**Round 2 (`4d9e68ed`): Greptile stayed at 4/5 with a NEW P1** -- "Unparsed account bypasses validation". The round-1 fix only rejected a *parsed* mismatch, so an HTTP 200 yielding no account skipped verification and reported `credentials: "ok"`. The author had written that `undefined` fallback deliberately as graceful degradation; it was fail-OPEN on the exact check the operator requested by setting `expectedAccountId`, reintroducing the ticket's own bug shape in miniature. Fixed to fail closed; the round-1 test that asserted the fail-open behaviour was inverted with a comment recording why. Live-checked that the path is unreachable by normal traffic -- real STS returns a parseable account over both `Accept: application/json` (JSON) and `Accept: text/plain` (XML) -- and both real bodies became regression tests.

**Round 3 (`1f4e5ff6`):** Greptile **5/5**, "The PR appears safe to merge", explicitly noting both the wrong-account rejection and the fail-closed behaviour. CodeRabbit `APPROVED`. All 5 review threads resolved.

**Latency:** all three Greptile rounds completed within a few minutes; no re-triggers needed.

**Takeaways:**

1. *Zero overlap between the bots' valid findings.* Greptile: two correctness gaps in the author's validation logic. CodeRabbit: a crash-on-malformed-input the author introduced. Neither found the other's. This is the clearest evidence in the ledger that the two reviewers are complementary rather than redundant.
2. *Incremental re-examination is where Greptile earns its place.* The round-2 P1 existed only because of the round-1 fix. A reviewer that merely re-ran its original checklist would have passed it; catching a NEW defect introduced by a fix is the behaviour worth paying for.
3. *A bot catching the author overclaiming in the PR description.* The round-1 P1 falsified a specific claim in the PR body ("catches wrong-account keys"). Worth noting that review value is not only about code -- it caught a description that would have misled a future reader of the merge commit.
4. *Verify-before-apply, third consecutive entry.* Every accepted finding was reproduced first (real STS call for wrong-account, live `TypeError` for the crash) and the declined one was argued from properties of the actual data path. Two of the three fixes were shaped differently than the bot's suggested framing implied.
5. *Fail-open is the recurring anti-pattern.* Both Greptile P1s were the same underlying mistake in different clothes: a check reporting "ok" for a verification that never ran. That is exactly the defect SIO-1477 was filed to remove, which suggests it is a shape worth grepping for elsewhere in the readiness code.

## PR #673 detail (SIO-1478, gitlabFetch timeout + probe classification)

Three rounds on a small resilience fix: 4 files (+190/-2) round 1, (+94/-11) round 2, (+27/-10) round 3. **First entry in this ledger where the two bots CONVERGED on the same defect independently** -- and also the round where CodeRabbit's suggestion was materially better than the author's own fix.

**Origin:** `elastic-iac-mcp` was logged as `MCP server down ... identity unreachable: aborted due to timeout` while healthy. The line before it: `tools/call ok gitlab_list_merge_requests_by_source_branch durationMs: 136597` -- 136.6s against 227/236/263/243/336ms for the five preceding invocations of the same tool. `gitlabFetch` issued a bare `fetch()` with no `AbortSignal` (20 call sites, zero timeouts anywhere in that server), and because the server runs one event loop, a stalled GitLab call starved the agent's `/identity` probe (1s budget, tighter than `/health`'s 2s -- which is why health passed and identity failed).

**Round 1 (`eb381bf6`):** 30s default timeout at the shared helper, plus `describeProbeFailure` distinguishing timeout ("may be alive but blocked") from refusal ("unreachable").

- **CI Typecheck: FAILURE** -- three zero-arg `fetch` mocks cast straight to `typeof fetch` (TS2352). Author error, and instructive: the local gate had been read by grepping output for error strings instead of checking the **exit code**, so a real failure was reported as clean. Switched to exit-code checks, which is how the subsequent passes were confirmed.
- Greptile: **4/5**, two findings. (a) `parseInt` stops at the first non-digit, so `ELASTIC_IAC_GITLAB_TIMEOUT_MS=30s` silently became a **30 millisecond** deadline and `30_000` became 30ms -- both plausible operator input, both converting the new safety net into a guaranteed failure. (b) When the caller supplies its own signal, the helper's timeout is never armed, so reporting `timed out after 30000ms` asserted a deadline that never existed.
- CodeRabbit: `CHANGES_REQUESTED`, three findings -- **independently including the same caller-cancellation bug** ("Report caller cancellation as an abort"), plus a stricter version of the parsing finding, plus a test-hygiene issue Greptile missed (`delete Bun.env...` unconditionally removes a key the test process may have supplied).

**Triage, all five verified before acting:**

- *Unit-bearing timeout -- fixed.* Repro'd the exact silent-tiny-deadline behaviour across `"30s"`, `"30_000"`, `"1e4"` before changing anything.
- *Caller cancellation -- fixed.* Live-repro'd that a caller abort surfaces as `AbortError`, indistinguishable from the timeout path. Notable that this is the same class of false claim SIO-1477 and SIO-1478 themselves exist to remove -- the fix had reproduced the bug it was fixing.
- *`readPositiveIntEnv` (CodeRabbit) -- fixed, and better than the author's fix.* Round 2 hand-rolled a `/^\d+$/` guard; CodeRabbit pointed at the repo's existing canonical tunable reader. Verified the shared helper directly: `"30s"`, `"30_000"`, `"1.5"`, `"50ms"`, `"0"`, `"-5"` all fall back while `"75"` is accepted -- and it **logs** invalid input rather than falling back silently, which the hand-rolled version did not. Strictly better; replaced.
- *Test env restore (CodeRabbit) -- fixed.* Captured once and restored in `afterEach` rather than unconditionally deleted.

**Round 3 (`4d039435`):** Greptile **5/5**, CodeRabbit `APPROVED`, all 5 threads resolved, `reviewDecision: APPROVED`.

**Explicitly left unsolved:** why the call took 136s. The tool is a single GitLab GET with no retry loop, driven by a poll loop at `iac/nodes.ts:978` (90s budget / 10s interval), so GitLab-side throttling of the repeated identical query is the leading hypothesis but is unproven. Recorded as out of scope in both the ticket and the PR body rather than implying the root cause was closed; the new timeout message will make a recurrence obvious.

**Takeaways:**

1. *First convergence.* Both bots independently found the caller-cancellation mislabel on the same commit. Previous entries (#670, #672) showed zero overlap; this one shows the overlap is real but partial -- each still carried findings the other missed (Greptile: none unique this round; CodeRabbit: test-hygiene + the `readPositiveIntEnv` pointer).
2. *CodeRabbit's repo-awareness beat a hand-rolled fix.* Its "use `readPositiveIntEnv()`" note cited repo learnings and pointed at an existing helper the author had duplicated worse. This is a different KIND of value from Greptile's correctness findings -- convention/reuse rather than defect detection -- and is the strongest argument yet for keeping it alongside.
3. *A green local gate is not a green CI gate.* The round-1 typecheck failure was invisible locally because the check was grepped rather than exit-coded. Second occurrence this session of local verification being weaker than CI's; exit codes are the only reliable signal.
4. *The fix reproduced its own bug class.* Both the "timed out after Nms" mislabel and the tiny-deadline parse were instances of "assert something that did not happen" -- exactly what SIO-1477/1478 were filed to remove. Worth watching for in any change whose subject is diagnostics.

## PR #674 detail (SIO-1479, Renovate stage-tracker wiring + per-policy agent counts)

A single-commit UI/observability PR, +150/-34 across 11 files, bundling two independent fixes (SSE stage-tracker wiring for the Renovate lane; per-policy Fleet agent counts threaded through the shared event contract to the approval card). One review round, no re-triggers. Both bots reviewed the correct HEAD SHA (`8f0cc3e3`, confirmed in each footer).

**Round 1 (`8f0cc3e3`):**

- Greptile: `COMPLETED SUCCESS`, `reviewDecision: APPROVED`, Confidence Score **4/5**, one non-blocking finding (`nodes.ts:574-580`): the newly consumed Fleet `agents` field is validated with an inline `typeof` guard rather than "the repository-required Zod runtime validation pattern", framed as fragmenting validation of the external response.
- CodeRabbit: "No actionable comments were generated." Clean. (Walkthrough + change-summary only, effort rated 3/Moderate.)

**Triage (verified against the file, not applied on the bot's authority):** the finding's premise -- that Zod is *required* for these external responses -- is false for this specific call class. All three Kibana Fleet `fetch` responses in this file use the identical inline pattern: `(await res.json()) as { items?: unknown }` + a `typeof` guard + soft-fail, at `nodes.ts:459` (`resolveIntegrationSlug`), `:570` (this PR's new call), and `:629` (`enrichRenovateTarget`'s packages-list call). The two others predate this PR and were reviewed/merged as-is across #668/#669/#671. Zod *is* imported and heavily used in this file (112 occurrences) -- but for LangGraph state annotations and tool-arg schemas, deliberately NOT for these raw external Fleet HTTP payloads, which are intentionally guarded lightly so any shape drift degrades to `agentCount: null` rather than throwing on the approval-gate path. Adding a Zod schema for only the new `agents` field would make this call *inconsistent* with its two siblings, not more consistent. **Declined in-thread** with this reasoning (attribution appended) and the inline thread resolved.

**No fix push:** the sole finding was declined on merit; nothing to fix. Local verification before opening the PR was already green -- typecheck (0 errors, 19 packages), lint (0 errors, 12 pre-existing warnings none in changed files), 140 agent+shared and 286 web tests, plus an SSR render probe confirming the card's `(108 Agents)`/`(0 Agents)`/`(1 Agent)`/null-omitted output and the `iacNodes` selector returning `IAC_RENOVATE_NODES` with all 7 ids matching graph node names.

**Latency:** Greptile completed within ~1-2 minutes of PR open; no re-trigger needed.

**Takeaways:**

1. *First declined-as-false-premise entry in the series.* Prior declines (#660 Minor, #670 Zod) were judgment calls on defensibility of already-correct code. This one is different: the finding asserted a repo *convention* ("Zod required") that the surrounding code demonstrably does not follow for this call class. The verify step here was reading the two sibling calls in the same file, not a runtime repro -- the right form of verification for a convention claim, and the counter-evidence (two merged siblings using the exact declined pattern) was decisive.
2. *A convention finding is only as good as the convention.* Greptile correctly observed the pattern-divergence-from-Zod-elsewhere but mis-scoped which code the convention governs. Rule-shaped findings that cite a "repository-required pattern" warrant checking whether the cited pattern actually applies to the specific construct, not just whether it exists somewhere in the file -- the same lesson as #658/#670's declined Zod findings, now a three-peat for Zod-convention false positives specifically.
3. *CodeRabbit clean where Greptile flagged.* On a mechanical/threading PR with no correctness surface, CodeRabbit found nothing and Greptile found one convention nit. Neither a miss (the nit was declined, not a real defect), but a data point that Greptile is the noisier of the two on style/convention while CodeRabbit stayed silent -- the inverse of the recall advantage Greptile has shown on correctness bugs (#658/#659/#671/#672).
4. *4/5 with a declined finding still merges cleanly.* The `Greptile Review` check was `SUCCESS` and `reviewDecision` `APPROVED` despite the 4/5 -- the score reflects the open convention nit, not a merge block. Reading the body confirmed the finding was non-blocking and declinable, exactly the "a clean check is not the whole story, but here the body agrees" case.


## PR #675 detail (SIO-1525, gitlab-import sweep: external config changes into memory + KG)

The largest diff in the ledger so far (+1318/-2 across 12 files round 1) and the first entry where the review loop itself became a chain: each bot's strongest finding was a defect introduced by the fix for the previous round's finding. Four Greptile rounds (3/5 -> 4/5 -> 5/5 -> 5/5 "appears safe to merge"), two CodeRabbit `CHANGES_REQUESTED` verdicts, three fix pushes, final `reviewDecision: APPROVED`, zero unresolved threads.

**Round 1 (`48fa92d9`):** Greptile **3/5**, three findings; CodeRabbit `CHANGES_REQUESTED`, seven findings. **Second-ever convergence** (after #673): both independently flagged that a partial dual-store write returned "imported" and advanced the watermark, permanently stranding the failed store.

- Greptile unique: (a) the 1,000-commit listing cap retained GitLab's NEWEST results, so a giant window would strand its oldest commits below the advancing watermark forever -- fixed with an `until`-anchored back-walk that aborts (rather than silently truncates) when still capped after 5 rounds; (b) section-separator comments banned by the repo comment rules.
- CodeRabbit unique, and this is its best round in the ledger: (a) no `AbortSignal` on the GitLab fetches -- one stalled connection would wedge the `sweepRunning` re-entrancy guard for the process lifetime, disabling the importer entirely; (b) `committed_date` carries the commit author's UTC offset, so the lexicographic sort diverged from time order -- confirmed against live data (`+02:00` observed) and fixed with epoch sort + UTC normalization of watermark/createdAt; (c) a transient 429/5xx on a `_deployments` blob fetch silently classified the change as `topology-edit` under a PERMANENT record id; (d) the bootstrap import sat below the MCP connectivity guard, so a disconnected elastic-iac server skipped the backfill the sweep exists for.
- **The blob-misclassification finding was validated empirically, not just by inspection:** re-running the live probe after the fix produced 91 records for the same window where the pre-fix code had accumulated 140 -- the 49 extra records were exactly the duplicate misclassified ids CodeRabbit predicted ("a later correct sweep adds a second record for the same commit instead of replacing it"). A review finding reproduced as a live-data diff is the strongest confirmation form this ledger has recorded.
- Declined (1 of 10): CodeRabbit's "200-fact dedupe cap will duplicate memory writes as history grows" -- false premise: the deterministic recall path is filter-only retrieval with no top-k truncation (SIO-998; the `limit` arg is ignored on that path), and the KG per-id check is authoritative when the graph is on. Declined in-thread with the wrapper's own code as evidence.

**Round 2 (`b609b10b`):** Greptile **4/5**, one NEW finding -- and a real one: the round-1 partial-write fix interacted with the commit-level MR dedupe. After a partial import of an MR-backed commit, the import's OWN memory fact / `PROPOSED_IN` edge made the commit-level "already recorded" skip fire on the next sweep, so the missing store never got its retry. Fixed by excluding importer-created records (id prefix `gitlab:`, `external_import` facts) from the commit-level signals; per-record dedupe governs them instead.

**Round 3 (`7f6d1ad6`):** Greptile **5/5**. CodeRabbit then filed a second `CHANGES_REQUESTED` -- against the round-2 fix itself: `mrUrlHasChange` applied `LIMIT 25` before the TypeScript prefix filter, so an MR accumulating many `gitlab:` records could evict the one agent-lane row and let the importer double-record. Fixed by moving the exclusion into the query (`WHERE NOT c.id STARTS WITH 'gitlab:' ... LIMIT 1`), live-verified against a real lbug store (import-only url false, agent record true, unknown url false) before pushing.

**Round 4 (`71689a95`):** Greptile **5/5**, "The PR appears safe to merge", footer SHA == head; `reviewDecision: APPROVED`; merged.

**Latency:** Greptile round 1 took ~25-30 minutes on the 1,300-line diff (its longest observed run; earlier small-diff entries were ~1-2 min), rounds 2-4 each landed within a few minutes of push. CodeRabbit round 1 arrived in ~14 minutes; its second verdict followed the round-3 push by ~4 minutes. On this PR the two were latency-comparable.

**Takeaways:**

1. *The fix-chain is the headline.* Round 1's partial-write fix created round 2's retry-blocking interaction (Greptile); round 2's fix created round 3's LIMIT-eviction (CodeRabbit). Neither defect existed in the original diff. Two consecutive incremental rounds each catching a fix-introduced bug is the strongest dual-reviewer argument in the ledger: the bots alternated as the one that caught it.
2. *CodeRabbit's best round.* Four unique accepted findings on round 1, three of them availability/correctness (timeout wedge, offset sort, blob misclassification) rather than its usual convention notes -- and the misclassification one was confirmed by a 49-record live-data discrepancy. The prior pattern (#674: "Greptile for correctness, CodeRabbit for convention") does not survive this entry.
3. *Verify-before-apply kept paying.* The offset-sort finding was checked against live `committed_date` values, the declined dedupe-cap finding against the wrapper's actual retrieval mode, and the Cypher `STARTS WITH` fix against a real lbug store before push. One of ten findings died under verification; nine survived and all nine were real.
4. *A live probe is a reviewer too.* The pre-review live probe independently caught the newest-first truncation bug (fixed before either bot saw round 1), and the post-fix probe quantified the blob misclassification. Probe-then-review found different bugs than review alone would have.

## PR #676 detail (SIO-1527, renovate-lane MR edge attach)

A small follow-up PR (+203/-3 initial) that became a four-round study in reviewing a RECOVERY path: every round after the first attacked the legacy-marker fallback added for markers checkpointed before the fix. **First merge in this ledger without a 5/5** -- the terminal round was 4/5 with an explicitly declined floor-case finding, `reviewDecision: APPROVED`, zero unresolved threads.

**Round 1 (`9842b9ef`):** Greptile 4/5, two findings; CodeRabbit `CHANGES_REQUESTED`, two findings.

- Greptile real: the legacy-marker fallback passed the CURRENT turn's requestId, which can never match the trigger-time node -- a silent wrong-id no-op. Fixed: attach only with the marker-carried id, log-skip otherwise.
- Greptile declined: header-path suggestion (`// packages/agent/...`) contradicted the verified sibling convention (`head -1` on all four neighbor test files shows the package-root-relative form -- which CodeRabbit's own repo learning on #675 asked for). The two bots' conventions directly contradicted each other here.
- CodeRabbit real: `attachChangeMr` MERGEd the MergeRequest before verifying the ConfigChange, leaving an orphan MR node when the trigger write had soft-failed. Fixed with a `configChangeExists` pre-check; live-verified (missing-id attach leaves zero MR nodes).
- CodeRabbit declined: Zod-for-guards -- the FOURTH instance of the Zod-convention false-positive class (#658/#670/#674); every sibling writer uses plain guards and lane-knowledge.ts documents the choice.

**Round 2 (`a0a78212`/`4a4cb506`):** Greptile 4/5 with prose "not yet safe to merge": the log-skip fix meant legacy markers leave their node permanently proposed. Fixed by RECOVERY rather than decline: the trigger-time summary is deterministic (`renovate <dep> -> <marker>`, now emitted by a shared `renovateChangeSummary` so write and lookup cannot drift), so the legacy path recovers the node id by summary lookup. Live-verified on a real lbug store.

**Round 3 (`bc3cb890`):** both bots attacked the recovery's newest-wins selection, from different angles on the same commit -- Greptile P1: a newer re-trigger of the same deployment/marker STEALS the legacy attach; CodeRabbit: equal-createdAt ties resolve nondeterministically (reduce keeps first row, no ORDER BY). One fix closed both: selection anchored to the legacy marker's own `triggerAtIso` (the node is written moments after that instant) with a lexicographic id tiebreak in both modes, NaN-safe timestamp parsing.

**Round 4 (`fe7454bf`):** Greptile 4/5, one finding -- concurrent IDENTICAL triggers (two humans approving the same update within moments) could still misbind a legacy attach. **Declined as the information-theoretic floor**: a pre-SIO-1527 marker carries no identity that can disambiguate concurrent identical writes; both nodes describe the same logical change sharing one Renovate MR (one MR per branch), so the edge lands on a correct record either way, and the unattached twin staying proposed is the pre-existing superseded-duplicate property. Every new trigger uses the immune id-keyed path. Check `COMPLETED SUCCESS`, `reviewDecision: APPROVED`, thread declined-and-resolved -> merged at 4/5.

**Takeaways:**

1. *Recovery paths attract review pressure proportional to their cleverness.* The id-keyed happy path drew zero findings across four rounds; the legacy fallback drew five. Each fix narrowed the gap (skip -> summary lookup -> anchored + deterministic), and the terminal finding sat exactly at the point where the marker's information content runs out -- a good signal that triage should switch from fix to decline.
2. *The bots contradicted each other on convention for the first time.* Greptile demanded the repo-relative header the sibling files (and CodeRabbit's own learning) reject. Convention findings need checking against the ACTUAL neighbors, not the rule text -- same lesson as #674, now with the two reviewers on opposite sides.
3. *Round-3 convergence again, complementary angles.* Same target (the selection rule), different failure modes (steal vs nondeterminism), one shared fix. Third convergence in the ledger (#673, #675, #676).
4. *A 4/5 merge is legitimate when the residual is a declined floor-case.* The prose gate ("not yet safe to merge") flagged rounds 2-4; rounds 2-3 were real and fixed, round 4 was declined on merit with the reasoning in-thread. The check + decision + resolved-threads gates all passed; the score alone is not the gate.

## PR #679 detail (SIO-1572, live graph triage split-screen panel)

A frontend-heavy feature PR (+782/-2 initial: topology endpoint, layered SVG layout, live-lighting panel, split layout). Four Greptile rounds (3/5 -> 4/5 -> 4/5 -> 5/5 "appears safe to merge"), five accepted findings, zero declined. **First entry where CodeRabbit posted no review at all** across the PR's ~80-minute open life, so the head-to-head column is empty by absence, not by a clean pass. Also the first PR where Greptile's auto-review did not fire on open: the check never registered until an explicit `@greptile review` comment ~25 minutes in.

**Round 1 (`b18978df`):** 3/5, three findings, all accepted.

- *Parallel executions finish prematurely* (the strongest finding): the store tracked `activeNodes` as a `Set`, and parallel Sends (supervisor fan-out, correlationFetch, per-estate AWS) emit one `node_start`/`node_end` pair PER BRANCH under the same node name -- so the first branch's end marked the node done while siblings still ran. **Verified before fixing with a live LangGraph `Send` probe** (3 starts then 3 ends observed for one node name). Fixed by making `activeNodes` a `Map<nodeId, run count>` that completes only on the last branch's end (its duration = the slowest branch). Map shares `.has()`/`.size` with Set, so the fix also repaired the same early-green in the existing StreamingProgress pills -- a pre-existing bug caught only because the new panel re-consumed the same state.
- *Completion conflates paused states*: a turn paused on any HITL gate keeps its completedNodes for the resume leg, so the panel read every pause as a finished run. Fixed with a `paused` prop derived from the nine gate states plus an `outcome` prop.
- *File headers*: multi-paragraph header blocks violated the single-line-path convention. Accepted (unlike #674/#676 where header findings were declined -- this one matched the actual convention).

**Round 2 (`54d1bb43`):** 4/5, one new P1 -- against the round-1 fix's fallback: with a prior successful run on screen, a next turn failing before any node completed left an empty snapshot, so the persist-last-run scan walked PAST it and resurrected the older successful chart with END lit. Fixed by bounding the scan at the latest turn's user-message boundary.

**Round 3 (`2b802ab5`):** 4/5, one new P1 -- against the round-2 fix's outcome handling: `runFinished` excluded only `"error"`, so IaC terminal outcomes (rejected/declined/blocked/unsupported/pipeline-failed) lit END green. Fixed by requiring outcome `"completed"` (or undefined on the live path) and naming any other terminal outcome in the status line. Greptile's inline ```suggestion``` was adopted in refined form (the undefined allowance it lacked would have broken the live path).

**Round 4 (`615a0d63`):** 5/5, "The PR appears safe to merge", footer SHA == head, zero unresolved threads. Merged.

**Latency:** auto-review never fired on PR open (check absent after 20+ minutes; explicit `@greptile review` needed). Once triggered, each round landed within ~2-5 minutes of trigger/push. CodeRabbit: no review, no check, no comment for the PR's entire life.

**Takeaways:**

1. *The #675/#676 fix-chain pattern repeated solo.* Rounds 2 and 3 each attacked the previous round's fix (fallback scan, then outcome gating). With CodeRabbit absent, Greptile alone sustained the incremental-round pressure that #676 needed both bots for -- its strongest single-bot showing in the ledger.
2. *A reviewer found a pre-existing bug by reviewing new code.* The parallel-Send Set bug predated this PR (StreamingProgress had it since the fan-out existed); it surfaced because the new panel made the state's semantics load-bearing. The live LangGraph probe confirming per-branch event multiplicity is the verify-before-apply form that matters for state-model findings.
3. *CodeRabbit's absence is itself a data point.* Nine prior entries recorded its latency as "varies widely"; this one records a full no-show on a 10-file feature PR. For the bake-off decision, availability consistency now belongs next to recall in the comparison.
4. *Greptile's auto-trigger failed on PR open.* First observed auto-review no-fire; the deterministic completion check caught it (check never registered, distinct from "running"), and the documented `@greptile review` re-trigger recovered. The 20-minute monitor timeout was the right backstop.

## PR #680 detail (combined DevOpsAgentReadOnly IAM reference doc)

A docs-only PR (one added file, `docs/reference/devops-agent-readonly-iam.md`, +416) bundling the three already-committed IAM policy JSONs into one reference. Zero review rounds from either bot -- but HOW each bot declined to review is the ledger-worthy part.

**Greptile:** the auto-trigger on PR open AND an explicit `@greptile review` comment ~9 minutes later were both received and both logged as terminal **SKIPPED** reviews (visible only via the Greptile MCP `list_code_reviews`; ids 21596457 and 21597765, both on head `cc11489c`, `changedFiles` = the single .md). No status check, no bot comment, no review object -- from the GitHub side the bot is indistinguishable from the #679-style no-fire. The MCP was the only way to tell "skipped deliberately (docs-only)" from "never arrived", and it turned an indefinite wait into a deterministic answer.

**CodeRabbit:** nothing at all -- no review, no comment, consistent with its #679 absence.

**Merge gate implication:** on a docs-only diff the `Greptile Review` status check NEVER registers, so the documented completion gate cannot be satisfied and must not be waited on. The merge proceeded on: both Greptile reviews terminal SKIPPED via MCP, zero findings to triage, CI green (Test/Lint/Typecheck/YAML), `MERGEABLE`/`CLEAN`, and explicit user authorization. Merged at 4 CI checks green, squash `756493c6`.

**Takeaways:**

1. *Docs-only diffs are outside both bots' review surface.* Neither bot posts anything; the dual-review comparison is structurally empty for this PR class. Rows like this one record availability behavior, not recall.
2. *The Greptile MCP is the disambiguator for silent-bot states.* #679's lesson was "re-trigger when the check never registers"; #680 extends it: when the re-trigger ALSO stays silent, `list_code_reviews` distinguishes SKIPPED (stop waiting) from stuck (keep escalating). Check it before any long poll.
3. *The status-check gate needs a docs-only carve-out.* "Never merge while Greptile is pending" presumes a review will exist; SKIPPED is not pending. The operative gate for docs-only PRs is CI + MCP-confirmed SKIPPED + user sign-off.

## PR #681 detail (periodic AWS self-check strategy doc)

A docs-only PR (one added file, `docs/operations/aws-periodic-self-check-strategy.md`, +171). Second consecutive docs-only entry; its value is confirming #680's behavior is stable, not incidental.

**Greptile:** the auto-trigger on PR open was logged as a single terminal **SKIPPED** review (MCP `list_code_reviews` id 21783725, head `1c299f5d`, `changedFiles` = the single .md). No status check, no comment, no review object. Unlike #680, no explicit `@greptile review` re-trigger was attempted -- the MCP was consulted after a 30-minute CI-plus-bots poll came back empty, immediately converting the silence into a deterministic SKIPPED answer.

**CodeRabbit:** nothing -- no review, no comment, through the full watch window. Third consecutive absence (#679 feature PR, #680 docs-only, #681 docs-only).

**Merge gate:** CI green (Typecheck/Lint/YAML/Test), Greptile SKIPPED via MCP, zero findings to triage, standing user authorization to merge once clear. Squash `c020785c`; remote branch auto-deleted on merge.

**Takeaways:**

1. *#680's docs-only skip behavior reproduced exactly* (n=2): auto-trigger accepted then terminally SKIPPED, no GitHub-visible trace, CodeRabbit fully silent. The docs-only carve-out (CI + MCP-confirmed SKIPPED + user sign-off) can now be treated as the standard gate for this PR class rather than a one-off exception.
2. *Check the MCP before the long poll, not after.* This round spent 30 minutes polling GitHub surfaces that were never going to change; one `list_code_reviews` call at PR-open time would have answered immediately. Order of operations for future PRs: MCP status first, then poll only if the review is genuinely PENDING/REVIEWING.

## PR #683 detail (SIO-1640, agent-toolkit-for-aws content port)

A mixed PR: one new OKF runbook, two edited runbooks/RULES files, one doc, plus a two-line advice-string change in `packages/mcp-server-aws/src/tools/wrap.ts` and two test edits (7 files, +81/-3). Not docs-only, so the #680/#681 carve-out does not apply on its own terms. Its ledger value is that it is the first CODE PR merged after a terminal Greptile skip, and the third data point (after #682) that the skip is not diff-class-specific.

**Greptile:** the auto-trigger on push logged one terminal **SKIPPED** review (MCP `list_code_reviews` id 22714467, head `3ba94efd`, `changedFiles` = all 7, `completedAt` about 100 ms after `createdAt`). No status check, no comment, no review object. Consulted the MCP at PR-open time per the #681 lesson, so no poll was wasted. No re-trigger was attempted: #682 had already shown all three trigger paths (auto, `@greptile review`, MCP `trigger_code_review`) skip identically on a code PR, so a fourth attempt would have added nothing.

**CodeRabbit:** nothing, through CI completion. Fifth consecutive absence (#679, #680, #681, #682, #683).

**Merge gate:** CI green (Typecheck/Lint/YAML/Test), `MERGEABLE`/`CLEAN`, Greptile SKIPPED on the head SHA via MCP, zero findings to triage. Because this is code, the session reported that the documented gate could not be satisfied and did not merge on its own; the user then explicitly instructed the merge. Squash `d45e7407`. #682 (SIO-1635, 20 files) remains open under the same skip.

**Takeaways:**

1. *The skip is repo/account level, confirmed a third time.* Docs-only (#680, #681), a 20-file feature PR (#682), and a 7-file mixed PR (#683) all skip in ~100 ms with `body: null`. The cause is not the diff; it needs the Greptile dashboard (repo enablement, quota, or a skip rule), which the session cannot see.
2. *Gate for code PRs on a skip: explicit per-PR user authorization, not the docs-only carve-out.* The carve-out exists because docs are outside the review surface; code is not. Report the unsatisfiable gate, let the user decide, record the decision here.
3. *Both bots absent means the bake-off has produced no comparative signal since #679.* Five PRs of availability data and zero recall data. Until the Greptile skip is resolved on the dashboard, new rows here measure the outage, not the reviewers.
