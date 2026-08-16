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
| [#674](https://github.com/zx8086/devops-incident-analyzer/pull/674) | 2026-08-16 | 1 | 0 / 0 (1 declined) | 0 / 0 | Renovate stage-tracker wiring + per-policy agent counts; Greptile 4/5 with one convention finding declined as a false premise, CodeRabbit clean; detail below |

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
