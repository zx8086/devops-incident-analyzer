# HANDOFF 2026-09-17 (evening) -- what is outstanding after the fleet deploy

| Field | Value |
| -- | -- |
| Date | 2026-09-17 |
| Type | Programme handover (successor to `experiments/HANDOFF-2026-09-17-backlog-after-sio1681.md`) |
| Repo state | `main` @ `6f926762`, in sync with `origin/main`, clean |
| Fleet state | bundle `12a7be86` live on all 8 spokes + both hubs |
| Predecessor | `experiments/HANDOFF-2026-09-17-backlog-after-sio1681.md` (its §1 and §5 are now CLOSED) |
| Scope | Only what is genuinely unfinished. Everything else is recorded on its ticket. |

---

## TL;DR

**One item is outstanding and it needs nothing but more production turns: SIO-1240.**

Everything else that was open this morning is closed. SIO-1744 turned out to need no
work at all, SIO-1681's live check is done, and the three parked decisions are
resolved. Two new documentation tickets were filed and both shipped the same day.

Nothing is blocked. Nothing needs a deploy.

---

## 1. The one outstanding item: SIO-1240

**Status: Todo. Criteria 1 and 2 closed; 3, 4 and 5 open.**
<https://linear.app/siobytes/issue/SIO-1240>

### What changed today

It was parked on "no production traffic exists". That is no longer true -- a real
investigation ran at 12:04 (run `c431e436`, thread `591658a8`) and the SIO-1767
instrument fired four times. **The first production data is recorded in a comment
on the ticket.** The headline:

| datasource | requested | bound | dropped |
| -- | -- | -- | -- |
| kafka | 58 | 25 | **33 (57%)** |
| couchbase | 29 | 25 | 4 (14%) |
| aws (x2, one per estate) | 68 | 25 | **43 (63%)** |

elastic, gitlab and atlassian stayed under budget.

### The finding that matters

**The ticket's leading hypothesis is refuted.** It anticipated "if aws-agent is the
only datasource that ever truncates ... the answer is keep 25, the cap is fine".
Three of six truncate in a single turn, and kafka is proportionally almost as
oversubscribed as aws. The 15/25/40/uncapped eval the ticket proposes is therefore
justified rather than moot.

**But the cap cost nothing on this turn.** Cross-referencing the 46 tools the run
actually used against every logged `droppedNames`: **zero collisions**. What was
shed was coherent -- kafka lost its ksqlDB/Connect/REST-Proxy families and write
tools, aws lost ELB/Route53/RDS/Lambda/GuardDuty/S3/DynamoDB/SNS/SQS on an ECS +
CloudWatch Logs incident. `droppedHead: 0` throughout, so `MIN_ACTION_TOOLS = 8`
never had to defend the query-relevant head.

### What it needs now -- and this is the only ask in this document

**More production turns, of different incident families.** One turn cannot separate
"the action filter orders tools well" from "this incident happened not to need the
tail". The discriminating cases:

- a **network / ELB / Route53** incident would exercise the aws tail
- a **Kafka Connect or ksqlDB** incident would exercise kafka's tail

Then aggregate, per turn, `droppedNames` against `agent.request.end.toolNames`:

```bash
grep "tool budget truncated the bound set" <server-log> \
  | jq -c '{ds:.dataSourceId, requested, bound, droppedTail}'
```

If collisions stay at zero, **retain 25 and cite that as the evidence**. If a
collision appears, that named tool is the argument for raising it.

### Two hazards for whoever acts on it

1. **`droppedNames` caps at 30 entries** with `droppedNamesTruncated: true` (kafka
   logged 30 of 33, aws 30 of 43). A collision check on the logged names is a
   **lower bound**, not proof of no collision.
2. **`skill-tool-coverage.test.ts:21` hardcodes its own copy of
   `MAX_TOOLS_PER_AGENT`** with a "keep in sync" comment. Changing the value in
   `sub-agent.ts:1021` without moving both silently desynchronises the budget the
   test enforces from the budget the code applies.

**Do not synthesise traffic.** The whole point of the instrument is to size the cap
against real runs.

---

## 2. Closed today -- do not re-investigate these

| Ticket | Outcome | Where the evidence is |
| -- | -- | -- |
| **SIO-1143** | **FIXED & MERGED** (PR #801, `bca0eed6`) | Worktree dev servers now load the repo-root `.env`. Verified with two live dev servers: a worktree server returned 7 populated AWS estates and output **identical** to a main-checkout server. |
| **SIO-1681** | **live check DONE** | Bundle deployed fleet-wide; 8/8 spokes report `consecutive_run_errors=0` (present, not absent); zero `spoke-health` findings and zero monitor errors on a healthy fleet. Comment on the ticket. |
| **SIO-1744** | **NO WORK NEEDED** (still Backlog -- see below) | `preflight` passes on all 8; `plan` reports `No changes` on all 8; the live dev host registers `daily 15 8 * * *; tz Europe/Amsterdam`. |
| **SIO-1455** | **NO ACTION**, left in Backlog with tripwires | The unfiltered categories are **3.1%** of the tree; the 93.6% that is runbooks is already filtered by SIO-640. |
| **SIO-1099** | **CANCELED** as obsolete | Its central OR-combine mechanic no longer exists (SIO-1195); its actual failing line no longer trips the detector (SIO-1198). |
| **SIO-1768** | **FIXED & MERGED** (PR #802, `8e52aeb0`) | `CLAUDE.md` now points at both docs indexes. |
| **SIO-1769** | **FIXED & MERGED** (PR #803, `12a7be86`) | `deploying-from-a-worktree.md` linked from the index and `deployment.md`. |

### SIO-1744 needs a human decision, not work

It is **still in Backlog** and I did not move it, because the ticket asks for
"`just fleet apply` per host" while the observable state it wants is already in
place. Someone should decide whether it closes as satisfied or is re-scoped. The
analysis is in a comment on the ticket; there is no code or ops work behind it.

**One trap recorded there, worth repeating:** `monitor_tz` lives in each rendered
root's `main.tf:123-124`, **not** in `terraform.tfvars` (module defaults are `""`).
Grepping the tfvars returns ABSENT on all 8 and means nothing. Grep `main.tf`.

Note also that SIO-1742 (spoke IAM: SSM managed-instance + Cost Anomaly reads),
which that ticket lists as riding along with any apply, is **already live** --
`aws ssm describe-instance-information` returns instances from `eu-b2b-ecom-prd`
today. The clean plans are consistent with all prior drift having been applied.

---

## 3. The fleet deploy -- what happened and two traps it exposed

The fleet had been running `17a063a6` (2026-09-16 17:51), which **predates
SIO-1681**, so `spoke-health.ts` was on no host. Published and rolled out
`12a7be86` to both hub buckets and all 8 spokes, dev first then the 6 prd.

Only 4 of the 16 intervening commits reach the fleet (SIO-1681, SIO-1239,
SIO-1766, SIO-1769); the rest are web-app or repo docs. No bootstrap/userdata/
systemd changes, so no instance replacement.

### Trap 1: `just fleet rollout` does NOT update the hub host

`runRollout` iterates `spokeNames` only (`scripts/fleet.ts:298`). After a
**successful** dev rollout the hub was still on the old bundle with **zero**
references to `consecutive_run_errors` in `contracts/wire.ts` and
`coms-net-server.ts` -- spokes reporting a field into a hub that could not store or
serve it.

Fix: dispatch `/usr/local/bin/pi-coms-update` to each hub host directly
(`deployment.md:116`). The hub runs as user `comshub` at `/home/comshub/pi-coms/`,
**not** `piagent` -- that path guess cost time. The State Manager association would
converge it within 30 minutes anyway, but a rollout reporting success over a stale
hub is a real trap.

**Anyone rolling out a wire-contract change must update the hub host explicitly.**

### Trap 2: the agent-restart dance was NOT needed

`deployment.md:118-122` says to follow with `pkill -TERM -u piagent -f cli.js` when
`extensions/` changed, and both `coms-net.ts` and `turnReply.ts` did. Checked before
acting: the agent had **already** restarted at 08:54:57 loading the new extension
with `persona=pi-fleet-v0.2.1`. `operations-gotchas.md:64-65` is the accurate page
-- `pi-coms-update` "signals the Herdr-hosted agent to relaunch". The dance is the
fallback for when it does not, not a mandatory step.

**Check whether the agent process restarted before reaching for `pkill`** -- running
it needlessly drops live agents on six production spokes.

### Also

- `just fleet status` needs `--operator <principal>` exactly as `rollout` does;
  without it, it fails **after** printing the credential rows.
- `just fleet status` left **orphaned SSM tunnels** on 8787/8788 (parent = launchd
  after `fleet.ts` exited). Matches `reference_fleet_cli_orphans_ssm_tunnels`.
  Prove ownership by parent chain, then kill by tracked PID -- never a blanket
  `pkill`.

---

## 4. Still not verified (and not worth manufacturing)

**A spoke whose model is genuinely failing.** SIO-1681's counter has only ever been
observed at `0`. Reaching `>= 3` needs a real provider outage -- the eu-oit-prd 403
storm of 2026-09-09 is the motivating case. The documented limit stands: the counter
only moves on runs that actually happen, so an idle spoke accumulates nothing.

Every hop is now proven on real hosts. This is the one link that needs reality to
cooperate.

---

## 5. Leave in backlog

**SIO-1469** (mirror background terminal output into Herdr panes) -- zero code hits
for `herdr` in `*.ts`/`*.svelte`; docs only. **SIO-1218** (Couchbase Lite JS
feasibility) -- zero hits for `couchbase-lite|cblite` anywhere. Both speculative,
nothing broken, no forcing function. Unchanged from the predecessor.

---

## 6. Environment notes

**The Bash sandbox blocks server binds and SSH egress.** A dev server bind fails
with `EPERM` on `::1:<port>`, and `git push` fails with `Broken pipe`. Both work
outside the sandbox. This cost time twice today.

**`packages/pi-coms` tests: use `bun run test`, never `bun test`.** The former runs
`deps:monitor` first; the latter skips it and produces 7 failures that look like
code breakage (`Cannot find module '@aws-sdk/*'`). Correct invocation gives
**563 pass / 0 fail**.

**`bun test` at the repo root can crash the runner mid-suite** -- run per package.

**Greptile is active and its findings were 6-for-6 today.** Across PRs #801, #802
and #803 it raised six findings; **all six were real**, and two corrected factual
errors written into documentation. Verify the reasoning, not just the verdict, and
check the footer `Last reviewed commit` SHA against the PR head -- it edits one
comment in place.

---

## 7. Verification

Minimum bar:

```bash
bun run typecheck && bun run lint
```

Lint currently reports **15 warnings on a clean tree**, all pre-existing and none in
recently-touched files. Prove a change adds none by re-running on a stashed tree
rather than asserting it.

Tests per package:

```bash
cd packages/<name> && bun run test
```

For anything touching the aws-agent prompt or the tool budget:

```bash
cd packages/gitagent-bridge && bun test src/skill-tool-coverage.test.ts
```

**A green check-set is not sufficient evidence to merge** (SIO-1291). State what was
verified and how: the command run, the output read, the live probe performed.

---

## 8. Repo state detail

`main` is at `6f926762` and matches `origin/main`. One untracked file is present and
is **deliberately left alone**:

```
?? packages/pi-coms/deploy/fleet.yaml.bak-sio1741
```

A backup of the gitignored deploy config, dated 2026-09-14. It does **not** block
`publish-fleet.sh` (that check uses `--untracked-files=no`). Not mine to delete.

15 worktrees exist; the `handover-context-grounding-653682` one was removed today.
Of the rest, every "unmerged" one holds real commits (1-13 each) -- **do not bulk
clean them**.

---

## 9. Memory references

- `reference_fleet_cli_orphans_ssm_tunnels` -- the 8787/8788 orphans in §3
- `hub_pi_coms_ops`, `hub_pi_fleet` -- fleet/monitor context for §3
- `reference_greptile_active_again_2026_09_14` -- Greptile live; no reliable
  `APPROVED`, so never gate on `reviewDecision`
- `feedback_validate_every_claim_against_source` -- the governing rule; it caught
  wrong premises in the predecessor twice today
- `feedback_never_blame_working_code_for_probe_failures` -- the `bun test` failures
  in §6 are exactly this class
- `feedback_always_kill_own_background_processes_safely`
- `feedback_handoff_docs_main_branch` -- this file belongs on `main`
