# HANDOFF 2026-09-17 -- Backlog after SIO-1681 shipped

| Field | Value |
| -- | -- |
| Date | 2026-09-17 |
| Type | Programme handover (successor to `experiments/HANDOFF-2026-09-16-backlog-remaining.md`) |
| Repo state | `main` @ `e152715d`, clean (one untracked file, see below) |
| Predecessor | `experiments/HANDOFF-2026-09-16-backlog-remaining.md` |
| Scope | What SIO-1681 changed about the backlog, plus everything still open |
| Suggested start | A fresh session in the MAIN checkout (`/Users/Simon.Owusu@Tommy.com/WebstormProjects/devops-incident-analyzer`), not a worktree |

> **Where this disagrees with the predecessor, THIS document is correct.** Its §3.1
> (SIO-1681) is now shipped; its §6 Greptile item is resolved. Everything else it
> says still stands and is restated here rather than assumed.

---

## TL;DR

SIO-1681 shipped and merged (PR #800, `e152715d`) -- a spoke now reports its own
consecutive model failures, and the monitor warns on them without an operator.
**One live verification is outstanding** and needs a real deploy; it is the only
thing this session left unfinished.

Otherwise: **SIO-1240** is parked on production traces and **SIO-1744** is
ops-not-code. Nothing is blocked.

> **UPDATE 2026-09-17 (same day, later session).** The three §5 decisions are all
> RESOLVED -- SIO-1455 no action, SIO-1099 canceled as obsolete, and **SIO-1143
> fixed, merged (PR #801, `bca0eed6`) and verified against two live dev servers**.
> §5 carries the detail. **Two of the three judgements this document originally
> made were wrong**; the corrections are recorded there rather than silently
> edited away. The remaining open work is unchanged: SIO-1240 (needs production
> traffic) and SIO-1744's `just fleet apply`, which also carries the §1 SIO-1681
> live check.

---

## 1. What shipped since the predecessor

| PR | Ticket | What landed |
| -- | -- | -- |
| #800 | SIO-1681 | Spoke counts consecutive provider failures -> heartbeat -> hub -> `fleet_list_agents` -> monitor `spoke-health` warn, plus docs |
| (direct) | -- | `CLAUDE.md` Greptile section un-suspended, then corrected (`a593a7f9`, `01bbb6b9`) |

SIO-1681 is **Done** (the Linear PR automation moved it on merge, not a human).

### The one thing SIO-1681 did NOT verify -- DONE 2026-09-17

> **RESOLVED.** Both probes below were run against the real fleet after bundle
> `12a7be86` was published and rolled out to all 8 spokes and both hubs.
> **8/8 spokes report `consecutive_run_errors=0`** -- present, not absent -- and
> the healthy-fleet check found **zero** `spoke-health` findings and zero monitor
> errors. Full evidence in a comment on SIO-1681.
>
> **Two traps found while doing it, both worth knowing before any future rollout:**
>
> 1. **`just fleet rollout` does NOT update the hub host.** `runRollout` iterates
>    `spokeNames` only (`scripts/fleet.ts:298`). After a *successful* dev rollout
>    the hub was still on the old bundle with ZERO references to
>    `consecutive_run_errors` in `contracts/wire.ts` and `coms-net-server.ts` --
>    spokes reporting a field into a hub that could not store it. Dispatch
>    `/usr/local/bin/pi-coms-update` to each hub host explicitly
>    (`deployment.md:116`); State Manager converges it within 30 min anyway, but a
>    rollout reporting success over a stale hub is a real trap.
> 2. **The agent-restart dance was NOT needed** even though `extensions/` changed.
>    `pi-coms-update` had already relaunched the agent (`operations-gotchas.md:64-65`
>    is the accurate page; `deployment.md:118-122` reads as mandatory). Check
>    whether the agent process restarted BEFORE reaching for `pkill`.
>
> Also note `just fleet status` needs `--operator <principal>` just as `rollout`
> does; without it it fails after printing the credential rows.
>
> Still open: a spoke whose model is **genuinely failing**. The counter has only
> been observed at `0`; reaching `>= 3` needs a real provider outage and is not
> worth manufacturing.


**No live run against a spoke whose model is actually failing.** Every hop is
covered by tests, including one that spawns a real hub process, but the
end-to-end path on real hosts is unexercised until the next bundle publish and
rollout. Two concrete checks, worth doing on the first deploy that carries this:

```bash
# 1. The new heartbeat field survives the rollout (expect 0 on healthy spokes,
#    and the field PRESENT rather than absent)
curl -s -H "authorization: Bearer $PI_COMS_NET_AUTH_TOKEN" \
  "$PI_COMS_NET_SERVER_URL/v1/agents?project=$PI_COMS_NET_PROJECT&include_explicit=true" \
  | jq '.agents[] | {name, status, consecutive_run_errors, last_run_error}'

# 2. No spoke-health finding on a healthy fleet (a false positive here is worse
#    than the bug, because it trains people to ignore the family)
```

**Known limit, documented rather than hidden:** the counter only moves on runs
that actually happen. A spoke nothing is prompting accumulates nothing, so the
ticket's "warn within two cycles" holds under traffic, not on an idle spoke.
Recorded in `packages/pi-coms/docs/deployment/operations-gotchas.md` and the
`monitoring.md` checks table.

### Where the SIO-1681 code lives, for whoever does that verification

| Path | What |
| -- | -- |
| `packages/pi-coms/extensions/turnReply.ts` | `nextRunHealth` -- pure reducer, counts only `stopReason: "error"` |
| `packages/pi-coms/extensions/coms-net.ts` | settled at `agent_settled`, NOT `agent_end` (see hazard below) |
| `packages/pi-coms/scripts/coms-net-server.ts` | heartbeat store, re-registration carry-over, `entryToCard` |
| `packages/pi-coms/scripts/monitor/checks/spoke-health.ts` | the check, `classifyRunError`, `safeModelId` |
| `packages/agent/src/pi-fleet/tools.ts` | `renderAgents` shows the count |

---

## 2. Three hazards SIO-1681 uncovered that outlive it

These are properties of the hub and monitor, not of that ticket. Anyone touching
either will hit them.

**`AgentStatus` is a LIVENESS axis -- never overload it with health.** The hub
derives `stale`/`offline` itself from heartbeat age (`coms-net-server.ts:41-42`,
scan at `:1795`). A spoke self-reporting `stale` to mean "I am unwell" would both
lie about liveness and **suppress the genuine staleness transition**, because the
scan guards on `entry.status !== "stale"`. Health gets its own field.

**`entryToCard` whitelists fields onto the wire** (`coms-net-server.ts:727`). It
destructures an explicit list to keep `token_hash` and `principal` off the API.
So a new `AgentCard` field that the heartbeat handler stores is **silently
dropped from `/v1/agents`** until added there too. Typecheck cannot catch it
(`RegistryEntry = AgentCard & {...}`). Adding a field means touching four places:
the contract, the heartbeat handler, `entryToCard` (both halves), and the
`changed` comparison that gates the `agent_updated` broadcast.

**A monitor finding can reach a model even when you exclude it from
investigation.** `priorIncidents` (`monitor/state.ts:131`) matches journal rows
with a bare `payload LIKE '%resource%'` and **no family filter**, and
`coms-net-monitor.ts:310` joins those into the investigation prompt. So any
untrusted string a finding carries can surface in a later prompt for the same
resource. `spoke-health` handles this by classifying rather than sanitising --
`classifyRunError` and `safeModelId`. Apply the same rule to any new family whose
evidence carries text the monitor did not author.

---

## 3. The one live ticket: SIO-1240

**Status: Todo. Criteria 1 and 2 resolved; 3, 4 and 5 open, all waiting on the
same data.** Unchanged from the predecessor -- re-read on Linear 2026-09-17 to
confirm, not assumed.

`MAX_TOOLS_PER_AGENT = 25` (`packages/agent/src/sub-agent.ts:1021`, rationale
comment from `:974`) is documented. What remains is deciding whether 25 is right.

### The next step, concretely

SIO-1767 (PR #798) shipped the instrument. `composeBoundTools` emits one line
when -- and only when -- the budget actually cuts
(`packages/agent/src/sub-agent.ts:1213`):

```
"tool budget truncated the bound set"
{ dataSourceId, max, minAction, requested, bound, droppedHead, droppedTail,
  droppedNames[], droppedNamesTruncated? }
```

Let production traffic accumulate, then aggregate that line by `dataSourceId`.
Report how often truncation fires, the `requested` distribution, and which names
recur in `droppedNames`.

**The likely outcome closes three criteria at once.** If aws-agent is the only
datasource that ever truncates -- plausible at a 35-name prompt against a 17-name
budget -- the answer is "keep 25, the cap is fine, aws-agent's prompt was the
problem", and SIO-1239 already fixed that half. If several datasources truncate
regularly, the 15/25/40/uncapped eval the ticket proposes is justified.

**Do not synthesise the traffic.** The whole point of the instrumentation is to
stop sizing the cap against guesses.

**Hazard for whoever changes the value:** `skill-tool-coverage.test.ts:21`
hardcodes its own copy of `MAX_TOOLS_PER_AGENT` with a "keep in sync" comment.
Move both or the budget the test enforces silently desynchronises from the budget
the code applies.

---

## 4. Open, ops rather than code: SIO-1744

**The repo half is done -- re-verified on `e152715d`, not carried over from the
predecessor.** All 8 committed roots carry `monitor_tz` and `monitor_daily_cron`:

```bash
for d in packages/pi-coms/deploy/accounts/*/; do
  grep -q "monitor_tz" "$d/main.tf" || echo "MISSING: $d"
done   # -> no output, 8/8
```

The ticket says 9 hosts; `eu-b2bonboarding-prd` is a governance account with no
agent host, so 8/8 is complete, not 8/9.

~~What remains is `just fleet apply` per host~~ -- **NOTHING REMAINS (verified
2026-09-17).** `just fleet preflight` passes on all 8 spokes and `just fleet plan`
reports **`No changes`** on every one; the live dev host registers
`daily 15 8 * * *; tz Europe/Amsterdam`, this ticket's exact payload. The schedule
was already applied. See the comment on SIO-1744.

One trap: the values are hardcoded in each rendered root's `main.tf:123-124`, NOT
in `terraform.tfvars` (module defaults are `""`), so grepping the tfvars returns
ABSENT on all 8 and means nothing. Grep `main.tf`.

**The SIO-1681 live check did NOT need this apply** and was done via bundle
publish + rollout instead -- see §1, now resolved.

**The ticket's "worth considering" CI drift gate cannot be built as described.**
Three verified blockers, recorded so nobody spends a day rediscovering them:

1. It fails red on a clean tree. `fleet.example.yaml:67-68` has
   `monitor_tz`/`monitor_daily_cron` **commented out** and the hub `project`
   unset, while `render.ts:305` emits those lines only when set. The real
   `deploy/fleet.yaml` is gitignored (`.gitignore:19`) because it holds account
   ids and CIDRs, so CI can never render the committed bytes.
2. It would mutate the checkout. `render.ts` has no CLI; `scripts/fleet.ts`'s
   `--manifest` flag (`:74`) selects input but `renderAll` (`:112-124`) hardcodes
   `ACCOUNTS_DIR` (`:48`).
3. The `pi-coms` CI job has no `bun install`, and the renderer needs `yaml` + `zod`.

A subset check is not a fix either: the unmodified example emits nothing for
`monitor_tz`, so such a check only fires if someone hand-injects the field into
the fixture first -- exactly the step SIO-1737 proved gets skipped.

---

## 5. Decisions, not work -- ALL THREE RESOLVED 2026-09-17

> **This section is CLOSED.** All three were worked on 2026-09-17 and the full
> analysis lives in a decision comment on each Linear ticket. **Two of the three
> judgements below were WRONG**, and they are preserved with their corrections
> rather than deleted, because the errors are instructive: both came from reading
> a file's shape rather than measuring it. Nothing here is outstanding.

**SIO-1455 -- resolved: NO ACTION, left in Backlog with tripwires.**

~~Re-scope against `packages/agent/src/kg-retention.ts:14`~~ -- **WRONG COMPARAND,
do not spend time on it.** `kg-retention` purges knowledge-*graph* incident rows
from the DB on a cron. SIO-1455 is about the knowledge-*tree* markdown
concatenated into a prompt. Different subsystem, different failure mode, no
overlap.

Measured on `08ac44c3` instead of reasoned about, and the premise inverts: the
unfiltered categories the ticket worries about (`systems-map` + `slo-policies`)
are **3,827 bytes = 3.1%** of the tree, while `runbooks-*` is **115,338 bytes =
93.6%** and is ALREADY filtered per-turn by SIO-640 (`filterAgentRunbooks`,
`orchestrator-prompt-assembly.ts:44-51`). Tree grew 112 KB -> 120.3 KB in 13
months (~7%); elastic-iac, which genuinely needed `selectIacKnowledge`, is
535.5 KB. Re-open only if `systems-map`+`slo-policies` exceed ~25 KB or a new
always-on non-`runbooks-*` category is added.

**SIO-1099 -- resolved: CANCELED as obsolete** (Canceled, not Done -- nobody
implemented it; the problems were overtaken by other work).

The "outcomes or the regex?" framing was a **false dichotomy**: the ticket's own
CRITICAL section says the two caps OR-combine, so it was never separable. All
three of its load-bearing claims are now obsolete:

1. `min(score, 0.59)` is gone -- SIO-1155/SIO-1195 replaced the boolean OR with
   named `capReasons` + a two-class policy that soft-caps ABOVE the gate
   (`aggregator.ts:2037-2082`).
2. Problem 1 SHIPPED as the prompt rule the ticket prescribed --
   `healthCheckGapRule` (`aggregator.ts:361`) now names "a not-found for a named
   document/index/log-group/topic" explicitly.
3. Problem 2's trigger NO LONGER FIRES. The regex is untouched
   (`aggregator.ts:908`) but SIO-1198 added a conjunction gate at `:1229`
   requiring absence vocabulary alongside it. Verified by live repro: the
   ticket's actual failing line, `"The data was never loaded"`, is now
   **not flagged**.

Carried forward deliberately: the `never (?:populated|written|loaded)` branch
still fires on GROUNDED absences when absence vocabulary is present, and the
judge vetoes on scoping, not corroboration. If that recurs in production it is a
fresh narrow ticket, not a revival of this one.

**SIO-1143 -- resolved: FIXED, SHIPPED AND VERIFIED LIVE.** PR #801, merged as
`bca0eed6`.

~~"fixed exactly as the ticket words it"~~ and ~~"the fix predates the ticket
(`2e6c8349`)"~~ -- **BOTH WRONG.** The code was character-for-character the
snippet the ticket quotes as the BUG, and `2e6c8349` (2026-03-22) is the commit
that INTRODUCED the frontend, not a fix. The ticket was filed against live
behaviour that still shipped.

`findRepoRoot` (`apps/web/src/lib/repo-root.ts`) resolves via
`git rev-parse --path-format=absolute --git-common-dir`, whose parent is the true
root for a main checkout and every worktree alike. `startDir` is explicit (never
cwd) so a tarball inside another repo cannot resolve to that repo's root, and the
git call is not load-bearing -- any failure returns the historical `../..` path.

**Verified with two live dev servers, not a probe:** a worktree server (no `.env`
of its own) returned **7 populated AWS estates** and all four MCP env-presence
flags `true`, and its output was **identical** to a main-checkout server's. The
old `envDir` target holds no `.env`, so all five variables would have been unset
before.

Greptile found two real P1/P2 issues on the first round, both verified before
applying and both correct; fixing the P1 also exposed a latent depth bug in the
test (`../../..` from `src/lib` is `apps/`, not the checkout root). Final round
5/5, 7/7 checks.

---

## 6. Leave in backlog

**SIO-1469** (mirror background terminal output into Herdr panes) -- zero code hits
for `herdr` in `*.ts`/`*.svelte`; docs only. **SIO-1218** (Couchbase Lite JS
feasibility) -- zero hits for `couchbase-lite|cblite` anywhere. Both speculative,
nothing broken, no forcing function.

---

## 7. Environment notes that cost this session time

**The Bash sandbox blocks server binds.** The `packages/pi-coms` suite shows ~72
failures inside the sandbox ("Is port 0 in use?") and **563 pass / 0 fail**
outside it. The integration tests spawn a real hub. Confirm against an untouched
test before believing any failure:

```bash
cd packages/pi-coms && bun test   # run OUTSIDE the sandbox
```

**The sandbox also blocks writes outside the current worktree.** A
`git reset --hard` run from a worktree against the main checkout fails with
"operation not permitted" and aborts cleanly. Retry outside the sandbox.

**`bun test` needs the nested monitor deps.** `packages/pi-coms/package.json`'s
`test` script runs `bun run deps:monitor` first (a non-workspace
`scripts/package.json`). Calling `bun test` directly skips it and produces a wall
of `Cannot find module '@aws-sdk/*'` that looks like a code failure.

**Greptile is active and its findings are worth reading properly.** It produced
three real P1s on PR #800 across three rounds, all genuine bugs. Verify the
reasoning, not just the verdict -- and check the footer `Last reviewed commit`
SHA against the PR head, because it edits one comment in place.

---

## 8. Verification

Minimum bar for anything above:

```bash
bun run typecheck && bun run lint
```

Tests per package -- `bun test` at the repo root can crash the runner mid-suite:

```bash
cd packages/<name> && bun test
```

For anything touching the aws-agent prompt or the tool budget, the free check
that actually catches the regression class:

```bash
cd packages/gitagent-bridge && bun test src/skill-tool-coverage.test.ts
```

For a live AWS tool-selection check (~$0.10-0.50, needs the MCP proxy on :3001
and the main checkout's `.env` -- eval scripts use `--env-file=../../.env`, which
does not resolve inside a worktree):

```bash
bun run eval:mcp-tool -- --datasource aws
```

Scores land in LangSmith, not stdout. `tool_name_validity` is the
"no Tool X not found" metric (`evaluators.ts:627-641`);
`expected_tools_fired` is tool-selection quality. Recorded baseline is
`eval/README.md:251` -- the 0.972 figures elsewhere in that file are
**all-datasource** aggregates and are the wrong comparand for a single-datasource
run.

**A green check-set is not sufficient evidence to merge** (SIO-1291). State what
was verified and how: the command run, the output read, the live probe performed.

---

## 9. Workflow

Branch off `main` per ticket, named from each ticket's Linear `gitBranchName`.
Claim the issue (In Progress + assign) **before the first edit**, and never invent
a ticket ID. PRs go up ready for review, never draft.

**Watch the Linear PR-link automation.** It moves an issue to Done on merge even
when only some acceptance criteria are met -- it did that to SIO-1240 on
2026-09-16 (one of five criteria) and it moved SIO-1681 on 2026-09-17 (scope
genuinely complete, but the live check still outstanding). Check the status after
any merge on a multi-criteria ticket.

```
SIO-XXXX: <imperative summary>

<what changed and why>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

## 10. Repo state detail

`main` is at `e152715d` and matches `origin/main` exactly. One untracked file is
present and is **deliberately left alone**:

```
?? packages/pi-coms/deploy/fleet.yaml.bak-sio1741
```

It is a backup of the gitignored deploy config (account ids, CIDRs), dated
2026-09-14. The live `deploy/fleet.yaml` is present and newer. Not mine to
delete; kept so nobody treats it as stray.

The `sio-backlog-handover-4a06b6` worktree was removed and its branch deleted
after the PR #800 merge. An empty `.claude/.cc-writes` shell may remain at that
path -- session bookkeeping, not repo content.

---

## 11. Memory references

- `reference_sio1681_hub_status_axes_and_entrytocard` -- the two hub hazards in §2
- `reference_greptile_active_again_2026_09_14` -- Greptile live; no reliable
  `APPROVED` object, so never gate on `reviewDecision`
- `feedback_validate_every_claim_against_source` -- the governing rule; it caught
  wrong premises in both this session and the predecessor
- `feedback_never_blame_working_code_for_probe_failures` -- the sandbox test
  failures in §7 are exactly this class
- `feedback_always_kill_own_background_processes_safely`
- `hub_pi_fleet`, `hub_pi_coms_ops` -- fleet/monitor context for §1 and §4
- `feedback_handoff_docs_main_branch` -- this file belongs on `main`
