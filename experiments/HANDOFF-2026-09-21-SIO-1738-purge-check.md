# HANDOFF: verify the SIO-1738 mailbox purge

- **Date written**: 2026-09-14 (check due 2026-09-21)
- **Ticket**: [SIO-1738](https://linear.app/siobytes/issue/SIO-1738) -- Done, merged
- **PR**: [#771](https://github.com/zx8086/devops-incident-analyzer/pull/771) -> `d892a9ae` on `main`
- **Parent chain**: [SIO-1736](https://linear.app/siobytes/issue/SIO-1736) (#769, `69202f2a`) -> [SIO-1737](https://linear.app/siobytes/issue/SIO-1737) (#770, `49fc77dc`) -> SIO-1738
- **Repo state at writing**: `main` @ `d892a9ae`, clean, in sync with origin
- **Branch needed**: none. This is a read-only verification. Only open a branch if it fails and you are asked to fix something.
- **Scheduled task**: `check-sio-1738-mailbox-purge`, fires once 2026-09-21 09:00 CEST (`~/.claude/scheduled-tasks/check-sio-1738-mailbox-purge/SKILL.md`)

## TL;DR

SIO-1738 fixed a retention bug: expired one-way mail (monitor reports) was never deleted from the pi-coms hubs, because the delete required a status a report never reaches. The fix shipped and the live migration is confirmed, but **the actual deletion has never been observed** -- at merge time no row had yet crossed its 14-day TTL. The oldest rows date from 2026-09-07, so the first deletions fall due around 2026-09-21. Success is: zero rows past `expires_at`, and a `stored` count below the 2026-09-14 baseline.

## Context -- how this came about

Chasing "can the daily digest run at 08:15 CET" (SIO-1736) led to reading the hub's `messages` table directly. Every monitor report showed `status = queued`, which reads as "in flight, awaiting delivery". That produced a **wrong conclusion that production monitoring had been blind for 10 hours**, and a rollback of 8 production monitors was proposed before the journal and watermarks disproved it. The monitors were fine the whole time.

Investigating why that value was misleading turned up the real bug below. SIO-1730 had already stopped the fleet pane *rendering* the status (showing age instead) for the same reason -- that fixed the display, not the value.

## The bug that was fixed

`MailStore.purgeExpired`, before SIO-1738:

```sql
DELETE FROM messages WHERE mailbox = 1 AND status IN ('complete','error','timeout') AND expires_at < ?
```

A one-way report is `mailbox = 1`, sent with `expectReply: false`. Nothing named `ops` ever registers -- every operator has their own token name -- so the `queued -> delivered -> complete` transition could never fire. The report sat at `queued` forever, **never matched the delete, and accumulated indefinitely**. `expires_at` was always populated correctly; the status predicate was the whole bug.

Shipped fix, `packages/pi-coms/scripts/coms-net-server.ts:664`:

```ts
purgeExpired(retainMs = 1_209_600_000): void {
    const now = Date.now();
    this.db.query("DELETE FROM messages WHERE mailbox = 1 AND expires_at < ?").run(new Date(now).toISOString());
    this.db
        .query("DELETE FROM messages WHERE mailbox = 0 AND status IN ('complete','error','timeout') AND completed_at < ?")
        .run(new Date(now - retainMs).toISOString());
}
```

One-way mail also now carries a terminal `stored` status from write time, and legacy rows migrate on store open (`coms-net-server.ts:567`):

```ts
this.db.exec("UPDATE messages SET status = 'stored' WHERE mailbox = 1 AND status IN ('queued','delivered')");
```

Request-reply (`mailbox = 0`) keeps `queued -> delivered -> complete|error|timeout` untouched -- the SIO-1655 fleet console, `coms_net_broadcast` and the SIO-1651 pi-handoff all depend on it.

## Already verified -- do NOT re-investigate

**`purgeExpired` runs on a timer, not only at startup.** This was checked on 2026-09-14 because it was the obvious way the fix could silently fail:

```
startLoops()                                        coms-net-server.ts:1863   unconditional at boot
  -> setInterval(ttlScanTick, TTL_SCAN_INTERVAL_MS) coms-net-server.ts:1865   default 10_000 ms (:92)
       -> ttlScanTick()                             coms-net-server.ts:1814
            -> purgeExpired(HISTORY_RETAIN_MS)      coms-net-server.ts:1843   once per project
```

No conditional guards those timers, so a running hub always sweeps. **A row is deleted within ~10 seconds of passing its `expires_at`.**

**The live migration worked.** Both hubs were converged to `d892a9ae` and `coms-hub` restarted on 2026-09-14; every legacy row converted, zero left behind, and `GET /v1/mailbox` returned HTTP 200 with readable rows afterwards on both.

## Baseline counts (2026-09-14, immediately post-rollout)

| Hub | Project | Counts |
|---|---|---|
| prd | `pi-coms-prd` | `mailbox=1 stored=621`, `mailbox=0 complete=440`, `mailbox=0 error=18` |
| dev | `pi-coms-dev` | `mailbox=1 stored=390` |
| dev | `default` | `mailbox=1 stored=99`, `mailbox=0 complete=50`, `mailbox=0 error=1` |

Oldest report rows dated **2026-09-07**. `REPORT_TTL_MS` is 14 days (`coms-net-monitor.ts:63`). Growth is roughly 6 digests/day plus per-finding reports -- prd had already climbed 621 -> 625 within hours of the rollout, so treat the baseline as a floor to compare against, not a fixed number.

## The check (step by step)

### 1. AWS credentials

They expire often. On `ExpiredToken`, ask Simon to run `./aws-refresh.sh -f daily.txt` -- only he can refresh. Do not attempt an SSO flow.

### 2. Targets

These are the **hub** hosts (`pi-coms-hub`), NOT the 8 `pi-agent-agent` spoke hosts. Region `eu-central-1` for both.

| Hub | Profile | Instance |
|---|---|---|
| prd | `eu-shared-services-prd` | `i-06a37a552e6a74c29` |
| dev | `eu-shared-services-dev` | `i-05d6f6ae51e5353ce` |

### 3. Query each hub

DBs live at `/home/comshub/.pi/coms-net/projects/<project>/messages.db`, owned by the `comshub` user. **Base64-encode a small bun script and run it as that user** -- inline quoting through SSM mangles JS repeatedly (cost several failed attempts on 2026-09-14):

```bash
B64=$(printf '%s' 'import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
const root = "/home/comshub/.pi/coms-net/projects";
for (const proj of readdirSync(root)) {
  try {
    const d = new Database(root + "/" + proj + "/messages.db", { readonly: true });
    const rows = d.query("SELECT mailbox, status, COUNT(*) n FROM messages GROUP BY mailbox, status").all();
    console.log(proj + ":", rows.map(r => `mailbox=${r.mailbox} ${r.status}=${r.n}`).join(" | ") || "(empty)");
    const past = d.query("SELECT COUNT(*) n FROM messages WHERE mailbox=1 AND expires_at < ?").get(new Date().toISOString());
    const oldest = d.query("SELECT MIN(created_at) c, MIN(expires_at) e FROM messages WHERE mailbox=1").get();
    console.log("   past-expiry still present:", past.n, "| oldest created:", oldest.c, "| earliest expiry:", oldest.e);
  } catch { console.log(proj + ": no db"); }
}' | base64 | tr -d '\n')

aws ssm send-command --profile eu-shared-services-prd --region eu-central-1 \
  --instance-ids i-06a37a552e6a74c29 --document-name AWS-RunShellScript \
  --parameters "commands=[\"echo $B64 | base64 -d > /tmp/v.ts && chown comshub /tmp/v.ts && su comshub -c 'HOME=/home/comshub \$(command -v bun || echo /home/comshub/.bun/bin/bun) /tmp/v.ts'; rm -f /tmp/v.ts\"]"
```

Then `aws ssm get-command-invocation --command-id <id> --instance-id <id> --query StandardOutputContent --output text`.

## Success criteria

- **`past-expiry still present: 0`** on every project -- the sweep runs every 10s, so anything past TTL should be gone within seconds
- `mailbox=1 stored=N` has **fallen** below the baseline (621 prd / 390 + 99 dev), or is at least not climbing at ~6+/day
- `mailbox=0` rows still present and cycling -- the fix must not have touched request-reply
- `systemctl is-active coms-hub` returns `active` on both

## Timing caveat -- read before concluding failure

The oldest rows are dated 2026-09-07 and expire 14 days later **at the hour they were written**.

**Good news, measured on 2026-09-14 by dry-running the probe above against prd:**

```
pi-coms-prd: mailbox=0 complete=442 | mailbox=0 error=18 | mailbox=1 stored=625
   past-expiry still present: 0 | oldest created: 2026-09-07T01:45:33.688Z | earliest expiry: 2026-09-21T01:45:33.688Z
```

The earliest prd expiry is **2026-09-21T01:45Z = 03:45 CEST**, comfortably before the 09:00 check. So by the time this runs, the first rows should already have been swept for ~5 hours. If they have not, that is a genuine failure, not a timing artifact.

(The dev hub was not dry-run; check its `earliest expiry` in the output before concluding anything there.)

**If `earliest expiry` is still in the future, the correct conclusion is "not yet due, recheck later today" -- NOT "the fix failed."** Misreading an ambiguous signal as a failure is exactly the mistake that triggered this whole thread (see Context).

## If rows ARE past expiry and still present

That is a real failure. Check in order, report, do not fix unprompted:

1. `cat /home/comshub/pi-coms/.bundle-version` -- is the hub on `d892a9ae` or later? State Manager converges every 30 min, but a hub that was never restarted runs old code in memory.
2. `systemctl show -p ActiveEnterTimestamp --value coms-hub` -- was it restarted *after* the bundle landed?
3. `journalctl -u coms-hub --no-pager -n 50 | grep -iE "error|throw"`
4. Confirm the rows genuinely have `expires_at` in the past (the query above reports it).

## Out of scope

- **The RDS CPU alarm** on `eu-oit-prd-psql-db-0` and the flapping `*-CPU-Utilization-Low-20` scale-down alarms. Both surfaced in the 2026-09-14 inbox review; Simon explicitly assigned them to the operators. Do not open tickets.
- Anything about the digest schedule itself -- SIO-1736/1737 are Done and verified live (digests landed 06:15 UTC = 08:15 CEST on all 6 prd accounts).

## Gotchas carried from the 2026-09-14 session

- **Run `pi-coms` tests OUTSIDE the sandbox.** It blocks `mkdtemp`, so every hub integration test dies in `startHub` with a misleading `EADDRINUSE` on port 0. Sandboxed, the suite looks like ~46 failures; run properly it is **390 pass / 0 fail**. A false "pre-existing failures" claim reached two PR descriptions before this was caught.
- **Background `Monitor` watchers went silent twice**, leaving a green PR unmerged. Check CI directly with `gh pr checks <N>`; do not rely on the notification.
- The `apps/web` suite has **17 pre-existing failures / 12 errors** on clean `main`, unrelated to any of this work. Verify by stashing before blaming a diff.

## Related code references

- `packages/pi-coms/scripts/coms-net-server.ts:664` -- `purgeExpired`, the fix
- `packages/pi-coms/scripts/coms-net-server.ts:567` -- the legacy-row migration
- `packages/pi-coms/scripts/coms-net-server.ts:1814,1843,1863,1865` -- the sweep timer chain
- `packages/pi-coms/contracts/wire.ts:19` -- `MessageStatus`, where `stored` was added
- `apps/web/src/lib/message-age.ts:17` -- `UNINFORMATIVE`; `stored` must stay listed or every report row renders an amber "exceptional" badge
- `packages/pi-coms/tests/mailstore.test.ts:46,64` and `tests/inbox.test.ts:156,170` -- the retention tests

## Memory references

- `reference_sio1635_pi_coms_hub_client_gotchas`
- `reference_fleet_probe_recipes_ssm_stats_and_hub_fanout`
- `feedback_never_blame_working_code_for_probe_failures`
- `feedback_roll_back_before_diagnosing_a_deploy_break`
