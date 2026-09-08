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
| [#682](https://github.com/zx8086/devops-incident-analyzer/pull/682) | 2026-09-04 | 0 | skipped (3 triggers) | silent | SIO-1635 pi-coms handoff, 20-file CODE PR; first non-docs skip, all three trigger paths; detail below |
| [#683](https://github.com/zx8086/devops-incident-analyzer/pull/683) | 2026-09-05 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1640 agent-toolkit-for-aws content port (7 files incl. wrap.ts + 2 tests); auto-trigger logged terminal SKIPPED within ~100 ms, CodeRabbit silent (5th straight); first CODE PR merged on a skip, on green CI + MCP-confirmed SKIPPED + explicit per-PR user instruction; detail below |
| [#684](https://github.com/zx8086/devops-incident-analyzer/pull/684) | 2026-09-05 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1641 SSE pump node allowlist derived from the compiled graph (14 files, all apps/web + 1 doc); auto-trigger logged terminal SKIPPED within ~150 ms, CodeRabbit silent (6th straight); merged on green CI + MCP-confirmed SKIPPED + explicit per-PR user instruction; detail below |
| [#689](https://github.com/zx8086/devops-incident-analyzer/pull/689) | 2026-09-06 | 0 | n/a (SKIPPED, docs-only) | n/a (no review) | pi-fleet gitagent feasibility report (docs only); seven heads, seven terminal SKIPPED within 125-160 ms via MCP, CodeRabbit silent (10th straight); merged on user authorization; detail below |
| [#690](https://github.com/zx8086/devops-incident-analyzer/pull/690) | 2026-09-06 | 0 | n/a (never registered) | n/a (no review) | SIO-1654 pi-coms subtree import into packages/pi-coms (about 120 files); Greptile never created a review record on any of four heads, CodeRabbit silent (11th straight); merged on user authorization; detail below |
| [#691](https://github.com/zx8086/devops-incident-analyzer/pull/691) | 2026-09-06 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1635 Phase 0: per-environment hubs, hub client mailbox and sender prefix, Agent Memory identity map (17 files); three terminal SKIPPED records on two heads, CodeRabbit silent (12th straight); merged on user authorization; detail below |
| [#692](https://github.com/zx8086/devops-incident-analyzer/pull/692) | 2026-09-06 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1649 pi-fleet Phase 1: agents/pi-fleet definitions, bridge exporter and semver gate, persona in the fleet bundle, agent-release workflow (44 files); terminal SKIPPED in about 100 ms, CodeRabbit silent (13th straight); merged on user authorization; detail below |
| [#693](https://github.com/zx8086/devops-incident-analyzer/pull/693) | 2026-09-06 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1653 pi-fleet Phase 1b: fleet manifest, just fleet CLI, adopt mode, nine generated roots, S3 backend (56 files); SKIPPED in about 2.5 s, CodeRabbit silent (14th straight); Test job segfaulted once in packages/agent and passed on re-run; merged on user authorization; detail below |
| [#694](https://github.com/zx8086/devops-incident-analyzer/pull/694) | 2026-09-06 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1650 pi-fleet Phase 2a: pi-fleet pane next to the incident chat, /api/pi routes, sliced await with browser re-poll, pi-coms client exported from the agent barrel (23 files); SKIPPED twice in about 150 ms, CodeRabbit silent (15th straight); Test job segfaulted once in packages/agent and passed on re-run; merged on user authorization; detail below |
| [#695](https://github.com/zx8086/devops-incident-analyzer/pull/695) | 2026-09-06 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1652 pi-fleet Phase 2b: fetchFleetInbox node before aggregate, fleetInboxDigest sidecar, fleet_inbox SSE event and FleetInboxCard, node count 32 (36 files); SKIPPED twice in about 130 ms, CodeRabbit silent (16th straight); CI green first run; merged on user authorization; detail below |
| [#696](https://github.com/zx8086/devops-incident-analyzer/pull/696) | 2026-09-06 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1651 pi-fleet Phase 3: pi-handoff workflow registering the skillflow `graph` and `agent` step handlers, structured verdicts into live memory (17 files); SKIPPED twice in about 150 ms, CodeRabbit silent (17th straight); Lint failed the first run on a self-inflicted export-ordering slip, green on the second; merged on user authorization; detail below |
| [#697](https://github.com/zx8086/devops-incident-analyzer/pull/697) | 2026-09-06 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1655 Phase 2c PR 1: graphFor(agentName) registry replacing the two-agent assumption, pure refactor (8 files); SKIPPED once in about 150 ms, CodeRabbit silent (18th straight); all five CI jobs green first run; merged on user authorization; detail below |
| [#698](https://github.com/zx8086/devops-incident-analyzer/pull/698) | 2026-09-06 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1655 Phase 2c PR 2: fleet console graph, five hub tools, the untrusted-reply boundary (23 files); SKIPPED three times in about 130 ms each, CodeRabbit silent (19th straight); Typecheck and Lint both failed the first run (a union-typed graph thunk svelte-check caught, and three unformatted files); green on the third; merged on user authorization; detail below |
| [#699](https://github.com/zx8086/devops-incident-analyzer/pull/699) | 2026-09-06 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1655 follow-up: pi-coms capabilities default ON and move into the config schema (15 files); SKIPPED once in about 165 ms, CodeRabbit silent (20th straight); all five CI jobs green first run; merged on user authorization; detail below |
| [#700](https://github.com/zx8086/devops-incident-analyzer/pull/700) | 2026-09-06 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | gitlab-mcp proxy schema conversion: array and enum types honoured when converting GitLab's discovered tool schemas (2 files); SKIPPED once in about 130 ms, CodeRabbit silent (21st straight); all five CI jobs green first run; merged on user authorization; detail below |
| [#701](https://github.com/zx8086/devops-incident-analyzer/pull/701) | 2026-09-07 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | fleet CLI: nine fixes taking `just fleet deploy` from unrunnable to a clean end-to-end dev deployment (14 files); SKIPPED once in about 156 ms, CodeRabbit silent (22nd straight); all five CI jobs green first run; merged on user authorization; detail below |
| [#702](https://github.com/zx8086/devops-incident-analyzer/pull/702) | 2026-09-07 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | `just hub-tunnel` takes an environment instead of a profile, new `just coms-env` (11 files); SKIPPED three times in 115-165 ms, including an explicit MCP re-trigger; CodeRabbit silent (23rd straight); all five CI jobs green; merged on user authorization with the gate knowingly overridden; detail below |
| [#703](https://github.com/zx8086/devops-incident-analyzer/pull/703) | 2026-09-07 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | hub addressed by AWS account, positional port is the hub port, coms-env folded into `just coms` (8 files); SKIPPED once in 108 ms; CodeRabbit silent (24th straight); all five CI jobs green; merged on user authorization with the gate again overridden; detail below |
| [#704](https://github.com/zx8086/devops-incident-analyzer/pull/704) | 2026-09-07 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1656 elastic-iac MR change-class label, a High-severity defect reported from a failed CI gate rather than by either bot (5 files); SKIPPED once in 125 ms; CodeRabbit silent (25th straight); all five CI jobs green first run; merged on user authorization with the gate overridden; detail below |
| [#705](https://github.com/zx8086/devops-incident-analyzer/pull/705) | 2026-09-07 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1657 fleet console made contextual + triage SVG rendered at natural size (7 files); SKIPPED once in 115 ms; CodeRabbit silent (26th straight); all five CI jobs green first run; merged on user authorization with the gate overridden; detail below |
| [#706](https://github.com/zx8086/devops-incident-analyzer/pull/706) | 2026-09-07 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1657 follow-up, reverting #705's horizontal scroll and wrapping wide graph layers instead (3 files); SKIPPED once in 103 ms; CodeRabbit silent (27th straight); all five CI jobs green first run; merged on user authorization with the gate overridden; detail below |
| [#707](https://github.com/zx8086/devops-incident-analyzer/pull/707) | 2026-09-07 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1658, a tall HITL gate card collapsing the triage pane to zero height (1 file); SKIPPED once in 144 ms; CodeRabbit silent (28th straight); all five CI jobs green first run; merged on user authorization with the gate overridden; detail below |
| [#708](https://github.com/zx8086/devops-incident-analyzer/pull/708) | 2026-09-07 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1659, gate cards bounded to the chat column so they stop running under the panes (1 file); SKIPPED once in 92 ms; CodeRabbit silent (29th straight); Test job aborted once with the known packages/agent SIGABRT and passed on re-run; merged on user authorization with the gate overridden; detail below |
| [#709](https://github.com/zx8086/devops-incident-analyzer/pull/709) | 2026-09-07 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1660, instrumenting the pi-coms fleet path after a 403 took a live-hub curl investigation (2 files); SKIPPED once in 128 ms; CodeRabbit silent (30th straight); all five CI jobs green first run; merged on user authorization with the gate overridden; detail below |
| [#711](https://github.com/zx8086/devops-incident-analyzer/pull/711) | 2026-09-07 | 0 | n/a (SKIPPED, code PR) | n/a (no review) | SIO-1662, dropping the duplicate fleet-console header button and moving the entry into the pane (2 files); SKIPPED once in 139 ms; CodeRabbit silent (31st straight); all five CI jobs green first run; merged on user authorization with the gate overridden; detail below |

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

## PR #682 detail (SIO-1635, pi-coms hub verification and investigation handoff)

A code PR: 20 changed files, six new TypeScript sources (hub client, verifier, shared contracts) plus a Svelte card rewrite, tests, docs and `.env.example`. Head `670a4d77`. CI green on the first run (Typecheck, Lint, YAML check, Test).

**Greptile:** three terminal **SKIPPED** reviews on the same head, each completed about 150 ms after creation, one per trigger path: the auto-trigger on PR open (MCP id 22602629), the `@greptile review` comment (22602846), and a dispatch through the Greptile MCP `trigger_code_review` (22602981, which answered "Code review triggered successfully"). No status check registered, no bot comment, no review object, and `get_code_review` returns `body: null` with no reason. `list_custom_context` timed out when probed for a skip rule.

**CodeRabbit:** nothing through the watch window. Fourth consecutive absence (#679, #680, #681, #682).

**Merge gate:** not satisfied from the session side. The docs-only carve-out (CI + MCP-confirmed SKIPPED + user sign-off) was defined for diffs Greptile has nothing to say about; it does not extend to a 20-file code change. Left open for the user to check the Greptile dashboard (repo enabled, quota, skip rules) and to run their own smoke test against the corp hub.

**Takeaways:**

1. *The skip is no longer explained by docs-only diffs.* Every PR since #680 has been skipped regardless of content, so the cause is repo- or account-level in Greptile, not the classifier. The MCP still answers in one call what GitHub-side polling never would; the escalation path after a skipped code PR is the dashboard, not another re-trigger.
2. *The MCP trigger does not bypass the skip.* It reports success and is skipped like the others, so it is not a workaround.
3. *Review coverage for this PR came from the session itself:* unit tests at the fetch boundary, `--isolate` full-suite run, and a live smoke against the real hub that caught one real routing bug (a stale session's queue was being reported as a mailbox send). Record kept in the PR body.
**Merge 2026-09-06:** rebased twice onto main (`768ebf10`, then `9234c5cf` after #690 landed; only the ledger conflicted the first time). Greptile logged terminal SKIPPED on both rebased heads (ids 22786127, 22787353, about 115 ms each; seven SKIPPED records on this PR in total). CodeRabbit silent throughout. CI green on the final head; squash `e004441c`, merged on the user's "merge all" authorization without the corp-hub smoke test (the user's call; the hub token still has to be minted per hub before the cards work live).

## PR #683 detail (SIO-1640, agent-toolkit-for-aws content port)

A mixed PR: one new OKF runbook, two edited runbooks/RULES files, one doc, plus a two-line advice-string change in `packages/mcp-server-aws/src/tools/wrap.ts` and two test edits (7 files, +81/-3). Not docs-only, so the #680/#681 carve-out does not apply on its own terms. Its ledger value is that it is the first CODE PR merged after a terminal Greptile skip, and the third data point (after #682) that the skip is not diff-class-specific.

**Greptile:** the auto-trigger on push logged one terminal **SKIPPED** review (MCP `list_code_reviews` id 22714467, head `3ba94efd`, `changedFiles` = all 7, `completedAt` about 100 ms after `createdAt`). No status check, no comment, no review object. Consulted the MCP at PR-open time per the #681 lesson, so no poll was wasted. No re-trigger was attempted: #682 had already shown all three trigger paths (auto, `@greptile review`, MCP `trigger_code_review`) skip identically on a code PR, so a fourth attempt would have added nothing.

**CodeRabbit:** nothing, through CI completion. Fifth consecutive absence (#679, #680, #681, #682, #683).

**Merge gate:** CI green (Typecheck/Lint/YAML/Test), `MERGEABLE`/`CLEAN`, Greptile SKIPPED on the head SHA via MCP, zero findings to triage. Because this is code, the session reported that the documented gate could not be satisfied and did not merge on its own; the user then explicitly instructed the merge. Squash `d45e7407`. #682 (SIO-1635, 20 files) remains open under the same skip.

**Takeaways:**

1. *The skip is repo/account level, confirmed a third time.* Docs-only (#680, #681), a 20-file feature PR (#682), and a 7-file mixed PR (#683) all skip in ~100 ms with `body: null`. The cause is not the diff; it needs the Greptile dashboard (repo enablement, quota, or a skip rule), which the session cannot see.
2. *Gate for code PRs on a skip: explicit per-PR user authorization, not the docs-only carve-out.* The carve-out exists because docs are outside the review surface; code is not. Report the unsatisfiable gate, let the user decide, record the decision here.
3. *Both bots absent means the bake-off has produced no comparative signal since #679.* Five PRs of availability data and zero recall data. Until the Greptile skip is resolved on the dashboard, new rows here measure the outage, not the reviewers.

## PR #684 detail (SIO-1641, SSE pump node allowlist derived from the compiled graph)

A code PR: 14 files, +258/-95, all under `apps/web` plus one doc. It removes the hand-maintained `PIPELINE_NODES` allowlist from `sse-pump.ts` in favour of the compiled graph's own node list, refcounts parallel-branch start times, wires four routes and three route-test mocks, and adds labels for 20 plumbing nodes. Fourth consecutive CODE-class data point for the Greptile skip.

**Greptile:** the auto-trigger on push logged one terminal **SKIPPED** review (MCP `list_code_reviews` id 22718874, head `55efdd46`, `changedFiles` = all 14, `completedAt` about 150 ms after `createdAt`). No status check, no comment, no review object. Consulted the MCP at PR-open time; no re-trigger attempted (#682 proved all three trigger paths skip identically).

**CodeRabbit:** nothing, through CI completion. Sixth consecutive absence (#679 to #684).

**Merge gate:** CI green (Typecheck/Lint/YAML/Test), `MERGEABLE`/`CLEAN`, Greptile SKIPPED on the head SHA via MCP, zero findings to triage. Code-class skip: the session reported the unsatisfiable gate and did not merge on its own. The user then explicitly instructed the merge. Squash `70d5c4ec`.

**Takeaways:**

1. *Fourth code-class skip in a row, same ~100-150 ms signature.* The dashboard-level cause first flagged on #682 is still unresolved; the ledger keeps measuring the outage, not the reviewers.
2. *A self-verified change with no reviewer signal.* The PR's own evidence (live-probe of `streamEvents` metadata, a 23-node end-to-end run, TDD tests for the allowlist and the duration refcount) is the only review this change received. That is the operating mode until the skip is fixed; note it, do not normalise it.

## PR #685 detail (SIO-1643, dev-server warning triage: KG reserved alias, reader NULs, node:sqlite noise, Elastic unscoped fallback)

A code PR: 19 files, +445/-35, spanning four packages (knowledge-graph, shared, agent, apps/web) plus two docs. It renames a Cypher RETURN alias that lbug rejects as a reserved word (`group`), strips six raw NUL bytes from `reader.ts`, scopes a `process.emitWarning` filter around the `node:sqlite` import, and adds the SIO-1138/SIO-1159-style unscoped fallback to the Elastic findings card with matching rule-engine and coverage guards. Fifth consecutive CODE-class data point for the Greptile skip.

**Greptile:** two pushes, two terminal **SKIPPED** reviews (MCP `list_code_reviews` ids 22724142 on head `1de160c5` and 22724334 on head `53c14044`, `changedFiles` = all 19, `completedAt` 120-150 ms after `createdAt`, `strictness: 2`, body null). No status check, no comment, no review object. Consulted the MCP at PR-open time (one call); no re-trigger attempted, per the #682 finding that all three trigger paths skip identically.

**CodeRabbit:** nothing, through CI completion on both heads. Seventh consecutive absence (#679 to #685).

**Merge gate:** CI green on the second head (the first head failed Lint on one over-width line in a test stub edited after the format pass; fixed and re-pushed), `MERGEABLE`/`CLEAN`, Greptile SKIPPED on the head SHA via MCP, zero findings to triage. Code-class skip: the session reported the unsatisfiable gate and did not merge on its own. The user then explicitly instructed the merge. Squash `9aef66d9`.

**Takeaways:**

1. *Fifth code-class skip, same signature, now spanning a four-package diff.* Nothing about diff size, package mix, or file class changes the outcome; the SIO-1642 dashboard/billing cause is still the only lead.
2. *The CI Lint failure is exactly the kind of thing a reviewer would not have caught either, but it is a reminder that "local lint was clean" is only true for the tree at the moment it ran.* Any edit after the format pass needs a re-run before push; the PR's second commit exists only because of that ordering.
3. *Self-verified again.* The review this change received was its own evidence: a real-engine test that reproduced the production parser exception pre-fix, a Node-side before/after probe of the warning filter, and a live replay of the original incident query from a worktree server showing the three code-owned warns gone and the Elastic fallback engaging (126 raw -> 5 unscoped). Record it, do not normalise it.

## PR #686 detail (SIO-1645, process-wide KG store + in-process server slots; identity-aware port pre-flight)

A code PR: 12 files across knowledge-graph, mcp-server-knowledge-graph and apps/web, plus three docs (two new source files, two new test files). It fixes the false "a knowledge-graph server is already running on this port (likely started standalone)" warning: Vite restarts its dev server in-place on a root `.env` change (same PID, new SSR module runner, `hot.dispose` not run) and re-evaluates the linked workspace packages, so the module-scoped `storePromise` and the in-process KG server were recreated -- the reloaded module probed 9087, found its OWN previous module graph's listener, and warned about a nonexistent standalone server while `warm_knowledge_graph` opened a SECOND lbug `Database` on the same store (a corruption vector). Moves the lbug store singleton and the in-process KG server onto `globalThis` `Symbol.for` slots (the SIO-1113/SIO-1468 idiom) so an in-place restart reuses them, and replaces the raw-TCP "standalone" guess with an identity-aware pre-flight (`GET /identity` -> self / same-store other process / different store / non-KG / unidentifiable) that only registers kg_* tools when safe. Seventh consecutive CODE-class data point for the Greptile skip.

**Greptile:** terminal **SKIPPED** on head `14d5b73e` (MCP `list_code_reviews` id 22772055, `changedFiles` = all 12, `completedAt` ~140 ms after `createdAt`, `strictness: 2`, body null). No status check, no comment, no review object. Consulted the MCP at merge time (no re-trigger; #687 this same session proved a re-trigger skips identically).

**CodeRabbit:** nothing, through CI completion. Consistent with the run since #679.

**Merge gate:** CI green on the head (Typecheck, Lint, YAML check, Test all COMPLETED/SUCCESS), `MERGEABLE`/`CLEAN`, Greptile SKIPPED on the head SHA via MCP, zero findings to triage. Code-class skip; the session reported the unsatisfiable gate and merged on the user's "merge all" per-PR authorization. Squash `18a81a7d`.

**Takeaways:**

1. *Seventh code-class skip, same signature.* Same SIO-1642 dashboard/billing cause, still unresolved.
2. *The warning this PR fixes is the one that opened this whole session* -- the user's "false positive" instinct was right: the raw-TCP probe cannot tell its own reloaded self from a foreign standalone server, and the fix is the existing globalThis-slot idiom the codebase already uses for the health poll and the scheduler. No reviewer surfaced it; live diagnosis (curl `/identity` on 9087 returning the vite PID) did.
3. *Self-verified.* New unit tests for the store slot and the identity classifier, typecheck clean across all packages, and the identity-card evidence that the 9087 listener was the process's own previous module graph.

## PR #687 detail (SIO-1646, agent-memory degraded mode: backend-unavailable class, memoized ensure, bounded requeue, SESSION_NOT_FOUND teardown, read-site amendment)

A code PR: 10 files, spanning shared and agent plus three docs. It hardens the agent-memory client against a write-only backend outage observed live (service `GET /health` 200 while `GET /health/couchbase` 503 and every KV mutation returned `ec=1004 couchbase.network`): a `BackendUnavailableError` class (matched narrowly on `DATABASE_UNAVAILABLE`/`category=couchbase.network`), memoized `ensureUser`/`ensureSession`, a process-wide cooldown that costs one warn per window, requeue of only the unsent tail (also fixing a pre-existing mid-batch-503 double-write), a 200-write cap, a typed `SESSION_NOT_FOUND` teardown no-op, and a startup `/health/couchbase` probe. A second commit (`a7857aba`) amended the cooldown to gate only the WRITE sites, because the outage was write-only and reads kept working: gating recall/search/fleet-recall would have discarded functioning recall. Sixth consecutive CODE-class data point for the Greptile skip.

**Greptile:** three terminal **SKIPPED** reviews across two heads (MCP `list_code_reviews` ids 22772781 on head `8469a334`, 22777010 and 22779066 on head `a7857aba`; `changedFiles` = all 10, `completedAt` ~100-190 ms after `createdAt`, `strictness: 2`, body null). The MCP re-trigger on `a7857aba` (id 22779066) skipped identically, confirming the skip is not head-specific. No status check, no comment, no review object.

**CodeRabbit:** nothing, through CI completion on both heads. Eighth consecutive absence (#679 to #687).

**Merge gate:** CI green on the head (Typecheck, Lint, YAML check, Test all COMPLETED/SUCCESS), `MERGEABLE`/`CLEAN`, Greptile SKIPPED on the head SHA via MCP (verified before merge), zero findings to triage. Code-class skip: the session reported the unsatisfiable gate, re-triggered once to confirm, and did not merge on its own. The user then explicitly instructed the merge. Squash `604ba400`.

**Takeaways:**

1. *Sixth code-class skip, same ~100-190 ms signature, and a re-trigger this round proved it is per-review not per-head.* The SIO-1642 dashboard/billing cause is still the only lead and still unresolved.
2. *The change that mattered most had no reviewer to catch it.* The read-site amendment corrects a design error (gating reads during a write-only outage) that only surfaced from reading the live service's own logs after a user challenge; the evidence was a raw-SDK probe from inside the service container showing reads and body-less deletes succeeding while every mutation failed. A reviewer bot would likely not have reached that evidence; the human challenge did.
3. *Self-verified again.* 53+4 tests green in the agent package, typecheck clean across all packages, Biome clean on the changed files, and a live end-to-end write round-trip (create session + add fact + end) confirming the modelled failure and its recovery. Record it, do not normalise it.

## PR #688 detail (SIO-1647, gitlab-import auth backoff keyed on the token value; document the restart after a token rotation)

A code PR: 3 files (gitlab-import source + test, one doc). It stops the `bootstrapIac gitlab-import failed; GitLab repository/commits: 401 Unauthorized` warn from repeating on every new thread's first turn plus hourly on the cron. Root cause of the 401 was a rotated PAT the web process never picked up: Vite restarts on the `.env` change but its `loadEnv` gives existing `process.env` keys precedence over the re-parsed file (and `vite.config.ts` does `Object.assign(process.env, loadEnv(...))`), so the restarted server kept the stale token. The fix adds a per-process auth backoff (15 min) keyed on a hash of the token value, so a genuine rotation clears the backoff immediately while an unchanged bad token warns once per window, and documents that rotating `ELASTIC_IAC_GITLAB_TOKEN` needs a web dev-server restart. Eighth consecutive CODE-class data point for the Greptile skip.

**Greptile:** terminal **SKIPPED** on head `ff5b1020` (MCP `list_code_reviews` id 22772934, `changedFiles` = all 3, `completedAt` ~130 ms after `createdAt`, `strictness: 2`, body null). No status check, no comment, no review object.

**CodeRabbit:** nothing, through CI completion. Ninth consecutive absence (#679 to #688).

**Merge gate:** CI green on the head (Typecheck, Lint, YAML check, Test all COMPLETED/SUCCESS), `MERGEABLE`/`CLEAN`, Greptile SKIPPED on the head SHA via MCP, zero findings to triage. Code-class skip; merged on the user's "merge all" per-PR authorization. Squash `fc15dfc1`.

**Takeaways:**

1. *Eighth code-class skip, smallest diff of the run (3 files) and same signature.* Diff size is irrelevant to the skip; the SIO-1642 cause is unchanged.
2. *The 401 was a config-propagation trap, not a code bug* -- the same rotated token worked for the separately-restarted elastic-iac MCP (bun `--env-file`) while the Vite web process kept the stale value. The backoff makes an invalid token cost one warn per 15 min instead of per trigger; the real remedy (restart after rotation) is now documented at the point it bites.
3. *Self-verified.* Unit tests for the backoff helper (expired window, changed-token clear, 401 vs 500 handling) and live confirmation that both the rotated `ELASTIC_IAC_GITLAB_TOKEN` and `GITLAB_PERSONAL_ACCESS_TOKEN` reach GitLab (commits + pipelines 200) so the 401 was purely the stale in-process value.

## PR #690 detail (SIO-1654, pi-coms moved into packages/pi-coms by git subtree)

A code PR of about 120 files: the `git subtree add --squash` import of the pi-coms repository (hub, Pi extension, monitor, Terraform, deploy scripts) plus the workspace wiring (package rename, scripts that run the nested monitor install first, root Biome exclusions), the hub wire types moved into `packages/pi-coms/contracts/`, the fleet bundle staged from the subtree with a standalone lockfile and a `--stage-only` dry run, an AWS SDK major-version parity test, a root `justfile`, a CI deploy-checks job, and the sanitizing of an account id default, internal hostnames and personal paths on import. Two CI rounds failed on the pi-coms package only: the imported nested lockfile was Bun lockfile v2 (regenerated as v1), then one hub SSE integration test failed deterministically on Bun 1.3.14 and passed on 1.4.x, so the CI pin moved to 1.4.2 (the standalone pi-coms CI ran 1.4.0; dev machines and fleet hosts run 1.4).

**Greptile:** no review record at all. MCP `list_code_reviews` answered "Merge request not found" for the whole life of the PR across four heads (`e48449f6`, `6de5d2aa`, `af777352`, `ec25457d`), no status check, no comment. This differs from the terminal SKIPPED signature of #680 to #689 and #691: the PR was never registered. Working hypothesis: a file-count or diff-size cutoff before registration; noted on SIO-1642.

**CodeRabbit:** nothing, through CI completion on every head. Eleventh consecutive absence (#679 to #690).

**Merge gate:** CI green on the final head (Typecheck, Lint, YAML check, Test, pi-coms deploy checks), `MERGEABLE`/`CLEAN`, no review record to triage. Code-class; merged on the user's "merge all" authorization. Squash `7847dfbf`. Linear moved SIO-1654 to Done through the PR link.

**Takeaways:**

1. *A large import can fall below Greptile's radar entirely*, which is worse than a skip: nothing to poll, nothing to re-trigger. The MCP call at PR-open time is the only way to tell the two apart.
2. *Both CI failures were toolchain, not code:* lockfile format and Bun stream semantics. A subtree import brings the source repository's toolchain assumptions with it; check the Bun pin and lockfile versions before the first push.
3. *Self-verified:* full monorepo suites on 1.4.2, a two-hub isolation smoke on the real hub, `--stage-only` staging test, secret sweep on added lines.

## PR #691 detail (SIO-1635 Phase 0, per-environment pi-coms hubs, hub client mailbox and sender prefix, explicit Agent Memory identity map)

A code PR: 17 files (shared config schema and barrel, hub client, verifier, memory backend, their tests, `.env.example`, three docs). It replaces the two-agent ternaries in `memory-backend.ts` with an explicit identity map that throws for unregistered agents, introduces `PiComsConfigSchema.hubs` keyed by environment with `PI_COMS_HUBS` (single-hub variables map to `PI_COMS_NET_ENVIRONMENT`), scopes the hub client to one hub with a sender prefix, public heartbeat and `mailbox()`, and routes by estate suffix before any online check so a prd estate never reaches the dev hub. Stacked on #682 until that merged, then rebased onto main and retargeted.

**Greptile:** terminal **SKIPPED** on both heads (id 22787137 on `e86f60fc`; ids 22787589 and 22787590 on `81a2d0f4`, two records for one push, 115-130 ms each, `strictness: 2`, body null). No status check, no comment, no review object. Registered normally, unlike #690.

**CodeRabbit:** nothing, through CI completion on both heads. Twelfth consecutive absence (#679 to #691).

**Merge gate:** CI green on the final head (Typecheck, Lint, YAML check, Test, pi-coms deploy checks), `MERGEABLE`/`CLEAN`, Greptile SKIPPED on the head SHA via MCP, zero findings to triage. Code-class; merged on the user's "merge all" authorization. Squash `4caddf23`.

**Takeaways:**

1. *A push can produce two SKIPPED records for one head* (retarget plus force-push landed within the same second); the count is per event, not per head, consistent with the #687 per-review observation.
2. *Coverage came from the session:* fetch-boundary unit tests asserting the absolute hub URL per estate, a two-hub smoke on the real hub code with log assertions, and the full monorepo suites on Bun 1.4.2.
3. *The identity map surfaced a latent bug* the reviewers would have been well placed to catch: the write-behind queue resolved a role from an already-resolved user id, correct only because both agents' user ids equal their names.

## PR #692 detail (SIO-1649 pi-fleet Phase 1, personas as gitagent definitions, Pi package exporter, semver version gate, persona in the fleet bundle)

A code PR of 44 files across agents/, the gitagent bridge, pi-coms and CI: two new agent definitions (`agents/pi-fleet/` console and `agents/pi-fleet/agents/aws-spoke/` spoke with a `verify-incident-report` skill), semver validation of `agent.yaml` `version` in `loadAgent`, the shared context split into portable and analyzer-runtime halves, an allowlist-only Pi package exporter with a CLI, the fleet bundle carrying `vendor/pi-fleet/` and the bootstrap installing it (context file, global skills, `persona=pi-fleet-vX.Y.Z` in the register purpose), a generated console `AGENTS.md` pinned by a bridge test, and `agent-release.yml` on `pi-fleet-v*` tags. Also the approved `@devops-agent/pi-coms` workspace dependency in `packages/agent` so the hub client imports the wire contract.

**Greptile:** terminal **SKIPPED** on the first head (id 22789330 on `eb48e100`, about 100 ms, `strictness: 2`, body null); registered normally at 44 changed files, so the #690 non-registration was not a plain file-count cutoff at that size. No status check, no comment, no review object.

**CodeRabbit:** nothing, through CI completion on both heads. Thirteenth consecutive absence (#679 to #692).

**Merge gate:** CI green on the final head `cb7a638c` (Typecheck, Lint, YAML check, Test, pi-coms deploy checks), `MERGEABLE`/`CLEAN`, Greptile SKIPPED via MCP, zero findings to triage. Code-class; merged on the user's explicit instruction. Squash `fc5d96cb`. Linear moved SIO-1649 to Done through the PR link.

**Takeaways:**

1. *Coverage came from the session:* 442 bridge tests including a fixture tree that proves memory, hooks, compliance, workflows and the MCP table never reach the package, learned-skill and account-id refusals, section-order equality with the runtime prompt, and a byte-for-byte pin of the generated console file; the staging test runs the exporter end to end inside `publish-fleet.sh`.
2. *A reviewer would have been useful on the persona text itself* (two long markdown personas distilled from three sources); no automated gate reads prose for contradictions, so that review is now the user's.
3. *Greptile registers a 44-file PR and skips it in the usual 100 ms*, which narrows the #690 anomaly to something other than size alone (SIO-1642).

## PR #693 detail (SIO-1653 pi-fleet Phase 1b, manifest-driven fleet deploy)

A code PR of 56 files under `packages/pi-coms` plus docs: the gitignored `deploy/fleet.yaml` manifest with a committed nine-account example, the `just fleet` CLI (`scripts/fleet.ts` and `scripts/fleet/` modules behind an injectable AWS layer), the agent module's `readonly_role_mode` adopt path (import block, trust merged by Sid, only the managed `pi-coms-extensions` policy attached), nine generated Terraform roots whose committed files carry no identifiers, and an S3 state backend per environment hub account addressed from a gitignored `backend.hcl`. Nothing applied to AWS.

**Greptile:** terminal **SKIPPED** (id 22790642 on `26bc96fd`), about 2.5 s from creation to completion rather than the usual 100 ms, `strictness: 2`, body null. No status check, no comment, no review object.

**CodeRabbit:** nothing, through CI completion. Fourteenth consecutive absence (#679 to #693).

**Merge gate:** first CI run: Lint, Typecheck, YAML check and pi-coms deploy checks green, Test job died with a Bun 1.4.2 `SIGSEGV` panic inside the `@devops-agent/agent` test process (a package the PR does not touch; every other package exited 0; the same suite passed on #692 minutes earlier). `gh run rerun --failed` passed. Final state `MERGEABLE`/`CLEAN`, Greptile SKIPPED via MCP, zero findings to triage. Code-class; merged on the user's explicit instruction. Squash `41523088`. Linear moved SIO-1653 to Done through the PR link.

**Takeaways:**

1. *A native Bun crash in an untouched package is not a signal about the PR;* the per-package exit lines in the log locate it in seconds, and a re-run settles it. Worth a ticket if it recurs on Bun 1.4.2 in CI.
2. *Coverage came from the session:* 26 tests over manifest validation, the renderer's "no identifier in a committed file" pin, a preflight decision table with a fake AWS layer, token minting and rotation, hub expectations and rollout commands; `terraform validate` on an adopt root, the prd hub root and a dev root.
3. *A review would have been most valuable on the adopt-mode trust merge and the S3 backend split;* both are the kind of IAM and state edge a reviewer with Terraform context catches and no test here exercises against AWS.

## PR #694 detail (SIO-1650 pi-fleet Phase 2a, thin hub pane next to the incident chat)

A code PR of 23 files: the pi-coms hub client, its config resolver and the estate router exported from the `@devops-agent/agent` barrel; a web server module that lists spokes per environment hub, sends one operator prompt to one spoke on that hub and waits one 25 s await slice per request; three `/api/pi` routes; a pure reducer, a runes store and the `PiFleetPane` component mounted as a second split-row pane; four `PI_COMS_PANE_*` variables; the feature doc and the pi-coms principal section. Replies are rendered as data and never reach an LLM.

**Greptile:** terminal **SKIPPED** twice (ids 22792816 on `1ec8c6f2` and 22792832 on `c133872a`), about 150 ms each, `strictness: 2`, body null. No status check, no comment, no review object.

**CodeRabbit:** nothing, through CI completion. Fifteenth consecutive absence (#679 to #694).

**Merge gate:** first CI run: Lint, Typecheck, YAML check and pi-coms deploy checks green, the web suite itself green (359 pass) inside the Test job, then the job died with a Bun 1.4.2 `SIGSEGV` panic in the `@devops-agent/agent` test process, exactly as on #693 (the PR touches only that package's barrel exports; every other package exited 0). `gh run rerun --failed` passed. Final state `CLEAN`, Greptile SKIPPED via MCP, zero findings to triage. Code-class; merged on the user's explicit instruction. Squash `62c8a59d`.

**Takeaways:**

1. *Second `SIGSEGV` in the `@devops-agent/agent` suite on Bun 1.4.2 CI in two consecutive PRs;* both cleared on re-run. That is now a pattern worth a ticket rather than a footnote: the suite runs without `--isolate` in CI (`bun test` via the package script) while the session runs it with `--isolate`.
2. *Coverage came from the session:* 35 tests, the server module against a scripted fetch with the real client (per-hub tokens, hub isolation, register/send/await/deregister order, one-slice `budget_exhausted`, the environment refusal), route validation and envelopes, reducer transitions and the pane's SSR shape. The Svelte MCP autofixer ran clean.
3. *A review would have been most valuable on two runtime seams no test reaches:* the prop named `state` that silently broke the `$state` rune until the SSR probe caught it (svelte-check passes), and the long-poll shape under the SvelteKit adapter. The first is recorded in memory; the second is the design's whole point and still needs the manual run against a hub.

## PR #695 detail (SIO-1652 pi-fleet Phase 2b, fetchFleetInbox enrichment node)

A code PR of 36 files: pure helpers and a deterministic graph node that read each assessed AWS estate's pi-coms inbox and its hub's `ops` inbox for the incident window into a typed `fleetInboxDigest` (registered always, reached from `align` only when `PI_COMS_INBOX_ENABLED` is true, placed BEFORE `aggregate` through a wrapper around the alignment router so the structured summary reaches this turn's prompt), the shared schemas and `fleet_inbox` SSE event, the web reducer and store plumbing and a `FleetInboxCard`, three `PI_COMS_INBOX_*` variables, node count 31 to 32 across the docs, and the feature doc.

**Greptile:** terminal **SKIPPED** twice (ids 22794995 on `73d75d0b` and 22795006 on `f0cc59bc`), about 130 ms each, `strictness: 2`, body null. No status check, no comment, no review object.

**CodeRabbit:** nothing, through CI completion. Sixteenth consecutive absence (#679 to #695).

**Merge gate:** all five CI jobs green on the first run (no `@devops-agent/agent` segfault this time, after two in a row on #693 and #694). Final state `CLEAN`, Greptile SKIPPED via MCP, zero findings to triage. Code-class; merged on the user's explicit instruction. Squash `cb2fcdca`.

**Takeaways:**

1. *The one design question a reviewer would have had to raise was caught by the pre-plan survey instead:* the ticket placed the node after `aggregate` while requiring its output in the aggregator prompt, which `aggregate` builds. The plan moved it before `aggregate`; the deviation is recorded on the issue, in the plan and in the feature doc.
2. *Coverage came from the session:* 13 helper tests (report parser, classification, window and attribution filters, a prompt summary asserted free of a body marker), 5 node tests against a scripted hub (two hubs, isolation, timeout, environment refusal, self-sender exclusion), 2 byte-identity assembly tests, and web pump, reducer and SSR card tests.
3. *Where a reviewer would still earn their keep:* the `ops` attribution rule (account id from `AWS_ESTATES` role ARNs or agent and monitor sender names) is a convention, not a contract, and the report parser is keyed on today's `formatIncidentReport`; both are exactly the kind of drift a reviewer with pi-coms context would flag.

## PR #696 detail (SIO-1651 pi-fleet Phase 3, pi-handoff workflow and verdict memory)

A code PR of 17 files: the first production wiring of the skillflow executor's `graph` and `agent` step handlers (both threw `MissingHandlerError` everywhere until now), `pi-handoff.yaml` chaining `analyze` (graph) to `verify` (`agent: aws-spoke`), a detached post-turn trigger beside the incident-close chain gated by `PI_HANDOFF_ENABLED`, `runHubTask` exported so the workflow and the SIO-1635 card share one hub path, and a structured-only verdict writer both paths call.

**Greptile:** terminal **SKIPPED** twice (ids 22796918 on `cdfc0f78` and 22797058 on `27db4978`), about 150 ms each, `strictness: 2`, body null. No status check, no comment, no review object. Seventh consecutive code PR with no usable review.

**CodeRabbit:** nothing, through CI completion. Seventeenth consecutive absence (#679 to #696).

**Merge gate:** Lint FAILED on the first run and passed on the second; the other four jobs were green throughout. Final state `CLEAN`, Greptile SKIPPED via MCP, zero findings to triage. Code-class; merged on the user's explicit instruction. Squash `cee8c2ad`.

**Takeaways:**

1. *The bots caught nothing because they never ran; CI caught the one real defect that escaped the session's own checks.* A Biome `organizeImports` assist finding on the new export block in the agent barrel slipped through because the session's local "are my files clean" filter was a grep over path fragments that did not match `packages/agent/src/index.ts`. The fix was mechanical, but the lesson is about the check, not the code: verifying "my files are clean" by pattern-matching a global lint dump is weaker than linting the changed-file list directly (`git diff --name-only origin/main`), which is what the follow-up used.
2. *A baseline diff turned an ambiguous red into a decision.* Lint also reports 14 pre-existing findings on `main`. Rather than assert they were pre-existing, the session linted `origin/main` in a throwaway worktree and diffed the two sorted lists: identical after the fix. That converted "probably not mine" into evidence, and is cheap enough to be the default when inheriting a red-lint repo.
3. *The handover's two flagged risks were both retired by reading the code, and a third design point was overturned.* `graph: true` was the correct schema literal, and the workflow needs no `pi-fleet` principal because `senderPrefix` already defaults to the analyzer's own. More consequentially, the handover specified a `graph` handler that re-invokes the pipeline; `classify` already snapshots the report into `closingReport` precisely so closing an incident never re-runs a multi-minute fan-out, so the handler reads the completed turn instead. A reviewer with pipeline context would have been well placed to catch that, and no reviewer ran.
4. *Where a reviewer would still earn their keep:* the trigger takes only the first assessed estate, and the `readCompletedReport` dependency closes over a report captured before pruning rather than re-reading state. Both are deliberate and documented, and both are the kind of single-call-site assumption that rots quietly when the surrounding code changes.

## PR #697 detail (SIO-1655 Phase 2c PR 1, graphFor registry)

A pure refactor of 8 files, deliberately carrying no new behaviour: a `graphFor(agentName)` registry plus a runtime-free `agent-ids.ts`, replacing four of six graph ternaries, both `!== "incident-analyzer"` early returns, the stream route's hardcoded Zod enum, the topology route's two-name guard, and the binary UI toggle. Two ternaries were deliberately left (they select a different code path over a different state shape, not just a different graph object).

**Greptile:** terminal **SKIPPED** (id 22799662 on `aa1e4e29`), about 146 ms, `strictness: 2`, body null. No status check, no comment, no review object.

**CodeRabbit:** nothing, through CI completion. Eighteenth consecutive absence (#679 to #697).

**Merge gate:** all five CI jobs green on the first run. Zero findings to triage. Code-class; merged on the user's explicit instruction. Squash `756716e2`.

**Takeaways:**

1. *The changed-file lint discipline from #696 paid off immediately:* linting `git diff --name-only origin/main` locally caught two `organizeImports` findings that would otherwise have failed CI exactly as #696's did. The habit converted a repeat CI failure into a local fix.
2. *A refactor's real gate is "no test changed":* the suite went 368 to 374 with every pre-existing test untouched, which is stronger evidence of behaviour preservation than any assertion in the PR body. One new test pins that cycling the agent list reproduces the old binary toggle exactly.
3. *Not everything that looks binary is:* `schedules.ts` was listed in the issue as a two-agent site; on inspection its `elastic-iac` reference is a workflow directory path. Reading before refactoring kept an unrelated file out of the diff.

## PR #698 detail (SIO-1655 Phase 2c PR 2, fleet console graph)

23 files: the `agents/pi-fleet-console/` in-process persona (deliberately separate from the export-only `agents/pi-fleet/`), a `createReactAgent` graph with a teardown node, five hub tools, the `wrapUntrusted` injection boundary, an Agent Memory identity, an `/api/agents` endpoint for the selectable list, and the feature doc. Gated by `PI_FLEET_GRAPH_ENABLED`, default off.

**Greptile:** terminal **SKIPPED** three times (ids 22800891 on `415d19d8`, 22801352 on `eeb43fa7`, 22801442 on `cb3cf570`), about 130 ms each, `strictness: 2`, body null.

**CodeRabbit:** nothing, through CI completion. Nineteenth consecutive absence (#679 to #698).

**Merge gate:** Typecheck and Lint both FAILED the first run and were green by the third; the other three jobs were green throughout. Zero findings to triage. Code-class; merged on the user's explicit instruction. Squash `9f125775`.

**Takeaways:**

1. *CI caught a design defect that no local check could have.* `AgentDescriptor.graph` was typed as a union of the two existing graphs, and a `CompiledStateGraph`'s type parameters include its own node-name literals -- so the third graph did not fit, and every agent added would have forced the union wider, in the very registry built to make adding agents cheap. The thunk is now structural. **The root `bun run typecheck` does not run `svelte-check`**, so `apps/web` must be typechecked separately (`cd apps/web && bun run typecheck`); that gap is why it reached CI at all, and it is the single most reusable fact from this PR.
2. *A misread failure log cost a round.* CI's Lint output listed the 14 pre-existing findings, and the session first read that as the baseline failing. It was not: those are WARNINGS and have never failed CI. The actual failure was three **format** errors in new files, which `biome check` reports separately from lint rules -- so the per-file "any `lint/` or `assist/` findings?" grep used while building sailed straight past them. The corrected habit is to read the `Found N errors` line, not the finding list.
3. *This is the first path where a hub reply reaches a model,* a deliberate, documented departure from the PR #682 invariant, confined to `wrapUntrusted`. That function and its tests (a reply carrying "ignore previous instructions" stays bounded inside the wrapper; an agent card's `purpose` never reaches the model at all) are what a reviewer with security context should look at hardest -- and no reviewer ran, for the seventh and eighth consecutive code PR.
4. *Where a reviewer would still earn their keep:* the wrapper is a prompt-level defence, not a parser-level one. It is the right shape for this threat, but its strength is untested against a live adversarial spoke, and the live run is still user-run.

## PR #699 detail (SIO-1655 follow-up, capability defaults and config placement)

15 files. Two user-directed changes: the three pi-coms capability gates (`PI_HANDOFF_ENABLED`, `PI_COMS_INBOX_ENABLED`, `PI_FLEET_GRAPH_ENABLED`) flip from opt-in to kill-switch semantics, and their declaration moves from ad-hoc `process.env` reads at each call site into `PiComsCapabilitiesSchema` alongside the connection settings they govern, with defaults applied in `resolvePiComsConfig` (no `.default()` in the schema, per the project rule).

**Greptile:** terminal **SKIPPED** (id 22803524 on `fc36b4c6`), about 165 ms, `strictness: 2`, body null.

**CodeRabbit:** nothing, through CI completion. Twentieth consecutive absence (#679 to #699).

**Merge gate:** all five CI jobs green on the first run. Zero findings to triage. Code-class; merged on the user's explicit instruction. Squash `74b795bc`.

**Takeaways:**

1. *A default flip is a behaviour change, and the test suite said so.* Three tests failed, each for a different real reason: the inbox node's no-op test expressed "disabled" as an empty string (now ON under the new rule), the shared schema test lacked the newly required field, and the web barrel mock lacked an export the registry had started importing. None was a test rewritten to fit the change; the first in particular was the suite correctly reporting that a node which used to no-op now runs.
2. *"On by default" and "available by default" are different questions.* The capability defaults on, but the fleet console is still offered only where a pi-coms hub is configured, because without one its graph cannot build and the selector entry would be a dead end. Separating the two kept a deployment with no `PI_COMS_HUBS` completely unaffected by the flip -- worth checking with the user rather than assuming, which is what happened here.
3. *Kill-switch semantics change the failure direction of a typo.* Under opt-in, `PI_FLEET_GRAPH_ENABLED=ture` silently leaves a shipped feature off; under kill-switch it reads as on. For a capability gate that is the safer direction, and a test now pins it (`"no"`, `"FALSE"`, `""` all read as enabled).
4. *Scope check on the user's framing:* the "4-pillar config setup" (`defaults.ts`/`envMapping.ts`/`schemas.ts`/`loader.ts`) is specifically the MCP servers' structure; `packages/agent` has no such directory, and its established equivalent is a shared Zod schema plus a resolver applying defaults. Following the pattern actually in use beat inventing a config directory in a package that has none -- and the difference was surfaced to the user rather than silently decided.

## PR #700 detail (gitlab-mcp proxy schema conversion, found by a live regression check)

Two files. `jsonSchemaTypeToZod` handled string/number/integer/boolean and sent everything else to `z.unknown()`, so every ARRAY parameter on every proxied GitLab tool was schema-less. The converter now recurses on `items` and honours a string `enum` at either level.

**Greptile:** terminal **SKIPPED** (id 22806530 on `b1183a03`), about 130 ms, `strictness: 2`, body null.

**CodeRabbit:** nothing, through CI completion. Twenty-first consecutive absence (#679 to #700).

**Merge gate:** all five CI jobs green on the first run. Zero findings to triage. Code-class; merged on the user's explicit instruction. Squash `f7b12fd2`.

**Takeaways:**

1. *The bug was found by a post-change regression check, not by a reviewer or a test.* The user ran a real incident query after the pi-fleet work and pasted the log; `gitlab_get_merge_request` failed with "Validation error: include is invalid" while the turn as a whole succeeded. A recovered sub-agent error is exactly the kind of finding that survives indefinitely because nothing fails loudly -- worth reading tool-error arrays in run logs even when the run is green.
2. *A permissive local schema is worse than no schema.* `z.unknown()` meant the model's guess was accepted here and rejected at GitLab, so the model received a tool error it could not learn from rather than a schema violation it could correct. The fix pushes the contract back to where the model can see it.
3. *The upstream sources disagreed, and the difference mattered.* The REST API has no `include` parameter at all (only `include_*` booleans); only the MCP tool declares `include`, as an array of enum facets. Reading only the REST docs would have produced a confident wrong fix. The live `/api/v4/mcp` `tools/list` could not be read to confirm first-hand -- the configured PAT is project-scoped and the endpoint answers 403 -- so the published tool documentation is the source, and that limitation is recorded in the PR body rather than glossed.
4. *The test was verified to catch the bug.* Removing the `array` case again made 3 of 6 fail; restoring it made 6 pass. Writing a test after a fix proves nothing until it has been seen to fail.
5. *One deliberate non-strictness:* an array with no `items` still accepts any element, because GitLab shipped array params that way before gitlab-org/gitlab!211286. Tightening that too would have traded a wasted call for a refused one.

## PR #701 detail (fleet CLI, nine fixes found by actually running the deploy)

14 files. Every fix was found by driving `just fleet deploy` against two live AWS accounts, not by reading code: preflight refusing correct manifests, five instances of an unscoped hub-registry read, a doubled resource name, a tunnel port collision, and a placeholder written into a live IAM policy.

**Greptile:** terminal **SKIPPED** (id 22839873 on `c53fb11f`), about 156 ms, `strictness: 2`, body null.

**CodeRabbit:** nothing, through CI completion. Twenty-second consecutive absence (#679 to #701).

**Merge gate:** all five CI jobs green on the first run. Zero findings to triage. Code-class; merged on the user's explicit instruction. Squash `707b1bd0`.

**Takeaways:**

1. *Every one of these needed a live run to find.* Types checked, tests passed, and the code read fine; the failures were an empty-list-not-an-error API contract, an IAM condition that matched nothing, and a systemd unit reporting failure for a registration that had succeeded. A reviewer reading this diff would have caught none of them. That is the strongest argument yet for the user-run live checks this ledger keeps deferring.
2. *One API shape produced five separate bugs.* `GET /v1/agents` answers an unknown project with an empty list, never an error, so every project mismatch failed silently and differently -- a readiness poll that never sees its own agent, a short-circuit that relaunches a running agent, a drain-wait that exits immediately, a rollout that waits out its deadline, and monitors that 404 on send. When an API cannot distinguish "no results" from "wrong namespace", expect the mismatch to surface everywhere except where you look first.
3. *Hand-patching a generated file is a latent outage.* `render` wrote an `org_id` placeholder expecting a human to fill it in; the session did that repeatedly, `deploy` re-rendered, and `apply` wrote the literal `<set: ...>` string into the dist bucket policy's `aws:PrincipalOrgID`. Cross-account reads 403'd while the hub account kept working, so it presented as one slow spoke rather than a permissions wall. Generated files need their inputs in the manifest, not in an operator's memory.
4. *The asymmetry is what hid it.* Self-reads worked, cross-account reads failed. Any check run from the hub account -- including most of the obvious ones -- looked healthy. Worth reaching for the cross-boundary probe early when one node in a fleet misbehaves and the others do not.
5. *Preflight was refusing correct manifests in both modes.* `adopt` rejected roles trusted by the account's own pi-agent; `create` required the role to be absent, which is never true for a fleet pi-coms deployed itself. The fix was to ask ownership (the `ManagedBy` + `Project` tags the module stamps) rather than existence -- and to keep requiring both tags, so a same-named role belonging to someone else still needs `adopt`.

## PR #702 detail (hub-tunnel selects an environment; the first merge with the gate knowingly overridden)

11 files. `just hub-tunnel` took a profile, so dev was the bare recipe and prd needed all four positionals; both now take an ENVIRONMENT, resolved against the same gitignored `deploy/fleet.yaml` that `just fleet` reads. Adds `just coms-env <env> <cname>` for a console against a deployed hub, and carries an unpushed prd Terraform render commit that had been sitting on the user's local main.

**Greptile:** three terminal **SKIPPED** reviews (ids 22864243 on `c9fdf792`, 22864377 and 22864464 on `e9e812e6`), 115-165 ms each, `strictness: 2`, body null. The third was an explicit `trigger_code_review` through the MCP: it skipped in 115 ms, the same as the automatic ones. No status check ever registered, so the documented merge gate never had a state to reach.

**CodeRabbit:** nothing, through CI completion. Twenty-third consecutive absence (#679 to #702). The PR carries zero issue comments and zero review objects from any account.

**Merge gate:** all five CI jobs green. Zero findings to triage, because no reviewer produced any. Merged on the user's explicit instruction after being told the gate could not be satisfied. Squash `5b6fcbae`.

**Takeaways:**

1. *This is the first entry where the merge gate was reported as unsatisfiable and overridden deliberately, rather than treated as satisfied.* The repo rule makes the `Greptile Review` status check the only gate; it does not register at all here, so "wait for it" has no terminal state to wait for. The honest description is an override, and recording it as such matters more than the row itself -- eight consecutive code PRs (#695 to #702) have now merged with no code review from either bot.
2. *An explicit re-trigger is no longer worth attempting.* #682 established that all three trigger paths skip identically; this PR re-confirmed it through the MCP at 115 ms. Future rounds should read `list_code_reviews` once and move on rather than spending a round trip re-triggering.
3. *Two review-substitute findings came from the human, not from CI.* The user caught the stale `just hub-tunnel eu-shared-services-prd eu-central-1 8787` invocation failing with `does not contain recipe 8787` (just parses a 3rd positional as another recipe, so the guard had to move to the root delegation), and then asked for a repo-wide sweep that turned up `tag:Name=pi-coms-hub-hub` in `usage.md` -- stale since SIO-1653 dropped the module's redundant suffix, and wrong in a doc whose whole purpose is finding the instance by hand. Neither is the kind of defect CI can see.
4. *A verification claim in this session was wrong in a way a reviewer would have caught.* The recipe change was first applied to the worktree copy while `just` from the repo root reads the main checkout's justfile -- a different file -- so an early "verified working" claim was made against code that was not the code being run. The worktree/main justfile split is worth treating as a standing hazard, not a one-off slip.
5. *The PR is deliberately broader than its title.* It carries `83381d0b`, the user's own unpushed prd Terraform render, because `publish-fleet.sh` refuses to build a bundle while those tracked files are uncommitted. It was surfaced in the PR body and the user chose to keep it rather than split it -- the alternative was leaving a commit stranded on a local main that the prd fleet already depends on.

## PR #703 detail (hub addressed by AWS account; a doc sweep catches a live regression)

8 files. Follow-up to #702: `prd` names an environment, not a hub, so it cannot address a second hub in another account's production. The selector is now the AWS account (profile or id). Also fixes a positional-argument trap and folds `coms-env` into `just coms`.

**Greptile:** terminal **SKIPPED** (id 22869623 on `88154b1d`), 108 ms, `strictness: 2`, body null. No re-trigger attempted -- #702 re-confirmed that an explicit MCP trigger skips identically.

**CodeRabbit:** nothing, through CI completion. Twenty-fourth consecutive absence (#679 to #703).

**Merge gate:** all five CI jobs green. Zero findings to triage. Ninth consecutive code PR merged with no review from either bot. Merged on the user's explicit instruction. Squash `1d42f3fe`.

**Takeaways:**

1. *The bug this PR fixes was a self-inflicted regression from the PR before it, and it presented as an auth failure.* `just hub-tunnel prd 8787` read `8787` as the LOCAL port, so a prd tunnel bound **8787 -- dev's port**; `just coms simon` then reached the prd hub with dev-shaped credentials and returned `HTTP 401 POST /v1/agents/register`. A wrong-hub bug wearing a credentials error. Worth checking which hub a tunnel actually points at before believing a 401.
2. *Sweeping the docs found a regression the tests could not.* `dev` is both a manifest hub key and a legitimate cname, so `just coms dev --model X` -- the example printed in README.md and usage.md -- stopped opening a local session and tried the dev hub. The fix (`--strict-selector`: profile or account id only for the console) came from reading the docs against the new behaviour, not from CI. Docs that contain runnable examples are a test surface.
3. *A truncated tool output nearly hid a lint failure.* `bunx biome check | tail -2` printed "Checked 1 file. No fixes applied." and cut off "Found 1 error" -- a formatter error that would have failed CI. Read the `Found N errors` line, never a trimmed tail.
4. *The design work was parked deliberately rather than done.* `hubs` is keyed `dev|stg|prd` across the fleet CLI and the analyzer, so a genuine rekey touches spoke-to-hub binding, CIDR isolation, `token_env`, and `PI_COMS_HUBS`. The user chose KISS -- profile selector now, replace it when a second hub appears -- and the rekey is written up in `docs/superpowers/specs/2026-09-07-multi-hub-addressing.md` so it need not be re-derived under pressure.
5. *One silent hazard is now documented but NOT fixed:* `environmentForEstate` (`pi-verifier.ts:104`) routes an estate to a hub by name suffix, so `eu-oit-prd` and `eu-shared-services-prd` both resolve to `prd`. Correct only while one prd hub exists; a second would be routed to the wrong hub with no error.

## PR #689 detail (pi-fleet gitagent feasibility report)

A docs-only PR: `docs/architecture/pi-fleet-gitagent-feasibility.md` (new) plus the docs index row and changelog entry in `docs/README.md`, later the fleet-inbox section and this ledger row. No code. Tenth consecutive PR logged SKIPPED (#680 to #689: three docs-only, seven code-class).

**Greptile:** seven pushes (four before the rebase onto main, three after), seven terminal **SKIPPED** reviews (MCP `list_code_reviews` ids 22779277, 22779340, 22779474, 22780001, 22781272, 22782108, 22782497 on heads `27289de8`, `c7804168`, `63b2cf14`, `98044af0`, `b29de45e`, `3da8d48b`, `d1d51502`), `changedFiles` = the docs files, `completedAt` 125-160 ms after `createdAt`, `strictness: 2`, body null. No status check, no comment, no review object. Consulted the MCP after each push; no re-trigger attempted, per the #682 finding that all three trigger paths skip identically.

**CodeRabbit:** nothing, through CI completion on every head. Tenth consecutive absence (#679 to #689).

**Merge gate:** CI green on the final head, `MERGEABLE`/`CLEAN`, Greptile SKIPPED on the head SHA via MCP, zero findings to triage. Docs-only, merged on the user's explicit instruction. Squash `6c935bb2`.

**Takeaways:**

1. *The skip signature is unchanged for a pure-markdown diff*, which keeps the SIO-1642 account-level cause as the only lead. Nothing in this PR could have exercised a reviewer anyway.
2. *A side effect worth recording for docs PRs that plan future work:* the first head's title named the three phase issues (SIO-1649, SIO-1650, SIO-1651); Linear's GitHub integration linked the PR to all three within a minute and moved them from Backlog to In Progress, and a merge would have closed them. The commit, title and body were amended to drop the identifiers, the attachments deleted, and the issues restored to Backlog. Planning documents must reference their issues only inside the document body, never in the PR title, branch name or commit subject.

## PR #704 detail (SIO-1656, elastic-iac MR change-class label)

DEFECT 2026-09-07-01: every config MR the elastic-iac agent opened carried only `[agent-generated, iac]`, so the target repo's `check-mr-labels` gate rejected it and the MR could not merge without a manual relabel plus a pipeline re-create. Five files: the new `mr-labels.ts` and its test, two call sites in `nodes.ts`, and two test files.

**Greptile:** terminal **SKIPPED** (id 22887397 on `53fa193f`), 125 ms, `strictness: 2`, body null. No status check, no comment, no review object. Twenty-fifth consecutive skip since #679.

**CodeRabbit:** nothing, through CI completion. Twenty-fifth consecutive absence (#679 to #704).

**Merge gate:** all five CI jobs green first run. Zero findings to triage. Merged on the user's explicit instruction with the documented gate knowingly overridden. Squash `466ad209`.

**Takeaways:**

1. *The most valuable finding in this cycle came from neither bot, but from a CI gate in a different repository.* Both reviewers have been silent for 25 PRs; the defect was caught because `check-mr-labels` failed on MR !630 and a human read the job log. Worth recording for the bake-off: the review bots are not currently the mechanism catching contract violations here.
2. *The defect report named one call site; there were two.* `openMr` (the reported maker lane) and the drift reconcile lane both sent the bare label pair, and they need DIFFERENT classes (`config-change` derived from the workflow vs a fixed `drift`), so widening the single `AGENT_MR_LABELS` constant would have fixed only half the bug. Grepping every `gitlab_create_merge_request` call site before implementing is what surfaced the second one.
3. *The recommended fix was not reachable and was declined with a reason.* The report's preferred option was to shell out to the target repo's `scripts/open-mr.sh`; this agent talks to GitLab only through an MCP tool, with no checkout and no shell, so adopting it would have meant granting repo-checkout plus shell execution. The alternative was taken and the report's objection to it ("the agent must own the mapping by hand") answered by deriving the mapping from `WORKFLOW_VALUES` as a `Record<IacWorkflow, ChangeClass>`, which fails to typecheck when a new workflow is added unclassified.
4. *The regression tests were proven non-vacuous before merge* by reintroducing the defect and confirming four tests fail, then restoring the fix and confirming they pass. Worth doing whenever a test asserts the absence of a specific wrong value.
5. *Acceptance is only partly satisfied.* Steps 2-4 of the report need a live MR against project 82850717: the version-upgrade flow against `gl-testing` must show `check-mr-labels` passing on the FIRST pipeline, then an ILM change and a fleet pin to prove the mapping rather than the default. Unit coverage asserts the payload, not the gate's verdict.

## PR #705 detail (SIO-1657, fleet console surface + triage graph scaling)

Two frontend items from the running app: the header control cycled the fleet console as if it were a peer mode, and the Elastic IaC triage graph was unreadable. Seven files, all `apps/web`.

**Greptile:** terminal **SKIPPED** (id 22887432 on `1aa34e73`), 115 ms, `strictness: 2`, body null. Twenty-sixth consecutive skip.

**CodeRabbit:** nothing, through CI completion. Twenty-sixth consecutive absence (#679 to #705).

**Merge gate:** all five CI jobs green first run. Zero findings to triage. Merged on the user's explicit instruction with the gate knowingly overridden. Squash `50a3f4b4`.

**Takeaways:**

1. *The handover's diagnosis of the second item was wrong, and measuring beat reading.* It recorded that Elastic IaC showed no triage panel at all and listed three possible meanings for "looks small". The panel does render -- it is agent-parameterized end to end -- and the real cause was a forced downscale: the IaC graph lays out 1644px wide against a ~575px pane, so it drew at 35% and its 10px node labels became 3.5px. Running the real `computeLayout` against both topologies produced that table in minutes and replaced a three-way guess with a number.
2. *A first estimate was wrong by 25% and was corrected before merge.* A synthetic model of the 10-way intent fan-out predicted 2040px; the real layered layout distributes it better, at 1644px. The defect and the fix were unchanged, but the code comment and the Linear issue were both corrected rather than left carrying a number that would mislead the next reader.
3. *Only one agent looked wrong for a structural reason worth knowing.* The incident pipeline's datasource fan-out is a `Send` from a single `queryDataSource` node, so it never widens a layout layer; the IaC router's ten conditional targets do. Layout width is set by the widest row, so a `Send`-based fan-out is free and a conditional-edge fan-out is not.
4. *The obvious fix would not have worked.* Widening the pane (`max-w-xl` to `max-w-3xl`) only takes the labels from 3.5px to 3.8px while costing the chat column width; the downscale itself had to go. Also, the first attempt reintroduced the bug by reaching for `max-w-full`, which caps the SVG at the container width exactly as `w-full` did.
5. *One half of the change could not be verified in-browser and was covered by tests instead.* This machine has no pi-coms hub, so `/api/agents` correctly omits the console and its entry button never renders; `graph-registry.test.ts` and `agent-surface.test.ts` cover the rules, and both were confirmed to fail when the console is made a mode again. The button itself still wants a look on a hub-configured machine.
6. *The fix trades overview for legibility, deliberately.* IaC now shows 34% of its graph at a time (the incident analyzer 85%, costing it 103px of overflow it did not have before). In a pane this narrow a wide graph can be legible or fully visible, not both.

## PR #706 detail (SIO-1657 follow-up, wrap wide layers instead of scrolling)

A same-day revert-and-refix of #705's second item. #705 made the triage graph legible by rendering it at natural size and letting the panel scroll horizontally; the user rejected that on sight of the running app and the change was redone. Three files.

**Greptile:** terminal **SKIPPED** (id 22889730 on `fe905875`), 103 ms, `strictness: 2`, body null. Twenty-seventh consecutive skip.

**CodeRabbit:** nothing, through CI completion. Twenty-seventh consecutive absence (#679 to #706).

**Merge gate:** all five CI jobs green first run. Zero findings to triage. Merged on the user's explicit instruction with the documented gate knowingly overridden. Squash `f2740e2b`.

**Takeaways:**

1. *The regression was shipped, reviewed by nobody, and caught by the user looking at the app.* #705 passed five CI jobs, carried tests that encoded the wrong behaviour as correct, and was merged on a skipped review. Neither bot has spoken in 27 PRs. For the bake-off this is the second consecutive entry where the only effective review was a human opening the product -- worth weighing against any argument that the CI suite substitutes for a reviewer.
2. *Measuring the right quantity still gave the wrong answer.* #705 measured label size in pixels, optimised it, and confirmed 100% scale in-browser -- all correct, and all beside the point. The panel is a whole-graph map, so "can you read a node" was never the success criterion; "can you see the shape of the run" was. The screenshot the user posted showed the flow running off both edges of a mostly-empty pane, which no pixel measurement in that session would have surfaced.
3. *The binding constraint was one row, not the graph.* Chart width is the widest row, and a single 8-node fan-out (the IaC intent router) set 1644px for a graph whose other 18 layers need at most 4 nodes. Wrapping layers wider than three caps the chart at 654px -- the incident analyzer's own width -- so both graphs fit the pane whole at the same scale and neither scrolls. Diagnosing "which row sets the width" would have found this in #705.
4. *The cheaper-looking fix was tried and rejected on numbers.* Narrowing `NODE_W` reaches only 5.7px even at an unrealistic 100px, and the IaC graph has 22-character node names. Recording it here so it is not re-proposed.
5. *A screenshot belongs in the verification of any layout change.* #705's evidence was a table of scale percentages; #706's is two screenshots plus `scrollWidth === clientWidth`. The first proves a number, the second proves the thing the user actually asked for.

## PR #707 detail (SIO-1658, HITL gate card collapses the triage pane)

A one-file layout fix, reported by the user from the running app: the live graph triage pane disappeared whenever a plan-review card came up. Third consecutive PR in this run whose defect was found by a human looking at the product.

**Greptile:** terminal **SKIPPED** (id 22899198 on `80397b71`), 144 ms, `strictness: 2`, body null. Twenty-eighth consecutive skip.

**CodeRabbit:** nothing, through CI completion. Twenty-eighth consecutive absence (#679 to #707).

**Merge gate:** all five CI jobs green first run. Zero findings to triage. Merged on the user's explicit instruction with the documented gate knowingly overridden. Squash `32bfc9e6`.

**Takeaways:**

1. *The reported symptom named the wrong component.* "We lose the triage when the card comes up" reads as a bug in the triage pane, and the pane's own gating (`showGraphPane`) was the obvious suspect -- it was untouched and correct. The defect was in the CARD's layout: the ten HITL gate blocks render as full-width siblings of the split row, and on an `h-screen` page with a `flex-1 min-h-0` row, an uncapped tall card squeezes the row to nothing. Reading the gating first and only then measuring saved a fix in the wrong file.
2. *Confirming the old behaviour was the bug is cheap and worth doing.* Removing the cap live in the browser put the pane at exactly 0px, which turned "the pane disappears" from a report into a reproduced measurement before any fix was judged.
3. *The first cap satisfied the letter of the request and not its point.* 60vh kept the pane "visible" at 205px -- a strip too thin to read a graph in. Measuring the trade-off across 60/50/45/40/35vh produced 45vh (405px card, 340px pane), where both halves are actually usable. "Visible" was the wrong success criterion, the same class of mistake as #705's "labels are legible".
4. *A cap has to be checked in the cases where it should do nothing.* Verified that with no gate the region is 0px and the pane keeps its full 745px, and that a short banner (topic-shift) renders at its natural 45px with no scrollbar. A cap that silently pads or scrolls small content would have been a new bug.
5. *The fix covers all ten gate cards*, not only the plan review that surfaced it -- reconcile, synthetics push, fleet upgrade, renovate trigger and the HIL-learning gates shared the defect. Worth noting that 45vh is tuned against a 900px-tall viewport; a much shorter window gives the card proportionally less room.

## PR #708 detail (SIO-1659, gate cards bounded to the chat column)

The second follow-up on the same panel in one session: #707 stopped a tall gate card collapsing the triage pane vertically, but the card still spanned the full page width and rendered underneath the pane. One file.

**Greptile:** terminal **SKIPPED** (id 22907031 on `d39c85be`), 92 ms, `strictness: 2`, body null. Twenty-ninth consecutive skip.

**CodeRabbit:** nothing, through CI completion. Twenty-ninth consecutive absence (#679 to #708).

**Merge gate:** the Test job failed on the first run with exit code 134 and passed unchanged on re-run; the other four were green first time. Zero findings to triage. Merged on the user's explicit instruction with the documented gate knowingly overridden. Squash `45f52d40`.

**Takeaways:**

1. *A green-then-abort CI failure needs reading, not re-running on reflex.* The Test job's own output ended `393 pass, 0 fail ... Exited with code 0`, and the job still failed -- exit 134 (SIGABRT) from `panic(main thread): abort() called` in `packages/agent`, the transient already recorded for #693 and #694. The re-run passed. The habit worth keeping is reading far enough up the log to see WHICH package aborted and whether any test actually failed, because the same red X would appear for a genuine failure.
2. *Fixing the measured symptom left the real one untouched.* #707 capped the gate region's height because the reported symptom was "the pane disappears". The card was still a full-width sibling of the split row, so it laid out across the whole 1440px viewport and passed beneath the 576px pane -- a height cap cannot fix a width problem. Two rounds on one panel because the first fix treated the axis that was easiest to measure.
3. *The structural fix beat the CSS fix on both axes.* Nesting the gate region inside the chat column bounds it horizontally AND removes its competition for vertical space, so the pane went from 340px under #707's cap to its full 745px. When a layout fix needs a magic number (45vh), that is often a hint the element is in the wrong container.
4. *svelte-check earned its place in the loop.* The restructure left one unbalanced `</div>`; `bun run typecheck` in `apps/web` named the exact line. The ROOT typecheck skips svelte-check, so a repo-level run would have reported success on markup that does not compile.
5. *Third consecutive PR whose defect came from the user looking at the running app.* Four of the five entries in this run (#705, #707, #708 plus #706) are the same story: green CI, a skipped review, and a regression visible in one screenshot.

## PR #709 detail (SIO-1660, instrument the pi-coms fleet path)

Observability work rather than a bug fix, prompted by the operator noticing there was almost no logging around the fleet flow after a `403 name_not_allowed` had to be diagnosed with curl against a live production hub. Two files.

**Greptile:** terminal **SKIPPED** (id 22917651 on `777216b6`), 128 ms, `strictness: 2`, body null. Thirtieth consecutive skip.

**CodeRabbit:** nothing, through CI completion. Thirtieth consecutive absence (#679 to #709).

**Merge gate:** all five CI jobs green first run. Zero findings to triage. Merged on the user's explicit instruction with the documented gate knowingly overridden. Squash `ec4fc01d`.

**Takeaways:**

1. *The absence of logging was itself the defect, and it was measurable.* 10 log calls across ~1,600 lines, zero on the entire web surface, and 8 of the 10 were warn/error on config or schema edges -- so nothing described normal operation. Counting call sites per file turned "we do not have much logging" into a scoped ticket in a few minutes.
2. *One seam carried almost all the value.* Every hub call funnels through the client's private `http()`, which already threw a fully-formed `PiComsHttpError(status, code, method, path)` and logged nothing. Instrumenting that single method covers the 403 / timeout / unreachable class; the lifecycle events on top are what make a flow readable end to end.
3. *Adding logging can create its own noise, and the fix belongs at the seam.* Heartbeats route through the same `http()` and fire once per await slice, so at info they would have emitted a line every 25 s and buried the calls that matter. They log at debug via a path check inside `http()`, not by skipping instrumentation.
4. *A redaction rule with no enforcement mechanism has to be enforced by construction.* `packages/observability/src/logger.ts` has no redact config, so every log call was written to carry identity and outcome only, then verified against REAL output by grepping the running server's log for the actual tokens from `.env`, the `Bearer` header and the probe's prompt text -- all absent. Reading the diff would not have proved that.
5. *The acceptance test was the original incident, replayed.* Re-triggering the 403 now produces three lines pairing the sender name with `name_not_allowed` on `POST /v1/agents/register` -- the whole diagnosis, no curl. Verifying observability work means reproducing the failure it was meant to explain, not just confirming the code compiles.

## PR #710 detail (SIO-1661, name the rejected sender when pi-coms registration fails)

The other half of the `403 name_not_allowed` investigation that produced #709. Where that
PR made the failure visible in the server log, this one makes it legible in the response
body the operator actually sees. Four files, two of them tests.

**Greptile:** terminal **SKIPPED** three times -- id 22919165 on `8541481e`, then 22919493
and 22919793 on `f2232685` after an explicit `trigger_code_review` via the MCP. 113-130 ms
each, `strictness: 2`, body null. Thirty-first consecutive skip, and the first entry where
a deliberate re-trigger was tried and skipped identically, which is further evidence the
cause is account-level rather than per-PR or per-commit.

**CodeRabbit:** nothing, through CI completion. Thirty-first consecutive absence (#679 to #710).

**Merge gate:** all five CI jobs green. Zero findings to triage. Held for the user's
explicit per-PR go-ahead rather than merged.

**Takeaways:**

1. *The information needed to diagnose the 403 was already on the wire and thrown away.*
   The hub answers `errorJson("name_not_allowed", 403, { name, principal })`, and the
   client's `http()` extracted only `.error`, dropping `details`. The fix is a pass-through,
   not new data. Worth checking what an upstream already sends before concluding a failure
   is inherently opaque.
2. *An error's most useful context often lives in a frame that does not see the failure.*
   `senderNameFor()` ran only after a successful register, so the one frame that knew the
   attempted name never saw the rejection. Two small rethrows -- the client adds the name,
   the pane adds the hub and prefix -- compose into a complete message without either layer
   knowing the whole story.
3. *Preserving an error's TYPE across a rethrow was the real hazard.* `piFleetErrorResponse`
   maps `PiComsHttpError` to 502 and everything else to 500, so wrapping in a plain `Error`
   would have silently changed the status. `withContext()` returns the same class, and the
   test asserts the resulting 502 rather than only the message text.
4. *A passing new test proves nothing until it has been made to fail.* The pane test was
   verified by deliberately breaking the implementation: it failed with
   `Expected to contain: "prd hub"`, and the surviving output confirmed the client layer had
   still contributed the sender name. That one run distinguished a real assertion from a
   vacuous one and also demonstrated the two layers compose.
5. *"Pre-existing failure" is a claim that needs proof, not assertion.* 15 `packages/agent`
   test failures and the `packages/pi-coms` typecheck errors were reproduced by stashing the
   change, re-running, and restoring -- identical counts. Both are artifacts of this worktree
   (missing vendored Pi deps); the same jobs are green in CI.
6. *A ticket's premise can be wrong even when its conclusion is right.* SIO-1660 states the
   shared logger has NO redaction. It does (`packages/shared/src/logger.ts:107`), and `token`
   IS redacted -- but `authToken` is absent from `SENSITIVE_KEYS` and paths only go two deep,
   so the pi-coms secret leaks at every level. Confirmed by running the logger, not by reading
   it. The operational advice held; the reason given for it did not.
7. *Concurrent work on the same files is a merge problem, not a race to be won.* SIO-1660
   merged mid-implementation, touching both files including `http()` and `sendFleetMessage`.
   The changes were complementary -- a log for whoever watches the server, an explanation for
   whoever watches the browser -- so the resolution kept both and re-ran the live render to
   confirm behaviour survived.

## PR #711 detail (SIO-1662, one fleet control with the console entry in the pane)

Reported by the operator from the running app: the header showed a robot icon that duplicated the mode switch beside it, when the fleet was already reachable through the spokes pane. Two files.

**Greptile:** terminal **SKIPPED** (id 22938351 on `546f340d`), 139 ms, `strictness: 2`, body null. Thirty-first consecutive skip.

**CodeRabbit:** nothing, through CI completion. Thirty-first consecutive absence (#679 to #711).

**Merge gate:** all five CI jobs green first run. Zero findings to triage. Merged on the user's explicit instruction with the documented gate knowingly overridden. Squash `d75895ca`.

**Takeaways:**

1. *Driving the browser corrected the report before any code changed.* The symptom read as "there is a mode between the two agents", which would have meant a broken rotation. Clicking the mode control five times gave analyzer -> IaC -> analyzer, never the console: the rotation was already correct and the real defect was a redundant BUTTON reaching the console outside the cycle. Fixing the rotation would have been work on something that was not broken.
2. *The first attempt at the fix stranded the feature.* Deleting the header button removed the console's only entry point -- it is excluded from the mode cycle by design and the pane did not link to it -- so the agent became unreachable. Caught by grepping for remaining entry points before committing, and resolved by asking rather than guessing which of two readings ("the pane replaces the console" vs "keep it, elsewhere") was intended.
3. *Gating a control is not the same as gating what it controls.* Restricting the pane TOGGLE to the incident analyzer left the pane itself rendering in the IaC agent with nothing to close it -- a worse state than before. The pane's own `{#if}` needed the same condition. Browser verification found this; reading the diff would not have.
4. *An inconsistency inherited from an earlier PR surfaced only when a user looked.* #705 established that the fleet belongs to the incident analyzer, applied it to the console agent, and missed the pane, which kept rendering everywhere for three more PRs. Worth noting for the bake-off: neither bot has commented in 31 PRs, so partial applications of a rule are currently caught by the operator or not at all.

## PRs #712 and #713 (SIO-1663, SIO-1664), recorded after the fact

Neither PR received a ledger entry at merge time; filled in here from the Greptile API and the GitHub comment endpoints so the counts stay continuous.

**Greptile:** #712 terminal **SKIPPED** (id 22962684 on `316325b3`, 130 ms), thirty-second consecutive skip. #713 terminal **SKIPPED** (id 22996271 on `324ff90d`, 155 ms), thirty-third.

**CodeRabbit:** nothing on either PR, issue comments or reviews. Thirty-second and thirty-third consecutive absences.

## PR #714 detail (SIO-1665, hide monitors from spoke lists, no triage graph for Fleet Console)

Reported by the operator from the running app against the prd hub: `monitor-*` registrations were listed as selectable spokes, the graph triage pane drew the two-node console graph beside the fleet pane, and a follow-up "summarise" to a spoke came back with the earlier answer. Seventeen files.

**Greptile:** terminal **SKIPPED** (id 23040106 on `65f8a5d5`), 444 ms, `strictness: 2`, body null. Thirty-fourth consecutive skip.

**CodeRabbit:** nothing, through CI completion. Thirty-fourth consecutive absence (#679 to #714).

**Merge gate:** all five CI jobs green first run. Zero findings to triage. Not merged in the authoring session; awaiting the user's explicit go-ahead.

**Takeaways:**

1. *One of three reported defects was not a defect.* The repeated summary is the spoke's own behaviour: one persistent Pi session, a fresh sender name per pane send, no `conversation_id`. The pane stores each card's prompt once and never rewrites it, which a reviewer reading the store would confirm in a minute; a bot that skips cannot confirm anything. Establishing this before planning kept the ticket to the two real changes.
2. *The hub record has no role field, so the filter is a name filter.* `explicit` covers monitors and the analyzer's own senders alike, and `purpose` is agent-authored prose the console already refuses to read. The `monitor-` prefix is hub-controlled and minted as a pair with the spoke, which is the argument for trusting it. This is the kind of design choice a reviewer would be expected to probe; neither bot saw the PR.
3. *The same gate-both-sides rule from #711 applied again.* The triage pane needed its toggle and its mount on one derived value, or switching to the console would have left an open pane with no control to close it. Having the rule written down in the page comment from #711 made it a copy, not a rediscovery.
4. *An environment fault masqueraded as a typecheck regression.* The worktree and the main checkout both lack the `node_modules/@devops-agent/pi-coms` link, so `bun run typecheck` fails on the contracts import before any change. A baseline check against the untouched import line proved it pre-existing; a symlink fixed it locally without `bun install`.
