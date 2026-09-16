# HANDOFF 2026-09-16 -- What remains of the validated backlog

| Field | Value |
| -- | -- |
| Date | 2026-09-16 |
| Type | Programme handover (successor to `HANDOFF-2026-09-16-backlog-triage-programme.md`) |
| Repo state | `main` @ `fb19bb57`, clean |
| Predecessor | `experiments/HANDOFF-2026-09-16-backlog-triage-programme.md` (the validated work order this session executed) |
| Scope | Everything from that work order that is NOT finished, plus what this session changed about it |

> **Read the predecessor first only if you need the original triage reasoning.** Everything
> actionable is restated here. Where the two disagree, THIS document is correct: several of the
> predecessor's findings were wrong and are corrected below.

---

## TL;DR

Five PRs merged (#795-#799). The predecessor's §3 work order is complete except for **one open
ticket, SIO-1240**, which is now correctly parked: it is waiting on production trace data that
only started being collected today. Two backlog items the predecessor ranked (SIO-1681,
SIO-1744) remain open but have been **re-scoped by first-hand findings** -- in both cases the
predecessor pointed at the wrong fix. Three items are decisions, not work.

Nothing is blocked. The only thing that cannot proceed today is SIO-1240 criteria 3/4/5, and
that is a wait-for-data state, not an obstacle.

---

## 1. What shipped this session

| PR | Ticket(s) | What landed |
| -- | -- | -- |
| #795 | SIO-1109 + SIO-1119 | Read-only gate on Couchbase KV upsert/delete (all four call sites, v1 + v2), shared `ToolErrorEnvelopeSchema` + validated test helper |
| #796 | SIO-1644 | Kafka + GitLab unscoped fallback, with the rule-engine guards that keep fallback rows out of correlation |
| #797 | SIO-1240 (criterion 1) | Rationale comment on `MAX_TOOLS_PER_AGENT` |
| #798 | SIO-1767 (new) | Truncation telemetry in `composeBoundTools` |
| #799 | SIO-1239 | aws-agent prompt tool names 62 -> 35 |

Closed: SIO-1109, SIO-1119, SIO-1644, SIO-1239, SIO-1767, plus the six verified-already-fixed
tickets from the predecessor's §2.

---

## 2. The one live ticket: SIO-1240

**Status: Todo. Criteria 1 and 2 resolved; 3, 4 and 5 open, all waiting on the same data.**

`MAX_TOOLS_PER_AGENT = 25` (`packages/agent/src/sub-agent.ts:1021`, with its rationale comment
running from `:974`) now carries a full justification. What remains is deciding whether 25 is the
right number.

### What unblocked it

SIO-1767 (PR #798) added the missing instrument. `composeBoundTools` now emits one line when --
and only when -- the budget actually cuts (`packages/agent/src/sub-agent.ts:1213`):

```
"tool budget truncated the bound set"
{ dataSourceId, max, minAction, requested, bound, droppedHead, droppedTail,
  droppedNames[], droppedNamesTruncated? }
```

Before this, nothing recorded that a tool was dropped. The `filtered` flag at the
`createReactAgent` log site could not substitute -- it is returned true from four paths
(`:1406`, `:1415`, `:1424`, `:1438`), only one of which is a cap slice.

### The next step, concretely

Let production traffic accumulate, then aggregate that log line by `dataSourceId`. Report: how
often truncation fires, the `requested` distribution, and which names recur in `droppedNames`.

**The likely outcome is worth stating, because it would close three criteria at once.** If
aws-agent is the only datasource that ever truncates -- plausible at a 62-tool head against a
17-name budget -- then the answer is "keep 25, the cap is fine, aws-agent's prompt was the
problem", and SIO-1239 already fixed that half. If several datasources truncate regularly, the
15/25/40/uncapped eval the ticket proposes is justified and the traces will say which values are
worth testing.

Do **not** synthesise the traffic. The whole point of the instrumentation is to stop sizing the
cap against guesses.

### Criterion 5: the folded-in residual

SIO-1239 closed at 35 prompt-named tools against a 17-name budget, so `KNOWN_OVERSUBSCRIBED`
(`packages/gitagent-bridge/src/skill-tool-coverage.test.ts:54`) still lists `"aws-agent": 35`.

Every one of those 35 sits in an ordered chain where the name IS the instruction. **Do not
resolve this by more prose trimming** -- that was run to its honest limit. Resolve it by raising
the cap with evidence, or by explicitly retaining the entry with the rationale recorded.

**Hazard for whoever changes the value:** `skill-tool-coverage.test.ts:21` hardcodes its own copy
of `MAX_TOOLS_PER_AGENT` with a "keep in sync" comment. Change one without the other and the
budget the test enforces silently desynchronises from the budget the code applies.

### Criterion 2 is closed, not skipped

`contextWindow` in `MODEL_REGISTRY` is **not feasible**, verified live: `ListFoundationModels` in
`eu-central-1` returns 12 Anthropic models whose complete field set contains no token, context,
window or limit field. The registry requires every field be probe-backed
(`model-registry.ts:10-12`); a context window can only come from vendor docs. It would also be a
dead field -- nothing in the repo reads a context budget.

If an input-size fact is ever wanted, `observedMaxInputTokens` (the `largeLongFormInputTokens`
figure the probe already collects, ~82,914 on the Sonnet 5 report) is free, honest as a floor,
and does not touch the invariant.

---

## 3. Open, and re-scoped by first-hand findings

Both of these are in Backlog with correction comments attached. **In both cases the predecessor
handover pointed at the wrong fix.** Read the correction before starting.

### 3.1 SIO-1681 -- a 403'ing spoke reports "online"

**The predecessor said the hub overwrites spoke-reported status. It does not.**
`packages/pi-coms/scripts/coms-net-server.ts:1153-1157` *honors* a valid spoke-reported status;
`"online"` is only the fallback for an absent or invalid value. Patching the hub would fix
nothing.

The actual defect is spoke-side, `packages/pi-coms/extensions/coms-net.ts:1176`, which hardcodes
the literal on every heartbeat:

```ts
model: ctxNow?.model?.id ?? identity.model,
status: "online",
```

Nothing computes that value, so a spoke whose model is 403ing reports healthy and the hub
faithfully records the lie.

**What the work actually is.** The spoke already recognises a failed run --
`extensions/turnReply.ts:39-55` (`turnFailure()`), whose comment at `:37` names this very
incident ("nine Bedrock 403s, nine empty replies, all marked complete within 200 ms"). But it is
per-message and keeps no counter, and the heartbeat path (`coms-net.ts:1167-1183`) never consults
it. So: count consecutive failures on the spoke, and report a real status instead of the literal.
`AgentStatus` (`contracts/wire.ts:7`) may not even need widening.

None of the 21 checks under `scripts/monitor/checks/` covers model failure on a spoke -- they are
all AWS-resource checks. Two different consecutive-cycle idioms exist to follow: `checks/targets.ts`
persists across cycles via `MonitorState`; `checks/ingestion.ts:14-16,22` reads a run out of an
already-fetched series and explicitly keeps "no extra API call and no state".

### 3.2 SIO-1744 -- monitor digest schedule

**The repo half of this ticket is done and it can probably be closed.** All 8 committed roots
carry `monitor_tz` and `monitor_daily_cron` -- verified by parsing every
`deploy/accounts/*/main.tf`. The ticket says 9 hosts; `eu-b2bonboarding-prd` is a governance
account with no agent host (`fleet.example.yaml:141-147`), so 8/8 is complete, not 8/9. The roots
caught up incidentally via SIO-1743/1741/1746 rather than a deliberate re-render.

What remains is **ops, not code**: `just fleet apply` per host, which replaces the instance
(`user_data_replace_on_change = true`), so it wants scheduling rather than a side effect.

**The ticket's "worth considering" CI drift gate cannot be built as described.** Three verified
blockers, recorded so nobody spends a day rediscovering them:

1. It fails red on a clean tree. `fleet.example.yaml:67-68` has `monitor_tz`/`monitor_daily_cron`
   **commented out** and the hub `project` unset, while `render.ts:305` emits those lines only
   when set. The real `deploy/fleet.yaml` is gitignored (`.gitignore:19`) because it holds account
   ids and CIDRs, so CI can never render the committed bytes.
2. It would mutate the checkout. `render.ts` has no CLI; `scripts/fleet.ts`'s `--manifest` flag
   (`:74`) selects input but `renderAll` (`:112-124`) hardcodes `ACCOUNTS_DIR` (`:48`).
3. The `pi-coms` CI job has no `bun install`, and the renderer needs `yaml` + `zod`.

A subset check is not a fix either: the unmodified example emits nothing for `monitor_tz`, so
such a check only fires if someone hand-injects the field into the fixture first -- which is
exactly the step SIO-1737 proved gets skipped.

---

## 4. Decisions, not work

Three items need five minutes of judgement each, not implementation.

**SIO-1455 -- re-scope or close.** There is no size-management node in `graph.ts`, but size
management *does* exist out of band: `packages/agent/src/kg-retention.ts:14`
(`DEFAULT_RETENTION_DAYS = 30`, overridable via `KG_UNCURATED_RETENTION_DAYS`) feeding
`purgeUncuratedIncidents`, scheduled by `schedules/kg-purge-sweep.yaml`. Re-scope against that
before anyone builds a redundant node.

**SIO-1099 -- outcomes or the regex?** The benign not-found half shipped
(`aggregator.ts:586-587` STRONG/WEAK split). The regex the ticket names is untouched --
`aggregator.ts:908-910`, still a bare unscoped `never (?:populated|written|loaded)` -- but it is
vetoed at runtime by an LLM judge (`aggregator.ts:1903-1908`, `absence-judge.ts:47`) that
`ABSENCE_JUDGE_ENABLED=false` switches off. If the ticket was about outcomes, close it. If it was
about the regex, narrow the scope to the regex alone.

**SIO-1143 -- confirm intent.** `apps/web/vite.config.ts:9,14` resolve to `../..`, which is fixed
exactly as the ticket words it. But `resolve(__dirname, "../..")` is relative to the config file,
so **in a worktree it resolves to the worktree root**, where no `.env` exists. Fixed-as-written,
broken-in-practice. If the intent was "worktrees inherit the main checkout's .env" it needs
`git rev-parse --path-format=absolute --git-common-dir` and is still open. The fix also predates
the ticket (`2e6c8349`), so it may have been filed against stale behaviour.

---

## 5. Leave in backlog

**SIO-1469** (mirror background terminal output into Herdr panes) -- zero code hits for `herdr` in
`*.ts`/`*.svelte`; docs only. **SIO-1218** (Couchbase Lite JS feasibility) -- zero hits for
`couchbase-lite|cblite` anywhere. Both speculative, nothing broken, no forcing function.

---

## 6. Things this session learned that outlive it

**Greptile is active again. [RESOLVED -- `CLAUDE.md` un-suspended in `a593a7f9`.]** The section
asserting the bot posts nothing was stale: it reviewed all five PRs this session and found four
real issues. The merge gate is the `Greptile Review` status check, and its findings are worth
triaging but are not themselves a gate.

**Two follow-on corrections**, from re-checking the reviews endpoint on #795-#799 after that
commit landed:

- Greptile does **not** reliably post an `APPROVED` review object. All five reached
  `COMPLETED SUCCESS`; only #797 produced one, so the older #653/#652 pairing does not generalise.
- Therefore `reviewDecision` is **not** a corroborating signal -- empty on the other four
  finished reviews. `CLAUDE.md` recommended it through `a593a7f9`; that is now reversed. Gate on
  the status check alone.

**Verify Greptile's reasoning, not just its conclusion.** On PR #795 it claimed a mismatched error
envelope passed validation, giving `{kind: "not-found", category: "throttled"}` as the example.
That example was already rejected -- `throttled` is a *kind*, not a category. But a well-typed
mismatch (`category: "auth"`) genuinely did pass, so the conclusion was right and the example
wrong. Both halves mattered.

**The Bun test runner can segfault in CI on green code.** PR #798's Test job failed with exit 139
after every package reported 0 failures. Locally it exited 0 both directly and via the root
filter; a re-run with no code change passed. This is the crash `CLAUDE.md` documents. Do not chase
it as a regression without first re-running.

**Two sandbox boundaries bite repeatedly.** (a) `git push` and `gh` fail inside the Bash sandbox
because DNS for github.com does not resolve there -- the machine's SSH access is fine, and the
same command succeeds with `dangerouslyDisableSandbox`. I initially mis-diagnosed this as "SSH is
blocked" and wrote that into three tickets before correcting it. (b) `ps` and `kill` are blocked
and return "operation not permitted", which reads like "no such process" if you are not careful.

**Baseline your test suites by stashing before claiming a regression.** `packages/shared` shows
498 pass / 80 fail locally and 578 pass / 0 fail in CI; `packages/agent` carries 24 pre-existing
failures in unrelated iac/memory suites; `mcp-server-couchbase` has one sandbox `EPERM` on
`/tmp/docs`. All are environmental. Measure before and after with `git stash push -u -m <tag>`
and `git stash apply <sha>` (never bare `git stash`, per the worktree rule).

---

## 7. Verification

Minimum bar for anything above:

```bash
bun run typecheck && bun run lint
```

Tests per package -- `bun test` at the repo root can crash the runner mid-suite:

```bash
cd packages/<name> && bun test
```

For anything touching the aws-agent prompt or the tool budget, the free check that actually
catches the regression class:

```bash
cd packages/gitagent-bridge && bun test src/skill-tool-coverage.test.ts
```

For a live AWS tool-selection check (~$0.10-0.50, needs the MCP proxy on :3001 and the main
checkout's `.env` -- eval scripts use `--env-file=../../.env`, which does not resolve inside a
worktree):

```bash
bun run eval:mcp-tool -- --datasource aws
```

Scores land in LangSmith, not stdout. `tool_name_validity` is the "no `Tool \"X\" not found`"
metric (`evaluators.ts:627-641`); `expected_tools_fired` is tool-selection quality. Recorded
baseline for comparison is `eval/README.md:251` -- note the 0.972 figures elsewhere in that file
are **all-datasource** aggregates and are the wrong comparand for a single-datasource run.

**A green check-set is not sufficient evidence to merge** (SIO-1291). State what was verified and
how: the command run, the output read, the live probe performed.

---

## 8. Workflow

Branch off `main` per ticket, named from each ticket's Linear `gitBranchName`. Claim the issue
(In Progress + assign) **before the first edit**, and never invent a ticket ID. PRs go up ready
for review, never draft.

**Watch the Linear PR-link automation.** It moves an issue to Done on merge even when only one of
several acceptance criteria is met -- it did exactly that to SIO-1240 this session and I had to
move it back to Todo. Check the status after any merge on a multi-criteria ticket.

```
SIO-XXXX: <imperative summary>

<what changed and why>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

## 9. Memory references

- `feedback_validate_every_claim_against_source` -- the governing rule; it caught three wrong
  premises this session (SIO-1681's hub/spoke, SIO-1240's model fleet, SIO-1239's approach)
- `feedback_never_blame_working_code_for_probe_failures` -- my first SIO-1644 probe "failed" and
  the probe was wrong, not the code
- `feedback_verbatim_plan_code_has_bugs` -- SIO-1109's ticket snippet specified `auth-denied`,
  which would have capped confidence on a correct policy refusal
- `feedback_prove_already_solved_by_code_comparison` -- how the predecessor's §2 closures were
  established
- `feedback_always_kill_own_background_processes_safely` -- and its inverse: the `:3001` proxy was
  pre-existing and was left alone
- `hub_pi_fleet`, `hub_pi_coms_ops` -- fleet/monitor context for §3.1 and §3.2
- `feedback_handoff_docs_main_branch` -- this file belongs on `main`
